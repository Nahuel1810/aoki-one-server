import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useSyncExternalStore } from 'react'
import { ContractError, NetworkError, errorMessage } from './client'

export type ConnectionStatus =
  | { kind: 'ok' }
  | { kind: 'offline'; message: string }
  | { kind: 'contract'; message: string }
  | { kind: 'error'; message: string }

const OK: ConnectionStatus = { kind: 'ok' }

function computeStatus(queryClient: QueryClient): ConnectionStatus {
  const failed = queryClient
    .getQueryCache()
    .findAll()
    .find((query) => query.state.status === 'error')

  const error: unknown = failed?.state.error

  if (error === null || error === undefined) {
    return OK
  }

  if (error instanceof NetworkError) {
    return { kind: 'offline', message: 'Sin conexion con el servidor' }
  }

  if (error instanceof ContractError) {
    return { kind: 'contract', message: error.message }
  }

  return { kind: 'error', message: errorMessage(error) }
}

function statusKey(status: ConnectionStatus): string {
  return status.kind === 'ok' ? 'ok' : `${status.kind}|${status.message}`
}

/**
 * Estado agregado de la conexion con el servidor (RF21).
 *
 * Observa el cache entero en vez de un query puntual: da lo mismo cual de las
 * llamadas fallo, para el operario el mensaje es el mismo.
 *
 * Va por `useSyncExternalStore` y no por un efecto con `setState`: el cache
 * notifica mientras otros componentes estan renderizando, y actualizar estado
 * ahi provoca el aviso de React por actualizar un componente durante el render
 * de otro. La referencia se cachea por clave para que el snapshot sea estable
 * entre notificaciones que no cambian nada.
 */
export function useConnectionStatus(): ConnectionStatus {
  const queryClient = useQueryClient()
  const cached = useRef<{ key: string; value: ConnectionStatus }>({ key: 'ok', value: OK })

  const subscribe = useCallback(
    (onStoreChange: () => void) => queryClient.getQueryCache().subscribe(onStoreChange),
    [queryClient],
  )

  const getSnapshot = useCallback(() => {
    const next = computeStatus(queryClient)
    const key = statusKey(next)

    if (key !== cached.current.key) {
      cached.current = { key, value: next }
    }

    return cached.current.value
  }, [queryClient])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
