// T25 — E2E funcional del sistema COMPLETO: agente + servidor, con PLC simulado.
//
// Los e2e que ya existen prueban cada mitad por su cuenta (packages/agent/src/e2e
// y packages/server/src/e2e) y `sync/enlaceContraServidorReal.test.ts` prueba el
// enlace contra el servidor de verdad, pero manejando el loop del robot a mano.
// Lo que falta es el recorrido entero SIN nadie manejando nada: el servidor real
// escuchando, el agente real con su loop y su enlace corriendo solos, y los
// caminos de error y recuperacion encima de eso.
//
// Lo unico que no es real es el PLC, que no existe fuera de planta. Se inyecta
// como puerto de transporte para poder hacer dos cosas que el modo simulacion no
// permite: RETENER un comando —y con eso parar el tiempo justo en el medio de una
// maniobra— y FALLAR uno, que es el camino de RF13.
//
// El otro control del test es EL CABLE a internet: se reemplaza `globalThis.fetch`
// por un espia que deja pasar todo salvo lo que va al servidor. Cortarlo ahi y no
// en un doble es lo que hace que el agente viva la caida como la vive en la
// sucursal: el cliente HTTP de produccion, con su firma HMAC, contra un destino
// que no contesta.
//
// La base del agente es un ARCHIVO y no `:memory:`: sin eso no se puede cerrar el
// proceso y volver a abrirlo sobre lo que quedo escrito, que es la mitad de RF15.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as dormir } from 'node:timers/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { LOGGER_SILENCIOSO, type TipoDispositivo } from '@aoki-one/domain'

import { crearServidor, type Servidor } from '../../../server/src/composition.js'
import {
  generarClaveDeCifrado,
  VARIABLE_DE_CLAVE,
} from '../../../server/src/persistence/cifrado.js'
import { crearAgente, type Agente } from '../composition.js'
import type { PuertoDeTransporteConcreto } from '../transport/transportePort.js'

/** El servidor no arranca sin clave de cifrado de credenciales. */
const ENTORNO_DEL_SERVIDOR = { [VARIABLE_DE_CLAVE]: generarClaveDeCifrado() }

const SITE_ID = 'SUC-E2E'
const KEY_ID = 'key-suc-e2e'
const SECRETO = 'secreto-de-la-sucursal'
const AGENT_ID = 'AG-E2E'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'

/** Modulo par -> lado RIGHT. Los dos origenes caen del mismo lado, en niveles distintos. */
const ORIGEN_A = '3X04AA3'
const ORIGEN_E = '3X06AE1'

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

/** El origen 3X04AA3 es nivel A y lado RIGHT: gana el slot del mismo nivel de su lado. */
const SLOT_DE_A = '3X02AA1'

/** Los cinco movimientos fisicos de una orden. Es el canario de "hubo maniobra". */
const MANIOBRAS_POR_ORDEN = 5

/** INIT del carro: el comando del paso HOMING, con el que arranca todo replay. */
const COMANDO_HOMING = 41000

/**
 * Carro "dejar" sobre 3X04AA3. Es el ultimo movimiento de la devolucion, y el
 * valor esta verificado contra el robot real en el e2e de PICK portado.
 */
const COMANDO_DEJAR_EN_ORIGEN_A = 30200

const ESPERA_MAXIMA_MS = 20_000
const INTERVALO_DE_SONDEO_MS = 20
const TIMEOUT_DEL_TEST_MS = 60_000

// ------------------------------------------------------------- el PLC simulado

type DecisionDelPlc =
  | 'OK'
  /** El PLC contesta el 99 de planta: "No logro recuperarse". Fatal, no se reintenta. */
  | 'FALLA'
  /** El comando queda colgado hasta que el test abra la compuerta: el tiempo se para ahi. */
  | 'RETENER'

interface ComandoAlPlc {
  readonly robotId: string
  readonly dispositivo: TipoDispositivo
  readonly comando: number
}

interface PlcSimulado {
  /** Que hacer con cada comando. Se cambia en caliente durante el test. */
  politica: (comando: { readonly numero: number; readonly comando: number }) => DecisionDelPlc
  readonly comandos: ComandoAlPlc[]
  readonly puerto: PuertoDeTransporteConcreto
  /** Resuelve cuando un comando queda retenido. */
  readonly esperarRetenido: () => Promise<void>
  /** Suelta el comando retenido. `fallando` lo devuelve como error del PLC. */
  readonly soltar: (fallando?: boolean) => void
}

const ERROR_FATAL_DEL_PLC = {
  tipo: 'PLC_ERROR',
  codigoError: 99,
  mensaje: 'No logro recuperarse',
  fatal: true,
} as const

