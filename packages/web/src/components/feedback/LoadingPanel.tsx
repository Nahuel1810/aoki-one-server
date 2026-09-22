import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'

/** Estado de carga explicito: nunca una pantalla en blanco (RF22). */
export function LoadingPanel({ label, className }: { label: string; className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        'flex min-h-40 items-center justify-center gap-3 rounded-panel',
        'border border-border bg-surface/70 text-ink-muted shadow-card',
        className,
      )}
    >
      <Loader2 className="size-5 animate-spin text-brand-500" aria-hidden />
      <span className="text-base font-medium">{label}</span>
    </div>
  )
}

/** Hay respuesta del servidor, pero no hay nada que mostrar. */
export function EmptyPanel({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="grid min-h-32 place-items-center gap-1 rounded-panel border border-dashed border-border-strong bg-surface/50 p-6 text-center">
      <p className="text-base font-semibold text-ink-muted">{label}</p>
      {hint && <p className="text-sm text-ink-subtle">{hint}</p>}
    </div>
  )
}

/** Error de carga de una seccion, sin tumbar el resto de la pantalla. */
export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="grid gap-3 rounded-panel border border-fault-border bg-fault-soft p-6 shadow-card"
    >
      <p className="font-semibold text-fault-ink">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="h-12 justify-self-start rounded-control border border-fault-border bg-surface px-4 font-semibold text-fault-ink shadow-sm"
        >
          Reintentar
        </button>
      )}
    </div>
  )
}
