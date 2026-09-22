// Composicion del agente: donde se cablean base, transporte, orquestador y API.
//
// La capa HTTP es montable y desmontable: el agente arranca y sigue ejecutando
// ordenes con `montarApi` en false. Es lo que hace que la API sea un componente
// y no el centro del proceso.

import { randomUUID } from 'node:crypto'

import { crearServidorHttp } from './api/httpServer.js'
import { ejecutarCicloDeRobot } from './orchestrator/robotLoop.js'
import type { DireccionDeEscucha, ServidorHttp } from './api/httpServer.js'
import type { DependenciasDelOrquestador } from './orchestrator/ports.js'
import { abrirBase } from './persistence/database.js'
import { crearRepositorios } from './persistence/index.js'
import { crearRelojDelSistema } from './reloj.js'
import { crearDeviceMutex } from './transport/deviceMutex.js'
import { crearPuertoDeTransporte } from './transport/transportePort.js'

export interface OpcionesDelAgente {
  readonly siteId: string
  readonly rutaDeBase: string
  readonly montarApi: boolean
  readonly simularPlc: boolean
  readonly httpPuerto: number
  readonly httpBind: string
  readonly zonaDePickeo: readonly string[]
}

export interface Agente {
  readonly iniciar: () => Promise<void>
  readonly detener: () => Promise<void>
  readonly api: ServidorHttp | null
  readonly direccion: () => DireccionDeEscucha | null
  readonly orquestador: DependenciasDelOrquestador
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

  const transporte = crearPuertoDeTransporte({
    mutex,
    reloj,
    tiempos: TIEMPOS_DE_HANDSHAKE,
    simularPlc: opciones.simularPlc,
    buscarDispositivo: (robotId, tipo) => repositorios.dispositivos.buscar(robotId, tipo),
  })

  const orquestador: DependenciasDelOrquestador = {
    repositorios,
    siteId: opciones.siteId,
    // Se inyecta: la logica no llama a randomUUID directo (RNF de Calidad).
    generarId: () => randomUUID(),
    transporte,
    reloj,
    politica: POLITICA_DE_REINTENTOS,
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

  const api = opciones.montarApi
    ? crearServidorHttp({ orquestador, simularPlc: opciones.simularPlc, despertar })
    : null

  let direccion: DireccionDeEscucha | null = null
  let bucleTerminado: Promise<void> = Promise.resolve()

  return {
    api,
    direccion: () => direccion,
    orquestador,

    iniciar: async () => {
      // La zona de pickeo se siembra para cada robot dado de alta. Es idempotente:
      // un slot que ya existia conserva su estado (RF15).
      const robots = await repositorios.robots.listar(opciones.siteId)
      for (const robot of robots) {
        await repositorios.slots.sembrarZonaDePickeo(robot.id, opciones.zonaDePickeo)
      }

      if (api !== null) {
        direccion = await api.escuchar(opciones.httpPuerto, opciones.httpBind)
      }

      corriendo = true
      bucleTerminado = bucle()
    },

    detener: async () => {
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