function crearPlcSimulado(): PlcSimulado {
  const comandos: ComandoAlPlc[] = []
  let soltarRetenido: ((fallando: boolean) => void) | null = null
  let avisarRetencion: (() => void) | null = null
  let hayRetenido = false

  const plc: PlcSimulado = {
    politica: () => 'OK',
    comandos,

    esperarRetenido: () =>
      new Promise<void>((resolve) => {
        if (hayRetenido) {
          resolve()
          return
        }
        avisarRetencion = resolve
      }),

    soltar: (fallando = false) => {
      soltarRetenido?.(fallando)
      soltarRetenido = null
      hayRetenido = false
    },

    puerto: {
      ejecutarComandoDePaso: async (robotId, dispositivo, pedido) => {
        comandos.push({ robotId, dispositivo, comando: pedido.comando })
        const decision = plc.politica({ numero: comandos.length, comando: pedido.comando })

        if (decision === 'RETENER') {
          const fallando = await new Promise<boolean>((resolve) => {
            soltarRetenido = resolve
            hayRetenido = true
            avisarRetencion?.()
            avisarRetencion = null
          })
          return fallando ? { ok: false, error: ERROR_FATAL_DEL_PLC } : { ok: true, valor: { kind: 'OK' } }
        }

        if (decision === 'FALLA') {
          return { ok: false, error: ERROR_FATAL_DEL_PLC }
        }
        return { ok: true, valor: { kind: 'OK' } }
      },

      resetearMessageIn: () => Promise.resolve({ ok: true, valor: undefined }),
      leerRegistros: () =>
        Promise.resolve({ ok: true, valor: { messageIn1: 0, messageIn2: null, messageOut: 0 } }),
      cerrar: () => Promise.resolve(),
    },
  }

  return plc
}

// ----------------------------------------------------------------- el banco

let servidor: Servidor | null = null
let agente: Agente | null = null
let plc: PlcSimulado
let carpeta: string | null = null
let rutaDeBase = ''
let urlDelServidor = ''
let urlDelAgente = ''
let cableCortado = false
/** Se cae SOLO el canal de reporte: el reclamo sigue pasando. Ver el test del lease. */
let reportesCortados = false
/** Cuantas veces el agente le pidio trabajo al servidor. */
let reclamos = 0
let fetchOriginal: typeof globalThis.fetch | null = null

/** Las rutas del enlace que este test necesita distinguir entre si. */
const RUTA_DE_RECLAMO = '/api/v1/agent/work'
const RUTA_DE_REPORTE = '/api/v1/agent/report'

function urlDe(entrada: Parameters<typeof fetch>[0]): string {
  if (typeof entrada === 'string') {
    return entrada
  }
  return entrada instanceof URL ? entrada.href : entrada.url
}

/**
 * Espia el `fetch` global y corta SOLO lo que va al servidor.
 *
 * El agente arma su cliente HTTP con el `fetch` que ve al construirse, asi que
 * el espia se instala antes de `crearAgente`. Las llamadas del propio test a la
 * API del agente pasan por el mismo espia y no se tocan: lo que se cae es el
 * link a internet, no la LAN de la sucursal.
 */
function espiarLaRed(): void {
  const real = globalThis.fetch
  fetchOriginal = real
  const espia: typeof globalThis.fetch = async (entrada, init) => {
    const url = urlDe(entrada)
    if (url.startsWith(urlDelServidor)) {
      if (url.endsWith(RUTA_DE_RECLAMO)) {
        reclamos += 1
      }
      if (cableCortado) {
        throw new Error('ECONNREFUSED: la sucursal se quedo sin internet')
      }
      if (reportesCortados && url.endsWith(RUTA_DE_REPORTE)) {
        throw new Error('ECONNREFUSED: el reporte no llega al servidor')
      }
    }
    return real(entrada, init)
  }
  globalThis.fetch = espia
}

