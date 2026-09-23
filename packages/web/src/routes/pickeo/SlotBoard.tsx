import type { Order, Slot } from '@/api/schemas'
import { EmptyPanel } from '@/components/feedback/LoadingPanel'
import { buildBoards, indexOrders, slotDisplay, type RobotBoard } from './board'
import { SlotCard, SlotPlaceholder } from './SlotCard'

type SlotBoardProps = {
  slots: Slot[]
  orders: Order[]
  onReturn: (slot: Slot) => void
}

function BoardGrid({
  board,
  ordersById,
  onReturn,
}: {
  board: RobotBoard
  ordersById: Map<string, Order>
  onReturn: (slot: Slot) => void
}) {
  const { leftColumns, rightColumns } = board
  // Los dos lados van en la misma grilla para que un nivel quede en una sola
  // fila visual, como esta fisicamente en la estanteria.
  const columns = [
    `repeat(${String(leftColumns)}, minmax(0, 1fr))`,
    rightColumns > 0 ? `0.75rem repeat(${String(rightColumns)}, minmax(0, 1fr))` : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className="grid min-h-0 flex-1 gap-2.5"
      style={{ gridTemplateColumns: columns, gridAutoRows: 'minmax(7rem, 1fr)' }}
    >
      {board.rows.map((row) => {
        const key = row.level ?? 'sin-nivel'

        return (
          <div key={key} className="contents">
            {Array.from({ length: leftColumns }, (_, index) => {
              const slot = row.left[index]
              return slot ? (
                <SlotCard
                  key={slot.locationCode}
                  slot={slot}
                  display={slotDisplay(slot, ordersById)}
                  onReturn={slot.status === 'OCUPADO' ? onReturn : null}
                />
              ) : (
                <SlotPlaceholder key={`${String(key)}-l${String(index)}`} />
              )
            })}

            {rightColumns > 0 && (
              <div
                aria-hidden
                className="mx-auto h-full w-px bg-border-strong"
                key={`${String(key)}-sep`}
              />
            )}

            {Array.from({ length: rightColumns }, (_, index) => {
              const slot = row.right[index]
              return slot ? (
                <SlotCard
                  key={slot.locationCode}
                  slot={slot}
                  display={slotDisplay(slot, ordersById)}
                  onReturn={slot.status === 'OCUPADO' ? onReturn : null}
                />
              ) : (
                <SlotPlaceholder key={`${String(key)}-r${String(index)}`} />
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

export function SlotBoard({ slots, orders, onReturn }: SlotBoardProps) {
  const boards = buildBoards(slots)
  const ordersById = indexOrders(orders)

  if (boards.length === 0) {
    return <EmptyPanel label="No hay lugares de pickeo configurados" />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      {boards.map((board) => (
        <section key={board.robotId} className="flex min-h-0 flex-1 flex-col gap-3">
          {/* El encabezado por robot solo aparece cuando hay mas de uno. */}
          {boards.length > 1 && (
            <h2 className="text-sm font-bold tracking-wide text-ink-muted uppercase">
              Robot {board.robotId}
            </h2>
          )}
          <BoardGrid board={board} ordersById={ordersById} onReturn={onReturn} />
        </section>
      ))}
    </div>
  )
}
