import { z } from 'zod'
import {
  ORDER_ORIGINS,
  ORDER_STATUSES,
  ORDER_TYPES,
  SLOT_STATUSES,
  type OrderOrigin,
} from '@/design/status'

/*
 * Se declara solo lo que la UI consume, en objetos laxos: el backend puede
 * agregar campos sin romper el front. Lo que si se valida es que los campos
 * usados tengan la forma esperada (RF20).
 *
 * Los campos que el backend puede omitir llevan `.default(null)` en vez de
 * `.optional()`, asi el consumidor siempre recibe la propiedad presente y no
 * hay que distinguir "ausente" de "vacio".
 */

export const sideSchema = z.enum(['LEFT', 'RIGHT'])
export type Side = z.infer<typeof sideSchema>

export const currentBoxSchema = z.looseObject({
  id: z.string(),
  sourceLocationCode: z.string().nullable().default(null),
})

export const slotSchema = z.looseObject({
  id: z.string(),
  locationCode: z.string(),
  status: z.enum(SLOT_STATUSES),
  reservedByOrderId: z.string().nullable().default(null),
  currentBox: currentBoxSchema.nullable().default(null),
  lastError: z.string().nullable().default(null),
  updatedAt: z.number().nullable().default(null),

  /*
   * Derivados de locationCode por el backend (T05). El front no los calcula:
   * la gramatica de ubicaciones es dominio y vive de un solo lado.
   * Nullable para tolerar un backend anterior a ese cambio.
   */
  side: sideSchema.nullable().default(null),
  robotId: z.string().nullable().default(null),
  level: z.number().nullable().default(null),
  position: z.number().nullable().default(null),
})
export type Slot = z.infer<typeof slotSchema>

export const orderSchema = z.looseObject({
  id: z.string(),
  externalOrderId: z.number().nullable().default(null),
  type: z.enum(ORDER_TYPES),
  origin: z
    .enum(ORDER_ORIGINS)
    .nullable()
    .default(null)
    .transform((value): OrderOrigin | null => value),
  status: z.enum(ORDER_STATUSES),
  locationCode: z.string(),
  targetLocation: z.string().nullable().default(null),
  currentStepIndex: z.number().default(0),
  steps: z.array(z.unknown()).default([]),
  robotId: z.string().nullable().default(null),
  slotLocationCode: z.string().nullable().default(null),
  waitingForSlot: z.boolean().default(false),
  errorReason: z.string().nullable().default(null),
  createdAt: z.number().nullable().default(null),
})
export type Order = z.infer<typeof orderSchema>

export const deviceSchema = z.looseObject({
  id: z.string(),
  robotId: z.union([z.string(), z.number()]).transform(String),
  type: z.enum(['CARRO', 'ELEVADOR']),
  host: z.string().nullable().default(null),
  port: z.number().nullable().default(null),
  status: z.enum(['CONNECTED', 'DISCONNECTED']),
  lastCommand: z.unknown().nullable().default(null),
  /** Ultima vez que el PLC contesto. Es el dato de diagnostico que importa. */
  lastSeen: z.number().nullable().default(null),
  updatedAt: z.number().nullable().default(null),
})
export type Device = z.infer<typeof deviceSchema>

export const robotSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  status: z.string().default('IDLE'),
  currentOrderId: z.string().nullable().default(null),
  updatedAt: z.number().nullable().default(null),
  devices: z.array(deviceSchema).default([]),
})
export type Robot = z.infer<typeof robotSchema>

export const queueRowSchema = z.looseObject({
  robotId: z.union([z.string(), z.number()]).transform(String),
  paused: z.boolean().default(false),
  queueLength: z.number().default(0),
  activeOrderId: z.string().nullable().default(null),
})
export type QueueRow = z.infer<typeof queueRowSchema>

export const metricsReportSchema = z.looseObject({
  total: z.number().default(0),
  summary: z
    .looseObject({
      /** Un buscar + su guardar son un solo pedido. */
      totalOrders: z.number().default(0),
      pickingOrders: z.number().default(0),
      manualOrders: z.number().default(0),
      /** Movimientos fisicos: cada buscar y cada guardar por separado. */
      totalManoeuvres: z.number().default(0),
      manoeuvresPerOrder: z.number().default(0),
      failedOrders: z.number().default(0),
      /** Desde que entra el pedido hasta que el cajon esta en el lugar. */
      avgTimeToSlotMs: z.number().default(0),
      maxTimeToSlotMs: z.number().default(0),
      /** Cuanto de esa espera fue turno y no maniobra. */
      avgQueueMs: z.number().default(0),
    })
    .default({
      totalOrders: 0,
      pickingOrders: 0,
      manualOrders: 0,
      totalManoeuvres: 0,
      manoeuvresPerOrder: 0,
      failedOrders: 0,
      avgTimeToSlotMs: 0,
      maxTimeToSlotMs: 0,
      avgQueueMs: 0,
    }),
  byLocation: z
    .array(
      z.looseObject({
        locationCode: z.string(),
        total: z.number(),
      }),
    )
    .default([]),
})
export type MetricsReport = z.infer<typeof metricsReportSchema>

export const healthSchema = z.looseObject({
  ok: z.boolean(),
  service: z.string().default('aoki-one-server'),
  ts: z.number().nullable().default(null),
  mode: z.string().default('desconocido'),
})
export type Health = z.infer<typeof healthSchema>

export const slotListSchema = z.array(slotSchema)
export const orderListSchema = z.array(orderSchema)
export const robotListSchema = z.array(robotSchema)
export const deviceListSchema = z.array(deviceSchema)
export const queueStatusSchema = z.array(queueRowSchema)
