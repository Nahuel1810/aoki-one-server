// RF07, segunda mitad — el ciclo del robot ante un PUT con devoluciones de mas.
//
// DIVERGENCIA CORREGIDA contra el servidor de produccion. El legacy marca la
// orden `logicalReturnOnly` cuando `getLogicalPickStackDepth(slot) > 1`
// (`src/core/orchestrator/OrchestratorService.js:248-253`) y la termina DONE sin
// un solo paso fisico (misma clase, lineas 480-495). El sistema nuevo tenia el
// contador en el dominio pero el loop no lo miraba: TODO PUT bajaba el cajon.
//
// El escenario es el que rompe en planta: dos pedidos del mismo cajon. El
// segundo PICK termina DONE sin maniobra y deja pendingReturns en 2. Si el
// primer PUT devuelve el cajon fisicamente, el segundo pedido queda sin atender
// y el operario va al slot a buscar un cajon que ya no esta.
//
// Corre contra la base SQLite de verdad (en memoria) y contra el transporte
// doblado: lo que se afirma es que el transporte NO se toca en el primer PUT y
// SI en el segundo, mas el valor exacto del contador despues de cada uno.

import { describe, expect, it } from 'vitest'

import { LOGGER_SILENCIOSO } from '@aoki-one/domain'
import type { Result, TipoDispositivo } from '@aoki-one/domain'

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
/** Slot de pickeo donde el cajon esta apoyado. */
const SLOT = '3X02AE1'
/** Ubicacion de guardado a la que el cajon tiene que volver. */
const ORIGEN_DEL_CAJON = '3X04AE1'

const RELOJ: Reloj = { ahoraMs: () => 2_000, dormir: () => Promise.resolve() }

interface LlamadaAlTransporte {
  readonly dispositivo: TipoDispositivo
  readonly comando: number
}

interface Banco {
  readonly repositorios: RepositoriosDelAgente
  readonly dependencias: DependenciasDelOrquestador
  readonly llamadas: readonly LlamadaAlTransporte[]
  readonly cerrar: () => void
}

