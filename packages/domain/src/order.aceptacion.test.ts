// Portado de tests/unit/stateManager.test.js — "StateManager crea y actualiza
// orden", parte de dominio (RF06).
//
// El legacy creaba la orden con `createOrder`, afirmaba `status === 'PENDING'` y
// despues `updateOrder(id, { status: 'IN_PROGRESS' })`. Dos cosas cambian.
//
// CAMBIO DE CONTRATO (1): el almacen. `createOrder`/`updateOrder` eran un Map en
// memoria y pasan a ser repositorio SQLite (RF23); la persistencia y la relectura
// de la orden no se afirman aca sino en el repositorio del agente. Lo que queda
// en el dominio es la transicion pura.
//
// CAMBIO DE CONTRATO (2): `updateOrder({ status })` era un merge generico que
// aceptaba CUALQUIER salto de estado, incluido PENDING -> DONE directo, sin que
// nadie se entere. El assert legacy pasaba por construccion: no podia fallar
// salvo que se rompiera el Map. Ahora la transicion la valida una funcion total
// del dominio y el test agrega el caso negativo que el legacy no tenia.

import { describe, expect, it } from 'vitest'

import { transicionarOrden } from './order.js'

describe('maquina de estados de la orden', () => {
  it('una orden PENDING pasa a IN_PROGRESS cuando el robot la toma', () => {
    const resultado = transicionarOrden('PENDING', {
      tipo: 'INICIAR',
      robotId: '1',
    })

    expect(resultado).toEqual({ ok: true, valor: 'IN_PROGRESS' })
  })

  it('una orden IN_PROGRESS termina en DONE', () => {
    const resultado = transicionarOrden('IN_PROGRESS', { tipo: 'COMPLETAR' })

    expect(resultado).toEqual({ ok: true, valor: 'DONE' })
  })

  // El caso negativo que el merge generico del legacy dejaba pasar: saltar a DONE
  // sin haber pasado por IN_PROGRESS. Bajo RF06 es error del dominio, no un
  // estado silencioso.
  it('PENDING + COMPLETAR falla: no se puede saltar a DONE sin pasar por IN_PROGRESS', () => {
    const resultado = transicionarOrden('PENDING', { tipo: 'COMPLETAR' })

    expect(resultado).toEqual({
      ok: false,
      error: {
        codigo: 'TRANSICION_INVALIDA',
        desde: 'PENDING',
        evento: 'COMPLETAR',
      },
    })
  })
})
