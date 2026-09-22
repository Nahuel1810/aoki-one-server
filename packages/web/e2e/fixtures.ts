import type { Page, Route } from '@playwright/test'

type Json = Record<string, unknown> | unknown[]

export const SLOTS: Json = [
  slot('3X01AE3', 'LEFT', 5, 3),
  slot('3X01AE2', 'LEFT', 5, 2),
  slot('3X01AE1', 'LEFT', 5, 1),
  slot('3X01AC3', 'LEFT', 3, 3),
  slot('3X01AC2', 'LEFT', 3, 2, { status: 'BUSCANDO', reservedByOrderId: 'o-pick' }),
  slot('3X01AC1', 'LEFT', 3, 1),
  slot('3X01AA3', 'LEFT', 1, 3),
  slot('3X01AA2', 'LEFT', 1, 2),
  slot('3X01AA1', 'LEFT', 1, 1, {
    status: 'OCUPADO',
    currentBox: { id: 'box-1', sourceLocationCode: '3X07AB2' },
  }),
  slot('3X02AE1', 'RIGHT', 5, 1),
  slot('3X02AC1', 'RIGHT', 3, 1),
  slot('3X02AA1', 'RIGHT', 1, 1),
]

function slot(
  locationCode: string,
  side: 'LEFT' | 'RIGHT',
  level: number,
  position: number,
  extra: Record<string, unknown> = {},
) {
  return {
    id: locationCode,
    locationCode,
    side,
    level,
    position,
    robotId: '1',
    status: 'LIBRE',
    reservedByOrderId: null,
    currentBox: null,
    lastError: null,
    updatedAt: Date.now(),
    ...extra,
  }
}

export const ORDERS: Json = [
  {
    id: 'o-pick',
    type: 'PICK',
    origin: 'PICKING',
    status: 'IN_PROGRESS',
    locationCode: '3X09AD1',
    targetLocation: null,
    currentStepIndex: 2,
    steps: [1, 2, 3, 4, 5],
    robotId: '1',
    waitingForSlot: false,
    errorReason: null,
    createdAt: Date.now() - 60_000,
  },
  {
    id: 'o-error',
    type: 'PUT',
    origin: 'MANUAL',
    status: 'ERROR',
    locationCode: '3X01AA1',
    targetLocation: '3X05AB1',
    currentStepIndex: 1,
    steps: [1, 2, 3, 4, 5],
    robotId: '1',
    waitingForSlot: false,
    errorReason: 'El carro no confirmo la maniobra',
    createdAt: Date.now() - 120_000,
  },
]

const METRICS: Json = {
  total: 128,
  summary: {
    totalOrders: 64,
    pickingOrders: 51,
    manualOrders: 13,
    totalManoeuvres: 128,
    manoeuvresPerOrder: 2,
    failedOrders: 2,
    avgTimeToSlotMs: 46_000,
    maxTimeToSlotMs: 336_000,
    avgQueueMs: 41_000,
  },
  byLocation: [
    { locationCode: '3X07AB2', total: 24 },
    { locationCode: '3X09AD1', total: 19 },
    { locationCode: '3X04AA1', total: 15 },
    { locationCode: '3X05AB1', total: 11 },
    { locationCode: '3X02AE2', total: 8 },
    { locationCode: '3X11AC3', total: 5 },
  ],
}

const QUEUE: Json = [{ robotId: '1', paused: false, queueLength: 1, activeOrderId: 'o-pick' }]

const DEVICES: Json = [
  {
    id: '1:CARRO',
    robotId: '1',
    type: 'CARRO',
    host: '192.168.0.51',
    port: 502,
    status: 'CONNECTED',
    lastSeen: Date.now() - 140,
  },
  {
    id: '1:ELEVADOR',
    robotId: '1',
    type: 'ELEVADOR',
    host: '192.168.0.50',
    port: 502,
    status: 'CONNECTED',
    lastSeen: Date.now() - 2300,
  },
]

const ROBOTS: Json = [
  {
    id: '1',
    status: 'BUSY',
    currentOrderId: 'o-pick',
    updatedAt: Date.now(),
    devices: [
      {
        id: '1:CARRO',
        robotId: '1',
        type: 'CARRO',
        host: '192.168.1.50',
        port: 502,
        status: 'CONNECTED',
      },
      {
        id: '1:ELEVADOR',
        robotId: '1',
        type: 'ELEVADOR',
        host: '192.168.1.51',
        port: 502,
        status: 'CONNECTED',
      },
    ],
  },
]

export type Recorded = { url: string; method: string; body: unknown }

/** Solo las llamadas reales a la API, no los modulos que sirve Vite en dev. */
export function isApiRequest(url: URL): boolean {
  return url.pathname.startsWith('/api/')
}

/**
 * Intercepta la API y registra los POST. Lo que se verifica es el pedido que
 * la UI construye: del otro lado hay un robot que se mueve.
 */
export async function mockApi(page: Page): Promise<Recorded[]> {
  const recorded: Recorded[] = []

  const json = (route: Route, data: unknown) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data }),
    })

  /*
   * Se filtra por pathname y no con un glob de doble asterisco sobre /api/:
   * en dev, Vite sirve
   * los modulos fuente por su ruta real, y `/src/api/client.ts` tambien
   * matchearia ese glob, devolviendo JSON en lugar del modulo.
   */
  await page.route(isApiRequest, async (route) => {
    const request = route.request()
    const url = new URL(request.url())

    if (request.method() === 'POST') {
      recorded.push({
        url: url.pathname,
        method: 'POST',
        body: request.postDataJSON() as unknown,
      })
      await json(route, {})
      return
    }

    if (url.pathname === '/api/slots') return json(route, SLOTS)
    if (url.pathname === '/api/orders') return json(route, ORDERS)
    if (url.pathname === '/api/orders/queue/status') return json(route, QUEUE)
    if (url.pathname === '/api/devices/robots') return json(route, ROBOTS)
    if (url.pathname === '/api/devices') return json(route, DEVICES)
    if (url.pathname === '/api/orders/metrics/report') return json(route, METRICS)

    return json(route, [])
  })

  await page.route(
    (url) => url.pathname === '/health',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          service: 'aoki-one-server',
          ts: Date.now(),
          mode: 'simulation',
        }),
      }),
  )

  return recorded
}
