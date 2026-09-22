// Portado de tests/unit/orchestrator.test.js (T02).
//
// TRADUCIDO. El legacy ("rehidrata snapshot y reencola ordenes pendientes") partia
// de un objeto JSON de snapshot y de `StateManager.hydrateFromSnapshot`, que
// desaparecen con RF23: la fuente de verdad son los repositorios. El
// comportamiento de RF15 se conserva literal (lo IN_PROGRESS vuelve a PENDING y
// se reencola por antiguedad; lo DONE no) y se agregan los asserts que RF15
// nombra y el legacy no cubria: los slots conservan su estado persistido y los
// robots quedan IDLE con la orden activa en null.
//
// El legacy ordenaba con creadaEn 1 y 2 en el mismo orden en que ya venian las
// filas, asi que no demostraba nada sobre el sort. Aca la mas vieja es la que
// estaba EN CURSO, o sea que el orden esperado es el inverso al de insercion.

import { describe, it, expect } from 'vitest'

import type { EstadoSlot } from '@aoki-one/domain'

import type {
  DeviceRepository,
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
import { rehidratar } from './rehydrate.js'

function sinDoble(nombre: string): () => never {
  return () => {
    throw new Error(`doble no configurado: ${nombre}`)
  }
}

const SITE_ID = 'sucursal-1'

function orden(campos: Partial<Orden>): Orden {
  return {
    id: 'o-1',
    siteId: SITE_ID,
    robotId: '1',
    externalOrderId: null,
    tipo: 'PICK',
    origen: 'MANUAL',
    estado: 'PENDING',
    locationCode: '3X04AA3',
    targetLocation: null,
    slotLocationCode: null,
    currentStepIndex: 0,
    waitingForSlot: false,
    errorReason: null,
    creadaEn: 1_000,
    iniciadaEn: null,
    finalizadaEn: null,
    ...campos,
  }
}

const CAJON_APOYADO: EstadoSlot = {
  estado: 'OCUPADO',
  contenido: {
    cajon: { id: 'ORDER:o-vieja', ubicacionDeOrigen: '3X04AE1' },
    pendingReturns: 1,
  },
}

interface Doble {
  readonly repositorios: RepositoriosDelAgente
  readonly ordenes: Map<string, Orden>
  readonly robots: Map<string, Robot>
}

function crearDoble(ordenesIniciales: readonly Orden[], robotsIniciales: readonly Robot[]): Doble {
  const ordenesPorId = new Map(ordenesIniciales.map((o) => [o.id, o]))
  const robotsPorId = new Map(robotsIniciales.map((r) => [r.id, r]))
  const eventos: Evento[] = []
  const slots: SlotDeRobot[] = [
    {
      robotId: '1',
      locationCode: '3X02AE1',
      lado: 'RIGHT',
      estado: CAJON_APOYADO,
      actualizadoEn: 900,
    },
  ]

  const repositorioDeOrdenes: OrderRepository = {
    crear: sinDoble('ordenes.crear'),
    buscarPorId: (ordenId) => Promise.resolve(ordenesPorId.get(ordenId)),
    buscarPorExternalOrderId: () => Promise.resolve(undefined),
    listar: (filtro) =>
      Promise.resolve(
        [...ordenesPorId.values()].filter(
          (candidata) =>
            (filtro.robotId === undefined || candidata.robotId === filtro.robotId) &&
            (filtro.estados === undefined || filtro.estados.includes(candidata.estado)),
        ),
      ),
    actualizar: (ordenId, cambios) => {
      const actual = ordenesPorId.get(ordenId)
      if (actual === undefined) {
        return Promise.resolve({ ok: false, error: { codigo: 'ORDEN_INEXISTENTE', ordenId } })
      }
      const actualizada: Orden = { ...actual, ...cambios }
      ordenesPorId.set(ordenId, actualizada)
      return Promise.resolve({ ok: true, valor: actualizada })
    },
  }

  const repositorioDeRobots: RobotRepository = {
    guardar: (robot) => {
      robotsPorId.set(robot.id, robot)
      return Promise.resolve({ ok: true, valor: robot })
    },
    buscarPorId: (robotId) => Promise.resolve(robotsPorId.get(robotId)),
    buscarPorEstanteria: () => Promise.resolve(undefined),
    listar: () => Promise.resolve([...robotsPorId.values()]),
    fijarOrdenActiva: (robotId, ordenId) => {
      const actual = robotsPorId.get(robotId)
      if (actual === undefined) {
        return Promise.resolve({ ok: false, error: { codigo: 'ROBOT_INEXISTENTE', robotId } })
      }
      const actualizado: Robot = {
        ...actual,
        ordenActivaId: ordenId,
        estado: ordenId === null ? 'IDLE' : 'BUSY',
      }
      robotsPorId.set(robotId, actualizado)
      return Promise.resolve({ ok: true, valor: actualizado })
    },
  }

  const repositorioDeSlots: SlotRepository = {
    listarPorRobot: () => Promise.resolve(slots),
    buscar: (_robotId, locationCode) =>
      Promise.resolve(slots.find((slot) => slot.locationCode === locationCode)),
    buscarPorCajonDeOrigen: () => Promise.resolve(undefined),
    guardarEstado: sinDoble('slots.guardarEstado'),
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
    registrar: sinDoble('pasos.registrar'),
    actualizar: sinDoble('pasos.actualizar'),
    listarPorOrden: () => Promise.resolve([]),
  }

  const dispositivos: DeviceRepository = {
    registrar: sinDoble('dispositivos.registrar'),
    buscar: sinDoble('dispositivos.buscar'),
    listarPorRobot: () => Promise.resolve([]),
  }

  return {
    repositorios: {
      robots: repositorioDeRobots,
      ordenes: repositorioDeOrdenes,
      pasos,
      slots: repositorioDeSlots,
      eventos: repositorioDeEventos,
      dispositivos,
    },
    ordenes: ordenesPorId,
    robots: robotsPorId,
  }
}

const TRANSPORTE_SIN_USO: PuertoDeTransporte = {
  ejecutarComandoDePaso: sinDoble('ejecutarComandoDePaso'),
  resetearMessageIn: sinDoble('resetearMessageIn'),
  leerRegistros: sinDoble('leerRegistros'),
}

const RELOJ: Reloj = {
  ahoraMs: () => 1_700_000_000_000,
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

describe('rehidratacion tras reinicio (portado de orchestrator.test.js)', () => {
  it('devuelve a PENDING lo que estaba en curso y reencola por antiguedad sin tocar las DONE', async () => {
    const doble = crearDoble(
      [
        orden({ id: 'o-pending', estado: 'PENDING', creadaEn: 2_000 }),
        orden({ id: 'o-running', estado: 'IN_PROGRESS', creadaEn: 1_000, iniciadaEn: 1_500 }),
        orden({ id: 'o-done', estado: 'DONE', creadaEn: 3_000, currentStepIndex: 5 }),
      ],
      [
        {
          id: '1',
          siteId: SITE_ID,
          estanteriaCode: '3X',
          habilitado: true,
          estado: 'BUSY',
          ordenActivaId: 'o-running',
        },
      ],
    )

    const resumen = await rehidratar(dependencias(doble.repositorios))

    expect(resumen.ordenesRecuperadasDeEnCurso).toEqual(['o-running'])
    // De la mas vieja a la mas nueva: la que estaba en curso entro segunda en la
    // tabla pero es la mas antigua, asi que va primero.
    expect(resumen.ordenesPendientes).toEqual(['o-running', 'o-pending'])
    expect(resumen.robotsLiberados).toEqual(['1'])

    expect(doble.ordenes.get('o-running')?.estado).toBe('PENDING')
    expect(doble.ordenes.get('o-pending')?.estado).toBe('PENDING')
    expect(doble.ordenes.get('o-done')?.estado).toBe('DONE')

    // RF15: el robot queda IDLE y sin orden activa (el legacy no lo verificaba).
    expect(doble.robots.get('1')?.estado).toBe('IDLE')
    expect(doble.robots.get('1')?.ordenActivaId).toBeNull()

    // RF15: los slots conservan su estado persistido, con el cajon apoyado.
    const slots = await doble.repositorios.slots.listarPorRobot('1')
    expect(slots.at(0)?.estado).toEqual(CAJON_APOYADO)
  })
})
