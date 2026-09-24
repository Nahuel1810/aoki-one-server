// Resiliencia de la API del agente.
//
// Un throw del repositorio —SQLITE_BUSY, disco lleno, base corrupta, base
// cerrada— viajaba como unhandled rejection porque cada handler se registraba
// como `void (async () => {...})()` y Express 4 no mira esa promesa. Node baja el
// proceso ENTERO ante un rechazo sin manejar: una consulta de la tablet dejaba a
// la sucursal sin quien maneje el robot, y encima la request se quedaba colgada
// sin respuesta y sin timeout.
//
// La base se abre de verdad y se CIERRA por debajo: es la unica forma de que
// tiren los repositorios reales, con el throw sincrono de better-sqlite3, que es
// justo el que no se convierte en rechazo por si solo.

import { crearLogger, type RegistroDeLog } from '@aoki-one/domain'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DependenciasDelOrquestador, PuertoDeTransporte } from '../orchestrator/ports.js'
import { abrirBase } from '../persistence/database.js'
import { crearRepositorios } from '../persistence/index.js'
import { crearRelojDelSistema } from '../reloj.js'
import { crearServidorHttp, type ServidorHttp } from './httpServer.js'

const SITE_ID = 'SUC-TEST'

const TRANSPORTE_SIN_USO: PuertoDeTransporte = {
  ejecutarComandoDePaso: () => {
    throw new Error('estos casos no tocan el PLC')
  },
  resetearMessageIn: () => {
    throw new Error('estos casos no tocan el PLC')
  },
  leerRegistros: () => {
    throw new Error('estos casos no tocan el PLC')
  },
}

interface Levantado {
  readonly api: ServidorHttp
  readonly base: string
  /** Cierra la base del agente por debajo de la API, con la API ya escuchando. */
  readonly romperLaBase: () => void
  /** Lo que el agente logueo. El logger se INYECTA: no se espia la consola. */
  readonly logueado: RegistroDeLog[]
}

async function levantar(): Promise<Levantado> {
  const base = abrirBase(':memory:')
  const logueado: RegistroDeLog[] = []
  const orquestador: DependenciasDelOrquestador = {
    repositorios: crearRepositorios(base),
    siteId: SITE_ID,
    agentId: 'AG-TEST',
    logger: crearLogger({
      componente: 'agente',
      nivelMinimo: 'DEBUG',
      ahoraMs: () => 0,
      emitir: (registro) => logueado.push(registro),
    }),
    generarId: () => 'id-1',
    transporte: TRANSPORTE_SIN_USO,
    reloj: crearRelojDelSistema(),
    politica: { maxIntentos: 3, baseBackoffMs: 1 },
  }

  const api = crearServidorHttp({
    orquestador,
    simularPlc: true,
    despertar: () => undefined,
    tokenDeMantenimiento: null,
  })
  // Puerto 0: lo asigna el sistema. Uno fijo es EADDRINUSE en CI.
  const direccion = await api.escuchar(0, '127.0.0.1')
  return {
    api,
    logueado,
    base: `http://127.0.0.1:${String(direccion.puerto)}`,
    romperLaBase: () => {
      base.cerrar()
    },
  }
}

/**
 * Pide con corte propio: una request que no vuelve es el sintoma, no un cuelgue
 * del test. Sin esto el caso viejo no fallaba, se quedaba colgado hasta el
 * timeout de la suite.
 */
async function pedirConCorte(url: string): Promise<{ status: number; cuerpo: string }> {
  const respuesta = await fetch(url, { signal: AbortSignal.timeout(4_000) })
  return { status: respuesta.status, cuerpo: await respuesta.text() }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resiliencia de la API del agente', () => {
  it('traduce el fallo del repositorio a 500 y el agente sigue en pie', async () => {
    // El handler deja rastro en el log del agente: es el unico lugar donde queda,
    // porque el detalle no sale en la respuesta.
    const { api, base, romperLaBase, logueado } = await levantar()

    try {
      expect((await pedirConCorte(`${base}/health`)).status).toBe(200)

      romperLaBase()

      // Que conteste algo ya es la mitad del caso: antes el rechazo quedaba sin
      // manejar, Node mataba el proceso del agente y esta request no tenia
      // respuesta posible.
      const salud = await pedirConCorte(`${base}/health`)
      expect(salud.status).toBe(500)
      expect(JSON.parse(salud.cuerpo)).toEqual({ ok: false, error: 'error interno del agente' })
      expect(logueado.filter((registro) => registro.evento === 'API_UNHANDLED_FAILURE')).not.toEqual(
        [],
      )

      // Y la otra mitad: el proceso sigue vivo y la API sigue atendiendo, aunque
      // lo unico que pueda contestar sea el fallo.
      expect((await pedirConCorte(`${base}/api/orders`)).status).toBe(500)
      expect((await pedirConCorte(`${base}/api/orders/queue/status`)).status).toBe(500)
    } finally {
      await api.cerrar()
    }
  })

  it('no filtra el detalle del fallo a la tablet', async () => {
    const { api, base, romperLaBase } = await levantar()

    try {
      romperLaBase()
      const { cuerpo } = await pedirConCorte(`${base}/api/orders`)

      // El mensaje de SQLite nombra la base y el driver: es el mapa del agente.
      expect(cuerpo).not.toContain('database')
      expect(cuerpo).not.toContain('sqlite')
    } finally {
      await api.cerrar()
    }
  })
})
