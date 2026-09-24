// Portado de tests/unit/orchestrator.test.js (T02).
//
// ADAPTADO. El legacy ("no duplica orden si llega el mismo id externo") deduplicaba
// por un `id` numerico entero suelto y afirmaba `first.id === second.id` mas una
// sola entrada en la cola. Bajo RF14 la clave pasa a ser `(siteId, externalOrderId)`
// resuelta por el indice unico, y el id externo ya no tiene que ser numerico
// (RF35 lo genera prefijado por agente), asi que ese assert de tipo se cae.
// Se agrega el caso que la clave compuesta hace posible: el MISMO externalOrderId
// en otra sucursal SI crea una orden. El agente conserva su indice local aunque
// el dedupe sea del servidor: una re-entrega por lease vencido (RF28) no puede
// generar una segunda maniobra fisica.

import { describe, it, expect } from 'vitest'

import type { Result } from '@aoki-one/domain'

import type {
  ErrorDeOrden,
  Evento,
  EventRepository,
  Orden,
  OrderRepository,
  OrderStepRepository,
  RepositoriosDelAgente,
  Robot,
  RobotRepository,
  SlotRepository,
  DeviceRepository,
} from '../persistence/index.js'
import type { Reloj } from '../reloj.js'
import { admitirOrden, type PedidoDeAltaDeOrden } from './orderIntake.js'
import type { DependenciasDelOrquestador, PuertoDeTransporte } from './ports.js'
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

const AHORA_MS = 1_700_000_000_000

const ROBOT: Robot = {
  id: '1',
  siteId: 'sucursal-1',
  estanteriaCode: '3X',
  habilitado: true,
  estado: 'IDLE',
  ordenActivaId: null,
}

interface RepositoriosDoble {
  readonly repositorios: RepositoriosDelAgente
  readonly ordenesCreadas: readonly Orden[]
}

/**
 * Doble de repositorios con el indice unico `(site_id, external_order_id)` vivo:
 * el rechazo del duplicado lo produce `crear`, no una consulta previa, que es lo
 * que cierra la ventana de carrera de RF14.
 */
function crearRepositoriosDoble(): RepositoriosDoble {
  const porId = new Map<string, Orden>()
  const porClaveExterna = new Map<string, Orden>()
  const ordenesCreadas: Orden[] = []
  const eventos: Evento[] = []

  const claveExterna = (siteId: string, externalOrderId: string): string =>
    `${siteId}::${externalOrderId}`

  const ordenes: OrderRepository = {
    crear: (orden) => {
      if (orden.externalOrderId !== null) {
        const clave = claveExterna(orden.siteId, orden.externalOrderId)
        if (porClaveExterna.has(clave)) {
          const fallo: Result<Orden, ErrorDeOrden> = {
            ok: false,
            error: {
              codigo: 'EXTERNAL_ORDER_ID_DUPLICADO',
              siteId: orden.siteId,
              externalOrderId: orden.externalOrderId,
            },
          }
          return Promise.resolve(fallo)
        }
        porClaveExterna.set(clave, orden)
      }
      porId.set(orden.id, orden)
      ordenesCreadas.push(orden)
      return Promise.resolve({ ok: true, valor: orden })
    },
    buscarPorId: (ordenId) => Promise.resolve(porId.get(ordenId)),
    buscarPorExternalOrderId: (siteId, externalOrderId) =>
      Promise.resolve(porClaveExterna.get(claveExterna(siteId, externalOrderId))),
    listar: (filtro) =>
      Promise.resolve(
        [...porId.values()].filter(
          (orden) => filtro.siteId === undefined || orden.siteId === filtro.siteId,
        ),
      ),
    actualizar: sinDoble('ordenes.actualizar'),
  }

  const robots: RobotRepository = {
    guardar: sinDoble('robots.guardar'),
    buscarPorId: (robotId) => Promise.resolve(robotId === ROBOT.id ? ROBOT : undefined),
    buscarPorEstanteria: (siteId, estanteriaCode) =>
      Promise.resolve(estanteriaCode === ROBOT.estanteriaCode ? { ...ROBOT, siteId } : undefined),
    listar: () => Promise.resolve([ROBOT]),
    fijarOrdenActiva: sinDoble('robots.fijarOrdenActiva'),
  }

  const registroDeEventos: EventRepository = {
    registrar: (evento) => {
      eventos.push(evento)
      return Promise.resolve(evento)
    },
    listar: () => Promise.resolve(eventos),
  }

  const pasos: OrderStepRepository = {
    registrar: sinDoble('pasos.registrar'),
    actualizar: sinDoble('pasos.actualizar'),
    listarPorOrden: sinDoble('pasos.listarPorOrden'),
  }

  const slots: SlotRepository = {
    listarPorRobot: () => Promise.resolve([]),
    buscar: sinDoble('slots.buscar'),
    buscarPorCajonDeOrigen: () => Promise.resolve(undefined),
    guardarEstado: sinDoble('slots.guardarEstado'),
    sembrarZonaDePickeo: sinDoble('slots.sembrarZonaDePickeo'),
  }

  const dispositivos: DeviceRepository = {
    registrar: sinDoble('dispositivos.registrar'),
    buscar: sinDoble('dispositivos.buscar'),
    listarPorRobot: sinDoble('dispositivos.listarPorRobot'),
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
    repositorios: { robots, ordenes, pasos, slots, eventos: registroDeEventos, dispositivos, metricas },
    ordenesCreadas,
  }
}

