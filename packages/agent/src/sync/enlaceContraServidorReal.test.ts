// RF33 a RF36 — El enlace contra el servidor de pedidos DE VERDAD.
//
// Aca no hay doble del servidor: se levanta `crearServidor` en :memory: con puerto
// 0 y el agente le habla por HTTP con su cliente de produccion, firma HMAC
// incluida. Un doble confirma lo que el agente ya cree; lo que hay que afirmar es
// lo que el servidor contesta de verdad cuando la seq llega repetida, cuando el
// lease vencio y cuando la orden que se empuja nacio en la sucursal.
//
// Lo unico que el test controla es EL CABLE: cada request pasa, se pierde a la
// IDA o se pierde a la VUELTA. La vuelta es la que importa —el servidor ya la
// aplico y lo que no llega es la confirmacion—, porque es el unico camino por el
// que el outbox termina reintentando algo que del otro lado ya esta hecho.
//
// La base del agente es un ARCHIVO, no :memory:, para poder cerrarla y volver a
// abrirla: es la unica forma de afirmar que una orden reclamada sobrevive a que
// el proceso se muera antes de ejecutarla (RF33).

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LOGGER_SILENCIOSO, type TipoDispositivo } from '@aoki-one/domain'

import { crearServidor, type Servidor } from '../../../server/src/composition.js'
import {
  generarClaveDeCifrado,
  VARIABLE_DE_CLAVE,
} from '../../../server/src/persistence/cifrado.js'
import { admitirOrden } from '../orchestrator/orderIntake.js'
import type { DependenciasDelOrquestador, PuertoDeTransporte } from '../orchestrator/ports.js'
import { ejecutarCicloDeRobot } from '../orchestrator/robotLoop.js'
import { abrirBase, type BaseDelAgente } from '../persistence/database.js'
import { crearRepositorios, type RepositoriosDelAgente } from '../persistence/index.js'
import { crearRelojDelSistema } from '../reloj.js'
import { crearEnlace, type Enlace } from './link.js'
import { crearOrigenPorLongPoll, type OrdenEntrante, type OrderSource } from './orderSource.js'
import { crearOutboxSqlite, type OutboxDeTransiciones } from './outbox.js'
import { crearClienteHttp } from './serverClient.js'

/** El servidor no arranca sin clave de cifrado de credenciales. */
const ENTORNO_DEL_SERVIDOR = { [VARIABLE_DE_CLAVE]: generarClaveDeCifrado() }

const SITE_ID = 'SUC-ENLACE'
const KEY_ID = 'key-suc-enlace'
const SECRETO = 'secreto-del-enlace'
const AGENT_ID = 'AG-1'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'

/** Modulo par -> lado RIGHT. Los dos origenes caen del mismo lado y en niveles distintos. */
const ORIGEN_E = '3X04AE1'
const ORIGEN_C = '3X06AC1'

/** Los 12 slots reales de la zona de pickeo de planta. */
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

/** Los cinco movimientos fisicos de una orden de PICK. Es el canario de "hubo maniobra". */
const MANIOBRAS_POR_ORDEN = 5

const RUTA_DE_REPORTE = '/api/v1/agent/report'
const RUTA_DE_ALTA = '/api/v1/orders'

// ------------------------------------------------------------------- el cable

type DecisionDeCable =
  | 'PASA'
  /** Ni salio de la sucursal: el servidor no se entera. */
  | 'SE_PIERDE_A_LA_IDA'
  /** El servidor YA la proceso; lo que no vuelve es la confirmacion. */
  | 'SE_PIERDE_A_LA_VUELTA'

interface LlamadaAlServidor {
  readonly ruta: string
  readonly cuerpo: Record<string, unknown>
  readonly decision: DecisionDeCable
}

interface Cable {
  politica: (llamada: {
    readonly ruta: string
    readonly numeroEnLaRuta: number
  }) => DecisionDeCable
  readonly llamadas: LlamadaAlServidor[]
  readonly pedir: typeof fetch
}

function rutaDe(entrada: Parameters<typeof fetch>[0]): string {
  if (typeof entrada !== 'string') {
    throw new Error('el cliente del agente siempre pide por URL en texto')
  }
  return new URL(entrada).pathname
}

