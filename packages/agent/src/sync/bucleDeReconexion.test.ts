// RF37 — El bucle de reconexion, con el servidor ausente de verdad.
//
// `backoff.test.ts` afirma la formula. Esto afirma que el BUCLE la usa: que la
// espera crece con cada vuelta fallida, que se corta en el techo y que el jitter
// sale del azar inyectado. El enlace apunta a un puerto donde no escucha nadie,
// asi que el fallo es un ECONNREFUSED real y no un doble que devuelve `SIN_RED`.
//
// El reloj esta doblado y solo el reloj: `dormir` anota cuanto le pidieron y
// vuelve enseguida. Sin eso el test tardaria la suma del backoff, que es
// exactamente lo que el backoff existe para hacer larga.

import { createServer } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DependenciasDelOrquestador, PuertoDeTransporte } from '../orchestrator/ports.js'
import { abrirBase, type BaseDelAgente } from '../persistence/database.js'
import { crearRepositorios } from '../persistence/index.js'
import type { Reloj } from '../reloj.js'
import type { Azar, PoliticaDeBackoff } from './backoff.js'
import { crearEnlace, type Enlace } from './link.js'
import { crearOrigenPorLongPoll } from './orderSource.js'
import { crearOutboxSqlite, type OutboxDeTransiciones } from './outbox.js'
import { crearClienteHttp, TIEMPOS_DEL_CLIENTE_POR_DEFECTO } from './serverClient.js'

const SITE_ID = 'SUC-ENLACE'
const AGENT_ID = 'AG-1'
const AHORA_MS = 1_700_000_000_000

/**
 * Politica chica para que el techo se alcance en pocas vueltas.
 *
 * Con base 100 y techo 400 el tramo crudo es 100, 200, 400, 400, ...: tres
 * duplicaciones y despues la meseta, que es la forma que importa.
 */
const POLITICA: PoliticaDeBackoff = { baseMs: 100, techoMs: 400, fraccionDeJitter: 0.5 }
const CRUDOS = [100, 200, 400, 400, 400, 400]
const VUELTAS = CRUDOS.length

const TRANSPORTE_SIN_USO: PuertoDeTransporte = {
  ejecutarComandoDePaso: () => {
    throw new Error('el enlace no ejecuta pasos')
  },
  resetearMessageIn: () => {
    throw new Error('el enlace no toca el PLC')
  },
  leerRegistros: () => {
    throw new Error('el enlace no lee registros')
  },
}

interface RelojQueAnota {
  readonly reloj: Reloj
  readonly esperas: number[]
  /** Se resuelve cuando ya se anotaron `VUELTAS` esperas. */
  readonly suficientes: Promise<void>
}

function crearRelojQueAnota(): RelojQueAnota {
  const esperas: number[] = []
  let avisar: () => void = () => undefined
  const suficientes = new Promise<void>((resolve) => {
    avisar = resolve
  })

  return {
    esperas,
    suficientes,
    reloj: {
      ahoraMs: () => AHORA_MS,
      dormir: (ms) => {
        esperas.push(ms)
        if (esperas.length >= VUELTAS) {
          avisar()
        }
        return Promise.resolve()
      },
    },
  }
}

/** Un puerto que se reserva y se suelta: apuntar ahi da un ECONNREFUSED real. */
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

let base: BaseDelAgente
let outbox: OutboxDeTransiciones

beforeEach(() => {
  base = abrirBase(':memory:')
  outbox = crearOutboxSqlite(base)
})

afterEach(() => {
  base.cerrar()
})

/**
 * Arma el enlace contra la nada y lo deja correr hasta juntar `VUELTAS` esperas.
 *
 * Deja una transicion encolada a proposito: el ciclo falla en el drenado, que es
 * el primer paso, y de paso permite afirmar que la cola no se vacia mientras el
 * enlace esta caido.
 */
async function correrElBucleContraLaNada(azar: Azar): Promise<{
  readonly esperas: readonly number[]
  readonly enlace: Enlace
}> {
  const puertoMuerto = await puertoSinNadieEscuchando()
  const anotador = crearRelojQueAnota()

  const cliente = crearClienteHttp({
    urlBase: `http://127.0.0.1:${String(puertoMuerto)}`,
    siteId: SITE_ID,
    agentId: AGENT_ID,
    credencial: { keyId: 'key', secreto: 'secreto' },
    // No escucha nadie en ese puerto: el fallo es un ECONNREFUSED inmediato y el
    // timeout nunca llega a correr. Los tiempos de produccion alcanzan.
    tiempos: TIEMPOS_DEL_CLIENTE_POR_DEFECTO,
    pedir: fetch,
    ahoraMs: () => AHORA_MS,
  })

  const orquestador: DependenciasDelOrquestador = {
    repositorios: crearRepositorios(base),
    siteId: SITE_ID,
    agentId: AGENT_ID,
    generarId: () => 'no-se-usa',
    transporte: TRANSPORTE_SIN_USO,
    reloj: anotador.reloj,
    politica: { maxIntentos: 3, baseBackoffMs: 1 },
    outbox,
  }

  await outbox.vincular('o-1', 'remota-1')
  await outbox.encolar({ ordenId: 'o-1', estado: 'DONE', metadata: {}, creadaEn: AHORA_MS })

  const enlace = crearEnlace({
    origen: crearOrigenPorLongPoll(cliente),
    cliente,
    outbox,
    orquestador,
    azar,
    opciones: {
      limiteDeReclamo: 10,
      loteDeOutbox: 50,
      intervaloDeLatidoMs: 15_000,
      esperaMinimaEntreCiclosMs: 250,
      maxIntentosDeTransicion: 10,
      backoff: POLITICA,
    },
    despertar: () => undefined,
  })

  enlace.iniciar()
  await anotador.suficientes
  await enlace.detener()

  return { esperas: anotador.esperas.slice(0, VUELTAS), enlace }
}

describe('bucle de reconexion (RF37)', () => {
  it('duplica la espera con cada vuelta fallida y la corta en el techo', async () => {
    // Azar en 0: la espera es el piso del tramo, o sea la formula sin jitter.
    const { esperas, enlace } = await correrElBucleContraLaNada({ siguiente: () => 0 })

    expect(esperas).toEqual(CRUDOS.map((crudo) => crudo * (1 - POLITICA.fraccionDeJitter)))
    // Sin el techo, una caida de una hora daria esperas de horas y la sucursal
    // tardaria eso en reconectar cuando el servidor vuelve.
    expect(esperas.at(-1)).toBe(POLITICA.techoMs * (1 - POLITICA.fraccionDeJitter))

    const estado = await enlace.estado()
    expect(estado.status).toBe('DEGRADED')
    expect(estado.lastContactAt).toBeNull()
    // La cola no se toca mientras no hay a quien reportarle: reintentar no puede
    // costar transiciones.
    expect(estado.outboxSize).toBe(1)
  })

  it('el jitter mueve la espera dentro del tramo y sale del azar inyectado', async () => {
    const { esperas } = await correrElBucleContraLaNada({ siguiente: () => 0.9 })

    // Con fraccion 0.5 el sorteo solo puede mover la mitad superior del tramo: la
    // espera nunca baja del piso ni pasa el crudo.
    expect(esperas).toEqual(CRUDOS.map((crudo) => Math.round(crudo * 0.95)))
    esperas.forEach((espera, indice) => {
      const crudo = CRUDOS[indice] ?? 0
      expect(espera).toBeGreaterThanOrEqual(crudo * (1 - POLITICA.fraccionDeJitter))
      expect(espera).toBeLessThanOrEqual(crudo)
    })
  })
})
