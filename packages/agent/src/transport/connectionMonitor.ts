// RF18 — Monitor de conectividad.
//
// Backoff exponencial por dispositivo, recreacion de cliente cada N fallos
// consecutivos y hard-reset de transporte como ultimo recurso. Cede el socket
// cuando el orquestador esta ejecutando una orden: el monitor es la rueda de
// auxilio, no compite por el medio.


import type { Reloj } from '../reloj.js'
import type { DeviceMutex } from './deviceMutex.js'
import { clasificarError } from './errorClassification.js'
import type { FalloDeEjecucion } from './errorClassification.js'
import { claveDeDispositivo } from './modbusClient.js'
import type { ClaveDeDispositivo, DispositivoRegistrado, RegistroDeClientes } from './modbusClient.js'

/**
 * `baseMs * 2^(fallosConsecutivos - 1)`, con techo en `maxMs`.
 *
 * Con `fallosConsecutivos <= 1` devuelve `baseMs`. Es una formula aparte de la
 * del backoff de reintento de paso: son constantes distintas y no hay que
 * unificarlas.
 */
export function calcularBackoffMs(
  fallosConsecutivos: number,
  baseMs: number,
  maxMs: number,
): number {
  // Exponencial desde el primer fallo, con techo: 5000, 10000, 20000, 30000...
  const crudo = baseMs * 2 ** Math.max(0, fallosConsecutivos - 1)
  return Math.min(maxMs, crudo)
}

/** Estado de conexion observable de un dispositivo. */
export type EstadoDeConexion =
  | { readonly tipo: 'CONECTADO'; readonly ultimoContactoMs: number }
  | {
      readonly tipo: 'DESCONECTADO'
      readonly fallosConsecutivos: number
      /** Epoch ms antes del cual el monitor no vuelve a intentar. */
      readonly proximoIntentoMs: number
    }

/** Que hizo el monitor con un dispositivo en un ciclo. */
export type ResultadoDeCiclo =
  /** El orquestador esta usando el robot: el monitor no toco el socket. */
  | { readonly tipo: 'CEDIDO_AL_ORQUESTADOR' }
  /** El mutex del dispositivo estaba tomado: se saltea, no se encola. */
  | { readonly tipo: 'SALTEADO_POR_LOCK' }
  | { readonly tipo: 'ESPERANDO_BACKOFF'; readonly proximoIntentoMs: number }
  | { readonly tipo: 'CONECTADO' }
  | {
      readonly tipo: 'FALLO'
      readonly fallosConsecutivos: number
      /** True en el fallo 5, 10, 15... (la condicion es por modulo, no por umbral). */
      readonly clienteRecreado: boolean
      readonly fallo: FalloDeEjecucion
    }

export interface CicloDeDispositivo {
  readonly clave: ClaveDeDispositivo
  readonly resultado: ResultadoDeCiclo
}

/**
 * Lo que el monitor necesita para un ciclo.
 *
 * No estan `hardResetTrasNRecreaciones` ni `cooldownDeHardResetMs`: el disparo
 * automatico del hard-reset tras N recreaciones no lo ejercita ningun test
 * portado (el unico test de hard-reset lo invoca a mano) y, al ser campos
 * requeridos, cada fixture tendria que inventar valores que nadie afirma. La
 * escalera automatica entra con la task que escriba su test.
 */
export interface ConfiguracionDeMonitor {
  readonly baseBackoffMs: number
  readonly maxBackoffMs: number
  /** Cada cuantos fallos consecutivos se recrea el cliente Modbus. */
  readonly recrearClienteCadaNFallos: number
}

export interface DependenciasDeMonitor {
  readonly clientes: RegistroDeClientes
  readonly mutex: DeviceMutex
  readonly reloj: Reloj
  readonly configuracion: ConfiguracionDeMonitor
  /** Dispositivos dados de alta de ese robot. */
  readonly listarDispositivos: (robotId: string) => Promise<readonly DispositivoRegistrado[]>
  /** True cuando el orquestador esta ejecutando una orden de ese robot. */
  readonly orquestadorTienePrioridad: (robotId: string) => boolean
  /** En simulacion el monitor y el hard-reset son no-op (RF20). */
  readonly simularPlc: boolean
}

export interface MonitorDeConexiones {
  /**
   * Un ciclo sobre todos los dispositivos de un robot.
   *
   * Devuelve un resultado POR DISPOSITIVO incluso cuando cede o saltea, para que
   * "no hizo nada" sea una afirmacion positiva y no la ausencia de una llamada.
   */
  readonly verificarRobot: (robotId: string) => Promise<readonly CicloDeDispositivo[]>
  readonly estadoDe: (clave: ClaveDeDispositivo) => EstadoDeConexion | undefined
  /**
   * Ultimo recurso: cierra todos los clientes, olvida el backoff de cada
   * dispositivo y suelta el mutex. Se invoca desde afuera.
   */
  readonly hardReset: () => Promise<void>
}