function cuerpoDe(init: Parameters<typeof fetch>[1]): Record<string, unknown> {
  const crudo = init?.body
  if (typeof crudo !== 'string') {
    return {}
  }
  return JSON.parse(crudo) as Record<string, unknown>
}

function crearCable(): Cable {
  const porRuta = new Map<string, number>()

  const cable: Cable = {
    politica: () => 'PASA',
    llamadas: [],
    pedir: async (entrada, init) => {
      const ruta = rutaDe(entrada)
      const numeroEnLaRuta = (porRuta.get(ruta) ?? 0) + 1
      porRuta.set(ruta, numeroEnLaRuta)

      const decision = cable.politica({ ruta, numeroEnLaRuta })
      cable.llamadas.push({ ruta, cuerpo: cuerpoDe(init), decision })

      if (decision === 'SE_PIERDE_A_LA_IDA') {
        throw new Error('ECONNREFUSED: el paquete no salio de la sucursal')
      }

      const respuesta = await fetch(entrada, init)
      if (decision === 'SE_PIERDE_A_LA_VUELTA') {
        // Se drena el body para que la conexion cierre limpia: lo que se pierde
        // es la confirmacion, no el trabajo que el servidor ya hizo.
        await respuesta.text()
        throw new Error('ETIMEDOUT: la respuesta nunca volvio')
      }
      return respuesta
    },
  }
  return cable
}

/** Corta el cable en la N-esima request a una ruta y deja pasar todo lo demas. */
function cortarLaLlamada(ruta: string, numero: number, como: DecisionDeCable): Cable['politica'] {
  return (llamada) => (llamada.ruta === ruta && llamada.numeroEnLaRuta === numero ? como : 'PASA')
}

const CABLE_CORTADO: Cable['politica'] = () => 'SE_PIERDE_A_LA_IDA'
const CABLE_SANO: Cable['politica'] = () => 'PASA'

// ------------------------------------------------------------------- el banco

interface LlamadaAlPlc {
  readonly robotId: string
  readonly dispositivo: TipoDispositivo
  readonly comando: number
}

let servidor: Servidor | null = null
let carpeta: string | null = null
let rutaDeBase = ''
let base: BaseDelAgente | null = null
let repositorios: RepositoriosDelAgente
let outbox: OutboxDeTransiciones
let orquestador: DependenciasDelOrquestador
let enlace: Enlace
let cable: Cable
let maniobras: LlamadaAlPlc[]
let reclamos: (readonly OrdenEntrante[])[]
let despertares: number

/**
 * Transporte que cuenta maniobras.
 *
 * Contesta lo mismo que el modo simulacion del puerto real, que tampoco toca el
 * socket. Lo unico que agrega es el contador, y es lo que permite afirmar que una
 * re-entrega NO mueve el robot dos veces.
 */
function crearTransporteQueCuenta(): PuertoDeTransporte {
  return {
    ejecutarComandoDePaso: (robotId, dispositivo, pedido) => {
      maniobras.push({ robotId, dispositivo, comando: pedido.comando })
      return Promise.resolve({ ok: true, valor: { kind: 'OK' } })
    },
    resetearMessageIn: () => Promise.resolve({ ok: true, valor: undefined }),
    leerRegistros: () =>
      Promise.resolve({ ok: true, valor: { messageIn1: 0, messageIn2: null, messageOut: 0 } }),
  }
}

/** Abre (o reabre) la base del agente y rearma lo que cuelga de ella. */
function abrirBanco(): void {
  base = abrirBase(rutaDeBase)
  repositorios = crearRepositorios(base)
  outbox = crearOutboxSqlite(base)
}

interface OpcionesDeMontaje {
  readonly duracionDelLeaseMs?: number
  /**
   * Prefijo que se le cuelga a la URL del servidor.
   *
   * Sirve para el caso de despliegue mal configurado: el servidor esta vivo y
   * contesta, pero ninguna ruta del agente existe en esa base.
   */
  readonly prefijoDeUrl?: string
}

