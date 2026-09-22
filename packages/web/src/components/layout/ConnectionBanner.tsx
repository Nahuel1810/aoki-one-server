import { TriangleAlert, WifiOff } from 'lucide-react'
import { useConnectionStatus } from '@/api/connection'

/**
 * Aviso de que lo que se ve puede estar desactualizado (RF21).
 *
 * Va en el header: en el front anterior los errores caian en un `status-line`
 * al final de la columna derecha, donde nadie los ve en una tablet montada.
 */
export function ConnectionBanner() {
  const status = useConnectionStatus()

  if (status.kind === 'ok') {
    return null
  }

  const isOffline = status.kind === 'offline'
  const Icon = isOffline ? WifiOff : TriangleAlert

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2.5 bg-fault px-4 py-2 text-white sm:px-6"
    >
      <Icon className="size-5 shrink-0" aria-hidden />
      <p className="text-sm font-semibold">{status.message}</p>
    </div>
  )
}
