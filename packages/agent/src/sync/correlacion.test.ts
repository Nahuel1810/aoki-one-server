// RNF de Observabilidad — "Logs estructurados con nivel y correlacion por orden,
// con el mismo id de orden a los dos lados del enlace."
//
// Este es el test de la frase entera, y por eso corre contra el servidor DE
// VERDAD y no contra un doble: lo que hay que afirmar es que el id que el agente
// escribe en su log es EL MISMO que el servidor tiene en su libro. Contra un
// doble eso es tautologico —el doble devuelve el id que el test invento—; contra
// el servidor real es el unico cruce que despues permite contestar "el pedido 47
// se trabo, que paso".
//
// El hilo que se sigue es completo: alta en el servidor -> espejado en la
// sucursal -> comando al PLC -> reporte de vuelta. En las cuatro puntas tiene
// que estar el mismo par (`ordenId`, `externalOrderId`).

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  crearLogger,
  LOGGER_SILENCIOSO,
  type Logger,
  type RegistroDeLog,
} from '@aoki-one/domain'

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
import { crearOutboxSqlite, type OutboxDeTransiciones } from './outbox.js'
import { crearClienteHttp } from './serverClient.js'

const ENTORNO_DEL_SERVIDOR = { [VARIABLE_DE_CLAVE]: generarClaveDeCifrado() }

const SITE_ID = 'SUC-CORR'
const KEY_ID = 'key-corr'
const SECRETO = 'secreto-corr'
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
let outbox: OutboxDeTransiciones
let orquestador: DependenciasDelOrquestador
let enlace: Enlace
let emitidos: RegistroDeLog[]

/** Logger de verdad, con destino en memoria: se afirma el registro, no una linea de texto. */
function crearLoggerQueAcumula(destino: RegistroDeLog[]): Logger {
  return crearLogger({
    componente: 'agente',
    // DEBUG a proposito: es el nivel en el que aparece cada comando al PLC, que
    // es la punta del hilo que este test recorre.
    nivelMinimo: 'DEBUG',
    ahoraMs: () => Date.now(),
    emitir: (registro) => destino.push(registro),
  })
}

function lineas(evento: string): readonly RegistroDeLog[] {
  return emitidos.filter((registro) => registro.evento === evento)
}

function unaLinea(evento: string): RegistroDeLog {
  const encontradas = lineas(evento)
  const primera = encontradas[0]
  if (primera === undefined) {
    throw new Error(
      `no se logueo ${evento}. Se logueo: ${emitidos.map((r) => r.evento).join(', ')}`,
    )
  }
  return primera
}

