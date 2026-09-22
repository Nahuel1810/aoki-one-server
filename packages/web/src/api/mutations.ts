import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { apiPost } from './client'
import { queryKeys } from './queries'

/** Invalida todo lo que se ve afectado cuando cambia la operacion. */
function useOperationsInvalidation(): () => Promise<void> {
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

export type PickOrderInput = { locationCode: string }

/** Pedido manual de un cajon. El flujo normal entra por la API de picking. */
export function useCreatePickOrder(): UseMutationResult<void, Error, PickOrderInput> {
  const invalidate = useOperationsInvalidation()

  return useMutation({
    mutationFn: ({ locationCode }: PickOrderInput) =>
      apiPost('/api/orders', {
        type: 'PICK',
        origin: 'MANUAL',
        locationCode: locationCode.trim().toUpperCase(),
      }),
    onSuccess: invalidate,
  })
}

export type PutOrderInput = {
  /** Slot de pickeo desde donde sale el cajon. */
  slotLocationCode: string
  /**
   * Destino. Se envia SOLO cuando el slot esta vacio en libros (RF12): si hay
   * cajon registrado, el destino lo resuelve el backend desde
   * `currentBox.sourceLocationCode` y mandarlo seria pisarlo.
   */
  targetLocation?: string
}

export function useCreatePutOrder(): UseMutationResult<void, Error, PutOrderInput> {
  const invalidate = useOperationsInvalidation()

  return useMutation({
    mutationFn: ({ slotLocationCode, targetLocation }: PutOrderInput) =>
      apiPost('/api/orders', {
        type: 'PUT',
        origin: 'MANUAL',
        locationCode: slotLocationCode.trim().toUpperCase(),
        ...(targetLocation ? { targetLocation: targetLocation.trim().toUpperCase() } : {}),
      }),
    onSuccess: invalidate,
  })
}

export function useOrderAction(action: 'retry' | 'cancel'): UseMutationResult<void, Error, string> {
  const invalidate = useOperationsInvalidation()

  return useMutation({
    mutationFn: (orderId: string) =>
      apiPost(`/api/orders/${encodeURIComponent(orderId)}/${action}`),
    onSuccess: invalidate,
  })
}

/** Corrige los libros. NO mueve el robot ni el cajon fisico. */
export function useReleaseSlot(): UseMutationResult<void, Error, string> {
  const invalidate = useOperationsInvalidation()

  return useMutation({
    mutationFn: (locationCode: string) =>
      apiPost(`/api/slots/${encodeURIComponent(locationCode)}/release`),
    onSuccess: invalidate,
  })
}

export type QueueToggleInput = { robotIds: string[]; paused: boolean }

/**
 * Pausa o reanuda todas las colas. El endpoint es por robot, asi que se
 * recorre; con un solo robot es una sola llamada.
 */
export function useToggleQueues(): UseMutationResult<void, Error, QueueToggleInput> {
  const invalidate = useOperationsInvalidation()

  return useMutation({
    mutationFn: async ({ robotIds, paused }: QueueToggleInput) => {
      const action = paused ? 'resume' : 'pause'

      for (const robotId of robotIds) {
        await apiPost(`/api/orders/queue/${encodeURIComponent(robotId)}/${action}`)
      }
    },
    onSuccess: invalidate,
  })
}

export type RegisterDeviceInput = {
  robotId: string
  type: 'CARRO' | 'ELEVADOR'
  host: string
  port: number
}

export function useRegisterDevice(): UseMutationResult<void, Error, RegisterDeviceInput> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: RegisterDeviceInput) => apiPost('/api/devices/register', input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.devices }),
        queryClient.invalidateQueries({ queryKey: queryKeys.robots }),
      ])
    },
  })
}
