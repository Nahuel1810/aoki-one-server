// RF15 — Rehidratacion tras reinicio.
//
// Las ordenes IN_PROGRESS vuelven a PENDING y se reencolan respetando su
// antiguedad; los slots CONSERVAN su estado persistido y los robots quedan IDLE
// con `ordenActivaId` en null. Se arranca desde los repositorios, no desde un
// volcado de snapshot: RF23 elimina el snapshot completo.

import { noImplementadoAsync } from '../noImplementadoAsync.js'
import type { DependenciasDelOrquestador } from './ports.js'

export interface ResumenDeRehidratacion {
  /** Ids de las que estaban IN_PROGRESS y volvieron a PENDING. */
  readonly ordenesRecuperadasDeEnCurso: readonly string[]
  /** Ids de todas las pendientes, de la mas vieja a la mas nueva. Las DONE no entran. */
  readonly ordenesPendientes: readonly string[]
  readonly robotsLiberados: readonly string[]
}

export function rehidratar(
  dependencias: DependenciasDelOrquestador,
): Promise<ResumenDeRehidratacion> {
  return noImplementadoAsync('rehidratar', { dependencias })
}
