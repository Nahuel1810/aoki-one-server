// RNF de Observabilidad — el destino real de los logs del agente.
//
// El logger en si vive en `@aoki-one/domain` porque el agente y el servidor lo
// necesitan igual y lo unico que comparten es ese paquete. Lo que vive ACA es lo
// que no puede vivir alla: el reloj del sistema y la escritura a stdout.
//
// Una linea JSON por evento a stdout y nada mas. El agente corre en una notebook
// de sucursal: no hay recolector, no hay disco de sobra y no hay nadie que rote
// un archivo. Quien corre el proceso —un servicio de Windows, `nssm`, una
// consola abierta— es el que decide donde va esa salida, y asi no hay dos
// mecanismos de rotacion peleando por el mismo log.

import { crearLogger, formatearRegistro, type Logger, type NivelDeLog } from '@aoki-one/domain'

/** Quien escribe. Es el campo con el que se separan las dos mitades del enlace. */
export const COMPONENTE = 'agente'

export const NIVELES: readonly NivelDeLog[] = ['DEBUG', 'INFO', 'WARN', 'ERROR']

export function esNivelDeLog(valor: string): valor is NivelDeLog {
  return (NIVELES as readonly string[]).includes(valor)
}

/**
 * Logger del proceso del agente.
 *
 * Por defecto arranca en INFO: DEBUG incluye una linea por cada comando que sale
 * al PLC —cinco por maniobra— y eso en produccion es volumen, no informacion. Se
 * sube a DEBUG cuando hay que perseguir una orden concreta.
 *
 * `escribir` existe para los tests del arranque, que necesitan afirmar que una
 * variable rota se loguea sin llenar la salida de la suite. En produccion se
 * omite y la linea va a stdout.
 */
export function crearLoggerDelAgente(
  nivelMinimo: NivelDeLog = 'INFO',
  escribir?: (linea: string) => void,
): Logger {
  const destino =
    escribir ??
    ((linea: string) => {
      console.log(linea)
    })

  return crearLogger({
    componente: COMPONENTE,
    nivelMinimo,
    ahoraMs: () => Date.now(),
    emitir: (registro) => {
      destino(formatearRegistro(registro))
    },
  })
}
