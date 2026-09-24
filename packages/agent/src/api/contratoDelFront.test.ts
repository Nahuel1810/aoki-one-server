// T22 — El contrato que consume el front nuevo, afirmado desde el lado del agente.
//
// El front vive en packages/web y tiene su propia spec
// (docs/specs/2026-09-21-frontend-vite-react.md). Esta suite no lo rediseña: le
// garantiza el contrato, que es lo unico que los dos cutovers comparten.
//
// LOS ESQUEMAS DE ABAJO SON UNA COPIA DE packages/web/src/api/schemas.ts.
// Se copian en vez de importarse porque packages/web no es un workspace de este
// tsconfig: tiene su propio build, su propio zod y un alias `@/` que aca no
// existe, asi que importarlo romperia el typecheck del monorepo. La copia tiene
// un costo —hay que moverla cuando el front mueva la suya— y una ventaja que
// paga ese costo: esta suite falla cuando el AGENTE se desvia, que es cuando
// nadie lo mira. El front, por su lado, valida cada respuesta con estos mismos
// esquemas en runtime y descarta la pantalla entera si no pasan, asi que un
// campo de menos aca no es un campo de menos alla: es una pantalla vacia.
//
// Lo que el agente le debe al front, y esta suite afirma:
//   - las rutas, y el envoltorio { ok, data } / { ok, error } en todas;
//   - `side` y `robotId` por slot en GET /api/slots;
//   - el estado del enlace en /health, para que la pantalla pueda avisar "sin
//     conexion con el servidor de pedidos" sin que parezca que el robot murio.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { LOGGER_SILENCIOSO } from '@aoki-one/domain'

import { crearAgente, type Agente } from '../composition.js'

const SITE_ID = 'sucursal-contrato'
const AGENT_ID = 'AG-CONTRATO'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'

/** Modulo 04 (par) -> lado RIGHT: solo compiten los slots del modulo 02. */
const ORIGEN = '3X04AA3'
const SLOT_GANADOR = '3X02AA1'

/** Zona chica pero de los dos lados: el tablero del front agrupa por lado y por nivel. */
const ZONA_DE_PICKEO: readonly string[] = ['3X02AE1', '3X02AC1', '3X02AA1', '3X01AA1', '3X01AA2']

const ESPERA_MAXIMA_MS = 10_000
const INTERVALO_DE_SONDEO_MS = 25
const TIMEOUT_DEL_TEST_MS = 30_000

// --------------------------------------------- copia de los esquemas del front

const SLOT_STATUSES = ['LIBRE', 'RESERVADO', 'BUSCANDO', 'OCUPADO', 'DEVOLVIENDO', 'ERROR'] as const
const ORDER_STATUSES = ['PENDING', 'IN_PROGRESS', 'DONE', 'CANCELED', 'ERROR'] as const
const ORDER_TYPES = ['PICK', 'PUT'] as const
const ORDER_ORIGINS = ['MANUAL', 'PICKING'] as const

const esquemaDeSlot = z.looseObject({
  id: z.string(),
  locationCode: z.string(),
  status: z.enum(SLOT_STATUSES),
  reservedByOrderId: z.string().nullable().default(null),
  currentBox: z
    .looseObject({ id: z.string(), sourceLocationCode: z.string().nullable().default(null) })
    .nullable()
    .default(null),
  lastError: z.string().nullable().default(null),
  updatedAt: z.number().nullable().default(null),
  side: z.enum(['LEFT', 'RIGHT']).nullable().default(null),
  robotId: z.string().nullable().default(null),
  level: z.number().nullable().default(null),
  position: z.number().nullable().default(null),
})

const esquemaDeOrden = z.looseObject({
  id: z.string(),
  type: z.enum(ORDER_TYPES),
  origin: z.enum(ORDER_ORIGINS).nullable().default(null),
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

const esquemaDeDispositivo = z.looseObject({
  id: z.string(),
  robotId: z.union([z.string(), z.number()]).transform(String),
  type: z.enum(['CARRO', 'ELEVADOR']),
  host: z.string().nullable().default(null),
  port: z.number().nullable().default(null),
  status: z.enum(['CONNECTED', 'DISCONNECTED']),
  lastCommand: z.unknown().nullable().default(null),
  lastSeen: z.number().nullable().default(null),
  updatedAt: z.number().nullable().default(null),
})

const esquemaDeRobot = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  status: z.string().default('IDLE'),
  currentOrderId: z.string().nullable().default(null),
  updatedAt: z.number().nullable().default(null),
  devices: z.array(esquemaDeDispositivo).default([]),
})

