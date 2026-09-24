// RNF de Observabilidad — la correlacion por orden del lado del agente.
//
// "El pedido 47 se trabo" es lo que dice el operario, y a partir de ahi alguien
// tiene que poder seguir esa orden desde el alta en el servidor hasta el comando
// que salio al PLC. Para eso el log del agente tiene que llevar, en cada linea,
// los ids con los que se cruza con el log del otro lado:
//
//   - `ordenId`: el id en el libro del SERVIDOR. Es el mismo valor a los dos
//     lados, y por eso es LA clave de correlacion. En el agente sale del vinculo
//     `sync_ordenes.orden_id_remoto`, que se escribe al espejar una orden de
//     picking (RF33) o al empujar una local (RF35).
//   - `externalOrderId`: el numero que dice el operario. Tambien vive de los dos
//     lados, y es el unico por el que se puede empezar a buscar sin tener ya un
//     id interno en la mano.
//   - `ordenIdLocal`: el id del libro del AGENTE. No existe del otro lado, pero
//     sin el no se puede cruzar el log con `events`, `order_steps` ni `outbox`.
//
// Vive en `sync/` y no en `orchestrator/` porque el unico de los tres que hay
// que ir a buscar es el remoto, y el vinculo lo guarda el outbox.

import type { CorrelacionDeOrden, Logger } from '@aoki-one/domain'

import type { Orden } from '../persistence/orderRepository.js'
import type { DependenciasDelOrquestador } from '../orchestrator/ports.js'

/**
 * Arma la correlacion de una orden local.
 *
 * El `ordenId` remoto queda en `null` cuando todavia no hay contraparte: enlace
 * apagado (cutover), o una orden manual que nacio en la sucursal y que recien se
 * empuja al reconectar (RF35). Es informacion, no un hueco: dice que esa orden
 * todavia no existe en el libro del servidor.
 */
export async function correlacionDeOrden(
  dependencias: DependenciasDelOrquestador,
  orden: Orden,
): Promise<CorrelacionDeOrden> {
  return {
    siteId: dependencias.siteId,
    ordenId: await buscarVinculoSinRomper(dependencias, orden.id),
    ordenIdLocal: orden.id,
    externalOrderId: orden.externalOrderId,
  }
}

/**
 * El id remoto, o `null` si no se lo pudo leer.
 *
 * El outbox vive en la misma base que la orden, asi que puede reventar por lo
 * mismo que todo lo demas: disco lleno, SQLITE_BUSY, base cerrada por debajo.
 * Loguear es DIAGNOSTICO: que la maniobra en curso se caiga porque no se pudo
 * armar una linea de log invierte exactamente la relacion que tiene que haber
 * entre las dos cosas. Se pierde el id remoto de esa linea y nada mas; el local
 * y el externo, que son los que el operario tiene a mano, siguen estando.
 */
async function buscarVinculoSinRomper(
  dependencias: DependenciasDelOrquestador,
  ordenId: string,
): Promise<string | null> {
  try {
    return (await dependencias.outbox?.buscarVinculo(ordenId)) ?? null
  } catch {
    return null
  }
}

/** El logger de esa orden: todo lo que escriba sale ya correlacionado. */
export async function loggerDeOrden(
  dependencias: DependenciasDelOrquestador,
  orden: Orden,
): Promise<Logger> {
  return dependencias.logger.paraOrden(await correlacionDeOrden(dependencias, orden))
}
