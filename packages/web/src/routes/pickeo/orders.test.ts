import { describe, expect, it } from 'vitest'
import { operationalOrders, orderBoxLocation } from './orders'
import { makeOrder } from '@/test/factories'

describe('operationalOrders', () => {
  it('deja fuera lo que ya no está en juego', () => {
    const orders = [
      makeOrder({ id: '1', status: 'DONE' }),
      makeOrder({ id: '2', status: 'PENDING' }),
      makeOrder({ id: '3', status: 'CANCELED' }),
      makeOrder({ id: '4', status: 'IN_PROGRESS' }),
      makeOrder({ id: '5', status: 'ERROR' }),
    ]

    expect(operationalOrders(orders).map((order) => order.id)).toEqual(['2', '4', '5'])
  })

  it('ordena por antiguedad: primero lo que espera hace mas tiempo', () => {
    const orders = [
      makeOrder({ id: 'nueva', createdAt: 3000 }),
      makeOrder({ id: 'vieja', createdAt: 1000 }),
      makeOrder({ id: 'media', createdAt: 2000 }),
    ]

    expect(operationalOrders(orders).map((order) => order.id)).toEqual(['vieja', 'media', 'nueva'])
  })
})

describe('orderBoxLocation', () => {
  it('un PICK se identifica por su origen', () => {
    expect(orderBoxLocation(makeOrder({ type: 'PICK', locationCode: '3X09AD1' }))).toBe('3X09AD1')
  })

  it('un PUT se identifica por su destino, no por el slot del que sale', () => {
    const order = makeOrder({
      type: 'PUT',
      locationCode: '3X01AA1',
      targetLocation: '3X09AD1',
    })

    expect(orderBoxLocation(order)).toBe('3X09AD1')
  })

  it('un PUT sin destino no muestra nada: el locationCode es el slot interno', () => {
    // 3X01AA1 es un slot de pickeo. Caer a ese codigo filtraba a la pantalla
    // una ubicacion que en el deposito nadie conoce ni necesita.
    expect(orderBoxLocation(makeOrder({ type: 'PUT', locationCode: '3X01AA1' }))).toBeNull()
  })
})
