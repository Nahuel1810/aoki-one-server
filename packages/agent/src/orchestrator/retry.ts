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

import type { EstadoOrden, Result } from '@aoki-one/domain'

import { noImplementadoAsync } from '../noImplementadoAsync.js'
import type { Orden } from '../persistence/index.js'
import type { FalloDeEjecucion } from '../transport/errorClassification.js'
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

export function reintentarOrden(
  dependencias: DependenciasDelOrquestador,
  ordenId: string,
): Promise<Result<Orden, ErrorDeReintentoDeOrden>> {
  return noImplementadoAsync('reintentarOrden', { dependencias, ordenId })
}
