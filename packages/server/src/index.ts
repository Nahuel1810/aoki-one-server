// Punto de entrada del servidor de pedidos.
//
// El servidor corre en un Linux propio y es el unico componente expuesto a
// internet: recibe los pedidos de la app de picking firmados con HMAC, mantiene
// la cola durable y se la entrega al agente de cada sucursal por long-poll.
//
// En T01 esto es solo andamiaje. La API, la cola y la persistencia entran en
// las tasks que las necesiten.

import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { PACKAGE_NAME } from '@aoki-one/domain'

// Superficie publica del paquete: el contrato de ingreso idempotente de pedidos
// (RF26) y su puerto de persistencia. Es lo unico declarado en esta fase.
export * from './api/hmac.js'
export * from './api/httpServer.js'
export * from './api/ordersIngest.js'
export * from './composition.js'
export * from './persistence/cifrado.js'
export * from './persistence/credentialsRepository.js'
export * from './persistence/database.js'
export * from './persistence/ordersRepository.js'
export * from './persistence/sqliteOrdersRepository.js'

/** Nombre del paquete. Sirve para trazas y diagnosticos. */
export const PACKAGE_NAME_SERVER = '@aoki-one/server'

/**
 * Arranque del servidor.
 *
 * Por ahora solo deja constancia de que el proceso levanto y de que el enlace
 * de compilacion contra el dominio resuelve de punta a punta.
 */
export function main(): void {
  // Log crudo a proposito: el logger estructurado llega junto con la API.
  console.log(`[${PACKAGE_NAME_SERVER}] servidor iniciado (dominio: ${PACKAGE_NAME})`)
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
  main()
}