interface OpcionesDeMontaje {
  /** Lease del servidor. 0 ms fuerza la re-entrega en cada vuelta. */
  readonly duracionDelLeaseMs?: number
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
      // Long-poll corto para que el test no espere los 25 s de produccion.
      esperaDeLongPollMs: 100,
      sondeoDeLongPollMs: 10,
      duracionDelLeaseMs: opciones?.duracionDelLeaseMs ?? 60_000,
    },
  })
  await servidor.iniciar()
  await servidor.credenciales.alta(KEY_ID, SITE_ID, SECRETO)

  const direccionDelServidor = servidor.direccion()
  if (direccionDelServidor === null) {
    throw new Error('el servidor no quedo escuchando')
  }
  urlDelServidor = `http://${direccionDelServidor.host}:${String(direccionDelServidor.puerto)}`

  carpeta = mkdtempSync(join(tmpdir(), 'aoki-e2e-'))
  rutaDeBase = join(carpeta, 'agente.db')

  cableCortado = false
  reportesCortados = false
  reclamos = 0
  plc = crearPlcSimulado()
  espiarLaRed()

  agente = crearAgenteDeLaSucursal()

  const robot = await agente.orquestador.repositorios.robots.guardar({
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

  await arrancarAgente()
}

function crearAgenteDeLaSucursal(): Agente {
  return crearAgente({
    siteId: SITE_ID,
    agentId: AGENT_ID,
    rutaDeBase,
    montarApi: true,
    // RF20 pone el default de simulacion en false, asi que va explicito. Con el
    // transporte inyectado no cambia nada del camino, pero `/health` tiene que
    // decir la verdad sobre en que modo arranco el agente.
    simularPlc: true,
    httpPuerto: 0,
    httpBind: '127.0.0.1',
    zonaDePickeo: ZONA_DE_PICKEO,
    tokenDeMantenimiento: null,
    enlace: { urlBase: urlDelServidor, keyId: KEY_ID, secreto: SECRETO },
    logger: LOGGER_SILENCIOSO,
    transporte: plc.puerto,
  })
}

async function arrancarAgente(): Promise<void> {
  const vivo = agenteVivo()
  await vivo.iniciar()
  const direccion = vivo.direccion()
  if (direccion === null) {
    throw new Error('el agente se arranco con la API montada y no expuso su direccion')
  }
  urlDelAgente = `http://${direccion.host}:${String(direccion.puerto)}`
}

afterEach(async () => {
  // Si quedo un comando retenido hay que soltarlo o `detener` espera para siempre
  // al ciclo que lo tiene tomado.
  plc.politica = () => 'OK'
  plc.soltar(true)

  cableCortado = false
  reportesCortados = false
  if (agente !== null) {
    await agente.detener()
    agente = null
  }
  if (servidor !== null) {
    await servidor.detener()
    servidor = null
  }
  if (fetchOriginal !== null) {
    globalThis.fetch = fetchOriginal
    fetchOriginal = null
  }
  if (carpeta !== null) {
    rmSync(carpeta, { recursive: true, force: true })
    carpeta = null
  }
})

// ---------------------------------------------------------------- ayudantes

function agenteVivo(): Agente {
  if (agente === null) {
    throw new Error('el banco no esta montado')
  }
  return agente
}

function servidorVivo(): Servidor {
  if (servidor === null) {
    throw new Error('el banco no esta montado')
  }
  return servidor
}

/** Mete un pedido en el libro del servidor, como lo hace la app de picking. */
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

async function estadoEnElServidor(externalOrderId: string): Promise<string | null> {
  const pedido = await servidorVivo().cola.buscarPorClave({ siteId: SITE_ID, externalOrderId })
  return pedido === null ? null : pedido.estado
}

async function ordenLocal(externalOrderId: string): Promise<
  | {
      readonly id: string
      readonly estado: string
      readonly slotLocationCode: string | null
      readonly targetLocation: string | null
      readonly currentStepIndex: number
      readonly errorReason: string | null
    }
  | undefined
> {
  const ordenes = await agenteVivo().orquestador.repositorios.ordenes.listar({ siteId: SITE_ID })
  return ordenes.find((orden) => orden.externalOrderId === externalOrderId)
}

async function estadoDelSlot(locationCode: string): Promise<string> {
  const slot = await agenteVivo().orquestador.repositorios.slots.buscar(ROBOT_ID, locationCode)
  return slot === undefined ? '(inexistente)' : slot.estado.estado
}

/** GET a la API local del agente, ya desenvuelto. */
async function leerDeLaApi(ruta: string): Promise<Record<string, unknown>> {
  const respuesta = await fetch(`${urlDelAgente}${ruta}`)
  return (await respuesta.json()) as Record<string, unknown>
}

async function reporteDeEnlace(): Promise<Record<string, unknown>> {
  const health = await leerDeLaApi('/health')
  return health['link'] as Record<string, unknown>
}

/** Sondea hasta que la condicion se cumple, o falla diciendo que se estaba esperando. */
async function esperarA(que: string, condicion: () => Promise<boolean>): Promise<void> {
  const limite = Date.now() + ESPERA_MAXIMA_MS
  for (;;) {
    if (await condicion()) {
      return
    }
    if (Date.now() >= limite) {
      throw new Error(`se agoto la espera: ${que}`)
    }
    await dormir(INTERVALO_DE_SONDEO_MS)
  }
}

const esperarQueElServidorVea = (externalOrderId: string, estado: string): Promise<void> =>
  esperarA(`el servidor tendria que ver ${externalOrderId} en ${estado}`, async () => {
    return (await estadoEnElServidor(externalOrderId)) === estado
  })

const esperarOrdenLocalEn = (externalOrderId: string, estado: string): Promise<void> =>
  esperarA(`la orden ${externalOrderId} tendria que quedar en ${estado}`, async () => {
    return (await ordenLocal(externalOrderId))?.estado === estado
  })

// ------------------------------------------------------------------- tests

describe('el recorrido completo de un pedido de picking (T25)', () => {
  it(
    'entra por el servidor, lo ejecuta el robot y el servidor se entera',
    async () => {
      await montar()
      await sembrarPedidoDePicking('PICK-1', ORIGEN_A)

      // De aca en mas no lo maneja nadie: el long-poll del enlace reclama el
      // pedido, el loop del robot lo ejecuta y el outbox reporta, todo solo.
      await esperarQueElServidorVea('PICK-1', 'DONE')

      const local = await ordenLocal('PICK-1')
      expect(local?.estado).toBe('DONE')
      expect(local?.currentStepIndex).toBe(MANIOBRAS_POR_ORDEN)
      expect(local?.slotLocationCode).toBe(SLOT_DE_A)

      // El robot se movio de verdad: cinco comandos, arrancando por el HOMING.
      expect(plc.comandos).toHaveLength(MANIOBRAS_POR_ORDEN)
      expect(plc.comandos[0]?.comando).toBe(COMANDO_HOMING)

      // El cajon quedo apoyado en el slot, con su devolucion pendiente.
      expect(await estadoDelSlot(SLOT_DE_A)).toBe('OCUPADO')

      // Y el enlace lo dice: sincronizado y sin nada por reportar.
      await esperarA('el enlace tendria que quedar sincronizado y vacio', async () => {
        const link = await reporteDeEnlace()
        return link['status'] === 'CONNECTED' && link['outboxSize'] === 0
      })
      expect((await reporteDeEnlace())['lastContactAt']).toEqual(expect.any(Number))
    },
    TIMEOUT_DEL_TEST_MS,
  )
})

describe('el enlace se cae DESPUES de ejecutar (T25, RF34, RF36)', () => {
  it(
    'el outbox acumula mientras no hay internet y al volver converge',
    async () => {
      await montar()

      // Se retiene el primer comando: a partir de ahi la orden esta EN VUELO y el
      // test puede cortar el cable en el medio exacto de la maniobra.
      plc.politica = ({ numero }) => (numero === 1 ? 'RETENER' : 'OK')
      await sembrarPedidoDePicking('PICK-1', ORIGEN_A)
      await plc.esperarRetenido()

      cableCortado = true
      plc.soltar()

      // La sucursal sigue trabajando sin internet: es RF36, no hay modo de espera.
      await esperarOrdenLocalEn('PICK-1', 'DONE')
      expect(plc.comandos).toHaveLength(MANIOBRAS_POR_ORDEN)
      expect(await estadoDelSlot(SLOT_DE_A)).toBe('OCUPADO')

      // Del otro lado nadie se entero todavia, y el agente NO lo disimula.
      expect(await estadoEnElServidor('PICK-1')).not.toBe('DONE')
      await esperarA('el enlace tendria que reportarse DEGRADED con cola', async () => {
        const link = await reporteDeEnlace()
        return link['status'] === 'DEGRADED' && Number(link['outboxSize']) > 0
      })

      cableCortado = false

      await esperarQueElServidorVea('PICK-1', 'DONE')
      await esperarA('el outbox tendria que quedar vacio', async () => {
        const link = await reporteDeEnlace()
        return link['status'] === 'CONNECTED' && link['outboxSize'] === 0
      })

      // Y la vuelta del enlace no repite la maniobra: converger es reportar lo
      // que paso, no volver a hacerlo.
      expect(plc.comandos).toHaveLength(MANIOBRAS_POR_ORDEN)
    },
    TIMEOUT_DEL_TEST_MS,
  )
})

describe('el agente se reinicia a mitad de una orden (T25, RF15)', () => {
  it(
    'no reanuda sola la maniobra interrumpida, y el retry la replaya sobre el MISMO slot',
    async () => {
      await montar()

      // Se retiene el tercer comando: los dos primeros pasos quedan hechos en
      // disco y la orden queda IN_PROGRESS de verdad, no seteada a mano.
      plc.politica = ({ numero }) => (numero === 3 ? 'RETENER' : 'OK')
      await sembrarPedidoDePicking('PICK-1', ORIGEN_A)
      await plc.esperarRetenido()

      const enVuelo = await ordenLocal('PICK-1')
      expect(enVuelo?.estado).toBe('IN_PROGRESS')
      expect(enVuelo?.slotLocationCode).toBe(SLOT_DE_A)
      expect(await estadoDelSlot(SLOT_DE_A)).toBe('BUSCANDO')
      const robotOcupado = await agenteVivo().orquestador.repositorios.robots.buscarPorId(ROBOT_ID)
      expect(robotOcupado?.ordenActivaId).toBe(enVuelo?.id)

      // El corte. `detener()` no puede abortar una maniobra en curso —espera a
      // que el ciclo termine—, asi que para poder bajar el proceso hay que soltar
      // el comando retenido, y eso deja la orden en ERROR. El estado que el corte
      // habia dejado escrito se vuelve a poner tal cual estaba DOS LINEAS ARRIBA:
      // no es un estado inventado, es el que esta corrida produjo.
      const ordenId = enVuelo?.id ?? ''
      plc.soltar(true)
      await esperarOrdenLocalEn('PICK-1', 'ERROR')
      await agenteVivo().detener()

      const reiniciado = crearAgenteDeLaSucursal()
      agente = reiniciado
      await reiniciado.orquestador.repositorios.ordenes.actualizar(ordenId, {
        estado: 'IN_PROGRESS',
        currentStepIndex: 2,
        errorReason: null,
      })
      await reiniciado.orquestador.repositorios.robots.fijarOrdenActiva(ROBOT_ID, ordenId)

      plc.politica = () => 'OK'
      const comandosAntesDelReinicio = plc.comandos.length
      await arrancarAgente()

      // RF15: el corte agarro la maniobra en el paso 3 (CARRO_BUSCA), o sea con
      // el cajon posiblemente ya en el carro. La orden NO se reanuda sola: queda
      // en ERROR con el motivo, el robot se libera y el agente no manda un solo
      // comando por su cuenta. Rehacer HOMING con el cajon encima y despues ir a
      // buscar un cajon que el robot ya tiene es la maniobra que no puede pasar.
      await esperarOrdenLocalEn('PICK-1', 'ERROR')
      const detenida = await ordenLocal('PICK-1')
      expect(detenida?.errorReason).toContain('interrumpida por un reinicio')
      const robotLibre = await reiniciado.orquestador.repositorios.robots.buscarPorId(ROBOT_ID)
      expect(robotLibre?.ordenActivaId).toBeNull()
      // Ni un comando al PLC: el robot se quedo quieto esperando al operario.
      expect(plc.comandos).toHaveLength(comandosAntesDelReinicio)

      // El operario ya devolvio el cajon al punto de origen del paso —el mismo
      // procedimiento de RF13— y da el retry. Recien ahi se replaya ENTERA desde
      // HOMING.
      const retry = await fetch(`${urlDelAgente}/api/orders/${ordenId}/retry`, { method: 'POST' })
      expect(retry.status).toBe(200)

      await esperarOrdenLocalEn('PICK-1', 'DONE')
      const replay = plc.comandos.slice(comandosAntesDelReinicio)
      expect(replay).toHaveLength(MANIOBRAS_POR_ORDEN)
      expect(replay[0]?.comando).toBe(COMANDO_HOMING)

      // Y sobre EL MISMO slot: el que la orden tenia tomado antes del corte. Los
      // slots no se rehidratan —conservan su estado— asi que el suyo seguia en
      // BUSCANDO; volver a elegir lo habria dejado ahi para siempre y la zona de
      // pickeo se iria comiendo un slot por cada reinicio.
      const final = await ordenLocal('PICK-1')
      expect(final?.slotLocationCode).toBe(SLOT_DE_A)
      expect(await estadoDelSlot(SLOT_DE_A)).toBe('OCUPADO')
      const zona = await reiniciado.orquestador.repositorios.slots.listarPorRobot(ROBOT_ID)
      expect(zona.filter((slot) => slot.estado.estado !== 'LIBRE')).toHaveLength(1)

      await esperarQueElServidorVea('PICK-1', 'DONE')
    },
    TIMEOUT_DEL_TEST_MS,
  )
})

describe('un paso del PLC falla (T25, RF13)', () => {
  it(
    'la orden queda en ERROR, el slot conserva su estado y el retry la replaya desde HOMING',
    async () => {
      await montar()

      // El tercer paso es CARRO_BUSCA: el carro se traba yendo a buscar el cajon.
      plc.politica = ({ numero }) => (numero === 3 ? 'FALLA' : 'OK')
      await sembrarPedidoDePicking('PICK-1', ORIGEN_A)
      await esperarOrdenLocalEn('PICK-1', 'ERROR')

      const fallada = await ordenLocal('PICK-1')
      // El mensaje del PLC se propaga tal cual: es lo que el operario ve en la
      // tablet, y "No logro recuperarse" le dice que ir a mirar.
      expect(fallada?.errorReason).toBe('No logro recuperarse')
      expect(fallada?.slotLocationCode).toBe(SLOT_DE_A)

      // RF13: el slot NO pasa a ERROR. Conserva su estado a la espera del retry;
      // ERROR de slot queda para un slot realmente inutilizable.
      expect(await estadoDelSlot(SLOT_DE_A)).toBe('BUSCANDO')

      // El servidor tambien se entera del ERROR: sin eso, la app de picking se
      // queda mirando un pedido en curso que nadie esta haciendo.
      await esperarQueElServidorVea('PICK-1', 'ERROR')

      // El operario devuelve el cajon al origen del paso que fallo y reintenta.
      plc.politica = () => 'OK'
      const comandosAntesDelRetry = plc.comandos.length
      const respuesta = await fetch(`${urlDelAgente}/api/orders/${fallada?.id ?? ''}/retry`, {
        method: 'POST',
      })
      expect(respuesta.status).toBe(200)

      await esperarOrdenLocalEn('PICK-1', 'DONE')

      // Replay COMPLETO desde HOMING, no desde el paso que fallo.
      const replay = plc.comandos.slice(comandosAntesDelRetry)
      expect(replay).toHaveLength(MANIOBRAS_POR_ORDEN)
      expect(replay[0]?.comando).toBe(COMANDO_HOMING)

      // Sobre el mismo slot, que era justo el que estaba esperando el retry.
      const final = await ordenLocal('PICK-1')
      expect(final?.slotLocationCode).toBe(SLOT_DE_A)
      expect(await estadoDelSlot(SLOT_DE_A)).toBe('OCUPADO')
      const zona = await agenteVivo().orquestador.repositorios.slots.listarPorRobot(ROBOT_ID)
      expect(zona.filter((slot) => slot.estado.estado !== 'LIBRE')).toHaveLength(1)

      // Y el servidor ve el pedido terminado, no clavado en ERROR.
      await esperarQueElServidorVea('PICK-1', 'DONE')
    },
    TIMEOUT_DEL_TEST_MS,
  )

  it(
    'la devolucion resuelve su destino contra el cajon en libros, y su retry tambien',
    async () => {
      await montar()

      // Primero un PICK que termina bien: deja el cajon apoyado en el slot, con
      // su ubicacion de guardado anotada en libros.
      await sembrarPedidoDePicking('PICK-1', ORIGEN_A)
      await esperarOrdenLocalEn('PICK-1', 'DONE')
      expect(await estadoDelSlot(SLOT_DE_A)).toBe('OCUPADO')

      // Ahora la devolucion. La tablet NO manda destino, y no tiene por que:
      // RF11 dice que con el cajon en libros el destino sale del cajon.
      plc.politica = ({ numero }) => (numero === MANIOBRAS_POR_ORDEN + 3 ? 'FALLA' : 'OK')
      const alta = await fetch(`${urlDelAgente}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'PUT', locationCode: SLOT_DE_A }),
      })
      expect(alta.status).toBe(202)
      const cuerpo = (await alta.json()) as { data: Record<string, unknown> }
      const devolucionId = String(cuerpo.data['id'])
      const externalDeLaDevolucion = String(cuerpo.data['externalOrderId'])

      // El carro se traba en el tercer paso de la devolucion.
      await esperarOrdenLocalEn(externalDeLaDevolucion, 'ERROR')
      const fallada = await ordenLocal(externalDeLaDevolucion)
      expect(fallada?.errorReason).toBe('No logro recuperarse')
      // El destino se resolvio contra el cajon: la orden nacio sin destino y lo
      // tiene. Sin eso muere armando los pasos con "destino invalido" y el cajon
      // no vuelve nunca a su ubicacion de guardado.
      expect(fallada?.targetLocation).toBe(ORIGEN_A)

      // RF13: el slot conserva su estado y no pasa a ERROR. Ese estado es
      // DEVOLVIENDO y no OCUPADO: la devolucion ya arranco y el cajon puede no
      // estar mas en el slot, asi que dejarlo figurando OCUPADO mandaria a un
      // PICK nuevo del mismo cajon por el camino de refcount (RF07) a buscar un
      // cajon que el robot ya levanto. Lo retiene esta orden hasta que el retry
      // la termine.
      expect(await estadoDelSlot(SLOT_DE_A)).toBe('DEVOLVIENDO')

      plc.politica = () => 'OK'
      const comandosAntesDelRetry = plc.comandos.length
      const respuesta = await fetch(`${urlDelAgente}/api/orders/${devolucionId}/retry`, {
        method: 'POST',
      })
      expect(respuesta.status).toBe(200)

      await esperarOrdenLocalEn(externalDeLaDevolucion, 'DONE')

      // Replay completo desde HOMING, y el cajon termina en su ubicacion de
      // guardado: el ultimo comando del carro es el "dejar" de 3X04AA3.
      const replay = plc.comandos.slice(comandosAntesDelRetry)
      expect(replay).toHaveLength(MANIOBRAS_POR_ORDEN)
      expect(replay[0]?.comando).toBe(COMANDO_HOMING)
      expect(replay[MANIOBRAS_POR_ORDEN - 1]?.comando).toBe(COMANDO_DEJAR_EN_ORIGEN_A)

      // El slot queda libre para el proximo pedido.
      expect(await estadoDelSlot(SLOT_DE_A)).toBe('LIBRE')
      await esperarQueElServidorVea(externalDeLaDevolucion, 'DONE')
    },
    TIMEOUT_DEL_TEST_MS,
  )
})

describe('la orden manual de la tablet sin enlace (T25, RF35)', () => {
  it(
    'se ejecuta sin internet y se empuja al servidor al reconectar',
    async () => {
      await montar()
      cableCortado = true

      // La tablet no sabe ni le importa que no haya internet: el alta entra por
      // la API local igual que siempre.
      const alta = await fetch(`${urlDelAgente}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'PICK', locationCode: ORIGEN_E }),
      })
      expect(alta.status).toBe(202)
      const cuerpo = (await alta.json()) as { data: Record<string, unknown> }
      const externalOrderId = String(cuerpo.data['externalOrderId'])
      // RF35: el id externo se prefija con la identidad del agente para que no
      // choque con uno de picking cuando los dos libros se junten.
      expect(externalOrderId.startsWith(`local-${AGENT_ID}-`)).toBe(true)

      await esperarOrdenLocalEn(externalOrderId, 'DONE')
      expect(plc.comandos).toHaveLength(MANIOBRAS_POR_ORDEN)
      // El servidor todavia no sabe que esta orden existe.
      expect(await estadoEnElServidor(externalOrderId)).toBeNull()

      cableCortado = false

      // Al volver el enlace se empuja por la MISMA ruta firmada que usa la app de
      // picking (RF26), y con el estado real, no como pedido nuevo.
      await esperarQueElServidorVea(externalOrderId, 'DONE')
      await esperarA('el outbox tendria que quedar vacio', async () => {
        return (await reporteDeEnlace())['outboxSize'] === 0
      })
      expect(plc.comandos).toHaveLength(MANIOBRAS_POR_ORDEN)
    },
    TIMEOUT_DEL_TEST_MS,
  )
})

