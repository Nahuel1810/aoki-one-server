import { RotateCw, X } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { useOrderAction } from '@/api/mutations'
import type { Order } from '@/api/schemas'
import { Badge } from '@/components/ui/badge'
import { orderStatusLabel, orderStatusTone, orderTypeLabel } from '@/design/status'
import { cn } from '@/lib/cn'
import { operationalOrders, orderBoxLocation } from './orders'

/** Acción al costado: no empuja la tarjeta hacia abajo. */
function InlineAction({
  label,
  icon,
  tone = 'neutral',
  disabled,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  tone?: 'neutral' | 'fault'
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        // Ancho automático: en un cuadrado de 48px la palabra no entra y se
        // sale del borde. El alto fijo mantiene la tarjeta siempre igual.
        'flex h-12 shrink-0 items-center gap-1.5 rounded-control px-3',
        'border text-xs font-bold whitespace-nowrap transition-colors',
        'disabled:pointer-events-none disabled:opacity-40',
        '[&_svg]:size-4',
        tone === 'fault'
          ? 'border-fault-border bg-surface text-fault-ink hover:bg-fault-soft'
          : 'border-border-strong bg-surface text-ink-muted hover:bg-surface-muted hover:text-ink',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function OrderCard({ order }: { order: Order }) {
  const retry = useOrderAction('retry')
  const cancel = useOrderAction('cancel')
  const isError = order.status === 'ERROR'
  const isActive = order.status === 'IN_PROGRESS'
  const steps = order.steps.length
  const progress = steps > 0 ? ((order.currentStepIndex + 1) / steps) * 100 : 0
  const actionError = retry.error ?? cancel.error
  const box = orderBoxLocation(order)
  const isManual = order.origin === 'MANUAL'

  return (
    <li
      className={cn(
        'relative flex min-w-80 shrink-0 items-center gap-3 overflow-hidden rounded-control border p-3 shadow-card',
        isError ? 'border-fault bg-fault-soft' : 'border-border bg-surface',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-0 w-1.5',
          isError ? 'bg-fault' : isActive ? 'bg-motion' : 'bg-border-strong',
        )}
      />

      <div className="grid min-w-0 flex-1 gap-1.5 pl-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm text-ink-muted">{orderTypeLabel(order.type)}</span>
          <span className="font-code text-base font-extrabold">{box ?? '—'}</span>

          {/* De dónde salió el pedido: picking es el flujo normal. */}
          <span
            className={cn(
              'rounded-full border px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase',
              isManual
                ? 'border-brand-200 bg-brand-50 text-brand-800'
                : 'border-border bg-surface-muted text-ink-muted',
            )}
          >
            {isManual ? 'Manual' : 'Picking'}
          </span>

          <Badge tone={orderStatusTone(order.status)} className="ml-auto">
            {orderStatusLabel(order.status)}
          </Badge>
        </div>

        {/* Una sola línea: el motivo del error no puede estirar la tarjeta. */}
        {isError && order.errorReason ? (
          <p className="truncate text-xs font-medium text-fault-ink" title={order.errorReason}>
            {order.errorReason}
          </p>
        ) : order.waitingForSlot ? (
          <p className="truncate text-xs font-semibold text-ink-muted">Esperando lugar libre</p>
        ) : (
          <span
            aria-hidden
            className="h-1.5 overflow-hidden rounded-full bg-surface-muted"
            title={
              steps > 0 ? `Paso ${String(order.currentStepIndex + 1)} de ${String(steps)}` : ''
            }
          >
            <span
              className={cn(
                'block h-full rounded-full transition-all duration-500',
                isActive ? 'bg-motion' : 'bg-transparent',
              )}
              style={{ width: `${String(isActive ? progress : 0)}%` }}
            />
          </span>
        )}

        {actionError && (
          <p role="alert" className="truncate text-xs font-semibold text-fault-ink">
            {errorMessage(actionError)}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {isError && (
          <InlineAction
            label="Reintentar"
            icon={<RotateCw aria-hidden />}
            disabled={retry.isPending}
            onClick={() => {
              retry.mutate(order.id)
            }}
          />
        )}
        {/*
         * Cancelar está en cualquier estado, no solo en error: un pedido
         * mandado por equivocación se saca sin esperar a que falle.
         */}
        <InlineAction
          label="Cancelar"
          icon={<X aria-hidden />}
          tone="fault"
          disabled={cancel.isPending}
          onClick={() => {
            cancel.mutate(order.id)
          }}
        />
      </div>
    </li>
  )
}

/**
 * Los pedidos van debajo del tablero, en fila: son contexto de lo que el
 * robot está haciendo, no la tarea principal.
 */
export function OrderQueue({ orders }: { orders: Order[] }) {
  const rows = operationalOrders(orders)

  if (rows.length === 0) {
    return null
  }

  return (
    <ul className="flex items-stretch gap-2 overflow-x-auto pb-1">
      {rows.map((order) => (
        <OrderCard key={order.id} order={order} />
      ))}
    </ul>
  )
}
