/** Rango de fechas del reporte, en milisegundos epoch. */
export type Range = { from: number; to: number }

export type PresetId = 'hoy' | '7d' | '30d'

export const PRESETS: { id: PresetId; label: string; days: number }[] = [
  { id: 'hoy', label: 'Hoy', days: 0 },
  { id: '7d', label: '7 dias', days: 6 },
  { id: '30d', label: '30 dias', days: 29 },
]

export function startOfDay(date: Date): number {
  const copy = new Date(date)
  copy.setHours(0, 0, 0, 0)
  return copy.getTime()
}

export function endOfDay(date: Date): number {
  const copy = new Date(date)
  copy.setHours(23, 59, 59, 999)
  return copy.getTime()
}

/** Un preset se resuelve contra la fecha que se le pase, no contra el reloj. */
export function rangeFromPreset(preset: PresetId, today: Date): Range {
  const days = PRESETS.find((item) => item.id === preset)?.days ?? 0
  const from = new Date(today)
  from.setDate(today.getDate() - days)
  return { from: startOfDay(from), to: endOfDay(today) }
}

/** `yyyy-mm-dd` en hora local, que es lo que espera un <input type="date">. */
export function toInputValue(ms: number): string {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/**
 * Interpreta `yyyy-mm-dd` en hora local. `new Date('2026-01-05')` lo tomaria
 * como UTC y en Argentina caeria un dia antes.
 */
export function parseInputValue(value: string): Date | null {
  const [year, month, day] = value.split('-').map(Number)

  if (!year || !month || !day) {
    return null
  }

  return new Date(year, month - 1, day)
}

const formatter = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium' })

export function formatRange({ from, to }: Range): string {
  return `${formatter.format(new Date(from))} — ${formatter.format(new Date(to))}`
}
