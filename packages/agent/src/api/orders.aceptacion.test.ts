// Portado de tests/integration/api.test.js (T02). Cuatro tests del alta y la
// consulta de ordenes por la API local del agente.
//
// Contexto comun a los cuatro: el ingreso de pedidos de PICKING se va al
// servidor Linux (RF26), asi que POST /api/orders en el agente pasa a ser SOLO
// el alta MANUAL de la tablet (RF21, RF35). Y el robot deja de salir del mapa
// cableado { '3X': '1' }: se resuelve por la fila de robots(site_id,
// estanteria_code) que siembra el fixture (RF23), asi que el assert
// robotId === '1' ya no se apoya en una constante del codigo.

import { describe, expect, it } from 'vitest'

import { crearAgente, type Agente, type OpcionesDelAgente } from '../composition.js'
import type { CuerpoDeRespuesta } from './httpServer.js'

const SITE_ID = 'SUC-TEST'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'

const OPCIONES: OpcionesDelAgente = {
  siteId: SITE_ID,
  agentId: 'AG-TEST',
  rutaDeBase: ':memory:',
  montarApi: true,
  // RF20: el default es false, asi que la simulacion se pide explicita.
  simularPlc: true,
  httpPuerto: 0,
  httpBind: '127.0.0.1',
  zonaDePickeo: ['3X02AE1', '3X02AE2'],
  // RF22: sin token configurado el comando directo a PLC queda deshabilitado.
  // Este fixture no lo usa, asi que va en null a proposito.
  tokenDeMantenimiento: null,
  // RF36/T26: el enlace con el servidor va APAGADO. Estos fixtures ejercitan el
  // agente solo con su cola local, que es como arranca en el cutover.
  enlace: null,
}

interface ItemDeCola {
  readonly robotId: string
  readonly activeOrderId: string | null
  readonly queueLength: number
  readonly paused: boolean
  readonly queuedOrderIds: readonly string[]
}

interface OrdenDeApi {
  readonly id: string
  readonly type: string
  readonly locationCode: string
}

interface ComandoPrevisto {
  readonly commandCode: number
}

interface PasoPrevisto {
  readonly seq: number
  readonly deviceType: string
}

interface DatosDeSimulacion {
  readonly order: { readonly robotId: string }
  readonly commandPreview: {
    readonly carroBring: ComandoPrevisto
    readonly carroReturn: ComandoPrevisto
    readonly elevadorGoLevel: ComandoPrevisto
  }
  readonly stepCommands: readonly PasoPrevisto[]
}

/** El mapa cableado 3X -> 1 del legacy pasa a ser esta fila (RF23). */
async function sembrarRobot(agente: Agente): Promise<void> {
  const guardado = await agente.orquestador.repositorios.robots.guardar({
    id: ROBOT_ID,
    siteId: SITE_ID,
    estanteriaCode: ESTANTERIA,
    habilitado: true,
    estado: 'IDLE',
    ordenActivaId: null,
  })
  if (!guardado.ok) {
    throw new Error(`no se pudo sembrar el robot: ${guardado.error.codigo}`)
  }
}

async function levantarAgente(): Promise<Agente> {
  const agente = crearAgente(OPCIONES)
  await agente.iniciar()
  await sembrarRobot(agente)
  return agente
}

function urlDe(agente: Agente, ruta: string): string {
  const direccion = agente.direccion()
  if (direccion === null) {
    throw new Error('el agente no monto la API')
  }
  return `http://${direccion.host}:${String(direccion.puerto)}${ruta}`
}

async function leerCuerpo<T>(respuesta: Response): Promise<CuerpoDeRespuesta<T>> {
  const cuerpo: unknown = await respuesta.json()
  return cuerpo as CuerpoDeRespuesta<T>
}

function datosDe<T>(cuerpo: CuerpoDeRespuesta<T>): T {
  if (!cuerpo.ok) {
    throw new Error(`la API respondio error: ${cuerpo.error}`)
  }
  return cuerpo.data
}

function postearJson(agente: Agente, ruta: string, cuerpo: unknown): Promise<Response> {
  return fetch(urlDe(agente, ruta), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  })
}

