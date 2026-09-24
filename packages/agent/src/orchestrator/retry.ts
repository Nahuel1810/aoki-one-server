// RF13 y RF17 — Reintento manual de una orden en ERROR.
//
// El operario ya devolvio el cajon al punto de origen del paso que fallo, asi que
// el retry replaya la orden COMPLETA desde HOMING: estado PENDING,
// `currentStepIndex` en 0 y `errorReason` en null.
//
// Antes de reencolar hay que dejar `messageIn` en 0 en los dispositivos del
// robot, o el PLC arranca el reintento con el comando anterior colgado.
//
// El slot conserva su estado y queda utilizable: el legacy lo manda a ERROR al
// fallar el paso y el retry no lo desbloquea, asi que hoy un slot queda
// inutilizable para siempre despues de un retry.

import { transicionarOrden } from '@aoki-one/domain'
import type { EstadoOrden, Result } from '@aoki-one/domain'

import type { Orden } from '../persistence/index.js'
import type { FalloDeEjecucion } from '../transport/errorClassification.js'
import { aplicarTransicionDeOrden } from '../sync/transitions.js'
import type { DependenciasDelOrquestador } from './ports.js'

export type ErrorDeReintentoDeOrden =
  | { readonly codigo: 'ORDEN_INEXISTENTE'; readonly ordenId: string }
  | {
      readonly codigo: 'ORDEN_NO_REINTENTABLE'
      readonly ordenId: string
      readonly estado: EstadoOrden
    }
  | {
      readonly codigo: 'FALLO_AL_RESETEAR_MESSAGE_IN'
      readonly ordenId: string
      readonly fallo: FalloDeEjecucion
    }

export async function reintentarOrden(
  dependencias: DependenciasDelOrquestador,
  ordenId: string,
): Promise<Result<Orden, ErrorDeReintentoDeOrden>> {
  const { repositorios, transporte } = dependencias

  const orden = await repositorios.ordenes.buscarPorId(ordenId)
  if (orden === undefined) {
    return { ok: false, error: { codigo: 'ORDEN_INEXISTENTE', ordenId } }
  }

  const siguiente = transicionarOrden(orden.estado, { tipo: 'REINTENTAR' })
  if (!siguiente.ok) {
    return {
      ok: false,
      error: { codigo: 'ORDEN_NO_REINTENTABLE', ordenId, estado: orden.estado },
    }
  }

  // Antes de reencolar hay que dejar messageIn en 0: si no, el PLC arranca el
  // reintento con el comando anterior colgado y repite la maniobra que fallo.
  const reset = await transporte.resetearMessageIn(orden.robotId)
  if (!reset.ok) {
    return {
      ok: false,
      error: { codigo: 'FALLO_AL_RESETEAR_MESSAGE_IN', ordenId, fallo: reset.error },
    }
  }

  // Replay completo desde HOMING: el operario ya devolvio el cajon al punto de
  // origen del paso que fallo. El slot NO se toca y sigue utilizable (RF13).
  //
  // RF34: volver a PENDING es un cambio de estado como cualquier otro, y viaja en
  // la misma transaccion que el estado. Sin el reporte, la app de picking se
  // queda viendo ERROR una orden que ya se esta rehaciendo.
  const actualizada = await aplicarTransicionDeOrden(
    dependencias,
    ordenId,
    {
      estado: siguiente.valor,
      currentStepIndex: 0,
      errorReason: null,
      waitingForSlot: false,
      finalizadaEn: null,
    },
    siguiente.valor,
    { motivo: 'REINTENTO_MANUAL' },
  )
  if (!actualizada.ok) {
    return { ok: false, error: { codigo: 'ORDEN_INEXISTENTE', ordenId } }
  }

  return { ok: true, valor: actualizada.valor }
}
