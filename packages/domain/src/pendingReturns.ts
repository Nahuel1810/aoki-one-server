// RF07 — Refcount de devoluciones pendientes (hoy `logicalPickStackDepth`).
//
// Existe para que dos pedidos del mismo cajon exijan dos devoluciones y ningun
// pedido quede sin atender. Un PICK sobre un cajon que YA esta en un slot no
// genera maniobra: incrementa el contador y la orden termina DONE.
//
// La mitad de abajo de RF07 (un PUT con el contador en mas de 1 decrementa y
// termina DONE sin maniobra, solo el ultimo PUT devuelve fisicamente) NO se
// declara aca: figura en la seccion "RF sin cobertura" del mapeo, ningun test
// portado la ejercita y entra con la task que escriba su test.

import { noImplementado } from './noImplementado.js'
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
  return noImplementado('incrementarPendingReturns', { actual })
}

/** 2 -> 1. Con `actual` menor o igual a 1 es error, no 0. */
export function decrementarPendingReturns(actual: number): Result<number, ErrorPendingReturns> {
  return noImplementado('decrementarPendingReturns', { actual })
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
  return noImplementado('resolverPick', { contenidoDelSlotQueYaTieneElCajon })
}
