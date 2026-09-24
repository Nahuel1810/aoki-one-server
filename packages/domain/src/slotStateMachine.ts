// RF06 — Maquina de estados de slot de pickeo.
//
// LIBRE -> RESERVADO -> BUSCANDO -> OCUPADO -> DEVOLVIENDO -> LIBRE, mas ERROR
// para un slot realmente inutilizable. Las transiciones son una funcion total
// pura: el compilador obliga a cubrir cada par (estado, evento) y una transicion
// invalida devuelve error del dominio, nunca null ni un estado silencioso.

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
  /** DEVOLVIENDO | OCUPADO -> LIBRE. Es el cierre normal de la maniobra. */
  | { readonly tipo: 'LIBERAR' }
  /**
   * CUALQUIER estado -> LIBRE. Es la salida del operario, y es TOTAL a proposito.
   *
   * Portado de `StateManager.releaseSlot`, que libera sin mirar el estado: es lo
   * que hoy sostiene la planta cuando un PICK falla de una forma que el retry no
   * arregla —cajon trabado, PLC en falla— y el slot queda en RESERVADO o
   * BUSCANDO para siempre. Sin esta salida, cada fallo de ese tipo se come uno
   * de los doce slots de la zona y la unica correccion es editar SQLite a mano.
   *
   * Que la transicion sea total NO la vuelve segura por si sola: liberar el slot
   * de una orden que el robot esta ejecutando AHORA deja el cajon a mitad de
   * camino y los libros diciendo que el slot esta vacio. Esa guarda es del
   * llamador, que es el unico que sabe en que estado esta la ORDEN (la API
   * rechaza la liberacion cuando la orden que retiene el slot esta IN_PROGRESS);
   * el dominio no la puede hacer porque no conoce la orden, solo su id.
   */
  /**
   * Salida del operario: corrige los libros sin mover el robot.
   *
   * `slotVacioConfirmado` es la DECLARACION de que el slot ya no tiene cajon
   * encima. No es ceremonia: si el slot tiene un cajon en libros y se lo libera
   * sin mirar, los libros pasan a decir LIBRE mientras el cajon sigue apoyado, y
   * el proximo PICK manda el carro a ese mismo slot y empuja el cajon viejo con
   * el nuevo. Eso ya paso en planta por el fallback de PUT (ver RF11), y esta es
   * la otra puerta al mismo choque.
   */
  | { readonly tipo: 'LIBERAR_MANUAL'; readonly slotVacioConfirmado: boolean }

export type NombreEventoSlot = EventoSlot['tipo']


/**
 * Se quiso liberar un slot que en libros todavia tiene un cajon, sin declarar
 * que se lo saco fisicamente.
 *
 * No es una transicion indefinida —LIBERAR_MANUAL vale desde cualquier estado—
 * sino una que exige mirar el slot antes. Por eso tiene codigo propio: el
 * llamador tiene que poder decirle a la persona QUE cajon hay y de donde salio,
 * no un "transicion invalida" que no se puede accionar.
 */
export type SlotConCajonEnLibros = {
  readonly codigo: 'SLOT_CON_CAJON_EN_LIBROS'
  readonly desde: NombreEstadoSlot
  /** baseCode del que salio el cajon, para que la persona sepa que esta mirando. */
  readonly ubicacionDeOrigen: string
}

/** Una transicion que la maquina no define. Es error del dominio, no null. */
export type TransicionInvalida = {
  readonly codigo: 'TRANSICION_INVALIDA'
  readonly desde: NombreEstadoSlot
  readonly evento: NombreEventoSlot
}

/**
 * Por que `transicionarSlot` puede rechazar.
 *
 * Los dos van juntos —y no `SlotConCajonEnLibros` suelto— porque los emite la
 * MISMA funcion: separarlos obligaria a cada llamador que solo propaga el error
 * a nombrar un rechazo que su evento no puede producir. Se distinguen por
 * `codigo`, y `desde` esta en los dos.
 */
