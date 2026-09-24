// Composicion del agente: donde se cablean base, transporte, orquestador y API.
//
// La capa HTTP es montable y desmontable: el agente arranca y sigue ejecutando
// ordenes con `montarApi` en false. Es lo que hace que la API sea un componente
// y no el centro del proceso.

import { randomUUID } from 'node:crypto'

import type { Logger } from '@aoki-one/domain'

import { crearServidorHttp } from './api/httpServer.js'
import { rehidratar } from './orchestrator/rehydrate.js'
import { ejecutarCicloDeRobot } from './orchestrator/robotLoop.js'
import type { DireccionDeEscucha, ServidorHttp } from './api/httpServer.js'
import type { DependenciasDelOrquestador } from './orchestrator/ports.js'
import { abrirBase } from './persistence/database.js'
import { crearRepositorios } from './persistence/index.js'
import {
  crearPurgaDelAgente,
  programarPurga,
  RETENCION_POR_DEFECTO,
  type PoliticaDeRetencion,
  type PurgaProgramada,
} from './persistence/retencion.js'
import { crearRelojDelSistema } from './reloj.js'
import { crearLoggerDelAgente } from './registro.js'
import { BACKOFF_DEL_ENLACE, crearAzarDelSistema } from './sync/backoff.js'
import { crearEnlace, OPCIONES_DE_ENLACE_POR_DEFECTO, type Enlace } from './sync/link.js'
import { crearOrigenPorLongPoll } from './sync/orderSource.js'
import { crearOutboxSqlite } from './sync/outbox.js'
import { crearClienteHttp, TIEMPOS_DEL_CLIENTE_POR_DEFECTO } from './sync/serverClient.js'
import { crearDeviceMutex } from './transport/deviceMutex.js'
import { crearPuertoDeTransporte } from './transport/transportePort.js'
import type { PuertoDeTransporteConcreto } from './transport/transportePort.js'

/**
 * Enlace con el servidor de pedidos (RF28, RF32).
 *
 * Es un objeto aparte porque o esta entero o no esta: media configuracion de
 * enlace (URL sin credencial) no es un enlace degradado, es un error de
 * despliegue, y el tipo lo vuelve imposible de expresar.
 */
export interface OpcionesDeEnlaceDelAgente {
  /** Base del servidor, sin barra final. */
  readonly urlBase: string
  readonly keyId: string
  readonly secreto: string
}

export interface OpcionesDelAgente {
  readonly siteId: string
  /** Identidad de este agente. Prefija el id externo de las ordenes locales (RF35). */
  readonly agentId: string
  readonly rutaDeBase: string
  readonly montarApi: boolean
  readonly simularPlc: boolean
  readonly httpPuerto: number
  readonly httpBind: string
  readonly zonaDePickeo: readonly string[]
  /**
   * Token del comando directo a PLC (RF22, segundo nivel).
   *
   * `null` = no configurado, y entonces el endpoint queda DESHABILITADO. Falla
   * cerrado a proposito: es el unico endpoint que escribe registros salteandose
   * el orquestador y las maquinas de estado, y arrancar sin configurar no puede
   * habilitarlo en silencio. Mismo criterio que RF20 con la simulacion.
   */
  readonly tokenDeMantenimiento: string | null
  /**
   * `null` = enlace APAGADO, y es el modo del cutover (T26): el agente corre
   * primero sin servidor, solo con su cola local. Mismo criterio que RF20 con la
   * simulacion y que RF22 con el token: arrancar sin configurar no puede
   * conectarse a nada en silencio.
   */
  readonly enlace: OpcionesDeEnlaceDelAgente | null
  /**
   * Destino de los logs estructurados (RNF de Observabilidad).
   *
   * Ausente = stdout. Se inyecta para que los tests puedan afirmar lo que se
   * loguea, o callarlo: un logger que escribe a stdout en la suite es ruido.
   */
  readonly logger?: Logger
  /**
   * Puerto de transporte al PLC. Ausente = el Modbus real, o su modo simulacion
   * cuando `simularPlc` esta en true.
   *
   * Se inyecta por lo mismo que el logger: el modo simulacion contesta OK
   * SIEMPRE, y un PLC que nunca falla no deja probar el camino de RF13 —un paso
   * que falla, la orden en ERROR, el slot conservando su estado y el retry
   * replayando desde HOMING—, que es justo el que tiene que funcionar el dia que
   * algo se traba en planta.
   */
  readonly transporte?: PuertoDeTransporteConcreto
  /** Cuanto se conserva cada cosa antes de purgarla. Ausente = los defaults. */
  readonly retencion?: PoliticaDeRetencion
  /**
   * Cada cuanto corre la purga. Ausente = una vez por hora.
   *
   * No es configuracion de afinado: es lo que hace que la purga corra SOLA. En
   * una notebook de sucursal que nadie mantiene, una purga que depende de que
   * alguien se acuerde de ejecutarla es una purga que no existe.
   */
  readonly intervaloDePurgaMs?: number
}

