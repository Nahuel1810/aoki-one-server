// RF07, segunda mitad — un PUT con devoluciones pendientes de mas NO mueve el robot.
//
// DIVERGENCIA CORREGIDA contra el servidor de produccion. El legacy resuelve
// esto en `src/core/orchestrator/OrchestratorService.js:248-253`:
//
//   const stackDepth = this.stateManager.getLogicalPickStackDepth(slotLocationCode);
//   if (stackDepth > 1) {
//     this.stateManager.decrementLogicalPickStack(slotLocationCode);
//     steps = [];
//     logicalReturnOnly = true;
//   }
//
// y la orden marcada `logicalReturnOnly` termina DONE sin un solo paso fisico
// (misma clase, lineas 480-495). El sistema nuevo tenia el contador
// (`decrementarPendingReturns`) pero NADIE lo llamaba: todo PUT ejecutaba la
// maniobra. Con dos pedidos del mismo cajon eso significa que el primer PUT se
// lleva el cajon y libera el slot mientras el segundo pedido lo sigue
// esperando: el operario va al slot y no hay nada.
//
// Los valores son concretos a proposito: lo que se afirma es el CONTADOR, no
// que la funcion no tire.

import { describe, expect, it } from 'vitest'

import { resolverPut } from './pendingReturns.js'
import type { CajonEnSlot } from './slotStateMachine.js'

function contenido(pendingReturns: number): CajonEnSlot {
  return { cajon: { id: 'caja-1', ubicacionDeOrigen: '3X04AA3' }, pendingReturns }
}

describe('resolverPut (RF07)', () => {
  it('con una sola devolucion pendiente ejecuta la maniobra: este PUT si mueve el cajon', () => {
    expect(resolverPut(contenido(1))).toEqual({
      ok: true,
      valor: { tipo: 'EJECUTAR_MANIOBRA' },
    })
  })

  it('con dos devoluciones pendientes decrementa a 1 y termina sin maniobra', () => {
    // El segundo pedido del mismo cajon todavia lo reclama: el cajon se queda.
    expect(resolverPut(contenido(2))).toEqual({
      ok: true,
      valor: { tipo: 'TERMINAR_SIN_MANIOBRA', pendingReturns: 1 },
    })
  })

  it('con tres devoluciones pendientes decrementa a 2: solo el ULTIMO PUT devuelve', () => {
    expect(resolverPut(contenido(3))).toEqual({
      ok: true,
      valor: { tipo: 'TERMINAR_SIN_MANIOBRA', pendingReturns: 2 },
    })
  })

  it('propaga el error cuando el contador del slot esta corrupto', () => {
    // 2.5 es mayor que 1 —o sea que entra por la rama del decremento— pero no es
    // un entero valido. Se rechaza explicito en vez de redondear en silencio:
    // un contador que se rompe se traduce en un cajon devuelto de menos.
    expect(resolverPut(contenido(2.5))).toEqual({
      ok: false,
      error: { codigo: 'PENDING_RETURNS_FUERA_DE_RANGO', actual: 2.5 },
    })
  })
})
