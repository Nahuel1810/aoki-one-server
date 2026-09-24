// RF06 — La cadena de transiciones de un PUT cierra, y un rechazo no se traga.
//
// DIVERGENCIA CORREGIDA. El slot nunca pasaba a DEVOLVIENDO: la maniobra emitia
// INICIAR_DEVOLUCION sobre un slot OCUPADO —que la maquina rechaza, porque antes
// va RESERVAR_PARA_PUT— y el agente ignoraba el rechazo. El evento
// RESERVAR_PARA_PUT existia en el dominio, con tests, y no lo emitia NADIE.
//
// En planta: mientras el robot se lleva el cajon, el slot seguia figurando
// OCUPADO con ese cajon en libros, asi que un PICK nuevo del mismo cajon entraba
// por el camino de refcount de RF07 y le decia al pickeador que su cajon estaba
// en el slot cuando ya no estaba.
//
// Se afirma leyendo el estado del slot DURANTE la maniobra, en cada comando que
// sale al PLC: es el unico momento en el que la diferencia se ve.

import { describe, expect, it } from 'vitest'

import { LOGGER_SILENCIOSO } from '@aoki-one/domain'
import type { NombreEstadoSlot, Result, TipoDispositivo } from '@aoki-one/domain'

import { abrirBase, crearRepositorios } from '../persistence/index.js'
import type { Orden, RepositoriosDelAgente } from '../persistence/index.js'
import type { Reloj } from '../reloj.js'
import type { FalloDeEjecucion } from '../transport/errorClassification.js'
import type { PedidoDeComando, RespuestaUtilPlc } from '../transport/stepHandshake.js'
import { ejecutarCicloDeRobot } from './robotLoop.js'
import type { DependenciasDelOrquestador, PuertoDeTransporte } from './ports.js'

const SITE_ID = 'sucursal-test'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'
const SLOT = '3X02AE1'
const ORIGEN_DEL_CAJON = '3X04AE1'

const RELOJ: Reloj = { ahoraMs: () => 2_000, dormir: () => Promise.resolve() }

interface Banco {
  readonly repositorios: RepositoriosDelAgente
  readonly dependencias: DependenciasDelOrquestador
  /** Estado del slot leido en cada comando que salio al PLC. */
  readonly estadosDurante: readonly NombreEstadoSlot[]
  readonly cerrar: () => void
}

/**
 * @param alComando Numero de comando en el que el doble interviene, o `null`.
 *   Se usa para simular al operario liberando el slot a mano a mitad de maniobra.
 */
async function crearBanco(alComando: number | null): Promise<Banco> {
  const base = abrirBase(':memory:')
  const repositorios = crearRepositorios(base)
  const estadosDurante: NombreEstadoSlot[] = []
  let siguienteId = 0
  let numeroDeComando = 0

  const transporte: PuertoDeTransporte = {
    ejecutarComandoDePaso: async (
      _robotId: string,
      _dispositivo: TipoDispositivo,
      _pedido: PedidoDeComando,
    ) => {
      numeroDeComando += 1
      const slot = await repositorios.slots.buscar(ROBOT_ID, SLOT)
      if (slot !== undefined) {
        estadosDurante.push(slot.estado.estado)
      }
      if (numeroDeComando === alComando) {
        // El operario libera el slot desde la tablet con la maniobra en curso.
        await repositorios.slots.guardarEstado(ROBOT_ID, SLOT, { estado: 'LIBRE' })
      }
      const ok: Result<RespuestaUtilPlc, FalloDeEjecucion> = { ok: true, valor: { kind: 'OK' } }
      return ok
    },
    resetearMessageIn: () => Promise.resolve({ ok: true, valor: undefined }),
    leerRegistros: () => {
      throw new Error('doble no configurado: leerRegistros')
    },
  }

  await repositorios.robots.guardar({
    id: ROBOT_ID,
    siteId: SITE_ID,
    estanteriaCode: ESTANTERIA,
    habilitado: true,
    estado: 'IDLE',
    ordenActivaId: null,
  })
  await repositorios.slots.sembrarZonaDePickeo(ROBOT_ID, [SLOT])
  await repositorios.slots.guardarEstado(ROBOT_ID, SLOT, {
    estado: 'OCUPADO',
    contenido: { cajon: { id: 'caja-1', ubicacionDeOrigen: ORIGEN_DEL_CAJON }, pendingReturns: 1 },
  })

  return {
    repositorios,
    estadosDurante,
    cerrar: base.cerrar,
    dependencias: {
      transporte,
      reloj: RELOJ,
      politica: { maxIntentos: 3, baseBackoffMs: 1 },
      repositorios,
      siteId: SITE_ID,
      agentId: 'AG-TEST',
      logger: LOGGER_SILENCIOSO,
      generarId: () => {
        siguienteId += 1
        return `id-${String(siguienteId)}`
      },
    },
  }
}

