import { errorMessage } from '@/api/client'
import { useOrderAction } from '@/api/mutations'
import type { Order } from '@/api/schemas'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { orderStatusLabel, orderStatusTone, orderTypeLabel } from '@/design/status'
import { cn } from '@/lib/cn'
import { operationalOrders, orderLocationLabel } from './orders'

function OrderCard({ order }: { order: Order }) {
  const retry = useOrderAction('retry')
  const cancel = useOrderAction('cancel')
  const isError = order.status === 'ERROR'
  const isActive = order.status === 'IN_PROGRESS'
  const steps = order.steps.length
  const progress = steps > 0 ? ((order.currentStepIndex + 1) / steps) * 100 : 0
  const actionError = retry.error ?? cancel.error

  return (
    <li
      className={cn(
        'relative grid min-w-64 shrink-0 content-start gap-2 overflow-hidden rounded-control border p-3 shadow-card',
        isError ? 'border-fault-border bg-fault-soft' : 'border-border bg-surface',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-0 w-1',
          isError ? 'bg-fault' : isActive ? 'bg-motion' : 'bg-border-strong',
        )}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 pl-2">
        <span className="font-semibold">
          <span className="text-ink-muted">{orderTypeLabel(order.type)}</span>{' '}
          <span className="font-code text-base font-extrabold">{orderLocationLabel(order)}</span>
        </span>
        <Badge tone={orderStatusTone(order.status)}>{orderStatusLabel(order.status)}</Badge>
      </div>

      {/* Barra de avance en vez de "Paso 3 de 5": se lee sin leer. */}
      {isActive && steps > 0 && (
        <span aria-hidden className="ml-2 h-1.5 overflow-hidden rounded-full bg-surface-muted">
          <span
            className="block h-full rounded-full bg-motion transition-all duration-500"
            style={{ width: `${String(progress)}%` }}
          />
        </span>
      )}

      {order.waitingForSlot && (
        <span className="pl-2 text-xs font-semibold text-ink-muted">Esperando lugar libre</span>
      )}

      {isError && order.errorReason && (
        <p className="pl-2 text-xs font-medium text-fault-ink">{order.errorReason}</p>
      )}

      {/*
       * Reintentar y cancelar solo aparecen en pedidos trabados (RF08).
       * En el front anterior estaban en todas las tarjetas, invitando a
       * cancelar por accidente uno que venia bien.
       */}
      {isError && (
        <div className="flex flex-wrap gap-2 pl-2">
          <Button
            variant="secondary"
            size="compact"
            disabled={retry.isPending}
            onClick={() => {
              retry.mutate(order.id)
            }}
          >
            Reintentar
          </Button>
          <Button
            variant="ghost"
            size="compact"
            disabled={cancel.isPending}
            onClick={() => {
              cancel.mutate(order.id)
            }}
          >
            Cancelar
          </Button>
        </div>
      )}

      {actionError && (
        <p role="alert" className="pl-2 text-xs font-semibold text-fault-ink">
          {errorMessage(actionError)}
        </p>
      )}
    </li>
  )
}

/**
 * Los pedidos van debajo del tablero, en fila: son contexto de lo que el
 * robot esta haciendo, no la tarea principal.
 */
export function OrderQueue({ orders }: { orders: Order[] }) {
  const rows = operationalOrders(orders)

  if (rows.length === 0) {
    return null
  }

  return (
    <ul className="flex gap-2 overflow-x-auto pb-1">
      {rows.map((order) => (
        <OrderCard key={order.id} order={order} />
      ))}
    </ul>
  )
}
