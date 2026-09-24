// RF06 y RF21 — La salida del operario sobre un slot, a nivel dominio.
//
// El legacy libera un slot MIRE LO QUE MIRE su estado (`StateManager.releaseSlot`
// pisa status, reservedByOrderId y currentBox sin condicion). La maquina de
// estados de esta version solo dejaba salir por LIBERAR desde OCUPADO y
// DEVOLVIENDO, asi que un PICK que fallaba dejaba el slot en RESERVADO o
// BUSCANDO y no habia ninguna transicion que lo sacara: doce fallos de ese tipo
// dejan la zona de pickeo entera inutilizable.
//
// Se afirman los dos eventos por separado a proposito: LIBERAR sigue siendo el
// cierre de la maniobra y sigue rechazando desde BUSCANDO —si el ciclo pudiera
// cerrar un PICK sin haber apoyado el cajon, el slot quedaria LIBRE con un cajon
// arriba—, y LIBERAR_MANUAL es la salida que pide una persona.

import { describe, expect, it } from 'vitest'

import { transicionarSlot } from './slotStateMachine.js'
import type { EstadoSlot } from './slotStateMachine.js'

const CAJON = { id: 'CAJON-1', ubicacionDeOrigen: '3X04AA3' }

/** Un estado por variante de la union. Es la tabla que el evento tiene que cubrir entera. */
const TODOS_LOS_ESTADOS: readonly EstadoSlot[] = [
  { estado: 'LIBRE' },
  { estado: 'RESERVADO', ordenId: 'ORD-1', contenido: null },
  { estado: 'BUSCANDO', ordenId: 'ORD-1' },
  { estado: 'OCUPADO', contenido: { cajon: CAJON, pendingReturns: 1 } },
  { estado: 'DEVOLVIENDO', ordenId: 'ORD-1', contenido: null },
  { estado: 'ERROR', motivo: 'cajon trabado' },
]

describe('liberacion manual de un slot de pickeo', () => {
  it('LIBERAR_MANUAL deja LIBRE desde cualquiera de los seis estados', () => {
    for (const estado of TODOS_LOS_ESTADOS) {
      const resultado = transicionarSlot(estado, { tipo: 'LIBERAR_MANUAL' })

      expect(resultado.ok).toBe(true)
      if (resultado.ok) {
        expect(resultado.valor).toEqual({ estado: 'LIBRE' })
      }
    }
  })

  it('LIBERAR sigue siendo el cierre de la maniobra y rechaza desde BUSCANDO y RESERVADO', () => {
    const desdeBuscando = transicionarSlot({ estado: 'BUSCANDO', ordenId: 'ORD-1' }, { tipo: 'LIBERAR' })
    expect(desdeBuscando.ok).toBe(false)
    if (!desdeBuscando.ok) {
      expect(desdeBuscando.error).toEqual({
        codigo: 'TRANSICION_INVALIDA',
        desde: 'BUSCANDO',
        evento: 'LIBERAR',
      })
    }

    const desdeReservado = transicionarSlot(
      { estado: 'RESERVADO', ordenId: 'ORD-1', contenido: null },
      { tipo: 'LIBERAR' },
    )
    expect(desdeReservado.ok).toBe(false)
  })

  it('el slot liberado a mano queda tomable de nuevo por un PICK', () => {
    // Es la razon de ser de la salida: que el slot VUELVA a la zona util, no que
    // quede en un estado terminal distinto.
    const liberado = transicionarSlot({ estado: 'BUSCANDO', ordenId: 'ORD-1' }, { tipo: 'LIBERAR_MANUAL' })
    expect(liberado.ok).toBe(true)
    if (!liberado.ok) {
      return
    }

    const reservado = transicionarSlot(liberado.valor, {
      tipo: 'RESERVAR_PARA_PICK',
      ordenId: 'ORD-2',
    })
    expect(reservado.ok).toBe(true)
    if (reservado.ok) {
      expect(reservado.valor).toEqual({ estado: 'RESERVADO', ordenId: 'ORD-2', contenido: null })
    }
  })
})
