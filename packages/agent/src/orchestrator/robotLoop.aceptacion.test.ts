// Portado de tests/unit/orchestrator.test.js (T02).
//
// TRADUCIDO. El legacy ("marca DONE si el cajon ya fue identificado para el mismo
// origen") montaba el escenario a mano y llamaba `processOrder` directo; aca es un
// ciclo del loop del robot, que es quien decide si hay maniobra.
//
// Se agrega el assert que el legacy NO hacia y que es el punto entero de RF07: el
// refcount de devoluciones (hoy `logicalPickStackDepth`, ahora `pendingReturns`)
// pasa de 1 a 2. Sin ese assert el test pasa con el contador roto y despues el
// primer PUT devuelve el cajon dejando el segundo pedido sin atender.

import { describe, it, expect } from 'vitest'

import type { EstadoSlot, Result, TipoDispositivo } from '@aoki-one/domain'

import type {
  DeviceRepository,
  ErrorDeOrden,
  ErrorDeRobot,
  ErrorDeSlot,
  Evento,
  EventRepository,
  Orden,
  OrderRepository,
  OrderStepRepository,
  PasoPersistido,
  RepositoriosDelAgente,
  Robot,
  RobotRepository,
  SlotDeRobot,
  SlotRepository,
} from '../persistence/index.js'
import type { Reloj } from '../reloj.js'
import type { PedidoDeComando } from '../transport/stepHandshake.js'
import { ejecutarCicloDeRobot } from './robotLoop.js'
import type { DependenciasDelOrquestador, PuertoDeTransporte } from './ports.js'
import { calcularTiempos } from '../persistence/metricsRepository.js'
import type { MetricsRepository } from '../persistence/metricsRepository.js'

function sinDoble(nombre: string): () => never {
  return () => {
    throw new Error(`doble no configurado: ${nombre}`)
  }
}

const SITE_ID = 'sucursal-1'

const ORDEN_PICK: Orden = {
  id: 'o-1',
  siteId: SITE_ID,
  robotId: '1',
  externalOrderId: null,
  tipo: 'PICK',
  origen: 'MANUAL',
  estado: 'PENDING',
  locationCode: '3X04AE1',
  targetLocation: null,
  slotLocationCode: null,
  currentStepIndex: 0,
  waitingForSlot: false,
  errorReason: null,
  creadaEn: 1_000,
  iniciadaEn: null,
  finalizadaEn: null,
}

/** El cajon pedido YA esta apoyado en la zona de pickeo, con una devolucion pendiente. */
const CAJON_YA_IDENTIFICADO: EstadoSlot = {
  estado: 'OCUPADO',
  contenido: {
    cajon: { id: 'existing', ubicacionDeOrigen: '3X04AE1' },
    pendingReturns: 1,
  },
}

interface LlamadaDeTransporte {
  readonly robotId: string
  readonly dispositivo: TipoDispositivo
  readonly pedido: PedidoDeComando
}

interface Doble {
  readonly repositorios: RepositoriosDelAgente
  readonly transporte: PuertoDeTransporte
  readonly llamadasAlTransporte: readonly LlamadaDeTransporte[]
  readonly ordenes: Map<string, Orden>
  readonly robots: Map<string, Robot>
  readonly slots: Map<string, SlotDeRobot>
}