describe('API local de ordenes', () => {
  // DIRECTO en su afirmacion central (200 con { ok: true, data: [] }), pero se
  // le arregla el defecto que el mapeo marca: el legacy solo afirmaba
  // Array.isArray(data) sobre una app recien creada, donde el snapshot es []
  // porque el Map esta vacio, o sea que pasaba sin que existiera ninguna cola.
  // Aca se encola una orden primero y se afirma la forma real del item, que es
  // lo que consume el front. El parentesis del nombre legacy ("no confunde con
  // /:id") ademas miente: GET /api/orders/:id matchea un solo segmento y nunca
  // podria capturar /queue/status, que son dos.
  it('GET /api/orders/queue/status devuelve el snapshot de cola por robot', async () => {
    const agente = await levantarAgente()

    try {
      await postearJson(agente, '/api/orders', {
        type: 'PICK',
        robotId: ROBOT_ID,
        locationCode: '3X04AA3',
      })

      const respuesta = await fetch(urlDe(agente, '/api/orders/queue/status'))
      const cuerpo = await leerCuerpo<readonly ItemDeCola[]>(respuesta)

      expect(respuesta.status).toBe(200)
      expect(cuerpo.ok).toBe(true)

      const cola = datosDe(cuerpo)
      expect(Array.isArray(cola)).toBe(true)

      const item = cola.find((entrada) => entrada.robotId === ROBOT_ID)
      expect(item).toBeDefined()
      expect(item?.paused).toBe(false)
      expect(typeof item?.queueLength).toBe('number')
      expect(Array.isArray(item?.queuedOrderIds)).toBe(true)
    } finally {
      await agente.detener()
    }
  })

  // ADAPTADO. El legacy ("API permite registrar dispositivo y crear orden")
  // mezclaba dos cosas sin relacion causal: el alta de orden no depende de que
  // haya un device registrado. El registro de dispositivo se porta en
  // devicesCommand.aceptacion.test.ts; aca queda el alta.
  //
  // Que afirmaba el legacy: POST /api/orders -> 202 con ok:true y GET /api/orders
  // listando esa unica orden.
  //
  // Que afirma ahora: lo mismo (202, ok, una sola orden) MAS el significado
  // nuevo del alta. El ingreso de picking se va al servidor (RF26), asi que esta
  // ruta crea una orden MANUAL (RF35) y el siteId sale de la configuracion del
  // agente, nunca del request: por eso el body manda otro a proposito.
  it('POST /api/orders da de alta una orden MANUAL con el siteId del agente', async () => {
    const agente = await levantarAgente()

    try {
      const respuesta = await postearJson(agente, '/api/orders', {
        type: 'PICK',
        robotId: ROBOT_ID,
        locationCode: '3X04AA3',
        // El agente lo ignora: su siteId es configuracion, no entrada.
        siteId: 'OTRA-SUCURSAL',
      })
      const cuerpo = await leerCuerpo<OrdenDeApi>(respuesta)

      expect(respuesta.status).toBe(202)
      expect(cuerpo.ok).toBe(true)

      const listado = await fetch(urlDe(agente, '/api/orders'))
      const cuerpoDelListado = await leerCuerpo<readonly OrdenDeApi[]>(listado)
      expect(listado.status).toBe(200)
      expect(cuerpoDelListado.ok).toBe(true)
      expect(datosDe(cuerpoDelListado)).toHaveLength(1)

      // El listado deja de leerse de un Map en memoria: la fuente de verdad es
      // el repositorio SQLite (RF23), y es ahi donde se ve el origen MANUAL.
      const persistidas = await agente.orquestador.repositorios.ordenes.listar({})
      expect(persistidas).toHaveLength(1)
      expect(persistidas[0]?.origen).toBe('MANUAL')
      expect(persistidas[0]?.siteId).toBe(SITE_ID)
      // RF35: se genera localmente para que la orden viva sin enlace. El prefijo
      // por agente que evita la colision con los ids de picking no tiene test
      // portado y entra con T30.
      expect(persistidas[0]?.externalOrderId).not.toBeNull()
    } finally {
      await agente.detener()
    }
  })

  // ADAPTADO. Los tres commandCode y el "no crea orden" son el nucleo empirico y
  // se portan literales.
  //
  // Que cambia respecto del legacy:
  //  - stepCommands.length > 0 pasa a === 5: el legacy afirmaba solo que no
  //    estaba vacio, que es justo lo que RF04 fija (cinco pasos, con sus
  //    dispositivos CARRO/ELEVADOR/CARRO/ELEVADOR/CARRO).
  //  - Se afirma que address, responseAddress, verifyAddress y expectedValue NO
  //    estan. Hoy salen undefined porque nadie los calcula y nadie los
  //    assertaba; la spec los saca del contrato.
  //  - robotId === '1' se apoya en la fila de robots del fixture, no en el mapa
  //    cableado.
  it('POST /api/orders/simulate traduce la ubicacion sin crear ninguna orden', async () => {
    const agente = await levantarAgente()

    try {
      const respuesta = await postearJson(agente, '/api/orders/simulate', {
        type: 'PICK',
        locationCode: '3X04AA3',
      })
      const cuerpo = await leerCuerpo<DatosDeSimulacion>(respuesta)

      expect(respuesta.status).toBe(200)
      expect(cuerpo.ok).toBe(true)

      const simulacion = datosDe(cuerpo)
      expect(simulacion.order.robotId).toBe(ROBOT_ID)
      // Conocimiento de planta: posicion 3 + parante '02' (ceil(04/2)) + ladoBit 0
      // (modulo par = derecho) + accionBit 1 (T = traer).
      expect(simulacion.commandPreview.carroBring.commandCode).toBe(30201)
      // El mismo comando con accion D/dejar: solo cambia el ultimo digito.
      expect(simulacion.commandPreview.carroReturn.commandCode).toBe(30200)
      // Elevador ir-a-nivel = 100 + nivel, con A = 1.
      expect(simulacion.commandPreview.elevadorGoLevel.commandCode).toBe(101)

      expect(simulacion.stepCommands).toHaveLength(5)
      expect(simulacion.stepCommands.map((paso) => paso.deviceType)).toEqual([
        'CARRO',
        'ELEVADOR',
        'CARRO',
        'ELEVADOR',
        'CARRO',
      ])

      const primerPaso = simulacion.stepCommands[0]
      expect(primerPaso).toBeDefined()
      const camposRetirados = ['address', 'responseAddress', 'verifyAddress', 'expectedValue']
      for (const campo of camposRetirados) {
        expect(Object.keys(primerPaso ?? {})).not.toContain(campo)
      }

      const listado = await fetch(urlDe(agente, '/api/orders'))
      const cuerpoDelListado = await leerCuerpo<readonly OrdenDeApi[]>(listado)
      expect(listado.status).toBe(200)
      expect(datosDe(cuerpoDelListado)).toHaveLength(0)
      expect(await agente.orquestador.repositorios.ordenes.listar({})).toHaveLength(0)
    } finally {
      await agente.detener()
    }
  })

  // DIRECTO. La accion (T/D/L) se deriva del type PICK/PUT y nunca viaja en el
  // codigo de ubicacion. Se conserva la regex del mensaje porque el envelope de
  // error es { ok: false, error: string } y no lleva codigo: el codigo estable
  // que el mapeo pide entra cuando el endpoint tenga su esquema zod (T19).
  it('POST /api/orders rechaza con 400 un locationCode con accion final', async () => {
    const agente = await levantarAgente()

    try {
      const respuesta = await postearJson(agente, '/api/orders', {
        type: 'PICK',
        robotId: ROBOT_ID,
        locationCode: '3X04AA3T',
      })
      const cuerpo = await leerCuerpo<never>(respuesta)

      expect(respuesta.status).toBe(400)
      expect(cuerpo.ok).toBe(false)
      if (!cuerpo.ok) {
        expect(cuerpo.error).toMatch(/locationCode no debe incluir accion final/i)
      }
      expect(await agente.orquestador.repositorios.ordenes.listar({})).toHaveLength(0)
    } finally {
      await agente.detener()
    }
  })

  // DIVERGENCIA CORREGIDA. El legacy contestaba 400 ("PUT requiere locationCode
  // de zona pickeo configurada"); el sistema nuevo aceptaba el pedido con 202 y
  // la orden quedaba PENDING esperando un slot que no existe. Un typo en la
  // tablet entraba como orden valida y ademas —por el head-of-line block—
  // congelaba la cola de ese robot: era el disparador mas probable del deadlock.
  it('POST /api/orders rechaza con 400 un PUT sobre un locationCode que no es slot de pickeo', async () => {
    const agente = await levantarAgente()

    try {
      // Gramatica valida, pero la posicion 3 no esta en la zona configurada.
      const respuesta = await postearJson(agente, '/api/orders', {
        type: 'PUT',
        robotId: ROBOT_ID,
        locationCode: '3X02AE3',
      })
      const cuerpo = await leerCuerpo<never>(respuesta)

      expect(respuesta.status).toBe(400)
      expect(cuerpo.ok).toBe(false)
      if (!cuerpo.ok) {
        expect(cuerpo.error).toMatch(/zona de pickeo/i)
      }
      // Y sobre todo: no quedo ninguna orden esperando para siempre.
      expect(await agente.orquestador.repositorios.ordenes.listar({})).toHaveLength(0)
    } finally {
      await agente.detener()
    }
  })
})
