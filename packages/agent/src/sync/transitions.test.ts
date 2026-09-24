// RF34 — El punto por el que el orquestador alimenta el outbox.
//
// El modulo declara una invariante fuerte: encolar NUNCA puede voltear una
// maniobra. La orden ya cambio de estado en el mundo fisico cuando esto corre,
// asi que perder el reporte es recuperable —el servidor lo vuelve a ver en la
// proxima transicion, o el enlace lo reconcilia cuando re-entrega la orden—
// mientras que abortar la maniobra por un fallo de escritura de la COLA DE
// SALIDA no lo es: el cajon queda a mitad de camino y el loop del robot se lleva
// la excepcion puesta.
//
// El estado local y su reporte ahora van en la MISMA transaccion
// (`aplicarTransicionDeOrden`), asi que estos tests pasaron de ejercitar
// `encolarTransicionDeOrden` —que ya no existe: nadie cambiaba de estado sin
// reportar— a ejercitar la escritura conjunta. La invariante que afirman es la
// misma: con la cola de salida rota, el ESTADO se escribe igual.

import { LOGGER_SILENCIOSO } from '@aoki-one/domain'

import { randomUUID } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { admitirOrden } from '../orchestrator/orderIntake.js'
import type { DependenciasDelOrquestador, PuertoDeTransporte } from '../orchestrator/ports.js'
import { ejecutarCicloDeRobot } from '../orchestrator/robotLoop.js'
import { abrirBase, type BaseDelAgente } from '../persistence/database.js'
import { crearRepositorios } from '../persistence/index.js'
import type { Reloj } from '../reloj.js'
import type { OutboxDeTransiciones } from './outbox.js'
import { aplicarTransicionDeOrden } from './transitions.js'

const SITE_ID = 'SUC-ENLACE'
const AGENT_ID = 'AG-1'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'
const ORIGEN = '3X04AE1'
const AHORA_MS = 1_700_000_000_000

const ZONA_DE_PICKEO: readonly string[] = ['3X02AE1', '3X02AC1', '3X02AA1']

const RELOJ: Reloj = { ahoraMs: () => AHORA_MS, dormir: () => Promise.resolve() }

/** Transporte que confirma todo, como el modo simulacion del puerto real. */
const TRANSPORTE_QUE_CONFIRMA: PuertoDeTransporte = {
  ejecutarComandoDePaso: () => Promise.resolve({ ok: true, valor: { kind: 'OK' } }),
  resetearMessageIn: () => Promise.resolve({ ok: true, valor: undefined }),
  leerRegistros: () =>
    Promise.resolve({ ok: true, valor: { messageIn1: 0, messageIn2: null, messageOut: 0 } }),
}

/**
 * Outbox que no puede escribir.
 *
 * Es el disco lleno, la base bloqueada por otro proceso o el archivo que se
 * quedo sin permisos: cosas que pasan en una sucursal y que no pueden dejar un
 * cajon colgado del elevador.
 */
function crearOutboxQueNoEscribe(): OutboxDeTransiciones {
  const reventar = (): never => {
    throw new Error('SQLITE_FULL: no se pudo escribir la cola de salida')
  }
  const rechazar = (): Promise<never> =>
    Promise.reject(new Error('SQLITE_FULL: no se pudo escribir la cola de salida'))
  return {
    encolar: rechazar,
    encolarConEstadoDeOrden: rechazar,
    proximas: () => Promise.resolve([]),
    reservarProximas: () => Promise.resolve([]),
    soltar: () => Promise.resolve(),
    confirmar: () => Promise.resolve(),
    registrarIntentoFallido: () => Promise.resolve(),
    darPorMuerta: () => Promise.resolve(),
    pendientes: () => Promise.resolve(0),
    tienePendientes: () => Promise.resolve(false),
    vincular: () => Promise.resolve(),
    buscarVinculo: reventar,
  }
}

let base: BaseDelAgente
let orquestador: DependenciasDelOrquestador

