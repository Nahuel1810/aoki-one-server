import { describe, expect, it } from 'vitest'
import { buildBoards, indexOrders, slotDisplay } from './board'
import { makeOrder, makeSlot } from '@/test/factories'

/** Los 12 slots reales de la instalacion, tal como los devuelve /api/slots. */
function realSlots() {
  const codes: [string, 'LEFT' | 'RIGHT', number, number][] = [
    ['3X01AA1', 'LEFT', 1, 1],
    ['3X01AA2', 'LEFT', 1, 2],
    ['3X01AA3', 'LEFT', 1, 3],
    ['3X01AC1', 'LEFT', 3, 1],
    ['3X01AC2', 'LEFT', 3, 2],
    ['3X01AC3', 'LEFT', 3, 3],
    ['3X01AE1', 'LEFT', 5, 1],
    ['3X01AE2', 'LEFT', 5, 2],
    ['3X01AE3', 'LEFT', 5, 3],
    ['3X02AA1', 'RIGHT', 1, 1],
    ['3X02AC1', 'RIGHT', 3, 1],
    ['3X02AE1', 'RIGHT', 5, 1],
  ]

  return codes.map(([locationCode, side, level, position]) =>
    makeSlot({ id: locationCode, locationCode, side, level, position }),
  )
}

describe('buildBoards', () => {
  it('reproduce la disposicion fisica de la instalacion real', () => {
    const [board] = buildBoards(realSlots())

    expect(board).toBeDefined()
    expect(board?.robotId).toBe('1')
    expect(board?.leftColumns).toBe(3)
    expect(board?.rightColumns).toBe(1)

    // Nivel mas alto arriba y posicion mas alta primero: el mismo orden que
    // el tablero anterior tenia escrito a mano en el navegador.
    expect(board?.rows.map((row) => row.level)).toEqual([5, 3, 1])
    expect(board?.rows[0]?.left.map((slot) => slot.locationCode)).toEqual([
      '3X01AE3',
      '3X01AE2',
      '3X01AE1',
    ])
    expect(board?.rows[0]?.right.map((slot) => slot.locationCode)).toEqual(['3X02AE1'])
  })

  it('separa los slots por robot y los ordena', () => {
    const boards = buildBoards([
      makeSlot({ id: 'b', locationCode: '4X01AA1', robotId: '2' }),
      makeSlot({ id: 'a', locationCode: '3X01AA1', robotId: '1' }),
    ])

    expect(boards.map((board) => board.robotId)).toEqual(['1', '2'])
  })

  it('no asume ninguna ubicacion: sin slots no hay tablero', () => {
    expect(buildBoards([])).toEqual([])
  })

  it('tolera un backend anterior a T05, sin lado ni nivel', () => {
    const boards = buildBoards([
      makeSlot({ side: null, level: null, position: null, robotId: null }),
    ])

    expect(boards).toHaveLength(1)
    expect(boards[0]?.robotId).toBe('sin-robot')
    expect(boards[0]?.rows[0]?.left).toHaveLength(1)
  })
})

describe('slotDisplay', () => {
  it('un slot ocupado muestra el origen del cajon que tiene encima', () => {
    const slot = makeSlot({
      status: 'OCUPADO',
      currentBox: { id: 'box-1', sourceLocationCode: '3X07AB2' },
    })

    expect(slotDisplay(slot, new Map())).toEqual({ code: '3X07AB2' })
  })

  it('un slot libre no muestra codigo', () => {
    expect(slotDisplay(makeSlot(), new Map())).toEqual({ code: null })
  })

  it('en camino muestra el cajon que viene', () => {
    const order = makeOrder({ id: 'o1', type: 'PICK', locationCode: '3X09AD1' })
    const slot = makeSlot({ status: 'BUSCANDO', reservedByOrderId: 'o1' })

    expect(slotDisplay(slot, indexOrders([order]))).toEqual({ code: '3X09AD1' })
  })

  it('guardando muestra a donde va el cajon, no el slot', () => {
    const order = makeOrder({
      id: 'o2',
      type: 'PUT',
      locationCode: '3X01AA1',
      targetLocation: '3X09AD1',
    })
    const slot = makeSlot({ status: 'DEVOLVIENDO', reservedByOrderId: 'o2' })

    expect(slotDisplay(slot, indexOrders([order]))).toEqual({ code: '3X09AD1' })
  })

  it('no rompe si la orden que reservo el slot ya no esta', () => {
    const slot = makeSlot({ status: 'BUSCANDO', reservedByOrderId: 'desaparecida' })

    expect(slotDisplay(slot, new Map())).toEqual({ code: null })
  })
})