export function crearMonitorDeConexiones(
  dependencias: DependenciasDeMonitor,
): MonitorDeConexiones {
  const { clientes, mutex, reloj, configuracion, listarDispositivos } = dependencias
  const estados = new Map<ClaveDeDispositivo, EstadoDeConexion>()

  async function verificarDispositivo(
    dispositivo: DispositivoRegistrado,
  ): Promise<CicloDeDispositivo> {
    const clave = claveDeDispositivo(dispositivo.robotId, dispositivo.tipo)
    const estado = estados.get(clave)

    // El backoff se respeta ANTES de tocar el socket: reintentar antes de tiempo
    // es lo que convertia un PLC caido en una tormenta de reconexiones.
    if (estado?.tipo === 'DESCONECTADO' && reloj.ahoraMs() < estado.proximoIntentoMs) {
      return {
        clave,
        resultado: { tipo: 'ESPERANDO_BACKOFF', proximoIntentoMs: estado.proximoIntentoMs },
      }
    }

    if (dependencias.simularPlc) {
      estados.set(clave, { tipo: 'CONECTADO', ultimoContactoMs: reloj.ahoraMs() })
      return { clave, resultado: { tipo: 'CONECTADO' } }
    }

    // intentarEjecutar NO espera: si el orquestador tiene el socket, el monitor
    // se corre. Es la cesion de RF18 a nivel de dispositivo.
    const intento = await mutex.intentarEjecutar(clave, async () => {
      const cliente = clientes.asegurar(dispositivo)
      await cliente.conectar()
    })

    if (!intento.ejecutado) {
      return { clave, resultado: { tipo: 'SALTEADO_POR_LOCK' } }
    }

    estados.set(clave, { tipo: 'CONECTADO', ultimoContactoMs: reloj.ahoraMs() })
    return { clave, resultado: { tipo: 'CONECTADO' } }
  }

  async function verificarDispositivoConFallo(
    dispositivo: DispositivoRegistrado,
  ): Promise<CicloDeDispositivo> {
    const clave = claveDeDispositivo(dispositivo.robotId, dispositivo.tipo)
    try {
      return await verificarDispositivo(dispositivo)
    } catch (error) {
      const previo = estados.get(clave)
      const fallosConsecutivos =
        previo?.tipo === 'DESCONECTADO' ? previo.fallosConsecutivos + 1 : 1

      // La recreacion es POR MODULO (5, 10, 15...), no por umbral: un dispositivo
      // que queda caido se sigue recreando cada N fallos, no una sola vez.
      const clienteRecreado =
        fallosConsecutivos % configuracion.recrearClienteCadaNFallos === 0
      if (clienteRecreado) {
        await clientes.recrear(dispositivo)
      }

      const esperaMs = calcularBackoffMs(
        fallosConsecutivos,
        configuracion.baseBackoffMs,
        configuracion.maxBackoffMs,
      )
      estados.set(clave, {
        tipo: 'DESCONECTADO',
        fallosConsecutivos,
        proximoIntentoMs: reloj.ahoraMs() + esperaMs,
      })

      return {
        clave,
        resultado: {
          tipo: 'FALLO',
          fallosConsecutivos,
          clienteRecreado,
          fallo: clasificarError(error),
        },
      }
    }
  }

  return {
    verificarRobot: async (robotId) => {
      const dispositivos = await listarDispositivos(robotId)

      // La cesion se decide UNA vez por robot: mientras el orquestador ejecuta una
      // orden el monitor no toca ningun dispositivo de ese robot.
      if (dependencias.orquestadorTienePrioridad(robotId)) {
        return dispositivos.map((dispositivo) => ({
          clave: claveDeDispositivo(dispositivo.robotId, dispositivo.tipo),
          resultado: { tipo: 'CEDIDO_AL_ORQUESTADOR' as const },
        }))
      }

      const ciclos: CicloDeDispositivo[] = []
      for (const dispositivo of dispositivos) {
        ciclos.push(await verificarDispositivoConFallo(dispositivo))
      }
      return ciclos
    },

    estadoDe: (clave) => estados.get(clave),

    hardReset: async () => {
      // Ultimo recurso: se tira todo el transporte y se olvida el estado de
      // recuperacion, incluido el mutex. Sin liberar el mutex un dispositivo que
      // quedo tomado por una operacion muerta bloquea al monitor para siempre.
      await clientes.cerrarTodos()
      mutex.liberarTodo()
      estados.clear()
    },
  }
}
