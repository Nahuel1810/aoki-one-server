// RF14 y RF21 — Admision de una orden en el agente.
//
// El dedupe es por `(siteId, externalOrderId)` resuelto por el indice unico de
// SQLite, no por un scan lineal sobre las ordenes en memoria ni por una consulta
// previa: dos altas concurrentes con el mismo id externo no pueden crear dos
// ordenes. El `siteId` sale de la configuracion del agente, nunca del request.
//
// El agente conserva su propio indice aunque el dedupe sea responsabilidad del
// servidor: admite ordenes manuales sin enlace (RF35) y una re-entrega del
// servidor tras un lease vencido (RF28) no debe crear una segunda orden.

import type { ErrorLocationCode, Result, TipoOrden } from '@aoki-one/domain'

import { noImplementadoAsync } from '../noImplementadoAsync.js'
import type { Orden, OrigenDeOrden } from '../persistence/index.js'
import type { DependenciasDelOrquestador } from './ports.js'

export interface PedidoDeAltaDeOrden {
  /** `null` cuando se resuelve por la estanteria del locationCode (tabla `robots`). */
  readonly robotId: string | null
  readonly externalOrderId: string | null
  readonly tipo: TipoOrden
  readonly origen: OrigenDeOrden
  readonly locationCode: string
  readonly targetLocation: string | null
}

export type ResultadoDeAdmision =
  | { readonly tipo: 'CREADA'; readonly orden: Orden }
  /** Reenvio del mismo `(siteId, externalOrderId)`: devuelve la orden existente y no encola otra. */
  | { readonly tipo: 'YA_EXISTIA'; readonly orden: Orden }

export type ErrorDeAdmision =
  /** El locationCode trae sufijo T/D/L: la accion se deriva del tipo de orden. */
  | { readonly codigo: 'LOCATION_CODE_CON_ACCION'; readonly recibido: string }
  | {
      readonly codigo: 'LOCATION_CODE_INVALIDO'
      readonly recibido: string
      readonly causa: ErrorLocationCode
    }
  /** No hay fila en `robots` para esa estanteria: ya no existe el fallback identidad. */
  | { readonly codigo: 'ROBOT_NO_REGISTRADO'; readonly estanteriaCode: string }

export function admitirOrden(
  dependencias: DependenciasDelOrquestador,
  pedido: PedidoDeAltaDeOrden,
): Promise<Result<ResultadoDeAdmision, ErrorDeAdmision>> {
  return noImplementadoAsync('admitirOrden', { dependencias, pedido })
}
