// RF21 — Desde que estados se puede cancelar una orden.
//
// La cancelacion no tenia transicion declarada: `CANCELED` existia como valor
// persistido y ningun evento lo producia, asi que el boton de la tablet no tenia
// contra que apoyarse. Lo que fija este test no es que la transicion exista sino
// DONDE se corta, que es la parte que importa: cancelar es sacar de la cola, y
// una orden que el robot ya esta ejecutando no esta en la cola, esta en el aire.

import { describe, expect, it } from 'vitest'

import { transicionarOrden, type EstadoOrden } from './order.js'

describe('cancelacion de una orden (RF21)', () => {
  it('una orden PENDING se cancela: todavia no se movio nada', () => {
    const resultado = transicionarOrden('PENDING', { tipo: 'CANCELAR' })

    expect(resultado).toEqual({ ok: true, valor: 'CANCELED' })
  })

  // El caso que de verdad tiene que fallar. Marcarla cancelada no frena al carro
  // —el ciclo que la ejecuta esta adentro del handshake con el PLC—, asi que el
  // cajon quedaria a mitad de camino con los libros diciendo que no hay nada en
  // curso, y el proximo pedido chocaria contra un cajon que no esta donde el
  // sistema cree.
  it('una orden IN_PROGRESS NO se cancela: el cajon quedaria a mitad de camino', () => {
    const resultado = transicionarOrden('IN_PROGRESS', { tipo: 'CANCELAR' })

    expect(resultado).toEqual({
      ok: false,
      error: { codigo: 'TRANSICION_INVALIDA', desde: 'IN_PROGRESS', evento: 'CANCELAR' },
    })
  })

  // DONE y CANCELED ya salieron de la cola; ERROR sale por REINTENTAR, que es el
  // camino que RF13 le da al operario despues de devolver el cajon a mano.
  it.each<EstadoOrden>(['DONE', 'ERROR', 'CANCELED'])(
    'una orden %s ya no esta en la cola y no se vuelve a cancelar',
    (estado) => {
      const resultado = transicionarOrden(estado, { tipo: 'CANCELAR' })

      expect(resultado).toEqual({
        ok: false,
        error: { codigo: 'TRANSICION_INVALIDA', desde: estado, evento: 'CANCELAR' },
      })
    },
  )
})
