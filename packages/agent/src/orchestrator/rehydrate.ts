// RF15 — Rehidratacion tras reinicio.
//
// Se arranca desde los repositorios, no desde un volcado de snapshot: RF23
// elimina el snapshot completo. Los slots CONSERVAN su estado persistido y los
// robots quedan IDLE con `ordenActivaId` en null.
//
// QUE PASA CON LA ORDEN QUE EL CORTE DEJO A MITAD DE MANIOBRA
//
// Aca NO se copia al legacy y tampoco vale lo que hacia esta misma funcion antes.
// Los dos eran inseguros y de formas distintas:
//   - el legacy reanudaba A CIEGAS en el paso donde murio el proceso, un paso que
//     puede haberse enviado y no confirmado: el robot retomaba desde un punto
//     que nadie verifico;
//   - la version anterior de este archivo mandaba TODA orden interrumpida de
//     vuelta a PENDING con `currentStepIndex` en cero, o sea a rehacer HOMING. Si
//     el corte agarro al carro con el cajon encima, el robot arranca un homing
//     con el cajon en la mano y despues va a buscar un cajon que ya tiene.
//
// La regla que queda se apoya en donde esta el cajon, que es lo unico que importa
// para decidir si se puede mover solo:
//   - el cajon recien puede estar en el carro a partir del paso 3 (CARRO_BUSCA).
//     Los pasos 1 (HOMING) y 2 (ELEVADOR) no lo tocan;
//   - `currentStepIndex` es el ultimo paso CONFIRMADO. Con 0 o 1 el paso 3 nunca
//     se envio: el carro esta vacio, no hay nada fisico que deshacer y la orden
//     vuelve a PENDING y se replaya entera desde HOMING, sin intervencion;
//   - con 2 o mas el paso 3 pudo haber salido y el cajon puede estar en el carro,
//     en el slot o en el aire. Nadie puede saberlo desde el software, asi que la
//     orden NO se reanuda sola: queda en ERROR con el motivo, el robot no se
//     mueve y espera el retry explicito del operario.
//
// Eso ultimo no inventa un procedimiento nuevo: es exactamente el invariante de
// RF13, que el sistema ya sostiene para un paso que falla —el operario devuelve
// el cajon al punto de origen del paso y el retry replaya la orden completa desde
// HOMING—. Un corte de luz a mitad de maniobra deja la planta en el mismo estado
// que un paso fallido, asi que se recupera por el mismo camino y no por uno
// paralelo que nadie ensayo. El slot queda tomado por la orden (RF13), asi que el
// retry lo reusa y no se pierde.

import { transicionarOrden } from '@aoki-one/domain'
import { aplicarTransicionDeOrden } from '../sync/transitions.js'
import type { DependenciasDelOrquestador } from './ports.js'

/**
 * Ultimo paso confirmado a partir del cual el cajon pudo quedar en el carro.
 *
 * El paso 3 es `CARRO_BUSCA`, el primero que toca el cajon. Con el paso 2
 * confirmado, el 3 es el que estaba en vuelo.
 */
const ULTIMO_PASO_SIN_CAJON_EN_EL_CARRO = 1

/** Motivo que ve el operario en la tablet antes de dar el retry. */
const MOTIVO_DE_INTERRUPCION =
  'maniobra interrumpida por un reinicio con el cajon en el carro: devolver el cajon al punto de origen del paso y reintentar'

export interface ResumenDeRehidratacion {
  /** Ids de las que estaban IN_PROGRESS y volvieron a PENDING. */
  readonly ordenesRecuperadasDeEnCurso: readonly string[]
  /**
   * Ids de las que quedaron en ERROR esperando al operario.
   *
   * El robot no las retoma solo: el corte las agarro con el cajon posiblemente
   * en el carro.
   */
  readonly ordenesDetenidasParaRevision: readonly string[]
  /** Ids de todas las pendientes, de la mas vieja a la mas nueva. Las DONE no entran. */
  readonly ordenesPendientes: readonly string[]
  readonly robotsLiberados: readonly string[]
}

export async function rehidratar(
  dependencias: DependenciasDelOrquestador,
): Promise<ResumenDeRehidratacion> {
  const { repositorios, siteId, reloj, logger } = dependencias

  const enCurso = await repositorios.ordenes.listar({ siteId, estados: ['IN_PROGRESS'] })
  const recuperadas: string[] = []
  const detenidas: string[] = []
  for (const orden of enCurso) {
    if (orden.currentStepIndex <= ULTIMO_PASO_SIN_CAJON_EN_EL_CARRO) {
      const siguiente = transicionarOrden(orden.estado, { tipo: 'REHIDRATAR' })
      if (!siguiente.ok) {
        continue
      }
      // Replay entero desde HOMING: el carro estaba vacio, no hay nada que
      // devolver a mano.
      await repositorios.ordenes.actualizar(orden.id, {
        estado: siguiente.valor,
        currentStepIndex: 0,
        waitingForSlot: false,
      })
      logger.info('ORDER_RECOVERED_FROM_IN_PROGRESS', {
        ordenId: orden.id,
        currentStepIndex: orden.currentStepIndex,
      })
      recuperadas.push(orden.id)
      continue
    }

    const siguiente = transicionarOrden(orden.estado, {
      tipo: 'FALLAR',
      motivo: MOTIVO_DE_INTERRUPCION,
    })
    if (!siguiente.ok) {
      continue
    }
    // RF34: el motivo viaja al servidor. La app de picking tiene que poder decir
    // por que ese pedido quedo esperando una mano.
    await aplicarTransicionDeOrden(
      dependencias,
      orden.id,
      {
        estado: siguiente.valor,
        errorReason: MOTIVO_DE_INTERRUPCION,
        waitingForSlot: false,
        finalizadaEn: reloj.ahoraMs(),
      },
      siguiente.valor,
      { motivo: 'INTERRUMPIDA_POR_REINICIO', currentStepIndex: orden.currentStepIndex },
    )
    // WARN y no INFO: alguien tiene que ir hasta el robot. Una linea por orden,
    // que es lo que se lee a las 7 de la mañana en la notebook de la sucursal.
    logger.warn('ORDER_HELD_FOR_REVIEW', {
      ordenId: orden.id,
      robotId: orden.robotId,
      currentStepIndex: orden.currentStepIndex,
      motivo: MOTIVO_DE_INTERRUPCION,
    })
    detenidas.push(orden.id)
  }

  // Los robots quedan IDLE: la orden activa que tenian ya no esta corriendo.
  const robots = await repositorios.robots.listar(siteId)
  const liberados: string[] = []
  for (const robot of robots) {
    if (robot.ordenActivaId !== null) {
      await repositorios.robots.fijarOrdenActiva(robot.id, null)
      liberados.push(robot.id)
    }
  }

  // Los slots NO se tocan: conservan su estado persistido. Un cajon apoyado sigue
  // apoyado aunque el proceso se haya caido, y el slot que retiene una orden
  // detenida lo sigue reteniendo hasta que el retry la termine (RF13).
  const pendientes = await repositorios.ordenes.listar({ siteId, estados: ['PENDING'] })

  return {
    ordenesRecuperadasDeEnCurso: recuperadas,
    ordenesDetenidasParaRevision: detenidas,
    // De la mas vieja a la mas nueva. Se ordena aca y no se confia en el orden que
    // devuelva el repositorio: es la garantia de RF15 de que la orden interrumpida
    // no pierde su lugar frente a las que entraron despues.
    ordenesPendientes: [...pendientes]
      .sort((a, b) => a.creadaEn - b.creadaEn)
      .map((orden) => orden.id),
    robotsLiberados: liberados,
  }
}
