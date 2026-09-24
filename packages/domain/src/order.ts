// Vocabulario de la orden y su maquina de estados.
//
// RF06 exige que una transicion invalida sea error del dominio y no un estado
// silencioso, y eso vale igual para la orden que para el slot: el legacy hace
// `updateOrder({ status })` como merge generico, o sea que acepta CUALQUIER
// salto (PENDING -> DONE directo incluido) sin que nadie se entere. Aca la
// transicion es una funcion total pura, al mismo nivel que `transicionarSlot`.

import type { Result } from './result.js'

/**
 * Tipo de orden.
 *
 * Es lo que decide la accion del comando de carro (un PICK trae, un PUT
 * devuelve) y la prioridad de servicio de la cola (RF09).
 */
export type TipoOrden = 'PICK' | 'PUT'

/**
 * Estado de una orden, con los valores que ya se persisten y salen por la API.
 *
 * `CANCELED` va con una sola L porque asi se escribe hoy en el contrato. Lo
 * produce `CANCELAR` (RF21): el boton de la tablet con el que el operario saca
 * de la cola un pedido que no va mas.
 */
export type EstadoOrden = 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'ERROR' | 'CANCELED'

/**
 * Eventos que mueven la orden.
 *
 * Solo estan los que ejercita algun test portado; el resto entra con la task que
 * escriba su test.
 */
export type EventoOrden =
  /** PENDING -> IN_PROGRESS. El robot tomo la orden y arranca la maniobra. */
  | { readonly tipo: 'INICIAR'; readonly robotId: string }
  /**
   * IN_PROGRESS -> DONE. Vale tanto para la orden que recorrio los cinco pasos
   * como para la que termina sin maniobra por el refcount de RF07.
   */
  | { readonly tipo: 'COMPLETAR' }
  /** IN_PROGRESS -> ERROR. `motivo` es el texto que ve el operario. */
  | { readonly tipo: 'FALLAR'; readonly motivo: string }
  /**
   * ERROR -> PENDING. El retry replaya la orden entera desde HOMING (RF13): se
   * vuelve a encolar con el indice de paso en cero y sin motivo de error.
   */
  | { readonly tipo: 'REINTENTAR' }
  /**
   * IN_PROGRESS -> PENDING. Rehidratacion tras reinicio (RF15): lo que estaba en
   * vuelo vuelve a la cola respetando su antiguedad.
   */
  | { readonly tipo: 'REHIDRATAR' }
  /**
   * PENDING -> CANCELED. El operario saca de la cola un pedido que no va mas
   * (RF21).
   *
   * SOLO desde PENDING, y es deliberado. Cancelar es sacar de la cola, no
   * abortar una maniobra: marcar cancelada una orden IN_PROGRESS no frena al
   * carro —el ciclo que la ejecuta esta adentro del handshake con el PLC y no
   * mira el estado— asi que dejaria el cajon a mitad de camino y los libros
   * diciendo que no hay nada en curso, que es la combinacion con la que el
   * proximo pedido choca contra un cajon que no esta donde el sistema cree.
   *
   * Las terminales tampoco: DONE y CANCELED ya salieron de la cola, y ERROR sale
   * por REINTENTAR, que es el camino que RF13 le da al operario.
   */
  | { readonly tipo: 'CANCELAR' }

export type NombreEventoOrden = EventoOrden['tipo']

/** Una transicion que la maquina no define. Es error del dominio, no un merge silencioso. */
export type ErrorTransicionOrden = {
  readonly codigo: 'TRANSICION_INVALIDA'
  readonly desde: EstadoOrden
  readonly evento: NombreEventoOrden
}

/**
 * Funcion total (estado, evento) -> estado | error.
 *
 * Pura y sin orden de por medio: el llamador ya resolvio de que orden habla y el
 * repositorio solo persiste el estado resultante.
 *
 * El caso negativo que fija el contrato es `PENDING` + `COMPLETAR`: saltar a DONE
 * sin pasar por IN_PROGRESS es exactamente lo que hoy se cuela por el merge.
 */
export function transicionarOrden(
  estado: EstadoOrden,
  evento: EventoOrden,
): Result<EstadoOrden, ErrorTransicionOrden> {
  const rechazo: Result<EstadoOrden, ErrorTransicionOrden> = {
    ok: false,
    error: { codigo: 'TRANSICION_INVALIDA', desde: estado, evento: evento.tipo },
  }

  switch (evento.tipo) {
    case 'INICIAR':
      return estado === 'PENDING' ? { ok: true, valor: 'IN_PROGRESS' } : rechazo

    case 'COMPLETAR':
      // PENDING -> DONE directo se rechaza: el legacy lo aceptaba en silencio.
      return estado === 'IN_PROGRESS' ? { ok: true, valor: 'DONE' } : rechazo

    case 'FALLAR':
      return estado === 'IN_PROGRESS' ? { ok: true, valor: 'ERROR' } : rechazo

    case 'REINTENTAR':
      // El retry replaya la orden completa desde HOMING (RF13).
      return estado === 'ERROR' ? { ok: true, valor: 'PENDING' } : rechazo

    case 'REHIDRATAR':
      // Tras un reinicio las IN_PROGRESS vuelven a PENDING y se reencolan (RF15).
      return estado === 'IN_PROGRESS' ? { ok: true, valor: 'PENDING' } : rechazo

    case 'CANCELAR':
      // Sacar de la cola algo que todavia no se toco. Una orden que el robot ya
      // esta ejecutando no se puede cancelar sin dejar el cajon a mitad de camino.
      return estado === 'PENDING' ? { ok: true, valor: 'CANCELED' } : rechazo
  }
}
