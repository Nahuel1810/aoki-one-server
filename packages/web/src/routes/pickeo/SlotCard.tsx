import type { Slot } from '@/api/schemas'
import { Badge } from '@/components/ui/badge'
import { isSlotInMotion, slotStatusLabel, slotStatusTone } from '@/design/status'
import { cn } from '@/lib/cn'
import type { SlotDisplay } from './board'

/** Superficie y barra de acento por estado. */
const SKIN: Record<string, { card: string; bar: string }> = {
  LIBRE: { card: 'border-border bg-surface/60', bar: 'bg-transparent' },
  OCUPADO: { card: 'border-ready-border bg-ready-soft shadow-card', bar: 'bg-ready' },
  RESERVADO: { card: 'border-motion-border bg-motion-soft shadow-card', bar: 'bg-motion' },
  BUSCANDO: { card: 'border-motion-border bg-motion-soft shadow-card', bar: 'bg-motion' },
  DEVOLVIENDO: { card: 'border-motion-border bg-motion-soft shadow-card', bar: 'bg-motion' },
  ERROR: { card: 'border-fault-border bg-fault-soft shadow-card', bar: 'bg-fault' },
}

type SlotCardProps = {
  slot: Slot
  display: SlotDisplay
  /** Solo los slots con un cajon encima se pueden tocar para devolverlo. */
  onReturn: ((slot: Slot) => void) | null
}

/**
 * Una celda muestra el cajon, no la posicion.
 *
 * En el deposito nadie conoce el codigo del slot de pickeo: lo que se busca es
 * la ubicacion que aparece en la app de picking, que es la del cajon. Que slot
 * es se ve por donde esta la celda en el tablero, que espeja la estanteria.
 */
export function SlotCard({ slot, display, onReturn }: SlotCardProps) {
  const interactive = onReturn !== null
  const inMotion = isSlotInMotion(slot.status)
  const isFree = slot.status === 'LIBRE'
  const skin = SKIN[slot.status] ?? SKIN['LIBRE']

  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          'absolute inset-x-0 top-0 h-1.5 rounded-t-panel',
          skin?.bar,
          inMotion && 'animate-activity',
        )}
      />

      {display.code ? (
        <span className="font-code text-[clamp(1.25rem,13cqw,2.75rem)] leading-none font-extrabold text-ink">
          {display.code}
        </span>
      ) : (
        <span className="text-3xl font-semibold text-ink-subtle/50" aria-hidden>
          —
        </span>
      )}

      {/* El estado nunca se comunica solo por color: el badge lleva texto. */}
      {!isFree && <Badge tone={slotStatusTone(slot.status)}>{slotStatusLabel(slot.status)}</Badge>}
    </>
  )

  const className = cn(
    '@container relative flex h-full min-h-28 flex-col items-center justify-center gap-2 overflow-hidden',
    'rounded-panel border p-3 text-center transition-all',
    skin?.card,
    interactive && 'cursor-pointer hover:-translate-y-0.5 hover:shadow-raised active:translate-y-0',
  )

  // La posicion va en el nombre accesible, no a la vista: sirve al lector de
  // pantalla para ubicar la celda sin ocupar lugar en el tablero.
  const label = `${display.code ?? 'Vacio'}, ${slotStatusLabel(slot.status)}, posicion ${slot.locationCode}`

  if (!interactive) {
    return (
      <div className={className} aria-label={label}>
        {body}
      </div>
    )
  }

  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        onReturn(slot)
      }}
      aria-label={`Guardar ${display.code ?? 'el cajon'}. ${label}`}
    >
      {body}
    </button>
  )
}

/** Hueco para alinear filas de distinto ancho sin romper la grilla. */
export function SlotPlaceholder() {
  return (
    <div
      aria-hidden
      className="h-full min-h-28 rounded-panel border border-dashed border-border/50"
    />
  )
}
