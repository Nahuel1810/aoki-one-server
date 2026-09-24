// Portado de tests/unit/orchestrator.test.js (T02).
//
// Dos tests del OrchestratorService legacy sobre el slot de un PICK.
//
// "asigna slot automaticamente en PICK" es TRADUCIDO y se parte: cual slot gana es
// una funcion pura del dominio (`rankearSlotsParaPick`, RF05) y su test vive en
// slotSelection; aca queda la mitad del agente, que es que la orden quede con su
// slotLocationCode y el slot pase a RESERVADO.
//
// "deja la orden en espera si el pedido no coincide con los slots ocupados" es
// ADAPTADO y ademas estaba MAL NOMBRADO: no probaba ninguna coincidencia, probaba
// que sin ningun slot LIBRE la orden espera. Y el assert cambia: el legacy hacia
// clearActive + enqueue, o sea que la orden perdia su turno cada vez que esperaba;
// RF10 exige que espere SIN PERDER SU LUGAR, asi que se afirma que conserva su
// `creadaEn` y que no se reencola.

import { describe, it, expect } from 'vitest'

import type { EstadoSlot, Result } from '@aoki-one/domain'

import type {
  DeviceRepository,
  ErrorDeOrden,
  ErrorDeSlot,
  Evento,
  EventRepository,
  Orden,
  OrderRepository,
  OrderStepRepository,
  RepositoriosDelAgente,
  Robot,
  RobotRepository,
  SlotDeRobot,
  SlotRepository,
} from '../persistence/index.js'
import type { Reloj } from '../reloj.js'
import type { DependenciasDelOrquestador, PuertoDeTransporte } from './ports.js'
import { resolverSlotDeOrden } from './slotWait.js'
import { calcularTiempos } from '../persistence/metricsRepository.js'
import type { MetricsRepository } from '../persistence/metricsRepository.js'

function sinDoble(nombre: string): () => never {
  return () => {
    throw new Error(`doble no configurado: ${nombre}`)
  }
}

/** Abre la rama ok del Result sin castear: si llego error, el test falla aca. */
function exigirOk<T, E>(resultado: Result<T, E>): T {
  if (!resultado.ok) {
    throw new Error(`se esperaba ok y llego error: ${JSON.stringify(resultado.error)}`)
  }
  return resultado.valor
}

const SITE_ID = 'sucursal-1'

const ROBOT: Robot = {
  id: '1',
  siteId: SITE_ID,
  estanteriaCode: '3X',
  habilitado: true,
  estado: 'BUSY',
  ordenActivaId: 'o-1',
}

const LIBRE: EstadoSlot = { estado: 'LIBRE' }

/** Cajon de OTRO origen: la zona queda sin ningun slot LIBRE. */
const OCUPADO_POR_OTRO: EstadoSlot = {
  estado: 'OCUPADO',
  contenido: {
    cajon: { id: 'existing', ubicacionDeOrigen: '8X04AE1' },
    pendingReturns: 1,
  },
}

const ORDEN_PICK: Orden = {
  id: 'o-1',
  siteId: SITE_ID,
  robotId: '1',
  externalOrderId: null,
  tipo: 'PICK',
  origen: 'MANUAL',
  estado: 'IN_PROGRESS',
  locationCode: '3X04AE1',
  targetLocation: null,
  slotLocationCode: null,
  currentStepIndex: 0,
  waitingForSlot: false,
  errorReason: null,
  creadaEn: 1_000,
  iniciadaEn: 1_500,
  finalizadaEn: null,
}

interface Doble {
  readonly repositorios: RepositoriosDelAgente
  readonly ordenes: Map<string, Orden>
  readonly slots: Map<string, SlotDeRobot>
}

