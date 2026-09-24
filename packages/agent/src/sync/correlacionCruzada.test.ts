// RNF de Observabilidad — "el mismo id de orden a los dos lados del enlace".
//
// `correlacion.test.ts` afirma la mitad del AGENTE: que el id que el agente
// loguea es el que el servidor tiene en su libro. Eso deja el RNF a medias,
// porque el otro lado no escribia una sola linea: un id correcto que aparece en
// un solo log no se puede cruzar con nada.
//
// Este test cierra el circulo. Levanta el servidor y el agente de verdad, cada
// uno con SU logger, y recorre el hilo entero:
//
//   app de picking -> alta en el servidor -> entrega con lease -> espejado en la
//   sucursal -> comando al PLC -> reporte -> transicion aplicada en el servidor
//
// y exige que, en las dos mitades, todas esas lineas lleven el MISMO `ordenId`.
// Es la operacion que alguien hace a mano cuando el operario dice "el pedido 47
// se trabo": juntar los dos logs y filtrar por un solo campo.
//
// El alta entra por HTTP firmado y no por `cola.insertar`: el primer eslabon del
// hilo es justo el que crea el id, y sembrarlo por abajo saltearia la linea que
// se quiere afirmar.

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { crearLogger, type Logger, type RegistroDeLog } from '@aoki-one/domain'

import { firmar } from '../../../server/src/api/hmac.js'
import {
  HEADER_FIRMA,
  HEADER_KEY_ID,
  HEADER_TIMESTAMP,
} from '../../../server/src/api/httpServer.js'
import { crearServidor, type Servidor } from '../../../server/src/composition.js'
import {
  generarClaveDeCifrado,
  VARIABLE_DE_CLAVE,
} from '../../../server/src/persistence/cifrado.js'
import type { DependenciasDelOrquestador, PuertoDeTransporte } from '../orchestrator/ports.js'
import { ejecutarCicloDeRobot } from '../orchestrator/robotLoop.js'
import { abrirBase, type BaseDelAgente } from '../persistence/database.js'
import { crearRepositorios } from '../persistence/index.js'
import { crearRelojDelSistema } from '../reloj.js'
import { crearEnlace, type Enlace } from './link.js'
import { crearOrigenPorLongPoll } from './orderSource.js'
import { crearOutboxSqlite } from './outbox.js'
import { crearClienteHttp } from './serverClient.js'

const ENTORNO_DEL_SERVIDOR = { [VARIABLE_DE_CLAVE]: generarClaveDeCifrado() }

const SITE_ID = 'SUC-CRUCE'
const KEY_ID = 'key-cruce'
const SECRETO = 'secreto-cruce'
const AGENT_ID = 'AG-1'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'
const ORIGEN = '3X04AE1'

/** El numero que dice el operario. */
const PEDIDO_DEL_OPERARIO = '47'

const ZONA_DE_PICKEO: readonly string[] = ['3X02AE1', '3X01AE1', '3X01AE2']

const TRANSPORTE_QUE_ANDA: PuertoDeTransporte = {
  ejecutarComandoDePaso: () => Promise.resolve({ ok: true, valor: { kind: 'OK' } }),
  resetearMessageIn: () => Promise.resolve({ ok: true, valor: undefined }),
  leerRegistros: () =>
    Promise.resolve({ ok: true, valor: { messageIn1: 0, messageIn2: null, messageOut: 0 } }),
}

let servidor: Servidor | null = null
let base: BaseDelAgente | null = null
let orquestador: DependenciasDelOrquestador
let enlace: Enlace
let urlDelServidor: string

/** Las dos mitades, cada una con su propio destino en memoria. */
let enElServidor: RegistroDeLog[]
let enElAgente: RegistroDeLog[]

function crearLoggerQueAcumula(componente: string, destino: RegistroDeLog[]): Logger {
  return crearLogger({
    componente,
    // DEBUG a proposito: es el nivel en el que el agente escribe cada comando al
    // PLC, que es la punta mas lejana del hilo.
    nivelMinimo: 'DEBUG',
    ahoraMs: () => Date.now(),
    emitir: (registro) => destino.push(registro),
  })
}

function lineas(registros: readonly RegistroDeLog[], evento: string): readonly RegistroDeLog[] {
  return registros.filter((registro) => registro.evento === evento)
}

function unaLinea(registros: readonly RegistroDeLog[], evento: string): RegistroDeLog {
  const primera = lineas(registros, evento)[0]
  if (primera === undefined) {
    throw new Error(
      `no se logueo ${evento}. Se logueo: ${registros.map((r) => r.evento).join(', ')}`,
    )
  }
  return primera
}

