// Punto de entrada del servidor de pedidos.
//
// El servidor corre en un Linux propio y es el unico componente expuesto a
// internet: recibe los pedidos de la app de picking firmados con HMAC, mantiene
// la cola durable y se la entrega al agente de cada sucursal por long-poll.
//
// Este archivo es la capa mas fina posible: lee el entorno del proceso, delega
// en `arrancar` y traduce el resultado a senales y exit code. Todo lo que se
// puede afirmar en un test vive en `arranque.ts`.

import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { arrancar } from './arranque.js'
import { leerConfiguracion } from './configuracion.js'
import { crearLoggerDelServidor } from './registro.js'

// Superficie publica del paquete: el contrato de ingreso idempotente de pedidos
// (RF26), su puerto de persistencia y el despliegue del proceso (T37).
export * from './api/hmac.js'
export * from './api/httpServer.js'
export * from './api/ordersIngest.js'
export * from './arranque.js'
export * from './composition.js'
export * from './configuracion.js'
export * from './persistence/cifrado.js'
export * from './persistence/credentialsRepository.js'
export * from './persistence/database.js'
export * from './persistence/ordersRepository.js'
export * from './persistence/retencion.js'
export * from './persistence/sqliteOrdersRepository.js'
export * from './registro.js'

/** Nombre del paquete. Sirve para trazas y diagnosticos. */
export const PACKAGE_NAME_SERVER = '@aoki-one/server'

/**
 * Arranque del proceso.
 *
 * Con la configuracion rota NO deja el proceso a medias: loguea todo lo que hay
 * que corregir y termina con exit code 1, que es lo que systemd necesita para
 * marcar la unidad como fallida en vez de reiniciarla en un bucle silencioso.
 */
export async function main(): Promise<void> {
  // El nivel sale de la misma lectura que valida todo lo demas. Si la
  // configuracion esta rota se cae al default y el logger igual existe: los
  // errores de configuracion son justo los que no se pueden perder.
  const configuracion = leerConfiguracion(process.env)
  const logger = crearLoggerDelServidor({
    nivelMinimo: configuracion.ok ? configuracion.valor.nivelDeLog : 'INFO',
  })

  const proceso = await arrancar({ entorno: process.env, logger })

  if (!proceso.ok) {
    process.exitCode = 1
    return
  }

  // SIGTERM es la senal con la que systemd para la unidad, y SIGINT la del
  // Ctrl+C de quien lo prueba a mano. Las dos cierran igual: se deja de escuchar
  // y recien entonces se cierra la base, para no cortar una escritura a la
  // mitad. Sin esto el long-poll de 25 s se corta de cuajo en cada deploy.
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