function crearDoble(): Doble {
  const ordenesPorId = new Map<string, Orden>([[ORDEN_PICK.id, ORDEN_PICK]])
  const robotsPorId = new Map<string, Robot>([
    [
      '1',
      {
        id: '1',
        siteId: SITE_ID,
        estanteriaCode: '3X',
        habilitado: true,
        estado: 'IDLE',
        ordenActivaId: null,
      },
    ],
  ])
  const slotsPorCodigo = new Map<string, SlotDeRobot>([
    [
      '3X02AE1',
      {
        robotId: '1',
        locationCode: '3X02AE1',
        lado: 'RIGHT',
        estado: CAJON_YA_IDENTIFICADO,
        actualizadoEn: 900,
      },
    ],
  ])
  const eventos: Evento[] = []
  const pasosRegistrados: PasoPersistido[] = []
  const llamadasAlTransporte: LlamadaDeTransporte[] = []

  const ordenes: OrderRepository = {
    crear: sinDoble('ordenes.crear'),
    buscarPorId: (ordenId) => Promise.resolve(ordenesPorId.get(ordenId)),
    buscarPorExternalOrderId: () => Promise.resolve(undefined),
    listar: (filtro) =>
      Promise.resolve(
        [...ordenesPorId.values()].filter(
          (orden) =>
            (filtro.robotId === undefined || orden.robotId === filtro.robotId) &&
            (filtro.estados === undefined || filtro.estados.includes(orden.estado)),
        ),
      ),
    actualizar: (ordenId, cambios) => {
      const actual = ordenesPorId.get(ordenId)
      if (actual === undefined) {
        const fallo: Result<Orden, ErrorDeOrden> = {
          ok: false,
          error: { codigo: 'ORDEN_INEXISTENTE', ordenId },
        }
        return Promise.resolve(fallo)
      }
      const actualizada: Orden = { ...actual, ...cambios }
      ordenesPorId.set(ordenId, actualizada)
      const ok: Result<Orden, ErrorDeOrden> = { ok: true, valor: actualizada }
      return Promise.resolve(ok)
    },
  }

  const robots: RobotRepository = {
    guardar: sinDoble('robots.guardar'),
    buscarPorId: (robotId) => Promise.resolve(robotsPorId.get(robotId)),
    buscarPorEstanteria: () => Promise.resolve(robotsPorId.get('1')),
    listar: () => Promise.resolve([...robotsPorId.values()]),
    fijarOrdenActiva: (robotId, ordenId) => {
      const actual = robotsPorId.get(robotId)
      if (actual === undefined) {
        const fallo: Result<Robot, ErrorDeRobot> = {
          ok: false,
          error: { codigo: 'ROBOT_INEXISTENTE', robotId },
        }
        return Promise.resolve(fallo)
      }
      const actualizado: Robot = {
        ...actual,
        ordenActivaId: ordenId,
        estado: ordenId === null ? 'IDLE' : 'BUSY',
      }
      robotsPorId.set(robotId, actualizado)
      const ok: Result<Robot, ErrorDeRobot> = { ok: true, valor: actualizado }
      return Promise.resolve(ok)
    },
  }

  const slots: SlotRepository = {
    listarPorRobot: () => Promise.resolve([...slotsPorCodigo.values()]),
    buscar: (_robotId, locationCode) => Promise.resolve(slotsPorCodigo.get(locationCode)),
    buscarPorCajonDeOrigen: (_robotId, ubicacionDeOrigen) =>
      Promise.resolve(
        [...slotsPorCodigo.values()].find((slot) => {
          const estado = slot.estado
          return (
            (estado.estado === 'OCUPADO' || estado.estado === 'DEVOLVIENDO') &&
            estado.contenido !== null &&
            estado.contenido.cajon.ubicacionDeOrigen === ubicacionDeOrigen
          )
        }),
      ),
    guardarEstado: (robotId, locationCode, estado) => {
      const actual = slotsPorCodigo.get(locationCode)
      if (actual === undefined) {
        const fallo: Result<SlotDeRobot, ErrorDeSlot> = {
          ok: false,
          error: { codigo: 'SLOT_INEXISTENTE', locationCode },
        }
        return Promise.resolve(fallo)
      }
      const actualizado: SlotDeRobot = { ...actual, robotId, estado, actualizadoEn: 2_000 }
      slotsPorCodigo.set(locationCode, actualizado)
      const ok: Result<SlotDeRobot, ErrorDeSlot> = { ok: true, valor: actualizado }
      return Promise.resolve(ok)
    },
    sembrarZonaDePickeo: sinDoble('slots.sembrarZonaDePickeo'),
  }

  const repositorioDeEventos: EventRepository = {
    registrar: (evento) => {
      eventos.push(evento)
      return Promise.resolve(evento)
    },
    listar: () => Promise.resolve(eventos),
  }

  const pasos: OrderStepRepository = {
    registrar: (paso) => {
      pasosRegistrados.push(paso)
      return Promise.resolve(paso)
    },
    actualizar: sinDoble('pasos.actualizar'),
    listarPorOrden: () => Promise.resolve(pasosRegistrados),
  }

  const dispositivos: DeviceRepository = {
    registrar: sinDoble('dispositivos.registrar'),
    buscar: sinDoble('dispositivos.buscar'),
    listarPorRobot: () => Promise.resolve([]),
  }

  const transporte: PuertoDeTransporte = {
    ejecutarComandoDePaso: (robotId, dispositivo, pedido) => {
      llamadasAlTransporte.push({ robotId, dispositivo, pedido })
      throw new Error('no deberia haber maniobra fisica: el cajon ya estaba en el slot')
    },
    resetearMessageIn: sinDoble('resetearMessageIn'),
    leerRegistros: sinDoble('leerRegistros'),
  }

  // La metrica se registra al terminar la orden (RF24). El doble la acepta y la
  // guarda: los tests de este archivo no la afirman, pero sin el repositorio el
  // ciclo no compila.
  const metricas: MetricsRepository = {
    registrar: (entrada) =>
      Promise.resolve({
        ordenId: entrada.ordenId,
        siteId: entrada.siteId,
        origen: entrada.origen,
        tipo: entrada.tipo,
        locationCode: entrada.locationCode,
        ...calcularTiempos(entrada),
        estado: entrada.estado,
        creadaEn: entrada.creadaEn,
        finalizadaEn: entrada.finalizadaEn,
      }),
    reporte: sinDoble('metricas.reporte'),
  }

  return {
    repositorios: { robots, ordenes, pasos, slots, eventos: repositorioDeEventos, dispositivos, metricas },
    transporte,
    llamadasAlTransporte,
    ordenes: ordenesPorId,
    robots: robotsPorId,
    slots: slotsPorCodigo,
  }
}

