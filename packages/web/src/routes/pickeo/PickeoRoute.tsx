import { Plus } from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { useCreatePutOrder } from '@/api/mutations'
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
 * es tocar un cajón. Los pedidos van abajo y solo ocupan lugar cuando hay algo
 * en curso. Pedir o guardar a mano es una acción de vez en cuando, así que el
 * botón es secundario.
 */
export function PickeoRoute() {
  const slots = useSlots()
  const orders = useOrders()
  const createPut = useCreatePutOrder()
  const [askTarget, setAskTarget] = useState<Slot | null>(null)

  const isFirstLoad = slots.isPending || orders.isPending
  const failedWithoutData = slots.isError && slots.data === undefined
  const pending = operationalOrders(orders.data ?? [])

  /**
   * Tocar un cajón lo manda a guardar directo: el pedido aparece abajo al
   * instante y desde ahí se puede cancelar, así que un toque de más se
   * deshace sin costo. Solo se pregunta cuando el sistema no sabe de dónde
   * salió el cajón, porque ahí falta un dato que nadie más tiene.
   */
  function handleReturn(slot: Slot) {
    const registered = slot.currentBox?.sourceLocationCode

    if (registered) {
      // El destino viaja explícito: es la ubicación de la que salió el cajón.
      createPut.mutate({ slotLocationCode: slot.locationCode, targetLocation: registered })
      return
    }

    setAskTarget(slot)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <section className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-extrabold tracking-tight">Zona de pickeo</h1>

          <div className="flex items-center gap-3">
            {createPut.isError && (
              <p role="alert" className="text-sm font-semibold text-fault-ink">
                {errorMessage(createPut.error)}
              </p>
            )}
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
          <SlotBoard slots={slots.data} orders={orders.data ?? []} onReturn={handleReturn} />
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
        slot={askTarget}
        onClose={() => {
          setAskTarget(null)
        }}
      />
    </div>
  )
}
