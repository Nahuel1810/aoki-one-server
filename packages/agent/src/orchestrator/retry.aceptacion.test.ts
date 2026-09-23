// Portado de tests/unit/orchestrator.test.js (T02).
//
// TRADUCIDO. El legacy ("retryOrder resetea messageIn del robot antes de reencolar")
// definia su propio fake inline y afirmaba el replay completo desde HOMING mas el
// reset del registro, que es conocimiento de planta: sin limpiar messageIn el PLC
// arranca el reintento con el comando anterior colgado.
//
// Se agrega el assert que RF13 exige y el legacy no hacia: el slot CONSERVA su
// estado (RESERVADO si fallo un PICK) y queda utilizable. El legacy mandaba el slot
// a ERROR al fallar el paso y el retry no lo desbloqueaba, asi que el slot quedaba
// inutilizable para siempre; portar el test tal cual era portar ese bug.

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
import type { FalloDeEjecucion } from '../transport/errorClassification.js'
import type { DependenciasDelOrquestador, PuertoDeTransporte } from './ports.js'
import { reintentarOrden } from './retry.js'
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

const ORDEN_EN_ERROR: Orden = {
  id: 'o-1',
  siteId: SITE_ID,
  robotId: '1',
  externalOrderId: null,
  tipo: 'PICK',
  origen: 'MANUAL',
  estado: 'ERROR',
  locationCode: '3X04AA3',
  targetLocation: null,
  slotLocationCode: '3X02AE1',
  currentStepIndex: 3,
  waitingForSlot: false,
  errorReason: 'forced',
  creadaEn: 1_000,
  iniciadaEn: 1_500,
  finalizadaEn: null,
}

/** El slot que el PICK ya habia tomado. Tiene que seguir siendo suyo tras el retry. */
const SLOT_RESERVADO: EstadoSlot = { estado: 'RESERVADO', ordenId: 'o-1', contenido: null }

const ROBOT: Robot = {
  id: '1',
  siteId: SITE_ID,
  estanteriaCode: '3X',
  habilitado: true,
  estado: 'IDLE',
  ordenActivaId: null,
}

interface Doble {
  readonly repositorios: RepositoriosDelAgente
  readonly transporte: PuertoDeTransporte
  readonly secuencia: readonly string[]
  readonly ordenes: Map<string, Orden>
  readonly slots: Map<string, SlotDeRobot>
}

function crearDoble(): Doble {
  const ordenesPorId = new Map<string, Orden>([[ORDEN_EN_ERROR.id, ORDEN_EN_ERROR]])
  const slotsPorCodigo = new Map<string, SlotDeRobot>([
    [
      '3X02AE1',
      {
        robotId: '1',
        locationCode: '3X02AE1',
        lado: 'RIGHT',
        estado: SLOT_RESERVADO,
        actualizadoEn: 900,
      },
    ],
  ])
  const eventos: Evento[] = []
  // Para poder afirmar el ORDEN: primero el reset del registro, despues la vuelta a la cola.
  const secuencia: string[] = []

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
      if (cambios.estado === 'PENDING') {
        secuencia.push(`orden-a-PENDING:${ordenId}`)
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
    buscarPorCajonDeOrigen: () => Promise.resolve(undefined),
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

  const transporte: PuertoDeTransporte = {
    ejecutarComandoDePaso: sinDoble('ejecutarComandoDePaso'),
    resetearMessageIn: (robotId) => {
      secuencia.push(`reset-messageIn:${robotId}`)
      const ok: Result<void, FalloDeEjecucion> = { ok: true, valor: undefined }
      return Promise.resolve(ok)
    },
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
    secuencia,
    ordenes: ordenesPorId,
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

describe('reintento de una orden en ERROR (portado de orchestrator.test.js)', () => {
  it('resetea messageIn antes de reencolar y replaya la orden entera desde HOMING', async () => {
    const doble = crearDoble()

    const reintentada = exigirOk(await reintentarOrden(dependencias(doble), 'o-1'))

    expect(reintentada.estado).toBe('PENDING')
    expect(reintentada.currentStepIndex).toBe(0)
    expect(reintentada.errorReason).toBeNull()

    // El reset del registro va PRIMERO: si no, el PLC arranca el reintento con el
    // comando anterior colgado.
    expect(doble.secuencia).toEqual(['reset-messageIn:1', 'orden-a-PENDING:o-1'])

    // La orden vuelve a estar disponible para el loop del robot (cola por estado).
    expect(doble.ordenes.get('o-1')?.estado).toBe('PENDING')

    // RF13: el slot conserva su estado y queda utilizable tras el retry.
    expect(doble.slots.get('3X02AE1')?.estado).toEqual(SLOT_RESERVADO)
  })
})
