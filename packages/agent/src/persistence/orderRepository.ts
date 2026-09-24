// RF23 y RF14 — Tabla `orders`.
//
// Indice unico `(site_id, external_order_id)`: el dedupe va por indice y nunca
// por scan lineal sobre el historico (RNF de rendimiento). Indice
// `(robot_id, status, created_at)` para resolver la cola sin traer todo a
// memoria.

import { noImplementado } from '@aoki-one/domain'
import type { EstadoOrden, Result, TipoOrden } from '@aoki-one/domain'

import type { BaseDelAgente } from './database.js'

/**
 * De donde salio la orden.
 *
 * `PICKING` llega del servidor (RF28); `MANUAL` la crea el operario desde la
 * tablet y se admite sin enlace, con `externalOrderId` prefijado por agente para
 * no colisionar con los de picking (RF35).
 */
export type OrigenDeOrden = 'PICKING' | 'MANUAL'

/**
 * Orden tal como la persiste el agente.
 *
 * Los nombres en ingles son los que ya salen por la API y consume el front; no
 * se renombran para no romper el contrato.
 *
 * `priority` no esta: se elimina del modelo y lo reemplaza la regla
 * PICK-antes-que-PUT de RF09.
 */
export interface Orden {
  readonly id: string
  readonly siteId: string
  readonly robotId: string
  /** Clave de dedupe junto con `siteId`. Nunca mas restringido a entero. */
  readonly externalOrderId: string | null
  readonly tipo: TipoOrden
  readonly origen: OrigenDeOrden
  readonly estado: EstadoOrden
  /** Ubicacion de guardado del cajon. Se rechaza si trae sufijo de accion. */
  readonly locationCode: string
  readonly targetLocation: string | null
  readonly slotLocationCode: string | null
  /** 0 antes del primer paso, 5 cuando la orden termino. Es el canario de RF04. */
  readonly currentStepIndex: number
  readonly waitingForSlot: boolean
  readonly errorReason: string | null
  readonly creadaEn: number
  readonly iniciadaEn: number | null
  readonly finalizadaEn: number | null
}

/** Campos que el orquestador mueve. El resto es inmutable desde el alta. */
export interface CambiosDeOrden {
  readonly estado?: EstadoOrden
  readonly slotLocationCode?: string | null
  readonly targetLocation?: string | null
  readonly currentStepIndex?: number
  readonly waitingForSlot?: boolean
  readonly errorReason?: string | null
  readonly iniciadaEn?: number | null
  readonly finalizadaEn?: number | null
}

export interface FiltroDeOrdenes {
  readonly siteId?: string
  readonly robotId?: string
  readonly estados?: readonly EstadoOrden[]
}

export type ErrorDeOrden =
  /** Lo tira el indice unico, no una consulta previa: cierra la ventana de carrera. */
  | {
      readonly codigo: 'EXTERNAL_ORDER_ID_DUPLICADO'
      readonly siteId: string
      readonly externalOrderId: string
    }
  | { readonly codigo: 'ORDEN_INEXISTENTE'; readonly ordenId: string }

export interface OrderRepository {
  readonly crear: (orden: Orden) => Promise<Result<Orden, ErrorDeOrden>>
  readonly buscarPorId: (ordenId: string) => Promise<Orden | undefined>
  readonly buscarPorExternalOrderId: (
    siteId: string,
    externalOrderId: string,
  ) => Promise<Orden | undefined>
  readonly listar: (filtro: FiltroDeOrdenes) => Promise<readonly Orden[]>
  readonly actualizar: (
    ordenId: string,
    cambios: CambiosDeOrden,
  ) => Promise<Result<Orden, ErrorDeOrden>>
}

export function crearOrderRepository(base: BaseDelAgente): OrderRepository {
  return noImplementado('crearOrderRepository', { base })
}
