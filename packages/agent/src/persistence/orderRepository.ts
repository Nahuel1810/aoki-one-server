// RF23 y RF14 — Tabla `orders`.
//
// Indice unico `(site_id, external_order_id)`: el dedupe va por indice y nunca
// por scan lineal sobre el historico (RNF de rendimiento). Indice
// `(robot_id, status, created_at)` para resolver la cola sin traer todo a
// memoria.

import type { EstadoOrden, Result, TipoOrden } from '@aoki-one/domain'

import type { BaseDelAgente } from './database.js'

/**
 * De donde salio la orden.
 *
 * `PICKING` llega del servidor (RF28); `MANUAL` la crea el operario desde la
 * tablet y se admite sin enlace, con `externalOrderId` prefijado por agente para
 * no colisionar con los de picking (RF35).
 */
export type OrigenDeOrden = 'PICKING' | 'MANUAL'

/**
 * Orden tal como la persiste el agente.
 *
 * Los nombres en ingles son los que ya salen por la API y consume el front; no
 * se renombran para no romper el contrato.
 *
 * `priority` no esta: se elimina del modelo y lo reemplaza la regla
 * PICK-antes-que-PUT de RF09.
 */
export interface Orden {
  readonly id: string
  readonly siteId: string
  readonly robotId: string
  /** Clave de dedupe junto con `siteId`. Nunca mas restringido a entero. */
  readonly externalOrderId: string | null
  readonly tipo: TipoOrden
  readonly origen: OrigenDeOrden
  readonly estado: EstadoOrden
  /** Ubicacion de guardado del cajon. Se rechaza si trae sufijo de accion. */
  readonly locationCode: string
  readonly targetLocation: string | null
  readonly slotLocationCode: string | null
  /** 0 antes del primer paso, 5 cuando la orden termino. Es el canario de RF04. */
  readonly currentStepIndex: number
  readonly waitingForSlot: boolean
  readonly errorReason: string | null
  readonly creadaEn: number
  readonly iniciadaEn: number | null
  readonly finalizadaEn: number | null
}

/** Campos que el orquestador mueve. El resto es inmutable desde el alta. */
export interface CambiosDeOrden {
  readonly estado?: EstadoOrden
  readonly slotLocationCode?: string | null
  readonly targetLocation?: string | null
  readonly currentStepIndex?: number
  readonly waitingForSlot?: boolean
  readonly errorReason?: string | null
  readonly iniciadaEn?: number | null
  readonly finalizadaEn?: number | null
}

export interface FiltroDeOrdenes {
  readonly siteId?: string
  readonly robotId?: string
  readonly estados?: readonly EstadoOrden[]
}

export type ErrorDeOrden =
  /** Lo tira el indice unico, no una consulta previa: cierra la ventana de carrera. */
  | {
      readonly codigo: 'EXTERNAL_ORDER_ID_DUPLICADO'
      readonly siteId: string
      readonly externalOrderId: string
    }
  | { readonly codigo: 'ORDEN_INEXISTENTE'; readonly ordenId: string }

export interface OrderRepository {
  readonly crear: (orden: Orden) => Promise<Result<Orden, ErrorDeOrden>>
  readonly buscarPorId: (ordenId: string) => Promise<Orden | undefined>
  readonly buscarPorExternalOrderId: (
    siteId: string,
    externalOrderId: string,
  ) => Promise<Orden | undefined>
  readonly listar: (filtro: FiltroDeOrdenes) => Promise<readonly Orden[]>
  readonly actualizar: (
    ordenId: string,
    cambios: CambiosDeOrden,
  ) => Promise<Result<Orden, ErrorDeOrden>>
}

/**
 * Deja los cambios en la fila y devuelve la orden ya actualizada.
 *
 * Es SINCRONA y vive fuera del repositorio a proposito: asi el outbox la puede
 * componer dentro de su propia transaccion y escribir el estado de la orden y su
 * reporte de una sola vez (RF34). Con dos transacciones separadas, un corte en el
 * medio deja la orden terminada en la sucursal y PENDING para siempre en la app
 * de picking. `undefined` = no hay orden con ese id.
 */
export function aplicarCambiosDeOrden(
  base: BaseDelAgente,
  ordenId: string,
  cambios: CambiosDeOrden,
): Orden | undefined {
  const actual = buscarOrden(base, ordenId)
  if (actual === undefined) {
    return undefined
  }

  // Escritura incremental por entidad: se tocan solo los campos que cambian,
  // en vez del volcado del snapshot completo que hacia el legacy en cada paso.
  const siguiente: Orden = { ...actual, ...cambios }
  base.sql
    .prepare(
      `UPDATE orders SET
         estado = @estado,
         target_location = @targetLocation,
         slot_location_code = @slotLocationCode,
         current_step_index = @currentStepIndex,
         waiting_for_slot = @waitingForSlot,
         error_reason = @errorReason,
         iniciada_en = @iniciadaEn,
         finalizada_en = @finalizadaEn
       WHERE id = @id`,
    )
    .run({
      id: ordenId,
      estado: siguiente.estado,
      targetLocation: siguiente.targetLocation,
      slotLocationCode: siguiente.slotLocationCode,
      currentStepIndex: siguiente.currentStepIndex,
      waitingForSlot: siguiente.waitingForSlot ? 1 : 0,
      errorReason: siguiente.errorReason,
      iniciadaEn: siguiente.iniciadaEn,
      finalizadaEn: siguiente.finalizadaEn,
    })

  return siguiente
}