const esquemaDeFilaDeCola = z.looseObject({
  robotId: z.union([z.string(), z.number()]).transform(String),
  paused: z.boolean().default(false),
  queueLength: z.number().default(0),
  activeOrderId: z.string().nullable().default(null),
})

const esquemaDeReporteDeMetricas = z.looseObject({
  total: z.number().default(0),
  summary: z.looseObject({
    totalOrders: z.number().default(0),
    pickingOrders: z.number().default(0),
    manualOrders: z.number().default(0),
    totalManoeuvres: z.number().default(0),
    manoeuvresPerOrder: z.number().default(0),
    failedOrders: z.number().default(0),
    avgTimeToSlotMs: z.number().default(0),
    maxTimeToSlotMs: z.number().default(0),
    avgQueueMs: z.number().default(0),
  }),
  byLocation: z
    .array(z.looseObject({ locationCode: z.string(), total: z.number() }))
    .default([]),
})

/**
 * `/health` NO viaja en el envoltorio: el front lo lee plano (`apiGetRaw`).
 * Por eso la API lo responde duplicado, en la raiz y bajo `data`.
 */
const esquemaDeHealth = z.looseObject({
  ok: z.boolean(),
  service: z.string().default('aoki-one-server'),
  ts: z.number().nullable().default(null),
  mode: z.string().default('desconocido'),
})

// ------------------------------------------------------------------ el banco

let agente: Agente | null = null
let base = ''

interface RespuestaHttp {
  readonly status: number
  readonly cuerpo: Record<string, unknown>
}

async function pedir(ruta: string, init?: RequestInit): Promise<RespuestaHttp> {
  const respuesta = await fetch(`${base}${ruta}`, init)
  const cuerpo = (await respuesta.json()) as Record<string, unknown>
  return { status: respuesta.status, cuerpo }
}

async function postear(ruta: string, cuerpo?: unknown): Promise<RespuestaHttp> {
  return pedir(ruta, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
  })
}

/**
 * El `data` de una respuesta que el front daria por buena.
 *
 * El cliente del front corta por `{ ok: false }` ANTES de mirar el esquema, asi
 * que exigir `ok === true` aca es exactamente su primer chequeo.
 */
function datos(respuesta: RespuestaHttp): unknown {
  expect(respuesta.cuerpo['ok']).toBe(true)
  return respuesta.cuerpo['data']
}

beforeEach(async () => {
  agente = crearAgente({
    siteId: SITE_ID,
    agentId: AGENT_ID,
    rutaDeBase: ':memory:',
    montarApi: true,
    // RF20 pone el default de simulacion en false, asi que va explicito.
    simularPlc: true,
    httpPuerto: 0,
    httpBind: '127.0.0.1',
    zonaDePickeo: ZONA_DE_PICKEO,
    tokenDeMantenimiento: null,
    // Sin enlace configurado: es el estado DISABLED de /health, que el front
    // tiene que poder distinguir de un enlace caido.
    enlace: null,
    logger: LOGGER_SILENCIOSO,
  })

  const repositorios = agente.orquestador.repositorios
  const robot = await repositorios.robots.guardar({
    id: ROBOT_ID,
    siteId: SITE_ID,
    estanteriaCode: ESTANTERIA,
    habilitado: true,
    estado: 'IDLE',
    ordenActivaId: null,
  })
  if (!robot.ok) {
    throw new Error('no se pudo sembrar el robot')
  }

  await agente.iniciar()
  const direccion = agente.direccion()
  if (direccion === null) {
    throw new Error('el agente se arranco con la API montada y no expuso su direccion')
  }
  base = `http://${direccion.host}:${String(direccion.puerto)}`

  // El alta de dispositivo es SETUP, no la conducta que este test afirma, y desde
  // que exige el token de mantenimiento pasarla por HTTP mezclaria la autorizacion
  // con lo que se esta probando. Va por el repositorio, que es la misma escritura.
  for (const tipo of ['CARRO', 'ELEVADOR'] as const) {
    await agente.orquestador.repositorios.dispositivos.registrar({
      robotId: ROBOT_ID,
      tipo,
      host: '127.0.0.1',
      puerto: 502,
      unitId: 1,
      timeoutMsDeSocket: 2000,
    })
  }
})

