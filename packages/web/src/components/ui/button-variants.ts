import { cva } from 'class-variance-authority'
import { cn } from '@/lib/cn'

/**
 * La accion primaria usa el teal de marca. Ningun color de estado lo usa, asi
 * que un boton nunca se lee como un estado de la operacion.
 *
 * `danger` es para lo que mueve el robot o corrige datos a mano.
 * `onDark` es para el header.
 *
 * Los tamanos arrancan en 56px (--spacing-touch) porque la tablet se opera
 * de pie y con guantes.
 */
export const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-2 rounded-control',
    'font-semibold whitespace-nowrap select-none',
    'transition-all duration-150',
    'disabled:pointer-events-none disabled:opacity-40',
    '[&_svg]:size-5 [&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        primary: 'bg-action text-action-fg shadow-card hover:bg-action-hover active:scale-[0.99]',
        secondary: cn(
          'border border-border-strong bg-surface text-ink shadow-sm',
          'hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800',
        ),
        danger: 'bg-fault text-white shadow-card hover:bg-fault-ink active:scale-[0.99]',
        ghost: 'bg-transparent text-ink-muted hover:bg-surface-muted hover:text-ink',
        onDark: 'bg-white/10 text-white hover:bg-white/20 active:scale-[0.99]',
      },
      size: {
        touch: 'h-touch min-w-touch px-6 text-base',
        lg: 'h-touch-lg min-w-touch-lg px-8 text-lg',
        compact: 'h-12 px-4 text-sm',
        icon: 'h-touch w-touch p-0',
      },
      block: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'touch',
      block: false,
    },
  },
)