async function crearBanco(pendingReturns: number): Promise<Banco> {
  const base = abrirBase(':memory:')
  const repositorios = crearRepositorios(base)
  const llamadas: LlamadaAlTransporte[] = []
  // Ids inyectados y unicos: la tabla de eventos tiene PRIMARY KEY y un id fijo
  // la rompe al segundo evento.
  let siguienteId = 0

  const transporte: PuertoDeTransporte = {
    ejecutarComandoDePaso: (
      _robotId: string,
      dispositivo: TipoDispositivo,
      pedido: PedidoDeComando,
    ) => {
      llamadas.push({ dispositivo, comando: pedido.comando })
      const ok: Result<RespuestaUtilPlc, FalloDeEjecucion> = { ok: true, valor: { kind: 'OK' } }
      return Promise.resolve(ok)
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
  // El cajon ya esta apoyado con `pendingReturns` devoluciones pendientes: es lo
  // que deja un PICK seguido de otro PICK del mismo cajon.
  await repositorios.slots.guardarEstado(ROBOT_ID, SLOT, {
    estado: 'OCUPADO',
    contenido: { cajon: { id: 'caja-1', ubicacionDeOrigen: ORIGEN_DEL_CAJON }, pendingReturns },
  })

  return {
    repositorios,
    llamadas,
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

function ordenDePut(id: string, creadaEn: number): Orden {
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
    creadaEn,
    iniciadaEn: null,
    finalizadaEn: null,
  }
}

describe('ciclo del robot ante un PUT con devoluciones pendientes (RF07)', () => {
  it('con pendingReturns en 2 termina DONE sin mover el robot y deja el contador en 1', async () => {
    const banco = await crearBanco(2)
    try {
      await banco.repositorios.ordenes.crear(ordenDePut('o-put-1', 1_000))

      const resultado = await ejecutarCicloDeRobot(banco.dependencias, ROBOT_ID)

      expect(resultado).toEqual({
        tipo: 'ORDEN_TERMINADA',
        ordenId: 'o-put-1',
        estadoFinal: 'DONE',
        huboManiobra: false,
      })
      // Ni un solo comando al PLC: el cajon no se movio.
      expect(banco.llamadas).toEqual([])

      const slot = await banco.repositorios.slots.buscar(ROBOT_ID, SLOT)
      // El slot sigue OCUPADO con el MISMO cajon: lo unico que bajo es el contador.
      expect(slot?.estado).toEqual({
        estado: 'OCUPADO',
        contenido: {
          cajon: { id: 'caja-1', ubicacionDeOrigen: ORIGEN_DEL_CAJON },
          pendingReturns: 1,
        },
      })

      const orden = await banco.repositorios.ordenes.buscarPorId('o-put-1')
      expect(orden?.estado).toBe('DONE')
      expect(orden?.slotLocationCode).toBe(SLOT)
      // Ningun paso fisico se registro.
      expect(orden?.currentStepIndex).toBe(0)
    } finally {
      banco.cerrar()
    }
  })

  it('con pendingReturns en 1 ejecuta la devolucion fisica completa y libera el slot', async () => {
    const banco = await crearBanco(1)
    try {
      await banco.repositorios.ordenes.crear(ordenDePut('o-put-2', 1_000))

      const resultado = await ejecutarCicloDeRobot(banco.dependencias, ROBOT_ID)

      expect(resultado).toEqual({
        tipo: 'ORDEN_TERMINADA',
        ordenId: 'o-put-2',
        estadoFinal: 'DONE',
        huboManiobra: true,
      })

      // Los cinco pasos de RF04, con los comandos de planta:
      //   HOMING = INIT del carro (41000)
      //   ELEVADOR al nivel del origen: slot 3X02AE1 -> nivel E = 5 -> 105
      //   CARRO_BUSCA sobre el slot: posicion 1, parante ceil(02/2)=01,
      //     ladoBit 0 (modulo par), accionBit 1 (traer) -> 10101
      //   ELEVADOR al nivel del destino: 3X04AE1 -> nivel E = 5 -> 105
      //   CARRO_DEVUELVE sobre el destino: posicion 1, parante ceil(04/2)=02,
      //     ladoBit 0, accionBit 0 (dejar) -> 10200
      expect(banco.llamadas).toEqual([
        { dispositivo: 'CARRO', comando: 41000 },
        { dispositivo: 'ELEVADOR', comando: 105 },
        { dispositivo: 'CARRO', comando: 10101 },
        { dispositivo: 'ELEVADOR', comando: 105 },
        { dispositivo: 'CARRO', comando: 10200 },
      ])

      const slot = await banco.repositorios.slots.buscar(ROBOT_ID, SLOT)
      // El ultimo PUT si devuelve: el slot queda libre para el proximo PICK.
      expect(slot?.estado).toEqual({ estado: 'LIBRE' })

      const orden = await banco.repositorios.ordenes.buscarPorId('o-put-2')
      expect(orden?.estado).toBe('DONE')
      // El destino salio del cajon en libros, no del pedido (que venia en null).
      expect(orden?.targetLocation).toBe(ORIGEN_DEL_CAJON)
      expect(orden?.currentStepIndex).toBe(5)
    } finally {
      banco.cerrar()
    }
  })

  it('dos PUT seguidos con el contador en 2: el primero no mueve nada y el segundo devuelve', async () => {
    const banco = await crearBanco(2)
    try {
      await banco.repositorios.ordenes.crear(ordenDePut('o-put-a', 1_000))
      await banco.repositorios.ordenes.crear(ordenDePut('o-put-b', 1_100))

      const primero = await ejecutarCicloDeRobot(banco.dependencias, ROBOT_ID)
      expect(primero).toMatchObject({ ordenId: 'o-put-a', huboManiobra: false })
      expect(banco.llamadas).toHaveLength(0)

      const segundo = await ejecutarCicloDeRobot(banco.dependencias, ROBOT_ID)
      expect(segundo).toMatchObject({
        ordenId: 'o-put-b',
        estadoFinal: 'DONE',
        huboManiobra: true,
      })
      // Recien el ULTIMO PUT baja el cajon: cinco pasos, ni antes ni dos veces.
      expect(banco.llamadas).toHaveLength(5)

      const slot = await banco.repositorios.slots.buscar(ROBOT_ID, SLOT)
      expect(slot?.estado).toEqual({ estado: 'LIBRE' })
    } finally {
      banco.cerrar()
    }
  })
})
