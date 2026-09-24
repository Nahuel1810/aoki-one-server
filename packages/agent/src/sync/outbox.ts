// RF34 — Outbox de transiciones de orden.
//
// Cada cambio de estado de una orden se encola aca antes de intentar reportarlo.
// Si el enlace esta caido se acumula; al reconectar se drena en orden y con
// reintento idempotente. Ningun cambio de estado se pierde por una caida de red,
// que es la unica razon por la que existe una cola en vez de un POST directo.
//
// La `seq` es lo que el servidor usa para descartar repetidos y viejos
// (`aplicarTransicion` en packages/server/src/persistence/sqliteOrdersRepository.ts:
// descarta seq repetida y seq menor que la maxima ya aplicada). Por eso se
// asigna monotona POR ORDEN y en la misma transaccion que el encolado: dos
// transiciones concurrentes de la misma orden no pueden sacar la misma seq ni
// salir invertidas.
//
// El encolado tambien sabe escribir el ESTADO de la orden, en la misma
// transaccion (`encolarConEstadoDeOrden`). Separados eran dos transacciones: un
// corte entre las dos dejaba la orden terminada en la sucursal y PENDING para
// siempre en la app de picking, sin nadie que lo recuperara.

import type { EstadoOrden, Result } from '@aoki-one/domain'

import type { BaseDelAgente } from '../persistence/database.js'
import {
  aplicarCambiosDeOrden,
  type CambiosDeOrden,
  type ErrorDeOrden,
  type Orden,
} from '../persistence/orderRepository.js'

export interface AltaDeTransicion {
  readonly ordenId: string
  readonly estado: EstadoOrden
  readonly metadata: Readonly<Record<string, unknown>>
  readonly creadaEn: number
}

export interface TransicionPendiente {
  /** Autoincremental: es el orden de encolado, y con eso el orden de drenado. */
  readonly id: number
  readonly ordenId: string
  readonly seq: number
  readonly estado: EstadoOrden
  readonly metadata: Readonly<Record<string, unknown>>
  readonly creadaEn: number
  readonly intentos: number
}

/** Lo que quedo escrito cuando el estado y su reporte van juntos. */
export interface EstadoYTransicion {
  readonly orden: Orden
  readonly transicion: TransicionPendiente
}

/**
 * La cola de salida del agente.
 *
 * El puerto vive separado de su implementacion SQLite para que el orquestador
 * pueda encolar con un doble y para que el enlace se pueda ejercitar sin base.
 */
export interface OutboxDeTransiciones {
  /** Encola una transicion y le asigna la proxima `seq` de esa orden. */
  readonly encolar: (alta: AltaDeTransicion) => Promise<TransicionPendiente>
  /**
   * Deja el nuevo estado de la orden y encola su reporte en UNA sola transaccion.
   *
   * Es el camino normal de toda transicion que nace de un cambio de estado: o
   * quedan las dos escrituras o no queda ninguna. `ORDEN_INEXISTENTE` cuando no
   * hay orden local con ese id, y ahi tampoco se encola nada.
   */
  readonly encolarConEstadoDeOrden: (
    alta: AltaDeTransicion,
    cambios: CambiosDeOrden,
  ) => Promise<Result<EstadoYTransicion, ErrorDeOrden>>
  /**
   * Mira las primeras `limite` pendientes, en orden de encolado, SIN tocarlas.
   *
   * Es lectura de diagnostico: es lo que el servidor todavia no sabe. El drenado
   * no la usa, porque leer sin reservar es justo lo que deja que dos drenados se
   * lleven las mismas filas.
   */
  readonly proximas: (limite: number) => Promise<readonly TransicionPendiente[]>
  /**
   * Toma las primeras `limite` que no tenga ya otro drenado, en orden de
   * encolado, y las RESERVA.
   *
   * Reservarlas es lo que impide que dos drenados solapados reporten las mismas
   * filas y le manden al servidor la misma seq dos veces, o peor, fuera de orden.
   * Lo que se toma y no se reporta se devuelve con `soltar`.
   */
  readonly reservarProximas: (limite: number) => Promise<readonly TransicionPendiente[]>
  /** Devuelve a la cola filas reservadas que el drenado no llego a reportar. */
  readonly soltar: (ids: readonly number[]) => Promise<void>
  /**
   * Saca la transicion de la cola.
   *
   * Tambien se llama cuando el servidor la DESCARTA: descartada significa que ya
   * estaba aplicada, o sea exito. Tratarla como error dejaria al outbox
   * reintentando la misma fila para siempre y bloqueando las que vienen atras.
   */
  readonly confirmar: (id: number) => Promise<void>
  /** Deja la fila en la cola con el motivo del ultimo fallo, para diagnostico. */
  readonly registrarIntentoFallido: (id: number, motivo: string) => Promise<void>
  /**
   * Saca la fila de la cola y la archiva en la cola muerta.
   *
   * Es para la transicion que el servidor rechaza de una forma que reintentar no
   * arregla. Se archiva y no se borra: es un cambio de estado que la app de
   * picking no va a ver nunca y alguien tiene que poder reconstruir cual fue.
   */
  readonly darPorMuerta: (id: number, motivo: string, muertaEn: number) => Promise<void>
  /** Tamaño de la cola. Es lo que `/health` publica como `outboxSize` (RF36). */
  readonly pendientes: () => Promise<number>
  /** Si esa orden todavia tiene algun reporte sin confirmar. */
  readonly tienePendientes: (ordenId: string) => Promise<boolean>
  /** Asocia la orden local con el id que le da el servidor (RF33, RF35). */
  readonly vincular: (ordenId: string, ordenIdRemoto: string) => Promise<void>
  /** El id remoto de la orden, o null si todavia no se la empujo al servidor. */
  readonly buscarVinculo: (ordenId: string) => Promise<string | null>
}

