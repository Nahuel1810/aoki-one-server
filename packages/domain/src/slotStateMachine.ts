// RF06 — Maquina de estados de slot de pickeo.
//
// LIBRE -> RESERVADO -> BUSCANDO -> OCUPADO -> DEVOLVIENDO -> LIBRE, mas ERROR
// para un slot realmente inutilizable. Las transiciones son una funcion total
// pura: el compilador obliga a cubrir cada par (estado, evento) y una transicion
// invalida devuelve error del dominio, nunca null ni un estado silencioso.

import { noImplementado } from './noImplementado.js'
import type { Result } from './result.js'

/**
 * Cajon apoyado en un slot de pickeo.
 *
 * Se lo encuentra por `ubicacionDeOrigen` normalizada a baseCode, no por `id`:
 * el id es sintetico (`ORDER:<orderId>` cuando el pedido no trae uno).
 */
export interface Cajon {
  readonly id: string
  /** baseCode de la ubicacion de guardado de la que salio, y a la que vuelve. */
  readonly ubicacionDeOrigen: string
}

/** Cajon en el slot junto a su refcount de devoluciones pendientes (RF07). */
export interface CajonEnSlot {
  readonly cajon: Cajon
  /**
   * Devoluciones pendientes. Arranca en 1 al ocupar el slot (1 = una unica
   * devolucion fisica pendiente), no en 0.
   */
  readonly pendingReturns: number
}

/**
 * Nombre de estado tal como se persiste y como lo lee el front.
 *
 * Los valores van en castellano a proposito: son los que hoy salen por la API y
 * los que RF06 nombra. El alias interno BLOCKED del legacy desaparece; el estado
 * se llama ERROR, que es lo que siempre se persistio.
 */
export type NombreEstadoSlot =
  | 'LIBRE'
  | 'RESERVADO'
  | 'BUSCANDO'
  | 'OCUPADO'
  | 'DEVOLVIENDO'
  | 'ERROR'

/** Sin reservar y sin cajon. Unico estado disponible para tomar un slot nuevo. */
export interface SlotLibre {
  readonly estado: 'LIBRE'
}

/**
 * Tomado por una orden, sin maniobra en curso.
 *
 * `contenido` distingue los dos caminos de RF11: si el slot estaba OCUPADO la
 * reserva de PUT PRESERVA el cajon (devolucion estandar, el destino sale de
 * `cajon.ubicacionDeOrigen`); si estaba LIBRE queda en null (devolucion manual
 * fuera-de-libros, donde el destino es obligatorio en el pedido).
 */
export interface SlotReservado {
  readonly estado: 'RESERVADO'
  readonly ordenId: string
  readonly contenido: CajonEnSlot | null
}

/** PICK en curso: el carro fue a buscar el cajon y todavia no lo dejo. */
export interface SlotBuscando {
  readonly estado: 'BUSCANDO'
  readonly ordenId: string
}

/** Con cajon apoyado, a la espera de que lo devuelvan. */
export interface SlotOcupado {
  readonly estado: 'OCUPADO'
  readonly contenido: CajonEnSlot
}

/** PUT en curso: el carro esta devolviendo el cajon a su ubicacion de origen. */
export interface SlotDevolviendo {
  readonly estado: 'DEVOLVIENDO'
  readonly ordenId: string
  readonly contenido: CajonEnSlot | null
}

/**
 * Slot inutilizable.
 *
 * RF13 acota el alcance: un paso que falla NO manda el slot aca (conserva
 * RESERVADO u OCUPADO esperando el retry). ERROR es para un slot que de verdad
 * no se puede usar.
 */
export interface SlotEnError {
  readonly estado: 'ERROR'
  readonly motivo: string
}

export type EstadoSlot =
  | SlotLibre
  | SlotReservado
  | SlotBuscando
  | SlotOcupado
  | SlotDevolviendo
  | SlotEnError

