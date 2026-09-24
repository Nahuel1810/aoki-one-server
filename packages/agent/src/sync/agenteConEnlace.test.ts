// RF33 a RF36 — El agente entero, con el enlace caido y con el enlace vivo.
//
// Estos dos tests son el motivo por el que el agente es un proceso aparte. El
// primero apunta el enlace a un puerto donde no escucha nadie —ECONNREFUSED de
// verdad, no un doble que devuelve un error— y exige que la maniobra ocurra
// igual: si esto se rompe, la sucursal deja de operar cuando se corta internet.
// El segundo levanta el servidor de verdad y recorre el camino completo: pedido
// de picking, long-poll, espejo, maniobra y reporte de vuelta.
//
// El estado del enlace se lee por `/health` y no del objeto en memoria, porque es
// lo que ve el operario en la tablet (RF36).

import { createServer } from 'node:net'
import { setTimeout as dormir } from 'node:timers/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { LOGGER_SILENCIOSO } from '@aoki-one/domain'

import { crearServidor, type Servidor } from '../../../server/src/composition.js'
import {
  generarClaveDeCifrado,
  VARIABLE_DE_CLAVE,
} from '../../../server/src/persistence/cifrado.js'
import { crearAgente, type Agente } from '../composition.js'

/** El servidor no arranca sin clave de cifrado de credenciales. */
const ENTORNO_DEL_SERVIDOR = { [VARIABLE_DE_CLAVE]: generarClaveDeCifrado() }

const SITE_ID = 'SUC-ENLACE'
const KEY_ID = 'key-suc-enlace'
const SECRETO = 'secreto-del-enlace'
const AGENT_ID = 'AG-1'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'
const ORIGEN = '3X04AE1'
const SLOT_GANADOR = '3X02AE1'

const ZONA_DE_PICKEO: readonly string[] = [
  '3X02AE1',
  '3X02AC1',
  '3X02AA1',
  '3X01AE1',
  '3X01AE2',
  '3X01AE3',
  '3X01AC1',
  '3X01AC2',
  '3X01AC3',
  '3X01AA1',
  '3X01AA2',
  '3X01AA3',
]

/** Una orden de PICK reporta dos transiciones: IN_PROGRESS y DONE. */
const TRANSICIONES_POR_ORDEN = 2

const ESPERA_MAXIMA_MS = 10_000
const INTERVALO_DE_SONDEO_MS = 25
const TIMEOUT_DEL_TEST_MS = 30_000

let agente: Agente | null = null
let servidor: Servidor | null = null

afterEach(async () => {
  if (agente !== null) {
    await agente.detener()
    agente = null
  }
  if (servidor !== null) {
    await servidor.detener()
    servidor = null
  }
})

/**
 * Un puerto donde no escucha nadie.
 *
 * Se pide uno al sistema y se lo suelta enseguida: apuntar el enlace ahi da un
 * ECONNREFUSED real. Un doble que devuelve `SIN_RED` afirmaria lo que el codigo
 * ya cree; esto afirma lo que pasa cuando el servidor no esta.
 */
function puertoSinNadieEscuchando(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const sonda = createServer()
    sonda.once('error', reject)
    sonda.listen(0, '127.0.0.1', () => {
      const direccion = sonda.address()
      if (direccion === null || typeof direccion === 'string') {
        reject(new Error('no se pudo reservar un puerto muerto'))
        return
      }
      const puerto = direccion.port
      sonda.close(() => {
        resolve(puerto)
      })
    })
  })
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null
}

/** Lee una ruta con puntos sobre un cuerpo JSON sin tipar. */
function leer(valor: unknown, ruta: string): unknown {
  let actual: unknown = valor
  for (const clave of ruta.split('.')) {
    if (!esObjeto(actual)) {
      return undefined
    }
    actual = actual[clave]
  }
  return actual
}

async function obtener(url: string): Promise<unknown> {
  const respuesta = await fetch(url)
  return respuesta.json()
}

async function postear(url: string, cuerpo: unknown): Promise<{ status: number; cuerpo: unknown }> {
  const respuesta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  })
  return { status: respuesta.status, cuerpo: await respuesta.json() }
}

/** Sondea hasta que la condicion se cumple o se agota la espera. */
async function esperarA(condicion: () => Promise<boolean>): Promise<boolean> {
  const limite = Date.now() + ESPERA_MAXIMA_MS
  while (Date.now() < limite) {
    if (await condicion()) {
      return true
    }
    await dormir(INTERVALO_DE_SONDEO_MS)
  }
  return false
}

function agenteVivo(): Agente {
  if (agente === null) {
    throw new Error('el agente no esta montado')
  }
  return agente
}

function baseDeLaApi(): string {
  const direccion = agenteVivo().direccion()
  if (direccion === null) {
    throw new Error('el agente se arranco con la API montada y no expuso su direccion')
  }
  return `http://${direccion.host}:${String(direccion.puerto)}`
}

/** Da de alta el robot y su zona de pickeo. El mapeo estanteria -> robot es una fila. */
async function sembrarPlanta(): Promise<void> {
  const repositorios = agenteVivo().orquestador.repositorios
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
  const zona = await repositorios.slots.sembrarZonaDePickeo(ROBOT_ID, ZONA_DE_PICKEO)
  if (!zona.ok) {
    throw new Error('no se pudo sembrar la zona de pickeo')
  }
}