/**
 * Una pasada por hora.
 *
 * El corte es por antiguedad en dias, asi que la frecuencia exacta no cambia que
 * se borra: solo cuanto tarda en notarse. Una vez por hora mantiene el trabajo
 * de cada pasada chico —nunca se acumula un dia entero de filas— sin competir
 * por el disco con la maniobra.
 */
const INTERVALO_DE_PURGA_POR_DEFECTO_MS = 60 * 60 * 1000

export interface Agente {
  readonly iniciar: () => Promise<void>
  readonly detener: () => Promise<void>
  readonly api: ServidorHttp | null
  readonly direccion: () => DireccionDeEscucha | null
  readonly orquestador: DependenciasDelOrquestador
  /** `null` con el enlace apagado. Expuesto para diagnostico y para los tests. */
  readonly enlace: Enlace | null
}

/**
 * Tiempos del handshake. El polling de `messageOut` se mantiene en 150 ms: es la
 * latencia percibida de la maniobra y el RNF pide conservarla.
 */
const TIEMPOS_DE_HANDSHAKE = {
  intervaloAckMs: 150,
  maxIntentosAck: 600,
  intervaloResetMs: 150,
  maxIntentosReset: 40,
} as const

const POLITICA_DE_REINTENTOS = { maxIntentos: 3, baseBackoffMs: 2000 } as const

/**
 * Tick de seguridad del loop, en ms.
 *
 * El avance real es POR EVENTO: el alta de una orden despierta el loop. Este
 * tick es solo la red que cubre lo que ningun evento despierta —una orden que
 * quedo esperando slot y el slot se libero por otra via—. El RNF prohibe el
 * busy-loop de 300 ms del legacy, asi que es deliberadamente lento.
 */
const TICK_DE_SEGURIDAD_MS = 250

