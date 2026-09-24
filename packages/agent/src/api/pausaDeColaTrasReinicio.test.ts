// RF21 y RF25 — La pausa de cola sobrevive al reinicio, y se GRITA.
//
// DESVIO DECLARADO respecto del legacy, con su motivo: el `QueueManager` guarda
// `paused` en memoria y nadie llama a `restoreRobotQueue`, asi que un reinicio
// del proceso reanudaba la cola sola. Aca la pausa vive en la tabla
// `colas_pausadas` y sobrevive.
//
// Por que se conserva y no se copia al legacy: la pausa se aprieta por algo
// fisico —un cajon trabado, alguien trabajando sobre la estanteria— y olvidarla
// al reiniciar pone el robot en marcha solo. Entre las dos formas de
// equivocarse, esta es la que no mueve fierro.
//
// Lo que NO puede pasar es que quede pausado EN SILENCIO: la notebook arranca
// sola, nadie mira su consola y el operario ve un /health que dice "ok" con el
// robot detenido. Por eso el arranque grita QUEUE_PAUSED_AT_STARTUP y /health
// informa `paused` por robot.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { crearLogger, type Logger, type RegistroDeLog } from '@aoki-one/domain'

import { crearAgente, type Agente, type OpcionesDelAgente } from '../composition.js'

const SITE_ID = 'SUC-PAUSA'
const ROBOT_ID = '1'

let carpeta = ''
let rutaDeBase = ''

/** Logger que acumula: es lo que permite afirmar que el arranque grito. */
function crearLoggerEspia(registros: RegistroDeLog[]): Logger {
  return crearLogger({
    componente: 'agente',
    nivelMinimo: 'DEBUG',
    ahoraMs: () => 0,
    emitir: (registro) => registros.push(registro),
  })
}

function opciones(logger: Logger): OpcionesDelAgente {
  return {
    siteId: SITE_ID,
    agentId: 'AG-PAUSA',
    rutaDeBase,
    montarApi: true,
    simularPlc: true,
    httpPuerto: 0,
    httpBind: '127.0.0.1',
    zonaDePickeo: ['3X02AE1'],
    tokenDeMantenimiento: null,
    enlace: null,
    logger,
  }
}

async function levantarAgente(logger: Logger): Promise<Agente> {
  const agente = crearAgente(opciones(logger))

  const robot = await agente.orquestador.repositorios.robots.guardar({
    id: ROBOT_ID,
    siteId: SITE_ID,
    estanteriaCode: '3X',
    habilitado: true,
    estado: 'IDLE',
    ordenActivaId: null,
  })
  if (!robot.ok) {
    throw new Error(`no se pudo sembrar el robot: ${robot.error.codigo}`)
  }

  await agente.iniciar()
  return agente
}

function urlDe(agente: Agente, ruta: string): string {
  const direccion = agente.direccion()
  if (direccion === null) {
    throw new Error('el agente no monto la API')
  }
  return `http://${direccion.host}:${String(direccion.puerto)}${ruta}`
}

interface RobotDeHealth {
  readonly robotId: string
  readonly paused: boolean
}

async function robotsDeHealth(agente: Agente): Promise<readonly RobotDeHealth[]> {
  const respuesta = await fetch(urlDe(agente, '/health'))
  const cuerpo = (await respuesta.json()) as { readonly robots: readonly RobotDeHealth[] }
  // Solo los dos campos que este test mira: el resto de /health tiene su propio test.
  return cuerpo.robots.map((robot) => ({ robotId: robot.robotId, paused: robot.paused }))
}

beforeEach(() => {
  // La base va a disco: la pausa que sobrevive a un reinicio no se puede afirmar
  // contra `:memory:`, que muere con el proceso.
  carpeta = mkdtempSync(join(tmpdir(), 'aoki-pausa-'))
  rutaDeBase = join(carpeta, 'persistencia.db')
})

afterEach(() => {
  rmSync(carpeta, { recursive: true, force: true })
})

describe('pausa de cola y reinicio del proceso', () => {
  it('sigue pausada despues del reinicio y el arranque lo grita', async () => {
    const primerArranque: RegistroDeLog[] = []
    const primero = await levantarAgente(crearLoggerEspia(primerArranque))

    try {
      const pausa = await fetch(urlDe(primero, `/api/orders/queue/${ROBOT_ID}/pause`), {
        method: 'POST',
      })
      expect(pausa.status).toBe(200)

      // El viernes se pausa y nadie mas toca nada.
      expect(primerArranque.some((registro) => registro.evento === 'QUEUE_PAUSED_AT_STARTUP')).toBe(
        false,
      )
    } finally {
      await primero.detener()
    }

    // El lunes la notebook arranca sola.
    const segundoArranque: RegistroDeLog[] = []
    const segundo = await levantarAgente(crearLoggerEspia(segundoArranque))

    try {
      const aviso = segundoArranque.find(
        (registro) => registro.evento === 'QUEUE_PAUSED_AT_STARTUP',
      )
      expect(aviso).toBeDefined()
      expect(aviso?.nivel).toBe('WARN')
      expect(aviso?.datos).toEqual({ robotId: ROBOT_ID })

      // Y se ve desde la tablet, que es lo unico que mira el operario.
      const robots = await robotsDeHealth(segundo)
      expect(robots).toEqual([{ robotId: ROBOT_ID, paused: true }])
    } finally {
      await segundo.detener()
    }
  })

  it('reanudada, el reinicio arranca sin aviso y /health dice paused false', async () => {
    const primero = await levantarAgente(crearLoggerEspia([]))
    try {
      await fetch(urlDe(primero, `/api/orders/queue/${ROBOT_ID}/pause`), { method: 'POST' })
      const reanudar = await fetch(urlDe(primero, `/api/orders/queue/${ROBOT_ID}/resume`), {
        method: 'POST',
      })
      expect(reanudar.status).toBe(200)
    } finally {
      await primero.detener()
    }

    const registros: RegistroDeLog[] = []
    const segundo = await levantarAgente(crearLoggerEspia(registros))
    try {
      expect(registros.some((registro) => registro.evento === 'QUEUE_PAUSED_AT_STARTUP')).toBe(false)
      const robots = await robotsDeHealth(segundo)
      expect(robots).toEqual([{ robotId: ROBOT_ID, paused: false }])
    } finally {
      await segundo.detener()
    }
  })
})
