import type { Order } from '@/api/schemas'

/** Lo que esta en juego ahora: pendientes, en curso y trabadas. */
export function operationalOrders(orders: Order[]): Order[] {
  return orders
    .filter((order) => ['PENDING', 'IN_PROGRESS', 'ERROR'].includes(order.status))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
}

/** Un PUT se identifica por su destino; un PICK, por su origen. */
export function orderLocationLabel(order: Order): string {
  if (order.type === 'PUT' && order.targetLocation) {
    return order.targetLocation
  }
  return order.locationCode
}