const RELOJ: Reloj = {
  ahoraMs: () => 2_000,
  dormir: () => Promise.resolve(),
}

/** RF35: el prefijo del id externo local sale de la identidad del agente. */
const AGENT_ID = 'AG-TEST'

function dependencias(doble: Doble): DependenciasDelOrquestador {
  return {
    transporte: doble.transporte,
    reloj: RELOJ,
    politica: { maxIntentos: 3, baseBackoffMs: 10 },
    repositorios: doble.repositorios,
    siteId: SITE_ID,
    agentId: AGENT_ID,
    generarId: () => 'ev-1',
  }
}

describe('ciclo del loop de un robot (portado de orchestrator.test.js)', () => {
  it('termina el PICK en DONE sin maniobra si el cajon ya esta en un slot e incrementa pendingReturns', async () => {
    const doble = crearDoble()

    const resultado = await ejecutarCicloDeRobot(dependencias(doble), '1')

    expect(resultado).toEqual({
      tipo: 'ORDEN_TERMINADA',
      ordenId: 'o-1',
      estadoFinal: 'DONE',
      huboManiobra: false,
    })

    const terminada = doble.ordenes.get('o-1')
    expect(terminada?.estado).toBe('DONE')
    expect(terminada?.waitingForSlot).toBe(false)

    // El robot queda libre: la orden no lo deja trabado.
    expect(doble.robots.get('1')?.ordenActivaId).toBeNull()
    expect(doble.robots.get('1')?.estado).toBe('IDLE')

    // RF07: el segundo pedido del mismo cajon exige una segunda devolucion.
    // El legacy no lo afirmaba y ese es su defecto mas grave.
    expect(doble.slots.get('3X02AE1')?.estado).toEqual({
      estado: 'OCUPADO',
      contenido: {
        cajon: { id: 'existing', ubicacionDeOrigen: '3X04AE1' },
        pendingReturns: 2,
      },
    })

    // Sin maniobra fisica: el robot no se movio.
    expect(doble.llamadasAlTransporte).toHaveLength(0)
  })

  // Portado de tests/unit/queueManager.test.js :: "QueueManager permite una orden
  // activa por robot" — RF08, RF23.
  //
  // TRADUCIDO. El legacy era tautologico: llamaba setActive y despues isRobotBusy,
  // setter y getter del mismo Map, sin ninguna regla en el medio, y el QueueManager
  // no imponia la invariante en ningun lado (dequeueNext ni miraba activeOrderId).
  // La invariante se afirma donde realmente vive: el loop no arranca la siguiente
  // orden si el robot ya tiene una en curso. Y la orden activa deja de vivir en un
  // Map para ser robots.current_order_id, asi que el assert va contra el
  // repositorio y la llamada es async.
  it('no arranca la siguiente orden si el robot ya tiene una en curso', async () => {
    const doble = crearDoble()
    const robot = doble.robots.get('1')
    if (robot === undefined) {
      throw new Error('el doble tiene que traer el robot 1')
    }
    doble.robots.set('1', { ...robot, estado: 'BUSY', ordenActivaId: 'o-en-curso' })

    const resultado = await ejecutarCicloDeRobot(dependencias(doble), '1')

    expect(resultado).toEqual({ tipo: 'ROBOT_OCUPADO', ordenActivaId: 'o-en-curso' })

    // La orden pendiente no se toca ni pierde su lugar: sigue PENDING.
    expect(doble.ordenes.get('o-1')?.estado).toBe('PENDING')

    // Y sobre todo: no se despacha una segunda maniobra fisica al mismo robot.
    expect(doble.llamadasAlTransporte).toHaveLength(0)
    expect(doble.robots.get('1')?.ordenActivaId).toBe('o-en-curso')
  })
})