function aOrden(fila: FilaDeOrden): Orden {
  return {
    id: fila.id,
    siteId: fila.site_id,
    robotId: fila.robot_id,
    externalOrderId: fila.external_order_id,
    tipo: fila.tipo as Orden['tipo'],
    origen: fila.origen as OrigenDeOrden,
    estado: fila.estado as Orden['estado'],
    locationCode: fila.location_code,
    targetLocation: fila.target_location,
    slotLocationCode: fila.slot_location_code,
    currentStepIndex: fila.current_step_index,
    waitingForSlot: fila.waiting_for_slot === 1,
    errorReason: fila.error_reason,
    creadaEn: fila.creada_en,
    iniciadaEn: fila.iniciada_en,
    finalizadaEn: fila.finalizada_en,
  }
}

function buscarOrden(base: BaseDelAgente, ordenId: string): Orden | undefined {
  const fila = base.sql.prepare('SELECT * FROM orders WHERE id = ?').get(ordenId)
  return fila === undefined ? undefined : aOrden(fila as FilaDeOrden)
}

export function crearOrderRepository(base: BaseDelAgente): OrderRepository {
  const { sql } = base

  return {
    crear: (orden) => {
      try {
        sql
          .prepare(
            `INSERT INTO orders (
               id, site_id, robot_id, external_order_id, tipo, origen, estado,
               location_code, target_location, slot_location_code,
               current_step_index, waiting_for_slot, error_reason,
               creada_en, iniciada_en, finalizada_en
             ) VALUES (
               @id, @siteId, @robotId, @externalOrderId, @tipo, @origen, @estado,
               @locationCode, @targetLocation, @slotLocationCode,
               @currentStepIndex, @waitingForSlot, @errorReason,
               @creadaEn, @iniciadaEn, @finalizadaEn
             )`,
          )
          .run({
            ...orden,
            waitingForSlot: orden.waitingForSlot ? 1 : 0,
          })
        return Promise.resolve({ ok: true as const, valor: orden })
      } catch (error) {
        // El duplicado lo rechaza el indice unico, no un SELECT previo: asi no hay
        // ventana entre la consulta y la insercion.
        if (esViolacionDeUnicidad(error)) {
          return Promise.resolve({
            ok: false as const,
            error: {
              codigo: 'EXTERNAL_ORDER_ID_DUPLICADO' as const,
              siteId: orden.siteId,
              externalOrderId: orden.externalOrderId ?? '',
            },
          })
        }
        throw error
      }
    },

    buscarPorId: (ordenId) => Promise.resolve(buscarOrden(base, ordenId)),

    buscarPorExternalOrderId: (siteId, externalOrderId) => {
      const fila = sql
        .prepare('SELECT * FROM orders WHERE site_id = ? AND external_order_id = ?')
        .get(siteId, externalOrderId)
      return Promise.resolve(fila === undefined ? undefined : aOrden(fila as FilaDeOrden))
    },

    listar: (filtro) => {
      const condiciones: string[] = []
      const parametros: unknown[] = []

      if (filtro.siteId !== undefined) {
        condiciones.push('site_id = ?')
        parametros.push(filtro.siteId)
      }
      if (filtro.robotId !== undefined) {
        condiciones.push('robot_id = ?')
        parametros.push(filtro.robotId)
      }
      if (filtro.estados !== undefined && filtro.estados.length > 0) {
        condiciones.push(`estado IN (${filtro.estados.map(() => '?').join(', ')})`)
        parametros.push(...filtro.estados)
      }

      const donde = condiciones.length === 0 ? '' : ` WHERE ${condiciones.join(' AND ')}`
      const filas = sql
        .prepare(`SELECT * FROM orders${donde} ORDER BY creada_en, id`)
        .all(...parametros)

      return Promise.resolve(filas.map((f: unknown) => aOrden(f as FilaDeOrden)))
    },

    actualizar: (ordenId, cambios) => {
      const siguiente = aplicarCambiosDeOrden(base, ordenId, cambios)
      if (siguiente === undefined) {
        return Promise.resolve({
          ok: false as const,
          error: { codigo: 'ORDEN_INEXISTENTE' as const, ordenId },
        })
      }
      return Promise.resolve({ ok: true as const, valor: siguiente })
    },
  }
}

/** SQLite marca la violacion de indice unico con este codigo. */
function esViolacionDeUnicidad(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false
  }
  const codigo = (error as { code?: unknown }).code
  return typeof codigo === 'string' && codigo.startsWith('SQLITE_CONSTRAINT')
}

interface FilaDeOrden {
  readonly id: string
  readonly site_id: string
  readonly robot_id: string
  readonly external_order_id: string | null
  readonly tipo: string
  readonly origen: string
  readonly estado: string
  readonly location_code: string
  readonly target_location: string | null
  readonly slot_location_code: string | null
  readonly current_step_index: number
  readonly waiting_for_slot: number
  readonly error_reason: string | null
  readonly creada_en: number
  readonly iniciada_en: number | null
  readonly finalizada_en: number | null
}
