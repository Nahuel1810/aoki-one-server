import type { Order, Slot } from '@/api/schemas'

/**
 * Disposicion del tablero a partir de los datos de la API.
 *
 * El front anterior tenia la lista de slots escrita a mano en el navegador
 * (RIGHT_PICK_SLOTS / LEFT_PICK_SLOTS), duplicando config/pickSlots.js. Aca no
 * se asume ninguna ubicacion: el tablero es exactamente lo que /api/slots
 * devuelva, ordenado con los campos `side`, `level` y `position` que el propio
 * backend deriva.
 */

export type BoardRow = {
  /** Nivel fisico. `null` agrupa los slots sin nivel informado. */
  level: number | null
  left: Slot[]
  right: Slot[]
}

export type RobotBoard = {
  robotId: string
  rows: BoardRow[]
  /** Ancho maximo de cada lado, para que todas las filas queden alineadas. */
  leftColumns: number
  rightColumns: number
}

function byPositionDesc(a: Slot, b: Slot): number {
  // Posicion mas alta primero: es el orden en que se ven desde el pasillo.
  return (b.position ?? 0) - (a.position ?? 0) || a.locationCode.localeCompare(b.locationCode)
}

export function buildBoards(slots: Slot[]): RobotBoard[] {
  const byRobot = new Map<string, Slot[]>()

  for (const slot of slots) {
    const robotId = slot.robotId ?? 'sin-robot'
    const group = byRobot.get(robotId)
    if (group) {
      group.push(slot)
    } else {
      byRobot.set(robotId, [slot])
    }
  }

  return [...byRobot.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([robotId, robotSlots]) => {
      const byLevel = new Map<number | null, Slot[]>()

      for (const slot of robotSlots) {
        const level = slot.level
        const group = byLevel.get(level)
        if (group) {
          group.push(slot)
        } else {
          byLevel.set(level, [slot])
        }
      }

      const rows: BoardRow[] = [...byLevel.entries()]
        // Nivel mas alto arriba, como esta fisicamente.
        .sort(([a], [b]) => (b ?? -1) - (a ?? -1))
        .map(([level, levelSlots]) => ({
          level,
          left: levelSlots.filter((slot) => slot.side !== 'RIGHT').sort(byPositionDesc),
          right: levelSlots.filter((slot) => slot.side === 'RIGHT').sort(byPositionDesc),
        }))

      return {
        robotId,
        rows,
        leftColumns: Math.max(0, ...rows.map((row) => row.left.length)),
        rightColumns: Math.max(0, ...rows.map((row) => row.right.length)),
      }
    })
}

export type SlotDisplay = {
  /** Codigo del cajon. Es el unico dato de la celda. */
  code: string | null
}

/**
 * Que muestra una celda.
 *
 * Un slot con cajon encima muestra la ubicacion de ese cajon: es el codigo que
 * el operario ve en la app de picking. Uno en maniobra muestra el cajon que
 * viene (PICK) o el que se esta guardando (PUT), que sale de la orden que
 * reservo el slot. Que esta pasando lo dice el estado, no un texto aparte.
 */
export function slotDisplay(slot: Slot, ordersById: Map<string, Order>): SlotDisplay {
  if (slot.status === 'OCUPADO') {
    return { code: slot.currentBox?.sourceLocationCode ?? null }
  }

  if (slot.status === 'LIBRE') {
    return { code: null }
  }

  const order = slot.reservedByOrderId ? ordersById.get(slot.reservedByOrderId) : undefined

  if (!order) {
    return { code: null }
  }

  return {
    code: order.type === 'PICK' ? order.locationCode : (order.targetLocation ?? order.locationCode),
  }
}

export function indexOrders(orders: Order[]): Map<string, Order> {
  return new Map(orders.map((order) => [order.id, order]))
}