function crearDoble(slotsIniciales: readonly SlotDeRobot[]): Doble {
  const ordenesPorId = new Map<string, Orden>([[ORDEN_PICK.id, ORDEN_PICK]])
  const slotsPorCodigo = new Map(slotsIniciales.map((slot) => [slot.locationCode, slot]))
  const eventos: Evento[] = []

  const ordenes: OrderRepository = {
    crear: sinDoble('ordenes.crear'),
    buscarPorId: (ordenId) => Promise.resolve(ordenesPorId.get(ordenId)),
    buscarPorExternalOrderId: () => Promise.resolve(undefined),
    listar: () => Promise.resolve([...ordenesPorId.values()]),
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

  const robots: RobotRepository = {
    guardar: sinDoble('robots.guardar'),
    buscarPorId: (robotId) => Promise.resolve(robotId === ROBOT.id ? ROBOT : undefined),
    buscarPorEstanteria: () => Promise.resolve(ROBOT),
    listar: () => Promise.resolve([ROBOT]),
    fijarOrdenActiva: sinDoble('robots.fijarOrdenActiva'),
  }

  const repositorioDeEventos: EventRepository = {
    registrar: (evento) => {
      eventos.push(evento)
      return Promise.resolve(evento)
    },
    listar: () => Promise.resolve(eventos),
  }

  const pasos: OrderStepRepository = {
    registrar: sinDoble('pasos.registrar'),
    actualizar: sinDoble('pasos.actualizar'),
    listarPorOrden: () => Promise.resolve([]),
  }

  const dispositivos: DeviceRepository = {
    registrar: sinDoble('dispositivos.registrar'),
    buscar: sinDoble('dispositivos.buscar'),
    listarPorRobot: () => Promise.resolve([]),
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
    ordenes: ordenesPorId,
    slots: slotsPorCodigo,
  }
}

function slotDePickeo(locationCode: string, estado: EstadoSlot): SlotDeRobot {
  return { robotId: '1', locationCode, lado: 'RIGHT', estado, actualizadoEn: 900 }
}

const TRANSPORTE_SIN_USO: PuertoDeTransporte = {
  ejecutarComandoDePaso: sinDoble('ejecutarComandoDePaso'),
  resetearMessageIn: sinDoble('resetearMessageIn'),
  leerRegistros: sinDoble('leerRegistros'),
}

const RELOJ: Reloj = {
  ahoraMs: () => 2_000,
  dormir: () => Promise.resolve(),
}

function dependencias(repositorios: RepositoriosDelAgente): DependenciasDelOrquestador {
  return {
    transporte: TRANSPORTE_SIN_USO,
    reloj: RELOJ,
    politica: { maxIntentos: 3, baseBackoffMs: 10 },
    repositorios,
    siteId: SITE_ID,
    generarId: () => 'ev-1',
  }
}

describe('resolucion del slot de una orden (portado de orchestrator.test.js)', () => {
  it('asigna el slot mas cercano a un PICK y lo deja RESERVADO para esa orden', async () => {
    const doble = crearDoble([
      slotDePickeo('3X02AE3', LIBRE),
      slotDePickeo('3X02AE2', LIBRE),
      slotDePickeo('3X02AE1', LIBRE),
    ])

    const resolucion = exigirOk(
      await resolverSlotDeOrden(dependencias(doble.repositorios), ORDEN_PICK),
    )

    // Mismo nivel y mismo modulo que el origen 3X04AE1: desempata la posicion
    // menor, que es ABSOLUTA (1 antes que 2 antes que 3).
    expect(resolucion).toEqual({ tipo: 'SLOT_ASIGNADO', slotLocationCode: '3X02AE1' })
    expect(doble.ordenes.get('o-1')?.slotLocationCode).toBe('3X02AE1')
    expect(doble.slots.get('3X02AE1')?.estado).toEqual({
      estado: 'RESERVADO',
      ordenId: 'o-1',
      contenido: null,
    })
  })

  it('deja el PICK esperando sin perder su lugar cuando no hay ningun slot LIBRE de ese lado', async () => {
    const doble = crearDoble([slotDePickeo('3X02AE1', OCUPADO_POR_OTRO)])

    const resolucion = exigirOk(
      await resolverSlotDeOrden(dependencias(doble.repositorios), ORDEN_PICK),
    )

    expect(resolucion).toEqual({
      tipo: 'EN_ESPERA',
      lado: 'RIGHT',
      motivo: { tipo: 'SIN_SLOT_LIBRE' },
    })

    const enEspera = doble.ordenes.get('o-1')
    expect(enEspera?.estado).toBe('PENDING')
    expect(enEspera?.waitingForSlot).toBe(true)
    expect(enEspera?.slotLocationCode).toBeNull()
    // RF10: espera sin perder su lugar. El legacy la reencolaba al final.
    expect(enEspera?.creadaEn).toBe(1_000)
    // El slot ocupado por otro cajon queda como estaba.
    expect(doble.slots.get('3X02AE1')?.estado).toEqual(OCUPADO_POR_OTRO)
  })
})
