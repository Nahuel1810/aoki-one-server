// Resiliencia de la API del servidor.
//
// Dos cosas que no son "casos borde" sino las dos formas concretas en que este
// proceso se rompia en produccion:
//
//   1. Cualquier throw del repositorio —SQLITE_BUSY, disco lleno, base
//      corrupta— viajaba como unhandled rejection y BAJABA EL PROCESO. El
//      servidor es el unico componente expuesto a internet: una request sola no
//      puede dejar sin servicio a todas las sucursales.
//   2. El long-poll seguia reclamando trabajo para un cliente que ya se habia
//      desconectado. El lote salia de la cola con lease de 60 s, la respuesta se
//      escribia en un socket muerto y esas ordenes quedaban invisibles hasta que
//      el lease vencia: el agente no las recibio y el servidor creia que si.

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  crearLogger,
  LOGGER_SILENCIOSO,
  type Logger,
  type RegistroDeLog,
} from '@aoki-one/domain'

import type {
  CredencialDeAgente,
  CredentialsRepository,
} from '../persistence/credentialsRepository.js'
import type { PedidoDelServidor } from '../persistence/ordersRepository.js'
import type { ColaDelServidor, PedidoConLease } from '../persistence/sqliteOrdersRepository.js'
import { firmar } from './hmac.js'
import {
  crearServidorHttp,
  HEADER_FIRMA,
  HEADER_KEY_ID,
  HEADER_TIMESTAMP,
  type ConfiguracionDelServidor,
  type ServidorHttp,
} from './httpServer.js'

const SITE_ID = 'SUC-1'
const KEY_ID = 'key-suc-1'
const SECRETO = 'secreto-de-prueba'
const AGENT_ID = 'agente-1'

const CREDENCIAL: CredencialDeAgente = {
  keyId: KEY_ID,
  siteId: SITE_ID,
  revocadaEn: null,
  ultimoVisto: null,
}

const CONFIGURACION: ConfiguracionDelServidor = {
  ventanaDeFirmaMs: 5 * 60 * 1000,
  // Larga a proposito: el test corta la conexion a mitad del long-poll, asi que
  // el timeout no puede ser quien termine el bucle.
  esperaDeLongPollMs: 10 * 1000,
  sondeoDeLongPollMs: 20,
  duracionDelLeaseMs: 60 * 1000,
  toleranciaDeLatidoMs: 90 * 1000,
}

const PEDIDO: PedidoDelServidor = {
  id: 'orden-1',
  siteId: SITE_ID,
  externalOrderId: 'pedido-1',
  tipo: 'PICK',
  locationCode: '3X04AE1',
  estado: 'PENDING',
  creadaEn: 0,
}

/** El repositorio no se usa en estos casos salvo por el metodo que cada test define. */
function colaQueNoSeUsa(): ColaDelServidor {
  const noEsperado = (nombre: string) => (): never => {
    throw new Error(`no se esperaba ${nombre}`)
  }
  return {
    buscarPorClave: noEsperado('buscarPorClave'),
    insertar: noEsperado('insertar'),
    reclamar: noEsperado('reclamar'),
    aplicarTransicion: noEsperado('aplicarTransicion'),
    buscarPorId: noEsperado('buscarPorId'),
    pendientes: noEsperado('pendientes'),
  }
}

/** Credenciales validas: lo que se prueba aca no es la autenticacion. */
function credencialesValidas(): CredentialsRepository {
  return {
    alta: () => Promise.resolve(CREDENCIAL),
    resolverSecreto: () =>
      Promise.resolve({ ok: true, valor: { credencial: CREDENCIAL, secreto: SECRETO } }),
    buscar: () => Promise.resolve(CREDENCIAL),
    revocar: () => Promise.resolve(),
    registrarLatido: () => Promise.resolve(),
    presencias: () => Promise.resolve([]),
  }
}

interface Levantado {
  readonly servidor: ServidorHttp
  readonly base: string
}

async function levantar(
  cola: ColaDelServidor,
  logger: Logger = LOGGER_SILENCIOSO,
): Promise<Levantado> {
  const servidor = crearServidorHttp({
    cola,
    credenciales: credencialesValidas(),
    ahora: () => Date.now(),
    dormir: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    configuracion: CONFIGURACION,
    logger,
  })
  // Puerto 0: lo asigna el sistema. Uno fijo es EADDRINUSE en CI.
  const direccion = await servidor.escuchar(0, '127.0.0.1')
  return { servidor, base: `http://127.0.0.1:${String(direccion.puerto)}` }
}

