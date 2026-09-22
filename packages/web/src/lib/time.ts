/**
 * Cuanto hace que pasó algo, en palabras.
 *
 * Por debajo del segundo informa milisegundos: en diagnostico de red, "hace
 * 120 ms" y "hace 3 s" significan cosas distintas.
 */
export function timeAgo(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return 'sin datos'
  }

  const ms = Math.max(0, now - timestamp)

  if (ms < 1000) return `hace ${String(Math.round(ms))} ms`

  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `hace ${String(seconds)} s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `hace ${String(minutes)} min`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `hace ${String(hours)} h`

  return `hace ${String(Math.floor(hours / 24))} d`
}

/** Hora exacta, para cuando el operador necesita comparar con otro registro. */
export function clockTime(timestamp: number | null): string | null {
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return null
  }

  return new Intl.DateTimeFormat('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp))
}

/** Una duracion en palabras cortas: "46 s", "5 min 36 s", "1 h 12 min". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'

  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${String(seconds)} s`

  const minutes = Math.floor(seconds / 60)
  const restSeconds = seconds % 60
  if (minutes < 60) {
    return restSeconds === 0
      ? `${String(minutes)} min`
      : `${String(minutes)} min ${String(restSeconds)} s`
  }

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(restMinutes)} min`
}
