// Portado de tests/unit/orchestrator.test.js (T02).
//
// Cinco tests del OrchestratorService legacy sobre la ejecucion de un paso con
// reintentos. TRADUCIDO: la clase con ocho dependencias por constructor
// desaparece y lo que queda es `ejecutarPasoConReintentos` contra el puerto de
// transporte tipado (RF12, RF13, RF16, RF19). Los asserts de "ok" y de cantidad
// de llamadas al transporte se conservan tal cual.

import { describe, it, expect } from 'vitest'

import type { PasoDeOrden, Result, TipoDispositivo } from '@aoki-one/domain'

import type { Reloj } from '../reloj.js'
import type { FalloDeEjecucion } from '../transport/errorClassification.js'
import type { PedidoDeComando, RespuestaUtilPlc } from '../transport/stepHandshake.js'
import type { DependenciasDePaso, PuertoDeTransporte } from './ports.js'
import { ejecutarPasoConReintentos, type ContextoDePaso } from './stepExecutor.js'

type RespuestaDePlan = Result<RespuestaUtilPlc, FalloDeEjecucion>

interface LlamadaDeTransporte {
  readonly robotId: string
  readonly dispositivo: TipoDispositivo
  readonly pedido: PedidoDeComando
}

interface TransporteDoble {
  readonly puerto: PuertoDeTransporte
  readonly llamadas: readonly LlamadaDeTransporte[]
}

function sinDoble(nombre: string): () => never {
  return () => {
    throw new Error(`doble no configurado: ${nombre}`)
  }
}

/** Devuelve el i-esimo resultado del plan; si el plan se agota, es que se llamo de mas. */
function crearTransporteDoble(plan: readonly RespuestaDePlan[]): TransporteDoble {
  const llamadas: LlamadaDeTransporte[] = []

  const puerto: PuertoDeTransporte = {
    ejecutarComandoDePaso: (robotId, dispositivo, pedido) => {
      llamadas.push({ robotId, dispositivo, pedido })
      const respuesta = plan.at(llamadas.length - 1)
      if (respuesta === undefined) {
        throw new Error(`el transporte se llamo mas veces que las ${String(plan.length)} del plan`)
      }
      return Promise.resolve(respuesta)
    },
    resetearMessageIn: sinDoble('resetearMessageIn'),
    leerRegistros: sinDoble('leerRegistros'),
  }

  return { puerto, llamadas }
}

interface RelojDoble {
  readonly reloj: Reloj
  readonly esperas: readonly number[]
}

function crearRelojDoble(): RelojDoble {
  const esperas: number[] = []
  const reloj: Reloj = {
    ahoraMs: () => 1_700_000_000_000,
    dormir: (ms) => {
      esperas.push(ms)
      return Promise.resolve()
    },
  }
  return { reloj, esperas }
}

/** Paso 1 de la secuencia fisica: el INIT del carro (41000) con ACK esperado 100. */
const PASO_HOMING: PasoDeOrden = {
  seq: 1,
  tipo: 'HOMING',
  dispositivo: 'CARRO',
  comando: 41000,
}

const CONTEXTO: ContextoDePaso = {
  ordenId: 'ord-1',
  robotId: '1',
  paso: PASO_HOMING,
}

const RESPUESTA_OK: RespuestaDePlan = { ok: true, valor: { kind: 'OK' } }

function falloDeTransporte(mensaje: string): RespuestaDePlan {
  return { ok: false, error: { tipo: 'TRANSPORTE', codigo: 'ETIMEDOUT', mensaje } }
}

function dependencias(transporte: PuertoDeTransporte, reloj: Reloj): DependenciasDePaso {
  return {
    transporte,
    reloj,
    politica: { maxIntentos: 3, baseBackoffMs: 10 },
  }
}

