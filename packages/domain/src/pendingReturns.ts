// RF07 — Refcount de devoluciones pendientes (hoy `logicalPickStackDepth`).
//
// Existe para que dos pedidos del mismo cajon exijan dos devoluciones y ningun
// pedido quede sin atender. Un PICK sobre un cajon que YA esta en un slot no
// genera maniobra: incrementa el contador y la orden termina DONE.
//
// La mitad de abajo de RF07 —un PUT con el contador en mas de 1 decrementa y
// termina DONE sin maniobra; solo el ULTIMO PUT devuelve fisicamente— vive en
// `resolverPut`. Estuvo sin declarar mientras ningun test portado la ejercitaba,
// y esa ausencia era una divergencia contra el robot de hoy
// (`OrchestratorService.js:248-253`): sin ella el primer PUT devuelve el cajon y
// libera el slot mientras un segundo pedido todavia lo esta esperando.

import type { Result } from './result.js'
import type { CajonEnSlot } from './slotStateMachine.js'

/**
 * El contador quedaria fuera de rango.
 *
 * Bajar de 1 es error explicito, no un clamp silencioso: si el contador se
 * rompe, el cajon se devuelve de menos y se pierde un pedido.
 */
export type ErrorPendingReturns = {
  readonly codigo: 'PENDING_RETURNS_FUERA_DE_RANGO'
  readonly actual: number
}

/** Que hacer con la orden: mover el robot, o cerrarla sin tocarlo. */
export type ResolucionDeManiobra =
  | { readonly tipo: 'EJECUTAR_MANIOBRA' }
  /** La orden termina DONE sin pasos fisicos, con el contador ya actualizado. */
  | { readonly tipo: 'TERMINAR_SIN_MANIOBRA'; readonly pendingReturns: number }

/** 1 -> 2. Al ocupar el slot el contador arranca en 1, no en 0. */
export function incrementarPendingReturns(actual: number): Result<number, ErrorPendingReturns> {
  if (!Number.isInteger(actual) || actual < 1) {
    return { ok: false, error: { codigo: 'PENDING_RETURNS_FUERA_DE_RANGO', actual } }
  }
  return { ok: true, valor: actual + 1 }
}

/** 2 -> 1. Con `actual` menor o igual a 1 es error, no 0. */
export function decrementarPendingReturns(actual: number): Result<number, ErrorPendingReturns> {
  // No baja de 1: mientras el cajon este apoyado queda al menos una devolucion
  // pendiente, y el contador llega a 0 recien cuando el slot se libera. Pedir un
  // decremento desde 1 es un error del dominio, no un clamp silencioso: significa
  // que el llamador perdio la cuenta.
  if (!Number.isInteger(actual) || actual <= 1) {
    return { ok: false, error: { codigo: 'PENDING_RETURNS_FUERA_DE_RANGO', actual } }
  }
  return { ok: true, valor: actual - 1 }
}

/**
 * Resuelve un PICK.
 *
 * `contenidoDelSlotQueYaTieneElCajon` es el contenido del slot de pickeo donde el
 * cajon pedido ya esta apoyado, o null si no esta en ninguno (buscarlo por
 * `cajon.ubicacionDeOrigen` es trabajo del repositorio, no del dominio).
 *
 * Si ya esta: incrementa y TERMINAR_SIN_MANIOBRA. Si no: EJECUTAR_MANIOBRA.
 */
export function resolverPick(
  contenidoDelSlotQueYaTieneElCajon: CajonEnSlot | null,
): Result<ResolucionDeManiobra, ErrorPendingReturns> {
  if (contenidoDelSlotQueYaTieneElCajon === null) {
    return { ok: true, valor: { tipo: 'EJECUTAR_MANIOBRA' } }
  }
  // El cajon ya esta apoyado: no se mueve el robot, se anota una devolucion mas.
  const incrementado = incrementarPendingReturns(contenidoDelSlotQueYaTieneElCajon.pendingReturns)
  if (!incrementado.ok) {
    return incrementado
  }
  return { ok: true, valor: { tipo: 'TERMINAR_SIN_MANIOBRA', pendingReturns: incrementado.valor } }
}

/**
 * Resuelve un PUT (segunda mitad de RF07).
 *
 * `contenidoDelSlot` es lo que el slot de pickeo tiene apoyado en libros.
 *
 * Con el contador en mas de 1 hay OTRO pedido que todavia reclama ese mismo
 * cajon: se decrementa, la orden termina DONE y el cajon NO se mueve. Solo
 * cuando el contador esta en 1 —el ultimo pedido pendiente— se ejecuta la
 * devolucion fisica.
 *
 * Es el reflejo exacto de `resolverPick`: sin esta mitad, el primer PUT devuelve
 * el cajon a su ubicacion de guardado y libera el slot mientras el segundo
 * pedido lo sigue esperando, que es justo el caso que el refcount existe para
 * evitar.
 */
export function resolverPut(
  contenidoDelSlot: CajonEnSlot,
): Result<ResolucionDeManiobra, ErrorPendingReturns> {
  if (contenidoDelSlot.pendingReturns <= 1) {
    // Ultima devolucion pendiente: esta si mueve el robot.
    return { ok: true, valor: { tipo: 'EJECUTAR_MANIOBRA' } }
  }

  const decrementado = decrementarPendingReturns(contenidoDelSlot.pendingReturns)
  if (!decrementado.ok) {
    return decrementado
  }
  return { ok: true, valor: { tipo: 'TERMINAR_SIN_MANIOBRA', pendingReturns: decrementado.valor } }
}