/** Request firmada, como la manda el agente. */
function comoAgente(
  base: string,
  ruta: string,
  cuerpo: unknown,
  signal: AbortSignal | null = null,
): Promise<Response> {
  const body = JSON.stringify(cuerpo)
  const ahora = Date.now()
  return fetch(`${base}${ruta}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [HEADER_KEY_ID]: KEY_ID,
      [HEADER_TIMESTAMP]: String(ahora),
      [HEADER_FIRMA]: firmar(SECRETO, ahora, body),
    },
    body,
    signal,
  })
}

const esperar = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resiliencia del servidor', () => {
  it('traduce el fallo del repositorio a 500 y sigue atendiendo', async () => {
    // El middleware de error deja rastro en el log del servidor: es el unico
    // lugar donde queda, porque el detalle no sale en la respuesta. Y va por el
    // logger estructurado, no por `console.error`: una linea con otra forma no
    // la encuentra el que la busca.
    const emitidos: RegistroDeLog[] = []

    const cola = colaQueNoSeUsa()
    let reclamos = 0
    const conRepositorioRoto: ColaDelServidor = {
      ...cola,
      reclamar: () => {
        reclamos += 1
        return Promise.reject(new Error('SQLITE_BUSY: database is locked'))
      },
      pendientes: () => Promise.resolve(0),
    }

    const { servidor, base } = await levantar(
      conRepositorioRoto,
      crearLogger({
        componente: 'servidor',
        nivelMinimo: 'DEBUG',
        ahoraMs: () => 0,
        emitir: (registro) => emitidos.push(registro),
      }),
    )

    try {
      const respuesta = await comoAgente(base, '/api/v1/agent/work', {
        siteId: SITE_ID,
        agentId: AGENT_ID,
        limite: 10,
      })

      // Que conteste algo ya es la mitad del test: antes el rechazo de la IIFE
      // async quedaba sin manejar y Node mataba el proceso, asi que esta request
      // no tenia respuesta posible.
      expect(respuesta.status).toBe(500)
      expect(await respuesta.json()).toEqual({ ok: false, error: 'error interno del servidor' })
      expect(reclamos).toBe(1)
      const fallo = emitidos.find((registro) => registro.evento === 'REQUEST_FAILED')
      expect(fallo?.nivel).toBe('ERROR')
      expect(fallo?.datos['ruta']).toBe('/api/v1/agent/work')
      expect(String(fallo?.datos['detalle'])).toContain('SQLITE_BUSY')

      // Y la otra mitad: el proceso sigue en pie y el servidor sigue atendiendo.
      const salud = await fetch(`${base}/health`)
      expect(salud.status).toBe(200)
    } finally {
      await servidor.cerrar()
    }
  })

  it('no filtra el detalle del fallo al cliente', async () => {
    const conSecretoEnElError: ColaDelServidor = {
      ...colaQueNoSeUsa(),
      reclamar: () =>
        Promise.reject(new Error('SQLITE_ERROR: no such column: /var/lib/aoki/ordenes.db')),
    }
    const { servidor, base } = await levantar(conSecretoEnElError)

    try {
      const respuesta = await comoAgente(base, '/api/v1/agent/work', {
        siteId: SITE_ID,
        agentId: AGENT_ID,
        limite: 10,
      })
      const cuerpo = JSON.stringify(await respuesta.json())

      // Un stack trace o una ruta del filesystem en la respuesta le dibuja al
      // atacante el mapa del servidor.
      expect(cuerpo).not.toContain('SQLITE_ERROR')
      expect(cuerpo).not.toContain('/var/lib/aoki')
    } finally {
      await servidor.cerrar()
    }
  })

  it('deja de reclamar trabajo cuando el agente corta la conexion', async () => {
    let reclamos = 0
    let hayTrabajo = false
    let arrendado: PedidoConLease | null = null

    const cola: ColaDelServidor = {
      ...colaQueNoSeUsa(),
      reclamar: (_siteId, agentId, _limite, ahoraMs, duracionDelLeaseMs) => {
        reclamos += 1
        if (!hayTrabajo) {
          return Promise.resolve([])
        }
        // Reclamar ARRIENDA: la orden sale de la cola con lease vigente y no
        // vuelve a estar disponible hasta que vence.
        arrendado = { ...PEDIDO, agentId, leaseVenceEn: ahoraMs + duracionDelLeaseMs }
        return Promise.resolve([arrendado])
      },
    }

    const { servidor, base } = await levantar(cola)

    try {
      const corte = new AbortController()
      const pendiente = comoAgente(
        base,
        '/api/v1/agent/work',
        { siteId: SITE_ID, agentId: AGENT_ID, limite: 10 },
        corte.signal,
      ).catch(() => null)

      // El long-poll arranca y da unas vueltas en vacio.
      await esperar(120)
      expect(reclamos).toBeGreaterThan(0)

      // Al agente se le cae la red a mitad del long-poll.
      corte.abort()
      await pendiente
      await esperar(80)
      const alCortar = reclamos

      // Y recien despues aparece trabajo para esa sucursal.
      hayTrabajo = true
      await esperar(200)

      // El bucle tiene que haber muerto con la conexion: si siguio vivo, se
      // llevo la orden con lease de 60 s hacia un socket que no existe y nadie
      // la va a ejecutar hasta que el lease venza.
      expect(reclamos).toBe(alCortar)
      expect(arrendado).toBeNull()
    } finally {
      await servidor.cerrar()
    }
  })
})