async function montar(): Promise<void> {
  servidor = crearServidor({
    rutaDeBase: ':memory:',
    entorno: ENTORNO_DEL_SERVIDOR,
    httpPuerto: 0,
    httpBind: '127.0.0.1',
    configuracion: { esperaDeLongPollMs: 100, sondeoDeLongPollMs: 10 },
    // Aca se afirma la mitad del AGENTE. El cruce de las dos mitades tiene su
    // propio test en `correlacionCruzada.test.ts`.
    logger: LOGGER_SILENCIOSO,
  })
  await servidor.iniciar()
  await servidor.credenciales.alta(KEY_ID, SITE_ID, SECRETO)

  const direccion = servidor.direccion()
  if (direccion === null) {
    throw new Error('el servidor no quedo escuchando')
  }

  base = abrirBase(':memory:')
  const repositorios = crearRepositorios(base)
  outbox = crearOutboxSqlite(base)
  emitidos = []

  const reloj = crearRelojDelSistema()
  const cliente = crearClienteHttp({
    urlBase: `http://${direccion.host}:${String(direccion.puerto)}`,
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
    logger: crearLoggerQueAcumula(emitidos),
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

function servidorVivo(): Servidor {
  if (servidor === null) {
    throw new Error('el banco no esta montado')
  }
  return servidor
}

async function sembrarPedido(externalOrderId: string, locationCode: string): Promise<string> {
  const alta = await servidorVivo().cola.insertar({
    siteId: SITE_ID,
    externalOrderId,
    tipo: 'PICK',
    locationCode,
  })
  if (!alta.ok) {
    throw new Error(`no se pudo sembrar el pedido ${externalOrderId}`)
  }
  // El id del libro del SERVIDOR: es contra este que se compara todo lo demas.
  return alta.valor.id
}

afterEach(async () => {
  base?.cerrar()
  base = null
  if (servidor !== null) {
    await servidor.detener()
    servidor = null
  }
})

describe('correlacion por orden a los dos lados del enlace', () => {
  it('el id que el agente loguea es el MISMO que el servidor tiene en su libro', async () => {
    await montar()
    const ordenIdEnElServidor = await sembrarPedido(PEDIDO_DEL_OPERARIO, ORIGEN)

    await enlace.sincronizar()

    const espejada = unaLinea('ORDER_MIRRORED')
    expect(espejada.correlacion?.ordenId).toBe(ordenIdEnElServidor)
    expect(espejada.correlacion?.externalOrderId).toBe(PEDIDO_DEL_OPERARIO)
    expect(espejada.correlacion?.siteId).toBe(SITE_ID)
    // El id local existe y es OTRO: los dos libros son distintos, y por eso hace
    // falta que las dos claves viajen juntas en la misma linea.
    expect(espejada.correlacion?.ordenIdLocal).toBeTruthy()
    expect(espejada.correlacion?.ordenIdLocal).not.toBe(ordenIdEnElServidor)
  })

  it('el hilo llega hasta el comando que se le mando al PLC', async () => {
    // "El pedido 47 se trabo" -> con esto se puede llegar, sin cambiar de clave,
    // desde el alta en el servidor hasta cada registro escrito en el PLC.
    await montar()
    const ordenIdEnElServidor = await sembrarPedido(PEDIDO_DEL_OPERARIO, ORIGEN)

    await enlace.sincronizar()
    const ciclo = await ejecutarCicloDeRobot(orquestador, ROBOT_ID)

    expect(ciclo.tipo).toBe('ORDEN_TERMINADA')

    const pasos = lineas('STEP_SENT')
    // Los cinco movimientos fisicos de RF04.
    expect(pasos).toHaveLength(5)
    for (const paso of pasos) {
      expect(paso.correlacion?.ordenId).toBe(ordenIdEnElServidor)
      expect(paso.correlacion?.externalOrderId).toBe(PEDIDO_DEL_OPERARIO)
      expect(paso.nivel).toBe('DEBUG')
      expect(paso.datos['comando']).toEqual(expect.any(Number))
    }

    expect(unaLinea('ORDER_STARTED').correlacion?.ordenId).toBe(ordenIdEnElServidor)
    expect(unaLinea('ORDER_DONE').correlacion?.ordenId).toBe(ordenIdEnElServidor)
  })

  it('la transicion que vuelve al servidor sale logueada con el mismo id', async () => {
    await montar()
    const ordenIdEnElServidor = await sembrarPedido(PEDIDO_DEL_OPERARIO, ORIGEN)

    await enlace.sincronizar()
    await ejecutarCicloDeRobot(orquestador, ROBOT_ID)
    await enlace.sincronizar()

    const reportadas = lineas('TRANSITION_REPORTED')
    expect(reportadas.length).toBeGreaterThan(0)
    for (const reportada of reportadas) {
      expect(reportada.correlacion?.ordenId).toBe(ordenIdEnElServidor)
      expect(reportada.correlacion?.externalOrderId).toBe(PEDIDO_DEL_OPERARIO)
    }

    // Y del otro lado del enlace ese mismo id quedo terminado: el cruce cierra.
    const pedido = await servidorVivo().cola.buscarPorId(ordenIdEnElServidor)
    expect(pedido?.estado).toBe('DONE')
  })

  it('un pedido que la sucursal no puede ejecutar igual queda correlacionado', async () => {
    // Es el caso donde la correlacion mas importa y donde es mas facil perderla:
    // no hay orden local a la que colgar el rastro, asi que sin el id remoto el
    // pedido muerto del servidor no se puede cruzar con nada de la sucursal.
    await montar()
    const ordenIdEnElServidor = await sembrarPedido('48', '9Z04AE1')

    await enlace.sincronizar()

    const rechazada = unaLinea('ORDER_REJECTED_BY_SITE')
    expect(rechazada.nivel).toBe('ERROR')
    expect(rechazada.correlacion?.ordenId).toBe(ordenIdEnElServidor)
    expect(rechazada.correlacion?.externalOrderId).toBe('48')
    expect(rechazada.correlacion?.ordenIdLocal).toBeNull()
    expect(rechazada.datos['motivo']).toBe('ROBOT_NO_REGISTRADO')
  })
})