async function montar(opciones?: OpcionesDeMontaje): Promise<void> {
  servidor = crearServidor({
    rutaDeBase: ':memory:',
    entorno: ENTORNO_DEL_SERVIDOR,
    // El default escribe a stdout: en la suite eso es ruido, no informacion.
    logger: LOGGER_SILENCIOSO,
    // Puerto 0: lo asigna el sistema. Uno fijo es EADDRINUSE en CI.
    httpPuerto: 0,
    httpBind: '127.0.0.1',
    configuracion: {
      // Long-poll corto para que el test no espere 25 s reales.
      esperaDeLongPollMs: 100,
      sondeoDeLongPollMs: 10,
      duracionDelLeaseMs: opciones?.duracionDelLeaseMs ?? 60_000,
    },
  })
  await servidor.iniciar()
  await servidor.credenciales.alta(KEY_ID, SITE_ID, SECRETO)

  const direccion = servidor.direccion()
  if (direccion === null) {
    throw new Error('el servidor no quedo escuchando')
  }
  const urlBase = `http://${direccion.host}:${String(direccion.puerto)}${opciones?.prefijoDeUrl ?? ''}`

  carpeta = mkdtempSync(join(tmpdir(), 'aoki-enlace-'))
  rutaDeBase = join(carpeta, 'agente.db')
  abrirBanco()

  cable = crearCable()
  maniobras = []
  reclamos = []
  despertares = 0

  const reloj = crearRelojDelSistema()
  const cliente = crearClienteHttp({
    urlBase,
    siteId: SITE_ID,
    agentId: AGENT_ID,
    credencial: { keyId: KEY_ID, secreto: SECRETO },
    // El servidor de este banco retiene el long-poll 100 ms: un timeout de un
    // segundo lo cubre con margen y no alarga el test cuando el cable esta sano.
    tiempos: { timeoutMs: 1_000, timeoutDeLongPollMs: 1_000 },
    pedir: cable.pedir,
    ahoraMs: () => reloj.ahoraMs(),
  })

  const longPoll = crearOrigenPorLongPoll(cliente)
  // Se envuelve el origen real para anotar QUE entrego el servidor en cada vuelta:
  // sin eso, "no se creo una segunda orden" pasaria igual si el servidor no
  // hubiera re-entregado nada.
  const origen: OrderSource = {
    nombre: longPoll.nombre,
    // La señal se reenvia: envolver el origen no puede sacarle al enlace la
    // capacidad de abortar su propio reclamo cuando se detiene.
    reclamar: async (limite, senal) => {
      const reclamado = await longPoll.reclamar(limite, senal)
      if (reclamado.ok) {
        reclamos.push(reclamado.valor)
      }
      return reclamado
    },
  }

  orquestador = {
    repositorios,
    siteId: SITE_ID,
    agentId: AGENT_ID,
    logger: LOGGER_SILENCIOSO,
    generarId: () => randomUUID(),
    transporte: crearTransporteQueCuenta(),
    reloj,
    politica: { maxIntentos: 3, baseBackoffMs: 1 },
    outbox,
  }

  enlace = crearEnlace({
    origen,
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
    despertar: () => {
      despertares += 1
    },
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

afterEach(async () => {
  base?.cerrar()
  base = null
  if (servidor !== null) {
    await servidor.detener()
    servidor = null
  }
  if (carpeta !== null) {
    rmSync(carpeta, { recursive: true, force: true })
    carpeta = null
  }
})

// ------------------------------------------------------------------ ayudantes

function servidorVivo(): Servidor {
  if (servidor === null) {
    throw new Error('el banco no esta montado')
  }
  return servidor
}

async function sembrarPedidoDePicking(externalOrderId: string, locationCode: string): Promise<void> {
  const alta = await servidorVivo().cola.insertar({
    siteId: SITE_ID,
    externalOrderId,
    tipo: 'PICK',
    locationCode,
  })
  if (!alta.ok) {
    throw new Error(`no se pudo sembrar el pedido ${externalOrderId}`)
  }
}

/** Corre el loop del robot hasta que no queda trabajo. Cada vuelta ejecuta una orden entera. */
async function ejecutarHastaQueNoQuedeTrabajo(): Promise<void> {
  for (let vuelta = 0; vuelta < 10; vuelta += 1) {
    const ciclo = await ejecutarCicloDeRobot(orquestador, ROBOT_ID)
    if (ciclo.tipo !== 'ORDEN_TERMINADA') {
      return
    }
  }
  throw new Error('el loop del robot no se quedo sin trabajo')
}

/** Lo que el outbox va a reportar, en orden, expresado en ids del libro del servidor. */
async function colaEnIdsRemotos(): Promise<[string, number][]> {
  const pendientes = await outbox.proximas(50)
  const enOrden: [string, number][] = []
  for (const transicion of pendientes) {
    const remoto = await outbox.buscarVinculo(transicion.ordenId)
    enOrden.push([remoto ?? '(sin vinculo)', transicion.seq])
  }
  return enOrden
}

/**
 * Los reportes que el servidor LLEGO a procesar, en orden.
 *
 * Se excluye lo que se perdio a la ida porque nunca salio de la sucursal; lo que
 * se perdio a la vuelta si cuenta, y es justamente el caso que deja al servidor
 * con una seq aplicada que el agente todavia cree pendiente.
 */
function reportesQueLlegaronAlServidor(): [unknown, unknown][] {
  return cable.llamadas
    .filter(
      (llamada) => llamada.ruta === RUTA_DE_REPORTE && llamada.decision !== 'SE_PIERDE_A_LA_IDA',
    )
    .map((llamada) => [llamada.cuerpo['ordenId'], llamada.cuerpo['seq']])
}

async function estadoEnElServidor(externalOrderId: string): Promise<string | null> {
  const pedido = await servidorVivo().cola.buscarPorClave({ siteId: SITE_ID, externalOrderId })
  return pedido === null ? null : pedido.estado
}

// ---------------------------------------------------------------------- tests

describe('lo reclamado se persiste antes de ejecutarse (RF33)', () => {
  it('sobrevive a que el proceso se muera entre reclamar y ejecutar', async () => {
    await montar()
    await sembrarPedidoDePicking('PICK-1001', ORIGEN_E)

    const ciclo = await enlace.sincronizar()
    expect(ciclo).toEqual({ tipo: 'SINCRONIZADO', reportadas: 0, admitidas: 1, rechazadas: 0 })
    // Espejar no ejecuta: el robot no se movio ni una vez todavia.
    expect(maniobras).toHaveLength(0)
    expect(despertares).toBe(1)

    // El proceso se muere aca. La base se cierra sin ceremonia y se vuelve a abrir.
    base?.cerrar()
    abrirBanco()

    const [orden] = await repositorios.ordenes.listar({ siteId: SITE_ID })
    expect(orden?.externalOrderId).toBe('PICK-1001')
    expect(orden?.estado).toBe('PENDING')
    expect(orden?.currentStepIndex).toBe(0)
    // El vinculo con el libro del servidor tambien sobrevive: sin el, las
    // transiciones de esta orden no sabrian a que id remoto ir.
    expect(await outbox.buscarVinculo(orden?.id ?? '')).not.toBeNull()
  })
})

describe('re-entrega por lease vencido (RF28)', () => {
  it('llega el mismo externalOrderId y no se crea otra orden ni se repite la maniobra', async () => {
    // Lease de 0 ms: el servidor considera disponible la orden apenas la entrego,
    // que es lo que pasa en planta cuando la maniobra dura mas que el lease.
    await montar({ duracionDelLeaseMs: 0 })
    await sembrarPedidoDePicking('PICK-1001', ORIGEN_E)

    const primero = await enlace.sincronizar()
    const segundo = await enlace.sincronizar()

    // El servidor re-entrego DE VERDAD: es la misma clave, dos veces.
    expect(reclamos.map((lote) => lote.map((entrante) => entrante.externalOrderId))).toEqual([
      ['PICK-1001'],
      ['PICK-1001'],
    ])
    expect(primero).toMatchObject({ tipo: 'SINCRONIZADO', admitidas: 1 })
    // La segunda entrega la absorbe el dedupe local (RF14): ni orden nueva ni
    // despertar al robot por trabajo que ya tenia.
    expect(segundo).toMatchObject({ tipo: 'SINCRONIZADO', admitidas: 0, rechazadas: 0 })
    expect(await repositorios.ordenes.listar({ siteId: SITE_ID })).toHaveLength(1)
    expect(despertares).toBe(1)

    await ejecutarHastaQueNoQuedeTrabajo()

    // Lo que mueve fierro: una sola maniobra, no dos.
    expect(maniobras).toHaveLength(MANIOBRAS_POR_ORDEN)
  })
})

describe('el outbox no pierde nada (RF34)', () => {
  it('acumula con el cable cortado y drena en orden al reconectar', async () => {
    await montar()
    await sembrarPedidoDePicking('PICK-1', ORIGEN_E)
    await sembrarPedidoDePicking('PICK-2', ORIGEN_C)
    await enlace.sincronizar()

    cable.politica = CABLE_CORTADO
    await ejecutarHastaQueNoQuedeTrabajo()

    const caido = await enlace.sincronizar()
    expect(caido).toMatchObject({ tipo: 'DEGRADADO' })
    // Dos ordenes, IN_PROGRESS y DONE cada una: nada se perdio por la caida.
    expect(await outbox.pendientes()).toBe(4)
    const esperado = await colaEnIdsRemotos()

    cable.politica = CABLE_SANO
    const reconectado = await enlace.sincronizar()

    expect(reconectado).toMatchObject({ tipo: 'SINCRONIZADO', reportadas: 4 })
    expect(await outbox.pendientes()).toBe(0)
    // Salieron en el orden exacto de encolado. Saltearse una le haria llegar al
    // servidor una seq mayor primero, y despues descartaria la que quedo atras
    // por SEQ_VIEJA: ahi si se perderia un cambio de estado.
    expect(reportesQueLlegaronAlServidor()).toEqual(esperado)

    expect(await estadoEnElServidor('PICK-1')).toBe('DONE')
    expect(await estadoEnElServidor('PICK-2')).toBe('DONE')
    // Drenar ANTES de reclamar es lo que evita que el servidor vuelva a entregar
    // ordenes que la sucursal ya termino (RF15).
    expect(reconectado).toMatchObject({ admitidas: 0 })
  })

  it('un drenado que se corta a la mitad deja lo que falto reportar', async () => {
    await montar()
    await sembrarPedidoDePicking('PICK-1', ORIGEN_E)
    await sembrarPedidoDePicking('PICK-2', ORIGEN_C)
    await enlace.sincronizar()

    cable.politica = CABLE_CORTADO
    await ejecutarHastaQueNoQuedeTrabajo()
    expect(await outbox.pendientes()).toBe(4)

    // El cable se corta en el tercer reporte: dos confirmados, dos sin salir.
    cable.politica = cortarLaLlamada(RUTA_DE_REPORTE, 3, 'SE_PIERDE_A_LA_IDA')
    const aMitad = await enlace.sincronizar()

    expect(aMitad).toMatchObject({ tipo: 'DEGRADADO' })
    expect(await outbox.pendientes()).toBe(2)

    cable.politica = CABLE_SANO
    await enlace.sincronizar()

    expect(await outbox.pendientes()).toBe(0)
    expect(await estadoEnElServidor('PICK-1')).toBe('DONE')
    expect(await estadoEnElServidor('PICK-2')).toBe('DONE')
  })

  it('una transicion que el servidor descarta por vieja tampoco bloquea la cola', async () => {
    await montar()
    await sembrarPedidoDePicking('PICK-1', ORIGEN_E)
    await enlace.sincronizar()

    const [orden] = await repositorios.ordenes.listar({ siteId: SITE_ID })
    const remota = await outbox.buscarVinculo(orden?.id ?? '')

    // El servidor ya tiene aplicada una seq MAS NUEVA que la que el agente tiene
    // por reportar. Pasa cuando se restaura una base del agente anterior al
    // ultimo reporte: la cola local quedo atras del libro del servidor.
    const aplicada = await servidorVivo().cola.aplicarTransicion({
      ordenId: remota ?? '',
      seq: 2,
      estado: 'DONE',
      reportadaEn: Date.now(),
      metadata: {},
    })
    expect(aplicada.tipo).toBe('APLICADA')

    await outbox.encolar({
      ordenId: orden?.id ?? '',
      estado: 'IN_PROGRESS',
      metadata: {},
      creadaEn: Date.now(),
    })
    const ciclo = await enlace.sincronizar()

    expect(ciclo).toMatchObject({ tipo: 'SINCRONIZADO', reportadas: 1 })
    expect(await outbox.pendientes()).toBe(0)
    // Y el servidor no retrocede de estado por un reporte que llego tarde.
    expect(await estadoEnElServidor('PICK-1')).toBe('DONE')
  })

  it('una transicion que el servidor descarta por repetida sale de la cola igual', async () => {
    await montar()
    await sembrarPedidoDePicking('PICK-1', ORIGEN_E)
    await enlace.sincronizar()

    cable.politica = CABLE_CORTADO
    await ejecutarHastaQueNoQuedeTrabajo()

    // El servidor aplica el primer reporte, pero la confirmacion no vuelve. Para
    // el agente es un fallo; para el servidor esa seq ya esta aplicada.
    cable.politica = cortarLaLlamada(RUTA_DE_REPORTE, 1, 'SE_PIERDE_A_LA_VUELTA')
    const perdido = await enlace.sincronizar()
    expect(perdido).toMatchObject({ tipo: 'DEGRADADO' })
    expect(await outbox.pendientes()).toBe(2)

    cable.politica = CABLE_SANO
    await enlace.sincronizar()

    // El reintento idempotente manda la MISMA seq y el servidor contesta
    // DESCARTADA. Si eso se tratara como error, el outbox la reintentaria para
    // siempre y bloquearia a todas las que vienen atras.
    const seqsReportadas = reportesQueLlegaronAlServidor().map(([, seq]) => seq)
    expect(seqsReportadas.filter((seq) => seq === 1)).toHaveLength(2)
    expect(await outbox.pendientes()).toBe(0)
    expect(await estadoEnElServidor('PICK-1')).toBe('DONE')
  })
})

describe('lo que el servidor contesta cuando la orden no esta (RF34)', () => {
  it('una transicion de una orden que el servidor no tiene sale de la cola', async () => {
    await montar()
    // Vinculo apuntando a un id que no existe del otro lado: es lo que queda
    // despues de restaurar una base vieja del agente contra un servidor limpio.
    await outbox.vincular('o-1', 'no-existe-en-el-libro-del-servidor')
    await outbox.encolar({ ordenId: 'o-1', estado: 'DONE', metadata: {}, creadaEn: Date.now() })

    const ciclo = await enlace.sincronizar()

    // Reintentar contra una orden que el servidor no tiene no converge nunca, y
    // la fila bloquearia a todas las que vienen atras.
    expect(ciclo).toMatchObject({ tipo: 'SINCRONIZADO', reportadas: 1 })
    expect(await outbox.pendientes()).toBe(0)
  })

  it('un 404 que no es "orden inexistente" no puede vaciar el outbox en silencio', async () => {
    // Servidor vivo detras de una base mal configurada: contesta 404 'ruta no
    // encontrada' a TODO. Si eso se leyera como "la orden no existe", el outbox
    // se drenaria al vacio y el operario veria el enlace en verde mientras cada
    // cambio de estado se pierde. Es el peor final posible para RF34.
    await montar({ prefijoDeUrl: '/detras-de-un-proxy-mal-configurado' })
    await outbox.vincular('o-1', 'remota-1')
    await outbox.encolar({ ordenId: 'o-1', estado: 'DONE', metadata: {}, creadaEn: Date.now() })

    const ciclo = await enlace.sincronizar()

    expect(ciclo).toMatchObject({ tipo: 'DEGRADADO' })
    expect(await outbox.pendientes()).toBe(1)
  })
})

describe('una orden que la sucursal no puede ejecutar (RF33)', () => {
  it('se reporta en ERROR contra el servidor y este deja de re-entregarla', async () => {
    // Lease de 0 ms: si el ERROR no llegara, el servidor la re-entregaria en cada
    // vuelta y la sucursal la rechazaria para siempre.
    await montar({ duracionDelLeaseMs: 0 })
    // Estanteria 9X: no hay robot dado de alta para esa estanteria.
    await sembrarPedidoDePicking('PICK-AJENA', '9Z04AE1')

    const primero = await enlace.sincronizar()
    expect(primero).toMatchObject({ tipo: 'SINCRONIZADO', admitidas: 0, rechazadas: 1 })
    expect(await repositorios.ordenes.listar({ siteId: SITE_ID })).toHaveLength(0)

    // La vuelta siguiente drena el ERROR contra el servidor de verdad.
    const segundo = await enlace.sincronizar()
    expect(segundo).toMatchObject({ tipo: 'SINCRONIZADO' })
    expect(await estadoEnElServidor('PICK-AJENA')).toBe('ERROR')

    const tercero = await enlace.sincronizar()
    // Ya no esta PENDING, asi que el servidor no la vuelve a entregar.
    expect(tercero).toMatchObject({ admitidas: 0, rechazadas: 0 })
    expect(await outbox.pendientes()).toBe(0)
  })
})

describe('ordenes que nacen en la sucursal (RF35)', () => {
  it('se crean sin enlace y se empujan al servidor al reconectar', async () => {
    await montar()
    cable.politica = CABLE_CORTADO

    const admision = await admitirOrden(orquestador, {
      robotId: null,
      externalOrderId: null,
      tipo: 'PICK',
      origen: 'MANUAL',
      locationCode: ORIGEN_E,
      targetLocation: null,
    })
    if (!admision.ok) {
      throw new Error('la orden local tenia que admitirse sin enlace')
    }
    const ordenLocal = admision.valor.orden
    expect(ordenLocal.externalOrderId).toMatch(/^local-AG-1-/)

    await ejecutarHastaQueNoQuedeTrabajo()
    expect(maniobras).toHaveLength(MANIOBRAS_POR_ORDEN)

    const sinEnlace = await enlace.sincronizar()
    expect(sinEnlace).toMatchObject({ tipo: 'DEGRADADO' })
    // El servidor todavia no la conoce y el agente ya la ejecuto entera.
    expect(await estadoEnElServidor(ordenLocal.externalOrderId ?? '')).toBeNull()

    cable.politica = CABLE_SANO
    await enlace.sincronizar()

    // Se empujo por la MISMA ruta firmada que usa la app de picking (RF26).
    expect(cable.llamadas.some((llamada) => llamada.ruta === RUTA_DE_ALTA)).toBe(true)
    expect(await estadoEnElServidor(ordenLocal.externalOrderId ?? '')).toBe('DONE')
    expect(await outbox.pendientes()).toBe(0)
  })

  it('el prefijo por agente evita que una orden local choque con una de picking', async () => {
    await montar()

    const admision = await admitirOrden(orquestador, {
      robotId: null,
      externalOrderId: null,
      tipo: 'PICK',
      origen: 'MANUAL',
      locationCode: ORIGEN_E,
      targetLocation: null,
    })
    if (!admision.ok) {
      throw new Error('la orden local tenia que admitirse')
    }
    const idLocal = admision.valor.orden.externalOrderId ?? ''
    const prefijo = `local-${AGENT_ID}-`
    expect(idLocal.startsWith(prefijo)).toBe(true)

    // El picking manda como id externo exactamente la parte cruda del id local.
    // Sin prefijo las dos ordenes serian la MISMA clave: el dedupe las fusionaria
    // y uno de los dos pedidos quedaria sin atender, sin ruido de ningun tipo.
    const idDePicking = idLocal.slice(prefijo.length)
    expect(idDePicking).not.toBe(idLocal)
    await sembrarPedidoDePicking(idDePicking, ORIGEN_C)

    await ejecutarHastaQueNoQuedeTrabajo()
    await enlace.sincronizar()

    const locales = await repositorios.ordenes.listar({ siteId: SITE_ID })
    expect([...locales.map((orden) => orden.externalOrderId)].sort()).toEqual(
      [idLocal, idDePicking].sort(),
    )

    const empujada = await servidorVivo().cola.buscarPorClave({
      siteId: SITE_ID,
      externalOrderId: idLocal,
    })
    const dePicking = await servidorVivo().cola.buscarPorClave({
      siteId: SITE_ID,
      externalOrderId: idDePicking,
    })
    expect(empujada).not.toBeNull()
    expect(dePicking).not.toBeNull()
    expect(empujada?.id).not.toBe(dePicking?.id)
  })
})