beforeEach(async () => {
  base = abrirBase(':memory:')
  const repositorios = crearRepositorios(base)

  orquestador = {
    repositorios,
    siteId: SITE_ID,
    agentId: AGENT_ID,
    logger: LOGGER_SILENCIOSO,
    generarId: () => randomUUID(),
    transporte: TRANSPORTE_QUE_CONFIRMA,
    reloj: RELOJ,
    politica: { maxIntentos: 3, baseBackoffMs: 1 },
    outbox: crearOutboxQueNoEscribe(),
  }

  const robot = await repositorios.robots.guardar({
    id: ROBOT_ID,
    siteId: SITE_ID,
    estanteriaCode: ESTANTERIA,
    habilitado: true,
    estado: 'IDLE',
    ordenActivaId: null,
  })
  if (!robot.ok) {
    throw new Error('no se pudo sembrar el robot')
  }
  const zona = await repositorios.slots.sembrarZonaDePickeo(ROBOT_ID, ZONA_DE_PICKEO)
  if (!zona.ok) {
    throw new Error('no se pudo sembrar la zona de pickeo')
  }
})

afterEach(() => {
  base.cerrar()
})

describe('encolar una transicion no puede voltear una maniobra (RF34)', () => {
  it('un outbox que no puede escribir no propaga el fallo al orquestador', async () => {
    const admision = await admitirOrden(orquestador, {
      robotId: null,
      externalOrderId: null,
      tipo: 'PICK',
      origen: 'MANUAL',
      locationCode: ORIGEN,
      targetLocation: null,
    })
    if (!admision.ok) {
      throw new Error('la orden tenia que admitirse')
    }

    const aplicada = await aplicarTransicionDeOrden(
      orquestador,
      admision.valor.orden.id,
      { estado: 'DONE', finalizadaEn: AHORA_MS },
      'DONE',
      { huboManiobra: true },
    )

    // El fallo no sube, y el ESTADO queda escrito igual: lo que se pierde es el
    // reporte, que es lo recuperable.
    expect(aplicada.ok).toBe(true)
    const orden = await orquestador.repositorios.ordenes.buscarPorId(admision.valor.orden.id)
    expect(orden?.estado).toBe('DONE')
  })

  it('la orden llega a DONE igual con el outbox roto', async () => {
    const admision = await admitirOrden(orquestador, {
      robotId: null,
      externalOrderId: null,
      tipo: 'PICK',
      origen: 'MANUAL',
      locationCode: ORIGEN,
      targetLocation: null,
    })
    if (!admision.ok) {
      throw new Error('la orden tenia que admitirse')
    }

    const ciclo = await ejecutarCicloDeRobot(orquestador, ROBOT_ID)

    // Si el fallo de la cola de salida se propaga, esto tira y el bucle del robot
    // de `composition.ts` muere con una promesa rechazada: la sucursal deja de
    // atender ordenes por no haber podido anotar un reporte.
    expect(ciclo).toMatchObject({ tipo: 'ORDEN_TERMINADA', estadoFinal: 'DONE' })
    const orden = await orquestador.repositorios.ordenes.buscarPorId(admision.valor.orden.id)
    expect(orden?.estado).toBe('DONE')
    // El robot queda libre para la siguiente: no se quedo con la orden colgada.
    const robot = await orquestador.repositorios.robots.buscarPorId(ROBOT_ID)
    expect(robot?.ordenActivaId).toBeNull()
  })

  it('deja traza del reporte que no se pudo encolar en vez de tragarselo', async () => {
    await aplicarTransicionDeOrden(
      orquestador,
      'o-1',
      { estado: 'DONE', finalizadaEn: AHORA_MS },
      'DONE',
      { huboManiobra: true },
    )

    const eventos = await orquestador.repositorios.eventos.listar({
      tipoDeEntidad: 'ORDER',
      entidadId: 'o-1',
    })
    // Seguir de largo no puede significar seguir de largo EN SILENCIO: si esto
    // desaparece, un outbox que no escribe nunca se entera nadie.
    expect(eventos.map((evento) => evento.evento)).toEqual(['OUTBOX_ENQUEUE_FAILED'])
    expect(eventos[0]?.severidad).toBe('ERROR')
    expect(eventos[0]?.metadata['estado']).toBe('DONE')
  })
})