function ordenDePut(id: string): Orden {
  return {
    id,
    siteId: SITE_ID,
    robotId: ROBOT_ID,
    externalOrderId: id,
    tipo: 'PUT',
    origen: 'MANUAL',
    estado: 'PENDING',
    // Para un PUT el locationCode ES el slot del que sale el cajon.
    locationCode: SLOT,
    targetLocation: null,
    slotLocationCode: null,
    currentStepIndex: 0,
    waitingForSlot: false,
    errorReason: null,
    creadaEn: 1_000,
    iniciadaEn: null,
    finalizadaEn: null,
  }
}

describe('el slot de un PUT pasa por DEVOLVIENDO (RF06)', () => {
  it('mientras el robot se lleva el cajon el slot NO figura OCUPADO', async () => {
    const banco = await crearBanco(null)
    try {
      await banco.repositorios.ordenes.crear(ordenDePut('o-put'))

      const resultado = await ejecutarCicloDeRobot(banco.dependencias, ROBOT_ID)
      expect(resultado).toMatchObject({ estadoFinal: 'DONE', huboManiobra: true })

      // Los cinco comandos salieron con el slot en DEVOLVIENDO. Si siguiera
      // OCUPADO, un PICK del mismo cajon terminaria DONE sin maniobra y mandaria
      // al pickeador a un slot vacio.
      expect(banco.estadosDurante).toEqual([
        'DEVOLVIENDO',
        'DEVOLVIENDO',
        'DEVOLVIENDO',
        'DEVOLVIENDO',
        'DEVOLVIENDO',
      ])

      // Y la cadena cierra: DEVOLVIENDO -> LIBRE.
      const slot = await banco.repositorios.slots.buscar(ROBOT_ID, SLOT)
      expect(slot?.estado).toEqual({ estado: 'LIBRE' })
    } finally {
      banco.cerrar()
    }
  })

  it('un rechazo de transicion termina la orden en ERROR con el motivo, no en silencio', async () => {
    // El operario libera el slot a mano en el primer comando: cuando la maniobra
    // termina y quiere cerrar DEVOLVIENDO -> LIBRE, el slot ya esta LIBRE y la
    // maquina rechaza. Antes ese rechazo se ignoraba y la orden terminaba DONE.
    const banco = await crearBanco(1)
    try {
      await banco.repositorios.ordenes.crear(ordenDePut('o-put'))

      const resultado = await ejecutarCicloDeRobot(banco.dependencias, ROBOT_ID)

      expect(resultado).toMatchObject({ ordenId: 'o-put', estadoFinal: 'ERROR' })
      const orden = await banco.repositorios.ordenes.buscarPorId('o-put')
      expect(orden?.estado).toBe('ERROR')
      expect(orden?.errorReason).toBe('transicion de slot invalida: LIBERAR desde LIBRE')
      // El robot queda libre igual: la orden fallida no lo deja tomado.
      const robot = await banco.repositorios.robots.buscarPorId(ROBOT_ID)
      expect(robot?.ordenActivaId).toBeNull()
    } finally {
      banco.cerrar()
    }
  })
})