interface FilaDeOutbox {
  readonly id: number
  readonly orden_id: string
  readonly seq: number
  readonly payload_json: string
  readonly creada_en: number
  readonly intentos: number
}

/** Lo que se serializa en `payload_json`. */
interface CargaDeTransicion {
  readonly estado: EstadoOrden
  readonly metadata: Record<string, unknown>
}

/**
 * Convierte el throw SINCRONO de SQLite en un rechazo.
 *
 * better-sqlite3 es sincrono: un disco lleno o una restriccion violada revientan
 * antes de que exista la promesa. El puerto promete una promesa, y el que llama
 * escribio un `try` alrededor del `await`: si el error saliera de forma sincrona,
 * ese `try` seguiria funcionando pero un `.catch()` no, y el tipo estaria
 * mintiendo.
 */
function comoPromesa<T>(operacion: () => T): Promise<T> {
  try {
    return Promise.resolve(operacion())
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

export function crearOutboxSqlite(base: BaseDelAgente): OutboxDeTransiciones {
  const { sql } = base

  // Lo que quedo marcado como en vuelo es de una corrida anterior: este proceso
  // es el unico dueño de la base, asi que si hay filas reservadas es porque el
  // agente se murio con un drenado a medias. Sin esto esas filas no se
  // reportarian nunca mas.
  sql.prepare('UPDATE outbox SET en_vuelo = 0 WHERE en_vuelo = 1').run()

  function aTransicion(fila: FilaDeOutbox): TransicionPendiente {
    const carga = JSON.parse(fila.payload_json) as CargaDeTransicion
    return {
      id: fila.id,
      ordenId: fila.orden_id,
      seq: fila.seq,
      estado: carga.estado,
      metadata: carga.metadata,
      creadaEn: fila.creada_en,
      intentos: fila.intentos,
    }
  }

  /**
   * El encolado propiamente dicho, sin transaccion propia.
   *
   * Se separa para poder componerlo dentro de la transaccion que tambien escribe
   * el estado de la orden.
   */
  function insertarTransicion(alta: AltaDeTransicion): TransicionPendiente {
    // La seq se reserva y se usa dentro de la misma transaccion: si se leyera y
    // despues se insertara, dos transiciones simultaneas de la misma orden
    // podrian llevarse el mismo numero y el servidor descartaria una de las dos.
    const reservada = sql
      .prepare(
        `INSERT INTO sync_ordenes (orden_id, ultima_seq) VALUES (?, 1)
         ON CONFLICT(orden_id) DO UPDATE SET ultima_seq = ultima_seq + 1
         RETURNING ultima_seq`,
      )
      .get(alta.ordenId) as { ultima_seq: number } | undefined
    if (reservada === undefined) {
      throw new Error('no se pudo reservar la seq de la transicion')
    }

    const carga: CargaDeTransicion = { estado: alta.estado, metadata: { ...alta.metadata } }
    const insertada = sql
      .prepare(
        `INSERT INTO outbox (orden_id, seq, payload_json, creada_en, intentos, en_vuelo)
         VALUES (?, ?, ?, ?, 0, 0)
         RETURNING id`,
      )
      .get(alta.ordenId, reservada.ultima_seq, JSON.stringify(carga), alta.creadaEn) as
      | { id: number }
      | undefined
    if (insertada === undefined) {
      throw new Error('no se pudo encolar la transicion')
    }

    return {
      id: insertada.id,
      ordenId: alta.ordenId,
      seq: reservada.ultima_seq,
      estado: alta.estado,
      metadata: carga.metadata,
      creadaEn: alta.creadaEn,
      intentos: 0,
    }
  }

  const encolar = sql.transaction(insertarTransicion)

  const encolarConEstadoDeOrden = sql.transaction(
    (alta: AltaDeTransicion, cambios: CambiosDeOrden): Result<EstadoYTransicion, ErrorDeOrden> => {
      const orden = aplicarCambiosDeOrden(base, alta.ordenId, cambios)
      if (orden === undefined) {
        // Nada escrito todavia: la transaccion cierra sin cambios.
        return { ok: false, error: { codigo: 'ORDEN_INEXISTENTE', ordenId: alta.ordenId } }
      }
      return { ok: true, valor: { orden, transicion: insertarTransicion(alta) } }
    },
  )

  const reservarProximas = sql.transaction((limite: number): FilaDeOutbox[] => {
    const filas = sql
      .prepare('SELECT * FROM outbox WHERE en_vuelo = 0 ORDER BY id LIMIT ?')
      .all(limite) as FilaDeOutbox[]
    const marcar = sql.prepare('UPDATE outbox SET en_vuelo = 1 WHERE id = ?')
    for (const fila of filas) {
      marcar.run(fila.id)
    }
    return filas
  })

  const soltar = sql.transaction((ids: readonly number[]): void => {
    const liberar = sql.prepare('UPDATE outbox SET en_vuelo = 0 WHERE id = ?')
    for (const id of ids) {
      liberar.run(id)
    }
  })

  const darPorMuerta = sql.transaction((id: number, motivo: string, muertaEn: number): void => {
    sql
      .prepare(
        `INSERT INTO outbox_muertas (
           id, orden_id, seq, payload_json, creada_en, intentos, ultimo_error, muerta_en
         )
         SELECT id, orden_id, seq, payload_json, creada_en, intentos, ?, ?
         FROM outbox WHERE id = ?`,
      )
      .run(motivo, muertaEn, id)
    sql.prepare('DELETE FROM outbox WHERE id = ?').run(id)
  })

  return {
    encolar: (alta) => comoPromesa(() => encolar(alta)),

    encolarConEstadoDeOrden: (alta, cambios) =>
      comoPromesa(() => encolarConEstadoDeOrden(alta, cambios)),

    proximas: (limite) =>
      comoPromesa(() => {
        const filas = sql
          .prepare('SELECT * FROM outbox ORDER BY id LIMIT ?')
          .all(limite) as FilaDeOutbox[]
        return filas.map(aTransicion)
      }),

    reservarProximas: (limite) => comoPromesa(() => reservarProximas(limite).map(aTransicion)),

    soltar: (ids) =>
      comoPromesa(() => {
        soltar(ids)
      }),

    confirmar: (id) => {
      sql.prepare('DELETE FROM outbox WHERE id = ?').run(id)
      return Promise.resolve()
    },

    registrarIntentoFallido: (id, motivo) => {
      // La reserva se suelta junto con el intento fallido: la fila vuelve a la
      // cola para que el proximo drenado la tome desde el principio.
      sql
        .prepare(
          `UPDATE outbox SET intentos = intentos + 1, ultimo_error = ?, en_vuelo = 0
           WHERE id = ?`,
        )
        .run(motivo, id)
      return Promise.resolve()
    },

    darPorMuerta: (id, motivo, muertaEn) =>
      comoPromesa(() => {
        darPorMuerta(id, motivo, muertaEn)
      }),

    pendientes: () => {
      const fila = sql.prepare('SELECT COUNT(*) AS total FROM outbox').get() as
        | { total?: number }
        | undefined
      return Promise.resolve(fila?.total ?? 0)
    },

    tienePendientes: (ordenId) => {
      const fila = sql.prepare('SELECT 1 AS hay FROM outbox WHERE orden_id = ? LIMIT 1').get(ordenId)
      return Promise.resolve(fila !== undefined)
    },

    vincular: (ordenId, ordenIdRemoto) => {
      sql
        .prepare(
          `INSERT INTO sync_ordenes (orden_id, orden_id_remoto, ultima_seq) VALUES (?, ?, 0)
           ON CONFLICT(orden_id) DO UPDATE SET orden_id_remoto = excluded.orden_id_remoto`,
        )
        .run(ordenId, ordenIdRemoto)
      return Promise.resolve()
    },

    buscarVinculo: (ordenId) => {
      const fila = sql
        .prepare('SELECT orden_id_remoto FROM sync_ordenes WHERE orden_id = ?')
        .get(ordenId) as { orden_id_remoto: string | null } | undefined
      return Promise.resolve(fila?.orden_id_remoto ?? null)
    },
  }
}