afterEach(async () => {
  await agente?.detener()
  agente = null
})

/** Sondea la orden hasta que llega a un estado final. */
async function esperarOrdenFinalizada(ordenId: string): Promise<Record<string, unknown>> {
  const limite = Date.now() + ESPERA_MAXIMA_MS
  for (;;) {
    const respuesta = await pedir(`/api/orders/${ordenId}`)
    const orden = esquemaDeOrden.parse(datos(respuesta))
    if (orden.status !== 'PENDING' && orden.status !== 'IN_PROGRESS') {
      return orden
    }
    if (Date.now() >= limite) {
      throw new Error(`la orden ${ordenId} no llego a un estado final: quedo en ${orden.status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVALO_DE_SONDEO_MS))
  }
}

// ---------------------------------------------------------------------- tests

describe('envoltorio { ok, data } / { ok, error } (T22)', () => {
  it('toda ruta de lectura contesta { ok: true, data }', async () => {
    const rutas = [
      '/api/slots',
      '/api/orders',
      '/api/orders/queue/status',
      '/api/devices',
      '/api/devices/robots',
      '/api/orders/metrics/report',
    ]

    for (const ruta of rutas) {
      const respuesta = await pedir(ruta)
      expect(respuesta.status, ruta).toBe(200)
      expect(respuesta.cuerpo['ok'], ruta).toBe(true)
      expect(respuesta.cuerpo, ruta).toHaveProperty('data')
      expect(respuesta.cuerpo['error'], ruta).toBeUndefined()
    }
  })

  it('el error tambien viaja envuelto, con el motivo en texto', async () => {
    // El cliente del front lee `error` como string y lo muestra tal cual: un
    // objeto ahi le deja al operario un "[object Object]" en pantalla.
    const inexistente = await pedir('/api/orders/no-existe')
    expect(inexistente.status).toBe(404)
    expect(inexistente.cuerpo['ok']).toBe(false)
    expect(typeof inexistente.cuerpo['error']).toBe('string')

    const invalida = await postear('/api/orders', { type: 'PICK', locationCode: '' })
    expect(invalida.status).toBe(400)
    expect(invalida.cuerpo['ok']).toBe(false)
    expect(typeof invalida.cuerpo['error']).toBe('string')

    const rutaQueNoExiste = await pedir('/api/lo-que-sea')
    expect(rutaQueNoExiste.status).toBe(404)
    expect(rutaQueNoExiste.cuerpo['ok']).toBe(false)
    expect(typeof rutaQueNoExiste.cuerpo['error']).toBe('string')
  })
})

describe('GET /api/slots (T22)', () => {
  it('cada slot trae lo que el tablero necesita, empezando por side y robotId', async () => {
    const servidos = z.array(esquemaDeSlot).parse(datos(await pedir('/api/slots')))
    expect(servidos).toHaveLength(ZONA_DE_PICKEO.length)

    const izquierdo = servidos.find((slot) => slot.locationCode === '3X01AA1')
    const derecho = servidos.find((slot) => slot.locationCode === '3X02AE1')

    // `side` y `robotId`, que es lo que T22 nombra literal.
    expect(izquierdo?.side).toBe('LEFT')
    expect(derecho?.side).toBe('RIGHT')
    expect(servidos.every((slot) => slot.robotId === ROBOT_ID)).toBe(true)

    // El tablero arma una fila por nivel y ordena por posicion. Sin estos dos
    // derivados no puede: la gramatica de ubicaciones es dominio y no se
    // reimplementa del otro lado.
    expect(derecho?.level).toBe(5)
    expect(izquierdo?.level).toBe(1)
    expect(izquierdo?.position).toBe(1)
    expect(servidos.find((slot) => slot.locationCode === '3X01AA2')?.position).toBe(2)

    // Un slot recien sembrado esta LIBRE, sin cajon, sin orden y sin error.
    expect(servidos.every((slot) => slot.status === 'LIBRE')).toBe(true)
    expect(servidos.every((slot) => slot.currentBox === null)).toBe(true)
    expect(servidos.every((slot) => slot.reservedByOrderId === null)).toBe(true)
    expect(servidos.every((slot) => slot.lastError === null)).toBe(true)
    expect(servidos.every((slot) => typeof slot.updatedAt === 'number')).toBe(true)
  })

  it(
    'un slot con cajon apoyado trae el cajon y su ubicacion de origen',
    async () => {
      const alta = await postear('/api/orders', { type: 'PICK', locationCode: ORIGEN })
      const creada = esquemaDeOrden.parse(datos(alta))
      await esperarOrdenFinalizada(creada.id)

      const servidos = z.array(esquemaDeSlot).parse(datos(await pedir('/api/slots')))
      const ganador = servidos.find((slot) => slot.locationCode === SLOT_GANADOR)

      expect(ganador?.status).toBe('OCUPADO')
      expect(ganador?.currentBox?.sourceLocationCode).toBe(ORIGEN)
      // OCUPADO no lo retiene ninguna orden: el cajon esta apoyado y la orden
      // que lo trajo ya termino. El tablero lo muestra "Listo", no "En camino".
      expect(ganador?.reservedByOrderId).toBeNull()
    },
    TIMEOUT_DEL_TEST_MS,
  )
})

describe('ordenes, robots, dispositivos y cola (T22)', () => {
  it(
    'la orden manual entra, se ejecuta y sale con la forma que el front valida',
    async () => {
      const alta = await postear('/api/orders', { type: 'PICK', locationCode: ORIGEN })
      expect(alta.status).toBe(202)
      expect(alta.cuerpo['created']).toBe(true)
      const creada = esquemaDeOrden.parse(datos(alta))
      expect(creada.origin).toBe('MANUAL')
      expect(creada.type).toBe('PICK')

      const final = await esperarOrdenFinalizada(creada.id)
      expect(final['status']).toBe('DONE')

      // El listado se valida entero: al front le alcanza UNA orden con la forma
      // equivocada para descartar la pantalla completa.
      const listadas = z.array(esquemaDeOrden).parse(datos(await pedir('/api/orders')))
      expect(listadas.map((orden) => orden.id)).toContain(creada.id)
      expect(listadas.every((orden) => orden.robotId === ROBOT_ID)).toBe(true)
    },
    TIMEOUT_DEL_TEST_MS,
  )

  it('el externalOrderId es TEXTO y lo sigue siendo', async () => {
    const alta = await postear('/api/orders', { type: 'PICK', locationCode: ORIGEN })
    const externo = (datos(alta) as Record<string, unknown>)['externalOrderId']

    // RF35: la orden local nace con id externo propio, prefijado con la identidad
    // del agente para que no choque con una de picking. RF26 lo usa como mitad de
    // la clave de dedupe `(siteId, externalOrderId)`. Es texto de punta a punta y
    // no puede dejar de serlo: volverlo numero rompe el prefijo y funde las dos
    // familias de ids en una.
    expect(typeof externo).toBe('string')
    expect(externo).toMatch(new RegExp(`^local-${AGENT_ID}-`))

    // Por eso este campo NO esta en la copia de los esquemas de arriba: el front
    // lo declara `z.number().nullable()` y rechaza lo que el agente manda. Esta
    // afirmacion fija el lado correcto —el del agente— para que la correccion
    // vaya donde tiene que ir y no al reves. Ver `hallazgos` de T22.
    expect(z.number().nullable().safeParse(externo).success).toBe(false)
  })

  it('GET /api/devices lista los dispositivos planos, con su estado', async () => {
    const dispositivos = z.array(esquemaDeDispositivo).parse(datos(await pedir('/api/devices')))

    expect(dispositivos.map((dispositivo) => dispositivo.type).sort()).toEqual([
      'CARRO',
      'ELEVADOR',
    ])
    expect(dispositivos.every((dispositivo) => dispositivo.robotId === ROBOT_ID)).toBe(true)
    // En simulacion se reporta conectado a proposito: es el modo en el que el
    // agente se prueba sin PLC, y decir lo contrario seria ruido.
    expect(dispositivos.every((dispositivo) => dispositivo.status === 'CONNECTED')).toBe(true)
    expect(dispositivos.every((dispositivo) => dispositivo.host === '127.0.0.1')).toBe(true)
  })

  it('GET /api/devices/robots trae los dispositivos con la MISMA forma', async () => {
    const robots = z.array(esquemaDeRobot).parse(datos(await pedir('/api/devices/robots')))

    expect(robots).toHaveLength(1)
    expect(robots[0]?.id).toBe(ROBOT_ID)
    expect(robots[0]?.status).toBe('IDLE')
    expect(robots[0]?.devices).toHaveLength(2)

    // Una forma distinta en cada ruta rompe una de las dos pantallas, porque el
    // front las valida con el mismo esquema.
    const planos = z.array(esquemaDeDispositivo).parse(datos(await pedir('/api/devices')))
    expect([...(robots[0]?.devices ?? [])].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...planos].sort((a, b) => a.id.localeCompare(b.id)),
    )
  })

  it('la cola por robot trae las cuatro cosas que el front muestra', async () => {
    const cola = z.array(esquemaDeFilaDeCola).parse(datos(await pedir('/api/orders/queue/status')))

    expect(cola).toHaveLength(1)
    expect(cola[0]?.robotId).toBe(ROBOT_ID)
    expect(cola[0]?.queueLength).toBe(0)
    expect(cola[0]?.activeOrderId).toBeNull()
    expect(cola[0]?.paused).toBe(false)
  })

  it('el reporte de metricas tiene resumen y desglose aunque no haya ninguna orden', async () => {
    const reporte = esquemaDeReporteDeMetricas.parse(
      datos(await pedir('/api/orders/metrics/report')),
    )

    expect(reporte.total).toBe(0)
    expect(reporte.summary.totalOrders).toBe(0)
    expect(reporte.byLocation).toEqual([])
  })
})

describe('/health y el estado del enlace (T22, RF25, RF36)', () => {
  it('responde plano, sin envoltorio, y dice el estado del enlace', async () => {
    const respuesta = await pedir('/health')
    expect(respuesta.status).toBe(200)

    // El front lo lee plano: los campos van en la RAIZ.
    const health = esquemaDeHealth.parse(respuesta.cuerpo)
    expect(health.ok).toBe(true)
    expect(health.mode).toBe('simulation')

    // Y ademas duplicados bajo `data`, para el chequeo de infraestructura que
    // consume el envoltorio de toda la API.
    expect(respuesta.cuerpo['data']).toMatchObject({ mode: 'simulation' })

    // RF36: sin modo silencioso. Sin enlace configurado el estado es DISABLED,
    // que es una respuesta y no un hueco: la pantalla tiene que poder decir "sin
    // conexion con el servidor de pedidos" SOLO cuando el enlace esta caido, y
    // no cuando ni siquiera se configuro. Son avisos distintos: uno es una falla
    // y el otro es como arranca el cutover.
    expect(respuesta.cuerpo['link']).toEqual({
      status: 'DISABLED',
      lastContactAt: null,
      outboxSize: 0,
    })
  })

  it('informa conectividad por dispositivo, cola por robot y arranque (RF25)', async () => {
    const respuesta = await pedir('/health')
    const cuerpo = respuesta.cuerpo

    expect(typeof cuerpo['startedAt']).toBe('number')
    expect(cuerpo['devices']).toHaveLength(2)
    expect(cuerpo['robots']).toEqual([
      {
        id: ROBOT_ID,
        robotId: ROBOT_ID,
        status: 'IDLE',
        queueDepth: 0,
        activeOrderId: null,
        // RF21: la pausa de cola sobrevive al reinicio del proceso, asi que
        // /health la informa. Sin este campo, una cola pausada un viernes deja
        // al operario con un health en "ok" y un robot que no se mueve.
        paused: false,
      },
    ])
    expect(cuerpo['lastCompletedOrder']).toBeNull()
  })
})