describe('el servidor re-entrega por lease vencido (T25, RF28, RF14)', () => {
  it(
    'el mismo pedido vuelve vuelta tras vuelta y el robot hace UNA sola maniobra',
    async () => {
      // Lease de 0 ms: en cada reclamo el lease ya vencio, asi que el servidor
      // vuelve a ofrecer el mismo pedido. Es la version acelerada de lo que en
      // produccion pasa cuando el agente tarda mas que el lease o cuando un
      // reporte se pierde.
      await montar({ duracionDelLeaseMs: 0 })

      // Se cae SOLO el canal de reporte. Es el unico control que deja al servidor
      // CLAVADO en PENDING mientras el reclamo sigue vivo, que es exactamente el
      // estado en el que queda despues de un reporte perdido: el agente termina
      // la orden, el servidor no se entera y la sigue re-entregando. Cortar el
      // cable entero no sirve para esto —sin reclamo no hay re-entrega— y dejarlo
      // sano tampoco: el primer reporte de IN_PROGRESS la saca de PENDING y el
      // servidor no la vuelve a ofrecer nunca.
      reportesCortados = true

      await sembrarPedidoDePicking('PICK-1', ORIGEN_A)
      await esperarOrdenLocalEn('PICK-1', 'DONE')
      expect(plc.comandos).toHaveLength(MANIOBRAS_POR_ORDEN)

      // El servidor sigue creyendo que el pedido esta pendiente y sin dueño: con
      // el lease vencido cuenta como disponible, asi que CADA reclamo se lo lleva.
      expect(await estadoEnElServidor('PICK-1')).toBe('PENDING')
      expect(await servidorVivo().cola.pendientes(SITE_ID, Date.now())).toBe(1)

      const reclamosAlTerminar = reclamos
      await esperarA('el agente tendria que reclamar de nuevo y recibir el mismo pedido', () =>
        Promise.resolve(reclamos >= reclamosAlTerminar + 2),
      )

      // LO QUE IMPORTA: se cuentan las maniobras, no el estado final. El estado
      // final seria DONE igual aunque el robot hubiera ido dos veces a buscar el
      // mismo cajon; el conteo es lo unico que distingue las dos cosas.
      expect(plc.comandos).toHaveLength(MANIOBRAS_POR_ORDEN)
      expect(await estadoDelSlot(SLOT_DE_A)).toBe('OCUPADO')

      // Y no hay una segunda orden en la sucursal: la re-entrega llega con el
      // MISMO externalOrderId y el dedupe de RF14 la absorbe en la que ya existe.
      const ordenes = await agenteVivo().orquestador.repositorios.ordenes.listar({
        siteId: SITE_ID,
      })
      expect(ordenes.filter((orden) => orden.externalOrderId === 'PICK-1')).toHaveLength(1)
      const zona = await agenteVivo().orquestador.repositorios.slots.listarPorRobot(ROBOT_ID)
      expect(zona.filter((slot) => slot.estado.estado !== 'LIBRE')).toHaveLength(1)

      // Al volver el canal de reporte el servidor se entera, suelta el lease y
      // deja de re-entregar. Sin este cierre la re-entrega seria para siempre.
      reportesCortados = false
      await esperarQueElServidorVea('PICK-1', 'DONE')
      await esperarA('el outbox tendria que quedar vacio', async () => {
        const link = await reporteDeEnlace()
        return link['status'] === 'CONNECTED' && link['outboxSize'] === 0
      })
      expect(await servidorVivo().cola.pendientes(SITE_ID, Date.now())).toBe(0)
      expect(plc.comandos).toHaveLength(MANIOBRAS_POR_ORDEN)
    },
    TIMEOUT_DEL_TEST_MS,
  )
})

