import type { Order } from '@/api/schemas'

/** Lo que esta en juego ahora: pendientes, en curso y trabadas. */
export function operationalOrders(orders: Order[]): Order[] {
  return orders
    .filter((order) => ['PENDING', 'IN_PROGRESS', 'ERROR'].includes(order.status))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
}

/**
 * El cajón al que se refiere el pedido.
 *
 * Para un PUT, `locationCode` es el slot de pickeo del que sale el cajón: un
 * dato interno del sistema que nunca se muestra. El cajón es `targetLocation`,
 * que es a donde vuelve. Si no está, no hay nada que mostrar; caer al
 * `locationCode` pondria el slot en pantalla, que es justo lo que no va.
 */
export function orderBoxLocation(order: Order): string | null {
  if (order.type === 'PUT') {
    return order.targetLocation
  }

  return order.locationCode
}
