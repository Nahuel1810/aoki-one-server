// RF18 — El monitor de conectividad, corriendo.
//
// `crearMonitorDeConexiones` estaba completo y testeado y NADIE LO INSTANCIABA:
// el unico `.conectar()` de todo el paquete vivia adentro suyo, asi que en
// planta nada abria el socket y la pantalla de dispositivos decia DISCONNECTED
// para siempre. Esto es la manivela que faltaba, equivalente a
// `ConnectionService.startMonitoring()` / `stopMonitoring()` del legacy.

import type { MonitorDeConexiones } from './connectionMonitor.js'

/**
 * Cada cuanto corre un ciclo del monitor.
 *
 * Es el default de CONNECTION_CHECK_INTERVAL_MS del legacy. No es afinado: es lo
 * que hace que un cable desenchufado se vea en pantalla en el segundo siguiente
 * y no cuando alguien manda una orden.
 */
export const INTERVALO_DE_MONITOREO_POR_DEFECTO_MS = 1000

export interface MonitorProgramado {
  readonly detener: () => void
}

export function programarMonitor(opciones: {
  readonly monitor: MonitorDeConexiones
  readonly intervaloMs: number
  /** Los robots a recorrer en cada ciclo. */
  readonly listarRobots: () => Promise<readonly string[]>
  readonly alFallar: (error: unknown) => void
}): MonitorProgramado {
  const { monitor, intervaloMs, listarRobots, alFallar } = opciones

  // Guarda de reentrada: un ciclo puede tardar mas que el intervalo (el
  // connectTCP de un PLC caido se come el timeout de socket entero), y sin esto
  // se irian encimando ciclos hasta que la cola de cada dispositivo crece sola.
  // El legacy usa setInterval pelado y por eso apilaba ticks contra un PLC
  // trabado.
  let enCurso = false

  const ciclo = (): void => {
    if (enCurso) {
      return
    }
    enCurso = true
    void (async () => {
      try {
        for (const robotId of await listarRobots()) {
          await monitor.verificarRobot(robotId)
        }
      } catch (error) {
        // Un ciclo que falla no puede tumbar al proceso que maneja el robot: el
        // proximo ciclo vuelve a intentar y el backoff por dispositivo ya esta
        // adentro del monitor.
        alFallar(error)
      } finally {
        enCurso = false
      }
    })()
  }

  // El primer ciclo va YA: si el monitor esperara al primer intervalo, el estado
  // de conexion arrancaria vacio y la pantalla diria DISCONNECTED sin haberlo
  // mirado.
  ciclo()
  const temporizador = setInterval(ciclo, intervaloMs)
  // unref: un ciclo pendiente no tiene que mantener vivo el proceso.
  temporizador.unref()

  return {
    detener: () => {
      clearInterval(temporizador)
    },
  }
}
