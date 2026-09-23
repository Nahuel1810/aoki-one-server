import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { apiGet, apiGetRaw } from './client'
import {
  deviceListSchema,
  healthSchema,
  metricsReportSchema,
  orderListSchema,
  queueStatusSchema,
  robotListSchema,
  slotListSchema,
  type Device,
  type Health,
  type MetricsReport,
  type Order,
  type QueueRow,
  type Robot,
  type Slot,
} from './schemas'

/**
 * Cadencia de actualizacion (RF21). TanStack Query no refetchea con la pestaña
 * oculta (`refetchIntervalInBackground` es false por defecto) y vuelve a pedir
 * al recuperar el foco, que es justo lo que el front anterior hacia a mano con
 * `document.visibilityState` y un flag `isRefreshingOrders`.
 */
export const POLL_MS = 5000

export const queryKeys = {
  slots: ['slots'] as const,
  orders: ['orders'] as const,
  robots: ['robots'] as const,
  devices: ['devices'] as const,
  queueStatus: ['queue-status'] as const,
  health: ['health'] as const,
  metrics: (from: number, to: number) => ['metrics', from, to] as const,
}

/** Datos que se refrescan solos mientras la vista esta a la vista. */
const live = {
  refetchInterval: POLL_MS,
  staleTime: POLL_MS / 2,
} as const

export function useSlots(): UseQueryResult<Slot[]> {
  return useQuery({
    queryKey: queryKeys.slots,
    queryFn: () => apiGet('/api/slots', slotListSchema),
    ...live,
  })
}

export function useOrders(): UseQueryResult<Order[]> {
  return useQuery({
    queryKey: queryKeys.orders,
    queryFn: () => apiGet('/api/orders', orderListSchema),
    ...live,
  })
}

export function useRobots(): UseQueryResult<Robot[]> {
  return useQuery({
    queryKey: queryKeys.robots,
    queryFn: () => apiGet('/api/devices/robots', robotListSchema),
    ...live,
  })
}

export function useDevices(): UseQueryResult<Device[]> {
  return useQuery({
    queryKey: queryKeys.devices,
    queryFn: () => apiGet('/api/devices', deviceListSchema),
    ...live,
  })
}

/**
 * Se usa este endpoint y no el campo `queue` de /api/devices/robots porque la
 * spec del backend documenta que ese campo devuelve {} con driver externo
 * (Promise sin await). Se consolidan cuando ese bug se corrija.
 */
export function useQueueStatus(): UseQueryResult<QueueRow[]> {
  return useQuery({
    queryKey: queryKeys.queueStatus,
    queryFn: () => apiGet('/api/orders/queue/status', queueStatusSchema),
    ...live,
  })
}

export function useHealth(): UseQueryResult<Health> {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => apiGetRaw('/health', healthSchema),
    refetchInterval: POLL_MS * 2,
  })
}

export function useMetrics(
  from: number,
  to: number,
  enabled: boolean,
): UseQueryResult<MetricsReport> {
  return useQuery({
    queryKey: queryKeys.metrics(from, to),
    queryFn: () =>
      apiGet(
        `/api/orders/metrics/report?startDate=${String(from)}&endDate=${String(to)}`,
        metricsReportSchema,
      ),
    enabled,
    // Un reporte historico no cambia solo: no se pollea.
    staleTime: 60_000,
  })
}

/** Refresca de inmediato todo lo que alimenta la vista de operacion. */
export function useRefreshOperations(): () => Promise<void> {
  const queryClient = useQueryClient()

  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.slots }),
      queryClient.invalidateQueries({ queryKey: queryKeys.orders }),
      queryClient.invalidateQueries({ queryKey: queryKeys.queueStatus }),
      queryClient.invalidateQueries({ queryKey: queryKeys.robots }),
    ])
  }
}