describe('ejecucion de un paso con reintentos (portado de orchestrator.test.js)', () => {
  it('ejecuta el paso contra el puerto de transporte inyectado con una sola llamada', async () => {
    // El legacy solo contaba llamadas ("acepta connection service fake"): pasaba
    // igual aunque el comando fuera basura. Se agrega el assert del payload, que
    // es lo que HOMING manda de verdad al PLC.
    const transporte = crearTransporteDoble([RESPUESTA_OK])
    const { reloj, esperas } = crearRelojDoble()

    const resultado = await ejecutarPasoConReintentos(
      dependencias(transporte.puerto, reloj),
      CONTEXTO,
    )

    expect(resultado).toEqual({ ok: true, valor: { intentos: 1, respuesta: { kind: 'OK' } } })
    expect(transporte.llamadas).toHaveLength(1)
    expect(transporte.llamadas.at(0)?.robotId).toBe('1')
    expect(transporte.llamadas.at(0)?.dispositivo).toBe('CARRO')
    expect(transporte.llamadas.at(0)?.pedido).toEqual({ comando: 41000, respuestasEsperadas: [100] })
    expect(esperas).toEqual([])
  })

  it('reintenta ante un fallo de transporte y el segundo intento cierra el paso', async () => {
    // El legacy fabricaba el error transitorio con `transient.fatal = false`, que
    // es justo el campo que leia la clasificacion: salteaba la regla. Bajo RF19 el
    // unico reintentable es el transporte, asi que el fixture usa un fallo de
    // transporte real.
    const transporte = crearTransporteDoble([falloDeTransporte('timeout'), RESPUESTA_OK])
    const { reloj, esperas } = crearRelojDoble()

    const resultado = await ejecutarPasoConReintentos(
      dependencias(transporte.puerto, reloj),
      CONTEXTO,
    )

    expect(resultado).toEqual({ ok: true, valor: { intentos: 2, respuesta: { kind: 'OK' } } })
    expect(transporte.llamadas).toHaveLength(2)
    expect(esperas).toEqual([10])
  })

  it('agota los intentos y devuelve el ultimo fallo: maxIntentos son intentos totales', async () => {
    // maxIntentos 3 = 3 llamadas al transporte, no 1 + 3. El legacy no miraba ni
    // el backoff (con baseBackoffMs 1 era invisible) ni cual era el error
    // devuelto: los dos se afirman aca.
    const plan = [
      falloDeTransporte('timeout 1'),
      falloDeTransporte('timeout 2'),
      falloDeTransporte('timeout 3'),
    ]
    const transporte = crearTransporteDoble(plan)
    const { reloj, esperas } = crearRelojDoble()

    const resultado = await ejecutarPasoConReintentos(
      dependencias(transporte.puerto, reloj),
      CONTEXTO,
    )

    expect(resultado).toEqual({
      ok: false,
      error: {
        codigo: 'REINTENTOS_AGOTADOS',
        intentos: 3,
        ultimoFallo: { tipo: 'TRANSPORTE', codigo: 'ETIMEDOUT', mensaje: 'timeout 3' },
      },
    })
    expect(transporte.llamadas).toHaveLength(3)
    // baseMs * 2^(intento - 1) entre intentos: 10 y 20. Sin espera despues del ultimo.
    expect(esperas).toEqual([10, 20])
  })

  it('reintenta un error del PLC distinto de 99 y completa en el segundo intento', async () => {
    // La regla "codigoError distinto de 99 es reintentable" es dominio puro y su
    // assert vive en plcProtocol; aca queda el assert operativo del agente.
    const errorReintentable: RespuestaDePlan = {
      ok: false,
      error: { tipo: 'PLC_ERROR', codigoError: 1, mensaje: 'Carro trabado avanzando', fatal: false },
    }
    const transporte = crearTransporteDoble([errorReintentable, RESPUESTA_OK])
    const { reloj } = crearRelojDoble()

    const resultado = await ejecutarPasoConReintentos(
      dependencias(transporte.puerto, reloj),
      CONTEXTO,
    )

    expect(resultado).toEqual({ ok: true, valor: { intentos: 2, respuesta: { kind: 'OK' } } })
    expect(transporte.llamadas).toHaveLength(2)
  })

  it('no reintenta el error 99 del PLC y propaga su mensaje tal cual', async () => {
    const errorFatal: RespuestaDePlan = {
      ok: false,
      error: { tipo: 'PLC_ERROR', codigoError: 99, mensaje: 'No logro recuperarse', fatal: true },
    }
    const transporte = crearTransporteDoble([errorFatal])
    const { reloj, esperas } = crearRelojDoble()

    const resultado = await ejecutarPasoConReintentos(
      dependencias(transporte.puerto, reloj),
      CONTEXTO,
    )

    expect(resultado).toEqual({
      ok: false,
      error: {
        codigo: 'FALLO_FATAL',
        intentos: 1,
        fallo: { tipo: 'PLC_ERROR', codigoError: 99, mensaje: 'No logro recuperarse', fatal: true },
      },
    })
    expect(transporte.llamadas).toHaveLength(1)
    expect(esperas).toEqual([])
  })
})
