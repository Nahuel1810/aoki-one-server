import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { Button } from './button'
import { cn } from '@/lib/cn'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

function Overlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn('animate-overlay fixed inset-0 z-50 bg-ink/45', className)}
      {...props}
    />
  )
}

export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        className={cn(
          'animate-panel fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
          'w-[min(34rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto',
          'rounded-panel border border-border bg-surface p-6 shadow-xl',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function DialogHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="grid gap-2 pr-10">
      <DialogPrimitive.Title className="text-xl font-bold text-ink">{title}</DialogPrimitive.Title>
      {description ? (
        <DialogPrimitive.Description asChild>
          <div className="text-base text-ink-muted">{description}</div>
        </DialogPrimitive.Description>
      ) : (
        // Radix avisa por consola si falta descripcion; la ocultamos accesiblemente.
        <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
      )}
    </div>
  )
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex flex-wrap justify-end gap-3">{children}</div>
}

/**
 * Panel lateral para acciones que no son de rutina (RF10).
 * Ocupa el borde derecho para quedar al alcance del pulgar en la tablet.
 */
export function Sheet({
  className,
  children,
  title,
  description,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { title: string; description?: string }) {
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        className={cn(
          'animate-sheet fixed inset-y-0 right-0 z-50 flex flex-col',
          'w-[min(32rem,100vw)] border-l border-border bg-surface shadow-2xl',
          className,
        )}
        {...props}
      >
        <header className="flex items-center justify-between gap-4 border-b border-border py-3 pr-3 pl-5">
          <div className="grid gap-0.5">
            <DialogPrimitive.Title className="text-lg font-bold text-ink">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description
              className={cn('text-sm text-ink-muted', !description && 'sr-only')}
            >
              {description ?? title}
            </DialogPrimitive.Description>
          </div>
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="compact" className="w-12 px-0" aria-label="Cerrar">
              <X />
            </Button>
          </DialogPrimitive.Close>
        </header>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}
