import { describe, expect, it } from 'vitest'
import { orderSchema, slotListSchema, slotSchema } from './schemas'

describe('slotSchema', () => {
  it('acepta la respuesta real del backend', () => {
    const slot = slotSchema.parse({
      id: '5be8f881-5b4f-4134-9598-178b04dc9c4b',
      locationCode: '3X01AA1',
      side: 'LEFT',
      robotId: '1',
      level: 1,
      position: 1,
      status: 'LIBRE',
      reservedByOrderId: null,
      currentBox: null,
      lastError: null,
      updatedAt: 1790081756290,
    })

    expect(slot.side).toBe('LEFT')
    expect(slot.level).toBe(1)
  })

  it('completa los campos que un backend anterior a T05 no manda', () => {
    const slot = slotSchema.parse({
      id: 'x',
      locationCode: '3X01AA1',
      status: 'LIBRE',
    })

    expect(slot.side).toBeNull()
    expect(slot.level).toBeNull()
    expect(slot.robotId).toBeNull()
  })

  it('no se rompe si el backend agrega campos nuevos', () => {
    expect(() =>
      slotSchema.parse({
        id: 'x',
        locationCode: '3X01AA1',
        status: 'OCUPADO',
        campoQueNoExisteTodavia: 42,
      }),
    ).not.toThrow()
  })

  it('rechaza un estado de slot que la UI no sabe dibujar', () => {
    // Preferible a inventar un fallback: el operario ve el aviso de error
    // en vez de un tablero que miente sobre el estado real.
    expect(() =>
      slotSchema.parse({ id: 'x', locationCode: '3X01AA1', status: 'OCCUPIED' }),
    ).toThrow()
  })

  it('exige locationCode: sin el no hay celda que dibujar', () => {
    expect(() => slotSchema.parse({ id: 'x', status: 'LIBRE' })).toThrow()
  })
})

describe('orderSchema', () => {
  it('aplica los valores por defecto de una orden recien creada', () => {
    const order = orderSchema.parse({
      id: 'o1',
      type: 'PICK',
      status: 'PENDING',
      locationCode: '3X04AA1',
    })

    expect(order.currentStepIndex).toBe(0)
    expect(order.steps).toEqual([])
    expect(order.waitingForSlot).toBe(false)
    expect(order.targetLocation).toBeNull()
  })

  it('conserva el origen cuando viene', () => {
    const order = orderSchema.parse({
      id: 'o1',
      type: 'PUT',
      status: 'IN_PROGRESS',
      locationCode: '3X01AA1',
      origin: 'PICKING',
    })

    expect(order.origin).toBe('PICKING')
  })
})

describe('slotListSchema', () => {
  it('una lista vacia es valida: puede no haber slots configurados', () => {
    expect(slotListSchema.parse([])).toEqual([])
  })
})