async function montar(): Promise<void> {
  enElServidor = []
  enElAgente = []

  servidor = crearServidor({
    rutaDeBase: ':memory:',
    entorno: ENTORNO_DEL_SERVIDOR,
    httpPuerto: 0,
    httpBind: '127.0.0.1',
    configuracion: { esperaDeLongPollMs: 100, sondeoDeLongPollMs: 10 },
    logger: crearLoggerQueAcumula('servidor', enElServidor),
  })
  await servidor.iniciar()
  await servidor.credenciales.alta(KEY_ID, SITE_ID, SECRETO)

  const direccion = servidor.direccion()
  if (direccion === null) {
    throw new Error('el servidor no quedo escuchando')
  }
  urlDelServidor = `http://${direccion.host}:${String(direccion.puerto)}`

  base = abrirBase(':memory:')
  const repositorios = crearRepositorios(base)
  const outbox = crearOutboxSqlite(base)

  const reloj = crearRelojDelSistema()
  const cliente = crearClienteHttp({
    urlBase: urlDelServidor,
    siteId: SITE_ID,
    agentId: AGENT_ID,
    credencial: { keyId: KEY_ID, secreto: SECRETO },
    tiempos: { timeoutMs: 1_000, timeoutDeLongPollMs: 1_000 },
    pedir: fetch,
    ahoraMs: () => reloj.ahoraMs(),
  })

  orquestador = {
    repositorios,
    siteId: SITE_ID,
    agentId: AGENT_ID,
    logger: crearLoggerQueAcumula('agente', enElAgente),
    generarId: () => randomUUID(),
    transporte: TRANSPORTE_QUE_ANDA,
    reloj,
    politica: { maxIntentos: 3, baseBackoffMs: 1 },
    outbox,
  }

  enlace = crearEnlace({
    origen: crearOrigenPorLongPoll(cliente),
    cliente,
    outbox,
    orquestador,
    azar: { siguiente: () => 0.5 },
    opciones: {
      limiteDeReclamo: 10,
      loteDeOutbox: 50,
      intervaloDeLatidoMs: 15_000,
      esperaMinimaEntreCiclosMs: 250,
      maxIntentosDeTransicion: 10,
      backoff: { baseMs: 1, techoMs: 5, fraccionDeJitter: 0.5 },
    },
    despertar: () => undefined,
  })

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

/** El alta tal como la manda la app de picking: firmada sobre los bytes del body. */
async function altaDePedido(externalOrderId: string): Promise<Response> {
  const cuerpo = JSON.stringify({
    siteId: SITE_ID,
    externalOrderId,
    tipo: 'PICK',
    locationCode: ORIGEN,
  })
  const ahora = Date.now()
  return fetch(`${urlDelServidor}/api/v1/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [HEADER_KEY_ID]: KEY_ID,
      [HEADER_TIMESTAMP]: String(ahora),
      [HEADER_FIRMA]: firmar(SECRETO, ahora, cuerpo),
    },
    body: cuerpo,
  })
}

/** El id que el servidor le puso al pedido: la clave contra la que se compara todo. */
async function darDeAlta(externalOrderId: string): Promise<string> {
  const respuesta = await altaDePedido(externalOrderId)
  if (respuesta.status !== 202) {
    throw new Error(`el alta no fue aceptada: ${String(respuesta.status)}`)
  }
  const cuerpo = (await respuesta.json()) as { readonly data: { readonly id: string } }
  return cuerpo.data.id
}

afterEach(async () => {
  base?.cerrar()
  base = null
  if (servidor !== null) {
    await servidor.detener()
    servidor = null
  }
})

describe('la misma orden queda logueada en los DOS lados del enlace', () => {
  it('el servidor loguea el alta y la entrega con el id con el que el agente la conoce', async () => {
    await montar()
    const ordenId = await darDeAlta(PEDIDO_DEL_OPERARIO)

    await enlace.sincronizar()

    // --- mitad del servidor
    const ingresada = unaLinea(enElServidor, 'ORDER_INGESTED')
    expect(ingresada.componente).toBe('servidor')
    expect(ingresada.correlacion?.ordenId).toBe(ordenId)
    expect(ingresada.correlacion?.externalOrderId).toBe(PEDIDO_DEL_OPERARIO)
    // El servidor no conoce el libro del agente, y lo dice en vez de omitirlo.
    expect(ingresada.correlacion?.ordenIdLocal).toBeNull()
    expect(ingresada.datos['creado']).toBe(true)

    const entregada = unaLinea(enElServidor, 'WORK_LEASED')
    expect(entregada.correlacion?.ordenId).toBe(ordenId)
    expect(entregada.datos['agentId']).toBe(AGENT_ID)

    // --- mitad del agente, con el MISMO id
    const espejada = unaLinea(enElAgente, 'ORDER_MIRRORED')
    expect(espejada.componente).toBe('agente')
    expect(espejada.correlacion?.ordenId).toBe(ordenId)
    // Y el id local es otro: son dos libros distintos, y por eso las dos claves
    // tienen que viajar juntas en la misma linea.
    expect(espejada.correlacion?.ordenIdLocal).not.toBe(ordenId)
  })

  it('el hilo completo se sigue con un solo id, de la app de picking al PLC y de vuelta', async () => {
    await montar()
    const ordenId = await darDeAlta(PEDIDO_DEL_OPERARIO)

    await enlace.sincronizar()
    const ciclo = await ejecutarCicloDeRobot(orquestador, ROBOT_ID)
    expect(ciclo.tipo).toBe('ORDEN_TERMINADA')
    await enlace.sincronizar()

    // Esto es literalmente lo que hace alguien con los dos logs delante: juntar
    // las dos mitades y filtrar por un solo campo.
    const deLaOrden = [...enElServidor, ...enElAgente].filter(
      (registro) => registro.correlacion?.ordenId === ordenId,
    )
    const eventos = deLaOrden.map((registro) => registro.evento)

    // Las cuatro puntas del hilo: alta y entrega del lado del servidor, comando
    // al PLC del lado del agente, y la transicion aplicada de vuelta.
    expect(eventos).toContain('ORDER_INGESTED')
    expect(eventos).toContain('WORK_LEASED')
    expect(eventos).toContain('STEP_SENT')
    expect(eventos).toContain('TRANSITION_APPLIED')

    // Y el cruce es real: hay lineas de los dos componentes bajo el mismo id.
    const componentes = new Set(deLaOrden.map((registro) => registro.componente))
    expect(componentes).toEqual(new Set(['servidor', 'agente']))

    // Ningun `ordenId` ajeno se colo: una sola orden, una sola clave.
    const ids = new Set(
      [...enElServidor, ...enElAgente]
        .map((registro) => registro.correlacion?.ordenId)
        .filter((valor) => valor !== undefined && valor !== null),
    )
    expect(ids).toEqual(new Set([ordenId]))

    // El servidor aplico las transiciones que el agente reporto, en orden y
    // hasta la ultima: el circulo cierra.
    const aplicadas = lineas(enElServidor, 'TRANSITION_APPLIED')
    expect(aplicadas.map((registro) => registro.datos['estado'])).toEqual([
      'IN_PROGRESS',
      'DONE',
    ])
    expect(unaLinea(enElAgente, 'TRANSITION_REPORTED').correlacion?.ordenId).toBe(ordenId)
  })

  it('el reenvio del mismo pedido se distingue del alta, con el mismo id', async () => {
    // RF26: un reenvio no crea una segunda orden. Sin el `creado` en el log, dos
    // lineas del mismo id se leerian como dos altas.
    await montar()
    const ordenId = await darDeAlta(PEDIDO_DEL_OPERARIO)

    const reenvio = await altaDePedido(PEDIDO_DEL_OPERARIO)
    expect(reenvio.status).toBe(200)

    const altas = lineas(enElServidor, 'ORDER_INGESTED')
    expect(altas).toHaveLength(2)
    expect(altas.map((registro) => registro.datos['creado'])).toEqual([true, false])
    for (const alta of altas) {
      expect(alta.correlacion?.ordenId).toBe(ordenId)
    }
  })
})

describe('los rechazos de autenticacion del servidor quedan logueados', () => {
  it('una firma que no cierra deja linea con el keyId y la ruta', async () => {
    // Es lo primero que se mira cuando una sucursal deja de reportar: sin esta
    // linea, un secreto desactualizado despues de una rotacion se ve igual que
    // una notebook apagada.
    await montar()

    const cuerpo = JSON.stringify({ siteId: SITE_ID, agentId: AGENT_ID })
    const ahora = Date.now()
    const respuesta = await fetch(`${urlDelServidor}/api/v1/agent/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [HEADER_KEY_ID]: KEY_ID,
        [HEADER_TIMESTAMP]: String(ahora),
        [HEADER_FIRMA]: firmar('el-secreto-viejo', ahora, cuerpo),
      },
      body: cuerpo,
    })
    expect(respuesta.status).toBe(401)

    const rechazo = unaLinea(enElServidor, 'AUTH_REJECTED')
    expect(rechazo.nivel).toBe('WARN')
    expect(rechazo.datos['keyId']).toBe(KEY_ID)
    expect(rechazo.datos['ruta']).toBe('/api/v1/agent/heartbeat')
    // La credencial existe, asi que el servidor puede decir de que sucursal es:
    // es lo que decide a quien llamar.
    expect(rechazo.datos['siteId']).toBe(SITE_ID)
  })

  it('un keyId que no existe tambien deja linea, y sin correlacion de orden', async () => {
    await montar()

    const cuerpo = JSON.stringify({ siteId: SITE_ID, agentId: AGENT_ID })
    const ahora = Date.now()
    const respuesta = await fetch(`${urlDelServidor}/api/v1/agent/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [HEADER_KEY_ID]: 'key-que-no-existe',
        [HEADER_TIMESTAMP]: String(ahora),
        [HEADER_FIRMA]: firmar(SECRETO, ahora, cuerpo),
      },
      body: cuerpo,
    })
    expect(respuesta.status).toBe(401)

    const rechazo = unaLinea(enElServidor, 'AUTH_REJECTED')
    expect(rechazo.datos['keyId']).toBe('key-que-no-existe')
    // No hay orden de la que hablar: la correlacion va nula, no inventada.
    expect(rechazo.correlacion).toBeNull()
  })
})
