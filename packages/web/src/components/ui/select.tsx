import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

export const Select = SelectPrimitive.Root
export const SelectValue = SelectPrimitive.Value

/**
 * Se usa Radix en lugar del `<select>` nativo porque las opciones necesitan
 * dos lineas (ubicación + cajón) y porque los items nativos no llegan al
 * objetivo tactil de 56px de forma consistente entre navegadores.
 */
export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'flex h-touch w-full items-center justify-between gap-2 rounded-control',
        'border border-border-strong bg-surface px-4 text-left text-base text-ink',
        'data-[placeholder]:text-ink-subtle',
        'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-subtle',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-5 shrink-0 text-ink-subtle" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

export function SelectContent({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={4}
        className={cn(
          'animate-panel z-50 max-h-80 w-[var(--radix-select-trigger-width)] overflow-hidden',
          'rounded-control border border-border bg-surface shadow-xl',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex min-h-touch cursor-pointer items-center gap-3 rounded-control',
        'px-3 py-2 pr-10 text-base text-ink outline-none select-none',
        'data-[highlighted]:bg-surface-muted',
        'data-[disabled]:pointer-events-none data-[disabled]:text-ink-subtle',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-3">
        <Check className="size-5" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}
