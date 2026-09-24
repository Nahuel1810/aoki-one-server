import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME } from './index.js'
import type { Brand } from './index.js'

describe('@aoki-one/domain', () => {
  it('expone el nombre del paquete', () => {
    expect(PACKAGE_NAME).toBe('@aoki-one/domain')
  })

  it('Brand no altera el valor en runtime y conserva el tipo base', () => {
    type OrderId = Brand<string, 'OrderId'>

    const orderId = 'ORD-001' as OrderId

    // Sigue siendo un string comun: la marca solo existe en tiempo de compilacion.
    expect(typeof orderId).toBe('string')
    expect(orderId.startsWith('ORD-')).toBe(true)
    expect(orderId).toBe('ORD-001')
  })
})
