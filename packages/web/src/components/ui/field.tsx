import * as LabelPrimitive from '@radix-ui/react-label'
import type { ComponentProps, ReactNode } from 'react'
import { useId } from 'react'
import { cn } from '@/lib/cn'

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('block text-sm font-semibold text-ink', className)}
      {...props}
    />
  )
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-touch w-full rounded-control border border-border-strong bg-surface px-4',
        'text-base text-ink placeholder:text-ink-subtle',
        'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-subtle',
        className,
      )}
      {...props}
    />
  )
}

type FieldProps = {
  label: string
  hint?: string
  error?: string | undefined
  children: (props: { id: string; 'aria-describedby': string | undefined }) => ReactNode
}

/**
 * Agrupa etiqueta, control, ayuda y error con los `id`/`aria-describedby`
 * ya conectados, para no tener que cablearlos a mano en cada formulario.
 */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-describedby': describedBy })}
      {hint && !error && (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm font-medium text-fault-ink">
          {error}
        </p>
      )}
    </div>
  )
}