export function crearAgente(opciones: OpcionesDelAgente): Agente {
  const base = abrirBase(opciones.rutaDeBase)
  const repositorios = crearRepositorios(base)
  const reloj = crearRelojDelSistema()
  const mutex = crearDeviceMutex()
  const logger = opciones.logger ?? crearLoggerDelAgente()
  const purga = crearPurgaDelAgente(base, opciones.retencion ?? RETENCION_POR_DEFECTO)

  const transporte =
    opciones.transporte ??
    crearPuertoDeTransporte({
      mutex,
      reloj,
      tiempos: TIEMPOS_DE_HANDSHAKE,
      simularPlc: opciones.simularPlc,
      buscarDispositivo: (robotId, tipo) => repositorios.dispositivos.buscar(robotId, tipo),
    })

  // El outbox existe solo si hay enlace: una cola de salida que nadie drena solo
  // crece (RF34).
  const outbox = opciones.enlace === null ? null : crearOutboxSqlite(base)

  const orquestador: DependenciasDelOrquestador = {
    repositorios,
    siteId: opciones.siteId,
    agentId: opciones.agentId,
    // Se inyecta: la logica no llama a randomUUID directo (RNF de Calidad).
    generarId: () => randomUUID(),
    logger,
    transporte,
    reloj,
    politica: POLITICA_DE_REINTENTOS,
    ...(outbox === null ? {} : { outbox }),
  }

  let corriendo = false
  let despertarPendiente = false
  let avisar: (() => void) | null = null

  /** Despierta el loop sin esperar al tick. */
  function despertar(): void {
    despertarPendiente = true
    avisar?.()
  }

  /** Espera un evento o el tick de seguridad, lo que llegue primero. */
  function esperarTrabajo(): Promise<void> {
    if (despertarPendiente) {
      despertarPendiente = false
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      const temporizador = setTimeout(() => {
        avisar = null
        resolve()
      }, TICK_DE_SEGURIDAD_MS)
      // unref: un tick pendiente no tiene que mantener vivo el proceso.
      temporizador.unref()
      avisar = () => {
        clearTimeout(temporizador)
        avisar = null
        resolve()
      }
    })
  }

  async function bucle(): Promise<void> {
    while (corriendo) {
      let huboTrabajo = false
      const robots = await repositorios.robots.listar(opciones.siteId)
      for (const robot of robots) {
        const ciclo = await ejecutarCicloDeRobot(orquestador, robot.id)
        if (ciclo.tipo === 'ORDEN_TERMINADA') {
          // Una orden que termino puede haber liberado el slot que otra esperaba.
          huboTrabajo = true
        }
      }
      if (!huboTrabajo) {
        await esperarTrabajo()
      }
    }
  }

  const configuracionDeEnlace = opciones.enlace
  const enlace =
    configuracionDeEnlace === null || outbox === null
      ? null
      : (() => {
          const cliente = crearClienteHttp({
            urlBase: configuracionDeEnlace.urlBase,
            siteId: opciones.siteId,
            agentId: opciones.agentId,
            credencial: {
              keyId: configuracionDeEnlace.keyId,
              secreto: configuracionDeEnlace.secreto,
            },
            tiempos: TIEMPOS_DEL_CLIENTE_POR_DEFECTO,
            pedir: fetch,
            ahoraMs: () => reloj.ahoraMs(),
          })
          return crearEnlace({
            origen: crearOrigenPorLongPoll(cliente),
            cliente,
            outbox,
            orquestador,
            azar: crearAzarDelSistema(),
            opciones: { ...OPCIONES_DE_ENLACE_POR_DEFECTO, backoff: BACKOFF_DEL_ENLACE },
            despertar,
          })
        })()

  const api = opciones.montarApi
    ? crearServidorHttp({
        orquestador,
        simularPlc: opciones.simularPlc,
        despertar,
        tokenDeMantenimiento: opciones.tokenDeMantenimiento,
        ...(enlace === null ? {} : { enlace: () => enlace.estado() }),
      })
    : null

  let direccion: DireccionDeEscucha | null = null
  let bucleTerminado: Promise<void> = Promise.resolve()
  let purgaProgramada: PurgaProgramada | null = null

  return {
    api,
    direccion: () => direccion,
    orquestador,
    enlace,

    iniciar: async () => {
      // La zona de pickeo se siembra para cada robot dado de alta. Es idempotente:
      // un slot que ya existia conserva su estado (RF15).
      const robots = await repositorios.robots.listar(opciones.siteId)
      for (const robot of robots) {
        await repositorios.slots.sembrarZonaDePickeo(robot.id, opciones.zonaDePickeo)
      }

      // RF15: se reconcilia ANTES de arrancar el bucle y el enlace. Un reinicio a
      // mitad de maniobra deja la orden en IN_PROGRESS y el robot con esa orden
      // activa, y el ciclo del robot solo toma PENDING: sin esto la orden queda
      // huerfana y el robot ocupado para siempre. Pedir trabajo nuevo antes de
      // reconciliar seria encima acumular encima de lo que quedo a medias.
      await rehidratar(orquestador)

      if (api !== null) {
        direccion = await api.escuchar(opciones.httpPuerto, opciones.httpBind)
      }

      // La purga arranca con el agente y corre sola de ahi en mas. Antes del
      // bucle: la primera pasada es la que recupera el disco despues de que el
      // agente estuvo apagado unos dias.
      purgaProgramada = programarPurga({
        purga,
        intervaloMs: opciones.intervaloDePurgaMs ?? INTERVALO_DE_PURGA_POR_DEFECTO_MS,
        ahoraMs: () => reloj.ahoraMs(),
        alTerminar: (resultado) => {
          logger.info('RETENTION_PURGED', { ...resultado })
        },
        alFallar: (error) => {
          // Una purga que falla no puede tumbar al proceso que maneja el robot:
          // lo que se deja de borrar es historia vieja, lo que se dejaria de
          // atender son maniobras de ahora.
          logger.error('RETENTION_PURGE_FAILED', {
            mensaje: error instanceof Error ? error.message : String(error),
          })
        },
      })

      corriendo = true
      bucleTerminado = bucle()
      // El enlace arranca DESPUES del loop: primero el agente queda en
      // condiciones de ejecutar, y recien ahi se le empieza a entregar trabajo.
      enlace?.iniciar()
    },

    detener: async () => {
      purgaProgramada?.detener()
      purgaProgramada = null
      if (enlace !== null) {
        await enlace.detener()
      }
      corriendo = false
      despertar()
      await bucleTerminado

      if (api !== null) {
        await api.cerrar()
        direccion = null
      }
      await transporte.cerrar()
      base.cerrar()
    },
  }
}