export type ErrorTransicionSlot = TransicionInvalida | SlotConCajonEnLibros

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
 * El cajon que el slot tiene EN LIBROS, o null si no tiene ninguno.
 *
 * OCUPADO siempre sostiene uno; RESERVADO y DEVOLVIENDO pueden sostenerlo o no
 * (RF11: la devolucion estandar preserva el cajon, la manual fuera-de-libros
 * arranca en null). LIBRE, BUSCANDO y ERROR nunca. Que sea una funcion y no un
 * `in` suelto es a proposito: agregar un estado con contenido obliga a pasar por
 * aca.
 */
export function cajonEnLibros(estado: EstadoSlot): CajonEnSlot | null {
  switch (estado.estado) {
    case 'OCUPADO':
      return estado.contenido
    case 'RESERVADO':
    case 'DEVOLVIENDO':
      return estado.contenido
    case 'LIBRE':
    case 'BUSCANDO':
    case 'ERROR':
      return null
  }
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
  const rechazo: Result<EstadoSlot, TransicionInvalida> = {
    ok: false,
    error: { codigo: 'TRANSICION_INVALIDA', desde: estado.estado, evento: evento.tipo },
  }

  switch (evento.tipo) {
    case 'RESERVAR_PARA_PICK':
      // Solo desde LIBRE: la reserva es exclusiva y una segunda reserva se rechaza.
      return estado.estado === 'LIBRE'
        ? { ok: true, valor: { estado: 'RESERVADO', ordenId: evento.ordenId, contenido: null } }
        : rechazo

    case 'RESERVAR_PARA_PUT':
      // Desde LIBRE es la devolucion manual fuera-de-libros; desde OCUPADO es la
      // estandar y CONSERVA el cajon con su ubicacion de origen, que es de donde
      // sale el destino de la devolucion (RF11).
      if (estado.estado === 'LIBRE') {
        return { ok: true, valor: { estado: 'RESERVADO', ordenId: evento.ordenId, contenido: null } }
      }
      if (estado.estado === 'OCUPADO') {
        return {
          ok: true,
          valor: { estado: 'RESERVADO', ordenId: evento.ordenId, contenido: estado.contenido },
        }
      }
      return rechazo

    case 'INICIAR_BUSQUEDA':
      return estado.estado === 'RESERVADO'
        ? { ok: true, valor: { estado: 'BUSCANDO', ordenId: evento.ordenId } }
        : rechazo

    case 'OCUPAR':
      // El cajon recien apoyado arranca con una devolucion pendiente (RF07).
      return estado.estado === 'BUSCANDO'
        ? {
            ok: true,
            valor: { estado: 'OCUPADO', contenido: { cajon: evento.cajon, pendingReturns: 1 } },
          }
        : rechazo

    case 'INICIAR_DEVOLUCION':
      return estado.estado === 'RESERVADO'
        ? {
            ok: true,
            valor: { estado: 'DEVOLVIENDO', ordenId: evento.ordenId, contenido: estado.contenido },
          }
        : rechazo

    case 'LIBERAR':
      // Cierre de la devolucion, y tambien la liberacion de un slot ocupado:
      // corrige los libros sin mover el robot.
      return estado.estado === 'DEVOLVIENDO' || estado.estado === 'OCUPADO'
        ? { ok: true, valor: { estado: 'LIBRE' } }
        : rechazo

    case 'LIBERAR_MANUAL': {
      // Desde CUALQUIER estado: es la salida del operario cuando la maniobra no
      // va a volver (ver `EventoSlot`), y bloquearla dejaria el slot muerto hasta
      // que alguien edite SQLite a mano.
      //
      // Pero si el slot tiene un cajon EN LIBROS, liberarlo lo borra del
      // inventario. Eso solo es cierto si alguien fue y lo saco: si no, los
      // libros dicen LIBRE con el cajon todavia apoyado y el proximo PICK lo
      // choca. Entonces se pide la declaracion explicita; sin ella, se rechaza
      // diciendo QUE cajon hay para que la persona lo vaya a mirar.
      const cajon = cajonEnLibros(estado)
      if (cajon !== null && !evento.slotVacioConfirmado) {
        return {
          ok: false,
          error: {
            codigo: 'SLOT_CON_CAJON_EN_LIBROS',
            desde: estado.estado,
            ubicacionDeOrigen: cajon.cajon.ubicacionDeOrigen,
          },
        }
      }
      return { ok: true, valor: { estado: 'LIBRE' } }
    }
  }
}