const TRANSPORTE_SIN_USO: PuertoDeTransporte = {
  ejecutarComandoDePaso: sinDoble('ejecutarComandoDePaso'),
  resetearMessageIn: sinDoble('resetearMessageIn'),
  leerRegistros: sinDoble('leerRegistros'),
}

const RELOJ: Reloj = {
  ahoraMs: () => AHORA_MS,
  dormir: () => Promise.resolve(),
}

function dependencias(
  repositorios: RepositoriosDelAgente,
  siteId: string,
  generarId: () => string,
): DependenciasDelOrquestador {
  return {
    transporte: TRANSPORTE_SIN_USO,
    reloj: RELOJ,
    politica: { maxIntentos: 3, baseBackoffMs: 10 },
    repositorios,
    siteId,
    generarId,
  }
}

describe('admision de ordenes (portado de orchestrator.test.js)', () => {
  it('no duplica la orden ante el mismo (siteId, externalOrderId) y si la crea para otra sucursal', async () => {
    const { repositorios, ordenesCreadas } = crearRepositoriosDoble()
    let siguienteId = 0
    const generarId = (): string => {
      siguienteId += 1
      return `ord-${String(siguienteId)}`
    }

    // Id externo no numerico a proposito: el legacy exigia entero
    // ("id debe ser numerico entero") y con RF35 los ids vienen prefijados por agente.
    const pedido: PedidoDeAltaDeOrden = {
      robotId: '1',
      externalOrderId: 'AG1-1001',
      tipo: 'PICK',
      origen: 'PICKING',
      locationCode: '3X04AA3',
      targetLocation: null,
    }

    const primera = await admitirOrden(dependencias(repositorios, 'sucursal-1', generarId), pedido)
    const reenvio = await admitirOrden(dependencias(repositorios, 'sucursal-1', generarId), pedido)

    const alta = exigirOk(primera)
    const absorbida = exigirOk(reenvio)

    expect(alta.tipo).toBe('CREADA')
    expect(absorbida.tipo).toBe('YA_EXISTIA')
    expect(absorbida.orden.id).toBe(alta.orden.id)
    expect(absorbida.orden.externalOrderId).toBe('AG1-1001')
    // Lo unico que el legacy probaba de verdad: una sola entrada encolada.
    expect(ordenesCreadas).toHaveLength(1)

    // Clave compuesta: el mismo id externo en otra sucursal es otra orden.
    const otraSucursal = exigirOk(
      await admitirOrden(dependencias(repositorios, 'sucursal-2', generarId), pedido),
    )

    expect(otraSucursal.tipo).toBe('CREADA')
    expect(otraSucursal.orden.siteId).toBe('sucursal-2')
    expect(otraSucursal.orden.id).not.toBe(alta.orden.id)
    expect(ordenesCreadas).toHaveLength(2)
  })
})