describe('el operario cancela desde la tablet (T25, RF21, RF34)', () => {
  it(
    'el pedido queda CANCELED de los dos lados, sin maniobra y sin re-entrega',
    async () => {
      // Lease de 0 ms tambien aca, y a proposito: si la cancelacion no llegara al
      // servidor, el pedido seguiria PENDING y volveria en la vuelta siguiente.
      await montar({ duracionDelLeaseMs: 0 })

      // Se pausa la cola ANTES de sembrar. Sin eso el robot lo toma apenas se
      // espeja y ya no se puede cancelar, que es justamente el otro lado de esta
      // funcionalidad.
      const pausa = await fetch(`${urlDelAgente}/api/orders/queue/${ROBOT_ID}/pause`, {
        method: 'POST',
      })
      expect(pausa.status).toBe(200)

      await sembrarPedidoDePicking('PICK-1', ORIGEN_A)
      await esperarA('el pedido tendria que espejarse en la sucursal', async () => {
        return (await ordenLocal('PICK-1')) !== undefined
      })
      const espejada = await ordenLocal('PICK-1')
      expect(espejada?.estado).toBe('PENDING')

      const cancelacion = await fetch(
        `${urlDelAgente}/api/orders/${espejada?.id ?? ''}/cancel`,
        { method: 'POST' },
      )
      expect(cancelacion.status).toBe(200)

      // La app de picking tiene que ver el pedido cancelado: sin el reporte se
      // queda mostrando un pedido en curso que nadie va a hacer.
      await esperarQueElServidorVea('PICK-1', 'CANCELED')

      // CANCELED es terminal del otro lado: suelta el lease y sale de la oferta.
      expect(await servidorVivo().cola.pendientes(SITE_ID, Date.now())).toBe(0)
      await esperarA('el outbox tendria que quedar vacio', async () => {
        return (await reporteDeEnlace())['outboxSize'] === 0
      })

      // Y el robot no se movio ni una vez, ni antes ni despues.
      expect(plc.comandos).toHaveLength(0)
      expect(await estadoDelSlot(SLOT_DE_A)).toBe('LIBRE')
    },
    TIMEOUT_DEL_TEST_MS,
  )
})
