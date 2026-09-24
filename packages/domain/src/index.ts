// Barrel del paquete de dominio.
//
// El dominio es logica pura: no hace I/O, no abre red y no usa Date.now()
// ni randomUUID directamente (esas capacidades se inyectan desde agent/server).
//
// Este es el ESQUELETO DE CONTRATOS previo a T02: los tipos y las firmas son
// reales, las implementaciones tiran "No implementado". La suite de aceptacion
// tiene que compilar y fallar en runtime hasta que T03 en adelante la pongan en
// verde.

export * from './result.js'
export * from './locationCode.js'
export * from './plcProtocol.js'
export * from './orderSteps.js'
export * from './order.js'
export * from './slotStateMachine.js'
export * from './slotSelection.js'
export * from './pendingReturns.js'
export * from './queueOrdering.js'

/** Nombre del paquete. Sirve para trazas y diagnosticos de los consumidores. */
export const PACKAGE_NAME = '@aoki-one/domain'

/**
 * Tipo nominal (branded type) para identificadores tipados.
 *
 * Marca un tipo base `T` con una etiqueta `B` para que el compilador no deje
 * intercambiar valores que comparten la misma representacion en runtime.
 *
 * @example
 * type OrderId = Brand<string, 'OrderId'>
 * type SlotId = Brand<string, 'SlotId'>
 * // Un OrderId no es asignable a un SlotId aunque ambos sean string.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B }
