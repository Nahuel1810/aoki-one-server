// Punto de entrada del agente de sucursal.
//
// El agente corre en la notebook de la LAN de la sucursal: es dueño del lazo de
// control Modbus contra los PLCs, expone la API HTTP solo hacia la LAN y habla
// con el servidor Linux por long-poll saliente. Nunca recibe conexiones de
// afuera, asi que no publica ningun puerto a internet (ver deploy/README-agente.md).
//
// Este archivo es la capa mas fina posible: lee el entorno del proceso, delega
// en `arrancar` y traduce el resultado a senales y exit code. Todo lo que se
// puede afirmar en un test vive en `arranque.ts`.

import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { arrancar } from './arranque.js'
import { leerConfiguracion } from './configuracion.js'
import { crearLoggerDelAgente } from './registro.js'

/** Nombre del paquete. Sirve para trazas y diagnosticos. */
export const PACKAGE_NAME_AGENT = '@aoki-one/agent'

/**
 * Arranque del proceso.
 *
 * Con la configuracion rota NO deja el agente a medias: loguea todo lo que hay
 * que corregir y termina con exit code 1. Arrancar igual seria peor que no
 * arrancar, porque la tablet mostraria una sucursal viva que no mueve el robot.
 */
export async function main(): Promise<void> {
  // El nivel sale de la misma lectura que valida todo lo demas. Si la
  // configuracion esta rota se cae al default y el logger igual existe: los
  // errores de configuracion son justo los que no se pueden perder.
  const configuracion = leerConfiguracion(process.env)
  const logger = crearLoggerDelAgente(configuracion.ok ? configuracion.valor.nivelDeLog : 'INFO')

  const proceso = await arrancar({ entorno: process.env, logger })

  if (!proceso.ok) {
    process.exitCode = 1
    return
  }

  // SIGTERM es la senal con la que un servicio de Windows o `nssm` paran el
  // proceso, y SIGINT la del Ctrl+C de quien lo prueba a mano. Las dos cierran
  // igual: se corta el enlace y el bucle del robot, y recien entonces se cierra
  // la base, para no dejar una maniobra escrita a la mitad.
  let deteniendo = false
  const detener = (senal: string): void => {
    if (deteniendo) {
      return
    }
    deteniendo = true
    logger.info('SIGNAL_RECEIVED', { senal })
    void proceso.valor.detener()
  }

  process.on('SIGTERM', () => {
    detener('SIGTERM')
  })
  process.on('SIGINT', () => {
    detener('SIGINT')
  })
}

/**
 * True cuando este modulo es el que Node ejecuto directamente.
 *
 * Evita que importar el paquete (por ejemplo desde un test) dispare el arranque.
 */
function esEntryPoint(): boolean {
  const ejecutado = process.argv[1]
  if (ejecutado === undefined) {
    return false
  }
  return fileURLToPath(import.meta.url) === ejecutado
}

if (esEntryPoint()) {
  void main()
}