/**
 * Eventos que mueven la maquina.
 *
 * NO hay evento de "marcar inutilizable". Se verifico contra el mapeo: el unico
 * test que necesita un slot en ERROR es "deja PUT en espera si el slot esta
 * BLOQUEADO", y ese ERROR es el SETUP del test, no su resultado. Como `EstadoSlot`
 * es una union de datos, el fixture escribe `{ estado: 'ERROR', motivo }` directo
 * y lo persiste con `guardarEstado`: no necesita transicionar para llegar ahi. Del
 * otro lado, RF13 dice que un paso fallido CONSERVA el estado del slot, asi que el
 * `blockSlot` del legacy —el unico productor real del evento— desaparece y encima
 * no tiene test propio. Un evento sin ningun productor es superficie que despues
 * hay que sostener. El estado `ERROR` se queda; el evento entra con la task que
 * escriba el test de un slot realmente inutilizable.
 */
export type EventoSlot =
  /** LIBRE -> RESERVADO. Un PICK toma el slot destino. */
  | { readonly tipo: 'RESERVAR_PARA_PICK'; readonly ordenId: string }
  /**
   * LIBRE | OCUPADO -> RESERVADO. Un PUT toma el slot.
   * Desde LIBRE es la devolucion manual fuera-de-libros; desde OCUPADO es la
   * devolucion estandar y conserva el cajon. RESERVADO, BUSCANDO, DEVOLVIENDO y
   * ERROR rechazan.
   */
  | { readonly tipo: 'RESERVAR_PARA_PUT'; readonly ordenId: string }
  /** RESERVADO -> BUSCANDO. Arranco la maniobra de PICK. */
  | { readonly tipo: 'INICIAR_BUSQUEDA'; readonly ordenId: string }
  /** BUSCANDO -> OCUPADO. El cajon quedo apoyado; pendingReturns arranca en 1. */
  | { readonly tipo: 'OCUPAR'; readonly cajon: Cajon }
  /** RESERVADO -> DEVOLVIENDO. Arranco la maniobra de PUT. */
  | { readonly tipo: 'INICIAR_DEVOLUCION'; readonly ordenId: string }
  /** DEVOLVIENDO -> LIBRE, y tambien la liberacion manual desde la tablet. */
  | { readonly tipo: 'LIBERAR' }

export type NombreEventoSlot = EventoSlot['tipo']

/** Una transicion que la maquina no define. Es error del dominio, no null. */
export type ErrorTransicionSlot = {
  readonly codigo: 'TRANSICION_INVALIDA'
  readonly desde: NombreEstadoSlot
  readonly evento: NombreEventoSlot
}

/**
 * El slot pedido no existe en la zona de pickeo de ese robot.
 *
 * No lo produce `transicionarSlot` —que ya recibe el estado resuelto— sino quien
 * resuelve el slot por su baseCode antes de transicionarlo (el repositorio del
 * agente). Vive en el dominio porque es el otro rechazo que el llamador tiene que
 * poder distinguir.
 *
 * Los dos rechazos van SUELTOS, sin union que los envuelva: cada uno tiene un
 * productor declarado y uno solo —`transicionarSlot` emite `ErrorTransicionSlot`
 * y el repositorio del agente emite este—, y ninguna firma devuelve los dos a la
 * vez, asi que una union de ambos no la podria construir nadie. Lo que RF06 exige
 * igual se cumple: donde el legacy devuelve `null` en los tres rechazos de
 * `reserveSlotForPut` (RESERVADO, ERROR y slot inexistente) y el llamador no sabe
 * cual fue, aca son dos valores distinguibles por su `codigo`.
 */
export type SlotInexistente = {
  readonly codigo: 'SLOT_INEXISTENTE'
  /** baseCode pedido, sin sufijo de accion. */
  readonly locationCode: string
}

/**
 * Funcion total (estado, evento) -> estado | error.
 *
 * Pura y sin slot de por medio: el llamador ya resolvio de que slot habla, asi
 * que el unico error que puede emitir es `TRANSICION_INVALIDA`.
 */
export function transicionarSlot(
  estado: EstadoSlot,
  evento: EventoSlot,
): Result<EstadoSlot, ErrorTransicionSlot> {
  return noImplementado('transicionarSlot', { estado, evento })
}
