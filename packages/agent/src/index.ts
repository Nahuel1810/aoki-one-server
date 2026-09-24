// Punto de entrada del agente de sucursal.
//
// El agente corre en la notebook de la LAN de la sucursal: es dueño del lazo de
// control Modbus contra los PLCs, expone la API HTTP solo hacia la LAN y habla
// con el servidor Linux por long-poll saliente.
//
// En T01 esto es solo andamiaje. El cableado real (orchestrator, transport,
// sync, persistence y api) entra en las tasks que lo necesiten.

import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { PACKAGE_NAME } from '@aoki-one/domain'

/** Nombre del paquete. Sirve para trazas y diagnosticos. */
export const PACKAGE_NAME_AGENT = '@aoki-one/agent'

/**
 * Arranque del agente.
 *
 * Por ahora solo deja constancia de que el proceso levanto y de que el enlace
 * de compilacion contra el dominio resuelve de punta a punta.
 */
export function main(): void {
  // Log crudo a proposito: el logger estructurado del agente llega en T21.
  console.log(`[${PACKAGE_NAME_AGENT}] agente iniciado (dominio: ${PACKAGE_NAME})`)
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
