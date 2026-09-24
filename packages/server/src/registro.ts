// T37 — El logger del proceso del servidor.
//
// No define un formato propio: usa el `Logger` de `domain`, que existe
// justamente para que el agente y el servidor escriban la MISMA linea y se
// puedan cruzar por correlacion de orden. Un segundo formato del lado del
// servidor haria imposible seguir un pedido de punta a punta, que es todo el
// valor de tener logs estructurados.
//
// Lo unico que agrega esta capa es lo que es propio del proceso: el componente,
// el destino (stdout) y el nivel minimo leido del entorno.

import { crearLogger, formatearRegistro } from '@aoki-one/domain'
import type { Logger, NivelDeLog } from '@aoki-one/domain'

/** Quien escribe. Es el campo con el que se separan las dos mitades del enlace. */
export const COMPONENTE = 'servidor'

export const NIVELES: readonly NivelDeLog[] = ['DEBUG', 'INFO', 'WARN', 'ERROR']

export function esNivelDeLog(valor: string): valor is NivelDeLog {
  return (NIVELES as readonly string[]).includes(valor)
}

export interface OpcionesDelLoggerDelServidor {
  readonly nivelMinimo: NivelDeLog
  /**
   * Destino de la linea ya formateada. Por defecto stdout, que es lo que espera
   * journald cuando el proceso corre como unidad de systemd: no hay que rotar
   * nada a mano y la retencion la maneja el journal. Por eso el servidor NO
   * escribe un archivo de log propio: dos rotaciones sobre el mismo log es como
   * se pierden logs.
   */
  readonly escribir?: (linea: string) => void
  readonly ahoraMs?: () => number
}

export function crearLoggerDelServidor(opciones: OpcionesDelLoggerDelServidor): Logger {
  const escribir =
    opciones.escribir ??
    ((linea: string) => {
      console.log(linea)
    })

  return crearLogger({
    componente: COMPONENTE,
    nivelMinimo: opciones.nivelMinimo,
    ahoraMs: opciones.ahoraMs ?? Date.now,
    emitir: (registro) => {
      escribir(formatearRegistro(registro))
    },
  })
}