describe('el agente con el enlace caido (RF33, RF36)', () => {
  it(
    'ejecuta la orden igual y dice en /health que esta degradado y cuanto quedo sin reportar',
    async () => {
      const puertoMuerto = await puertoSinNadieEscuchando()

      agente = crearAgente({
        siteId: SITE_ID,
        agentId: AGENT_ID,
        rutaDeBase: ':memory:',
        montarApi: true,
        simularPlc: true,
        httpPuerto: 0,
        httpBind: '127.0.0.1',
        zonaDePickeo: ZONA_DE_PICKEO,
        tokenDeMantenimiento: null,
        // Enlace CONFIGURADO y caido. No es lo mismo que apagado: apagado es
        // DISABLED, esto tiene que decir DEGRADED.
        enlace: {
          urlBase: `http://127.0.0.1:${String(puertoMuerto)}`,
          keyId: KEY_ID,
          secreto: SECRETO,
        },
      })
      await agente.iniciar()
      await sembrarPlanta()

      const base = baseDeLaApi()
      const alta = await postear(`${base}/api/orders`, { type: 'PICK', locationCode: ORIGEN })
      expect(alta.status).toBe(202)
      const ordenId = String(leer(alta.cuerpo, 'data.id'))

      const repositorios = agenteVivo().orquestador.repositorios
      const termino = await esperarA(async () => {
        const orden = await repositorios.ordenes.buscarPorId(ordenId)
        return orden?.estado === 'DONE'
      })

      // El invariante que justifica que el agente sea un proceso aparte: el robot
      // se movio de punta a punta sin servidor del otro lado.
      expect(termino).toBe(true)
      const orden = await repositorios.ordenes.buscarPorId(ordenId)
      expect(orden?.slotLocationCode).toBe(SLOT_GANADOR)
      expect(orden?.currentStepIndex).toBe(5)

      const salud = await obtener(`${base}/health`)
      expect(leer(salud, 'data.link.status')).toBe('DEGRADED')
      // Nunca hubo un contacto bueno: decir otra cosa seria inventar.
      expect(leer(salud, 'data.link.lastContactAt')).toBeNull()
      // El tamaño del outbox es el dato operativo: es lo que el servidor todavia
      // no sabe. Sin modo silencioso (RF36).
      expect(leer(salud, 'data.link.outboxSize')).toBe(TRANSICIONES_POR_ORDEN)
    },
    TIMEOUT_DEL_TEST_MS,
  )
})

describe('el agente con el enlace vivo (RF28, RF31, RF34, RF36)', () => {
  it(
    'reclama un pedido de picking, lo ejecuta y el servidor lo ve DONE',
    async () => {
      servidor = crearServidor({
        rutaDeBase: ':memory:',
        entorno: ENTORNO_DEL_SERVIDOR,
        httpPuerto: 0,
        httpBind: '127.0.0.1',
        // El default escribe a stdout: en la suite eso es ruido, no informacion.
        logger: LOGGER_SILENCIOSO,
        // Long-poll corto: el bucle del enlace tiene que dar varias vueltas dentro
        // del test, y con los 25 s de produccion daria una sola.
        configuracion: { esperaDeLongPollMs: 100, sondeoDeLongPollMs: 10 },
      })
      await servidor.iniciar()
      await servidor.credenciales.alta(KEY_ID, SITE_ID, SECRETO)
      const direccion = servidor.direccion()
      if (direccion === null) {
        throw new Error('el servidor no quedo escuchando')
      }

      agente = crearAgente({
        siteId: SITE_ID,
        agentId: AGENT_ID,
        rutaDeBase: ':memory:',
        montarApi: true,
        simularPlc: true,
        httpPuerto: 0,
        httpBind: '127.0.0.1',
        zonaDePickeo: ZONA_DE_PICKEO,
        tokenDeMantenimiento: null,
        enlace: {
          urlBase: `http://${direccion.host}:${String(direccion.puerto)}`,
          keyId: KEY_ID,
          secreto: SECRETO,
        },
      })
      await agente.iniciar()
      // La planta se siembra ANTES de que haya trabajo: un pedido que llega sin
      // robot dado de alta se rechaza y se reporta en ERROR, que es otro test.
      await sembrarPlanta()

      const pedido = await servidor.cola.insertar({
        siteId: SITE_ID,
        externalOrderId: 'PICK-1001',
        tipo: 'PICK',
        locationCode: ORIGEN,
      })
      expect(pedido.ok).toBe(true)

      const colaDelServidor = servidor.cola
      const cerroElCiclo = await esperarA(async () => {
        const remota = await colaDelServidor.buscarPorClave({
          siteId: SITE_ID,
          externalOrderId: 'PICK-1001',
        })
        return remota?.estado === 'DONE'
      })

      // Ida y vuelta completa: el servidor entrego, el agente movio el fierro y el
      // reporte volvio por el outbox.
      expect(cerroElCiclo).toBe(true)

      const repositorios = agenteVivo().orquestador.repositorios
      const [local] = await repositorios.ordenes.listar({ siteId: SITE_ID })
      expect(local?.externalOrderId).toBe('PICK-1001')
      expect(local?.origen).toBe('PICKING')
      expect(local?.slotLocationCode).toBe(SLOT_GANADOR)

      // RF31: el servidor sabe que la sucursal esta viva porque el agente late.
      const presencias = await servidor.credenciales.presencias()
      expect(presencias.map((presencia) => presencia.siteId)).toContain(SITE_ID)

      const salud = await obtener(`${baseDeLaApi()}/health`)
      expect(leer(salud, 'data.link.status')).toBe('CONNECTED')
      expect(leer(salud, 'data.link.outboxSize')).toBe(0)
      expect(typeof leer(salud, 'data.link.lastContactAt')).toBe('number')
    },
    TIMEOUT_DEL_TEST_MS,
  )
})
