import { cva } from 'class-variance-authority'

/**
 * El estado nunca se comunica solo por color (RNF Accesibilidad):
 * este badge siempre lleva texto. El color es refuerzo, no el mensaje.
 */
export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold tracking-wide uppercase shadow-sm',
  {
    variants: {
      tone: {
        neutral: 'border-border-strong bg-surface text-ink-muted',
        ready: 'border-ready bg-ready text-white',
        motion: 'border-motion bg-motion text-white',
        fault: 'border-fault bg-fault text-white',
        online: 'border-online bg-online text-white',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  },
)
