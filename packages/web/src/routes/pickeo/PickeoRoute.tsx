import { Plus } from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { useOrders, useSlots } from '@/api/queries'
import type { Slot } from '@/api/schemas'
import { ErrorPanel, LoadingPanel } from '@/components/feedback/LoadingPanel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogTrigger } from '@/components/ui/dialog'
import { ManualActionsSheet } from './ManualActionsSheet'
import { OrderQueue } from './OrderQueue'
import { operationalOrders } from './orders'
import { ReturnBoxDialog } from './ReturnBoxDialog'
import { SlotBoard } from './SlotBoard'

/**
 * Vista principal.
 *
 * El tablero es la tarea: se lleva el ancho completo y lo que el operario hace
 * es tocar un cajon. Los pedidos van abajo y solo ocupan lugar cuando hay algo
 * en curso. Pedir o guardar a mano es una accion de vez en cuando, asi que el
 * boton es secundario.
 */
export function PickeoRoute() {
  const slots = useSlots()
  const orders = useOrders()
  const [returning, setReturning] = useState<Slot | null>(null)

  const isFirstLoad = slots.isPending || orders.isPending
  const failedWithoutData = slots.isError && slots.data === undefined
  const pending = operationalOrders(orders.data ?? [])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <section className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-extrabold tracking-tight">Zona de pickeo</h1>

          <Dialog>
            <DialogTrigger asChild>
              <Button variant="secondary" size="compact">
                <Plus aria-hidden />
                Pedir o guardar
              </Button>
            </DialogTrigger>
            <ManualActionsSheet slots={slots.data ?? []} />
          </Dialog>
        </div>

        {isFirstLoad ? (
          <LoadingPanel label="Cargando" className="min-h-72" />
        ) : failedWithoutData ? (
          <ErrorPanel
            message={errorMessage(slots.error)}
            onRetry={() => {
              void slots.refetch()
            }}
          />
        ) : (
          <SlotBoard slots={slots.data} orders={orders.data ?? []} onReturn={setReturning} />
        )}
      </section>

      {orders.isError && orders.data === undefined ? (
        <ErrorPanel
          message={errorMessage(orders.error)}
          onRetry={() => {
            void orders.refetch()
          }}
        />
      ) : (
        pending.length > 0 && (
          <section className="grid shrink-0 gap-2">
            <h2 className="text-sm font-bold tracking-wide text-ink-muted uppercase">
              Pedidos en curso
            </h2>
            <OrderQueue orders={orders.data ?? []} />
          </section>
        )
      )}

      <ReturnBoxDialog
        slot={returning}
        onClose={() => {
          setReturning(null)
        }}
      />
    </div>
  )
}
