import type { badgeVariants } from '@/components/ui/badge-variants'
import type { VariantProps } from 'class-variance-authority'

export type Tone = NonNullable<VariantProps<typeof badgeVariants>['tone']>

/*
 * Estos son los valores literales que ya devuelve la API (StateManager.js:4),
 * no una normalizacion. El front anterior mapeaba FREE -> LIBRE, OCCUPIED ->
 * OCUPADO, etc. contra un backend que nunca devolvio ingles.
 */
export const SLOT_STATUSES = [
  'LIBRE',
  'RESERVADO',
  'BUSCANDO',
  'OCUPADO',
  'DEVOLVIENDO',
  'ERROR',
] as const
export type SlotStatus = (typeof SLOT_STATUSES)[number]

export const ORDER_STATUSES = ['PENDING', 'IN_PROGRESS', 'DONE', 'CANCELED', 'ERROR'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

export const ORDER_TYPES = ['PICK', 'PUT'] as const
export type OrderType = (typeof ORDER_TYPES)[number]

export const ORDER_ORIGINS = ['MANUAL', 'PICKING'] as const
export type OrderOrigin = (typeof ORDER_ORIGINS)[number]

/*
 * Las etiquetas dicen que significa el estado para quien esta en el deposito,
 * no como se llama adentro del sistema. Un slot OCUPADO, para el operario, es
 * un cajon que ya lo esta esperando: "Listo", no "Ocupado".
 */
const SLOT_LABELS: Record<SlotStatus, string> = {
  LIBRE: 'Libre',
  RESERVADO: 'En espera',
  BUSCANDO: 'En camino',
  OCUPADO: 'Listo',
  DEVOLVIENDO: 'Guardando',
  ERROR: 'Error',
}

const SLOT_TONES: Record<SlotStatus, Tone> = {
  LIBRE: 'neutral',
  RESERVADO: 'motion',
  BUSCANDO: 'motion',
  OCUPADO: 'ready',
  DEVOLVIENDO: 'motion',
  ERROR: 'fault',
}

export function slotStatusLabel(status: SlotStatus): string {
  return SLOT_LABELS[status]
}

export function slotStatusTone(status: SlotStatus): Tone {
  return SLOT_TONES[status]
}

/** Hay una maniobra fisica en curso sobre el slot. */
export function isSlotInMotion(status: SlotStatus): boolean {
  return status === 'RESERVADO' || status === 'BUSCANDO' || status === 'DEVOLVIENDO'
}

const ORDER_LABELS: Record<OrderStatus, string> = {
  PENDING: 'En espera',
  IN_PROGRESS: 'En curso',
  DONE: 'Hecho',
  CANCELED: 'Cancelado',
  ERROR: 'Error',
}

const ORDER_TONES: Record<OrderStatus, Tone> = {
  PENDING: 'neutral',
  IN_PROGRESS: 'motion',
  DONE: 'online',
  CANCELED: 'neutral',
  ERROR: 'fault',
}

export function orderStatusLabel(status: OrderStatus): string {
  return ORDER_LABELS[status]
}

export function orderStatusTone(status: OrderStatus): Tone {
  return ORDER_TONES[status]
}

/** La API habla PICK/PUT; en el deposito se busca y se guarda. */
export function orderTypeLabel(type: OrderType): string {
  return type === 'PICK' ? 'Buscar' : 'Guardar'
}

export function orderOriginLabel(origin: OrderOrigin): string {
  return origin === 'MANUAL' ? 'Manual' : 'Picking'
}

/** El estado del robot que devuelve la API es un codigo interno. */
export function robotStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    IDLE: 'Libre',
    BUSY: 'Trabajando',
    ERROR: 'Con error',
    PAUSED: 'Pausado',
  }
  return labels[status.toUpperCase()] ?? status
}
