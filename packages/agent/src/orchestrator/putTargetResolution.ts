// RF11 — Destino de una devolucion.
//
// Los dos caminos los distingue el estado del slot, que es justo el discriminante
// del requisito:
//   - slot CON cajon en libros -> el destino es `cajon.ubicacionDeOrigen` y
//     cualquier `targetLocation` recibido se IGNORA;
//   - slot VACIO en libros (devolucion manual fuera-de-libros: alguien saco el
//     cajon a mano, lo restockeo y lo apoya) -> `targetLocation` es OBLIGATORIO y
//     sin el la orden se rechaza con 400.
//
// El legacy nunca lee la ubicacion de origen del cajon: hace `target || source` y
// para un PUT `source` es el propio slot, o sea que sin `targetLocation` devuelve
// el cajon al mismo slot. Ese caso lo cierra el destino obligatorio; la
// prohibicion explicita de devolver al propio slot NO se declara aca (ver
// `ErrorDeDestinoDePut`).
//
// UN SLOT TOMADO NO ES UNA ORDEN INVALIDA. Un PUT sobre un slot RESERVADO,
// BUSCANDO, DEVOLVIENDO o ERROR no se rechaza: la orden ESPERA (queda PENDING con
// `waitingForSlot` y el slot conserva su estado). Por eso ese caso sale por la
// rama ok, como `ESPERAR_SLOT`, y no por el canal de error: es un estado
// transitorio del slot, no un defecto del pedido. En el canal de error queda solo
// lo que ninguna espera arregla.

import { noImplementado } from '@aoki-one/domain'
import type { EstadoSlot, NombreEstadoSlot, Result } from '@aoki-one/domain'

export interface PedidoDeDestinoDePut {
  /** baseCode del slot desde donde sale el cajon. */
  readonly slotLocationCode: string
  readonly estadoDelSlot: EstadoSlot
  /** Lo que mando la tablet, o `null` si no mando nada. */
  readonly targetLocationPedido: string | null
}

export interface DestinoDePut {
  readonly locationCode: string
  /** De donde salio el destino, para poder afirmar que el pedido se ignoro. */
  readonly resueltoDesde: 'CAJON_EN_LIBROS' | 'PEDIDO'
}

export type ResolucionDeDestinoDePut =
  | { readonly tipo: 'DESTINO_RESUELTO'; readonly destino: DestinoDePut }
  /**
   * El slot no se puede tomar AHORA (RESERVADO, BUSCANDO, DEVOLVIENDO o ERROR).
   * La orden espera y el slot queda como estaba.
   */
  | { readonly tipo: 'ESPERAR_SLOT'; readonly estado: NombreEstadoSlot }

/**
 * Lo genuinamente invalido de un pedido de PUT: no lo arregla esperar.
 *
 * `TARGET_LOCATION_REQUERIDO` es el assert nuevo de RF11 (slot vacio en libros y
 * sin destino -> 400) y es lo unico que las CORRECCIONES DE LA AUDITORIA mandan
 * agregar.
 *
 * NO esta `DESTINO_ES_EL_PROPIO_SLOT`. El mapeo lo registra como DEFICIT
 * conocido, no como alcance: la prohibicion de devolver el cajon al propio slot
 * "no existe en ningun test portable" y RF11 figura entero en "RF sin cobertura".
 * Un rechazo que ningun test puede producir es superficie que despues hay que
 * sostener, y ademas el caso practico que lo motivaba —el `target || source` del
 * legacy— ya lo cierra el destino obligatorio. Entra con la task que escriba su
 * test.
 */
export type ErrorDeDestinoDePut = {
  readonly codigo: 'TARGET_LOCATION_REQUERIDO'
  readonly slotLocationCode: string
}

export function resolverDestinoDePut(
  pedido: PedidoDeDestinoDePut,
): Result<ResolucionDeDestinoDePut, ErrorDeDestinoDePut> {
  return noImplementado('resolverDestinoDePut', { pedido })
}
