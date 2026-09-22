import { orderSchema, slotSchema, type Order, type Slot } from '@/api/schemas'

/**
 * Las factories arman los objetos pasandolos por el esquema real, no por un
 * cast: si el contrato cambia, los tests fallan al construir el fixture en vez
 * de pasar con datos que la app nunca veria.
 */

export function makeSlot(overrides: Record<string, unknown> = {}): Slot {
  return slotSchema.parse({
    id: 'slot-1',
    locationCode: '3X01AA1',
    status: 'LIBRE',
    side: 'LEFT',
    robotId: '1',
    level: 1,
    position: 1,
    ...overrides,
  })
}

export function makeOrder(overrides: Record<string, unknown> = {}): Order {
  return orderSchema.parse({
    id: 'order-1',
    type: 'PICK',
    status: 'PENDING',
    locationCode: '3X04AA1',
    ...overrides,
  })
}
