// Portado de tests/unit/stateManager.test.js — RF07, refcount de devoluciones
// pendientes.
//
// Sale del mega-test "StateManager administra slots y los persiste en snapshot",
// que afirmaba `incrementLogicalPickStack` -> 2 y `decrementLogicalPickStack` ->
// 1. El componente cambia: `logicalPickStackDepth` se renombra a
// `pendingReturns` (RF07 lo dice literal) y el contador deja de vivir en el
// StateManager para ser una funcion pura del dominio. Los valores se conservan:
// al ocupar arranca en 1 (eso se afirma en slotStateMachine.aceptacion.test.ts,
// sobre el evento OCUPAR), incrementa a 2 y decrementa a 1.
//
// CAMBIO DE CONTRATO: el piso de 1. El legacy lo tenia —
// `decrementLogicalPickStack` lanza "logicalPickStackDepth no puede
// decrementarse por debajo de 1" — pero ningun test lo cubria. Aca es un Result
// de error tipado, no una excepcion: el dominio no tira. Que el piso sea error
// explicito y no un clamp silencioso importa porque un contador roto devuelve el
// cajon de menos y deja un pedido sin atender, que es justamente el motivo por
// el que el refcount existe.

import { describe, expect, it } from 'vitest'

import { decrementarPendingReturns, incrementarPendingReturns } from './pendingReturns.js'

describe('pendingReturns', () => {
  it('incrementa de 1 a 2 cuando un segundo pedido reclama el mismo cajon', () => {
    expect(incrementarPendingReturns(1)).toEqual({ ok: true, valor: 2 })
  })

  it('decrementa de 2 a 1 cuando se atiende uno de los dos pedidos', () => {
    expect(decrementarPendingReturns(2)).toEqual({ ok: true, valor: 1 })
  })

  it('no baja de 1: decrementar con el contador en 1 es error del dominio', () => {
    expect(decrementarPendingReturns(1)).toEqual({
      ok: false,
      error: { codigo: 'PENDING_RETURNS_FUERA_DE_RANGO', actual: 1 },
    })
  })
})
