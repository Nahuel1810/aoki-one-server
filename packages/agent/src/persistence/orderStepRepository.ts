// RF23 y RF24 — Tabla `order_steps`.
//
// Cada comando mandado al PLC queda registrado correlacionado a su orden y a su
// numero de paso, y se lee por consulta indexada. Reemplaza al array `commands`
// del snapshot en memoria, que obligaba a serializar el estado completo en cada
// paso.

import type { Result, SeqPaso, TipoDispositivo, TipoPaso } from '@aoki-one/domain'

import type { BaseDelAgente } from './database.js'

/** Un paso nace en SENT (mandado al PLC) y cierra en DONE o en ERROR. */
export type EstadoDePaso = 'SENT' | 'DONE' | 'ERROR'

export interface PasoPersistido {
  readonly ordenId: string
  readonly seq: SeqPaso
  readonly tipo: TipoPaso
  readonly dispositivo: TipoDispositivo
  readonly estado: EstadoDePaso
  /** Intentos consumidos. `maxIntentos` son intentos TOTALES, no adicionales. */
  readonly intentos: number
  readonly iniciadoEn: number
  readonly finalizadoEn: number | null
}

export interface CambiosDePaso {
  readonly estado?: EstadoDePaso
  readonly intentos?: number
  readonly finalizadoEn?: number | null
}

export type ErrorDePaso = {
  readonly codigo: 'PASO_INEXISTENTE'
  readonly ordenId: string
  readonly seq: SeqPaso
}

export interface OrderStepRepository {
  readonly registrar: (paso: PasoPersistido) => Promise<PasoPersistido>
  readonly actualizar: (
    ordenId: string,
    seq: SeqPaso,
    cambios: CambiosDePaso,
  ) => Promise<Result<PasoPersistido, ErrorDePaso>>
  /** Los pasos de la orden, en orden de `seq`. */
  readonly listarPorOrden: (ordenId: string) => Promise<readonly PasoPersistido[]>
}

export function crearOrderStepRepository(base: BaseDelAgente): OrderStepRepository {
  const { sql } = base

  function aFila(fila: FilaDePaso): PasoPersistido {
    return {
      ordenId: fila.orden_id,
      seq: fila.seq as SeqPaso,
      tipo: fila.tipo as TipoPaso,
      dispositivo: fila.dispositivo as TipoDispositivo,
      estado: fila.estado as EstadoDePaso,
      intentos: fila.intentos,
      iniciadoEn: fila.iniciado_en,
      finalizadoEn: fila.finalizado_en,
    }
  }

  return {
    registrar: (paso) => {
      sql
        .prepare(
          `INSERT INTO order_steps (orden_id, seq, tipo, dispositivo, estado, intentos, iniciado_en, finalizado_en)
           VALUES (@ordenId, @seq, @tipo, @dispositivo, @estado, @intentos, @iniciadoEn, @finalizadoEn)
           ON CONFLICT(orden_id, seq) DO UPDATE SET
             tipo = excluded.tipo,
             dispositivo = excluded.dispositivo,
             estado = excluded.estado,
             intentos = excluded.intentos,
             iniciado_en = excluded.iniciado_en,
             finalizado_en = excluded.finalizado_en`,
        )
        .run({ ...paso })
      return Promise.resolve(paso)
    },

    actualizar: (ordenId, seq, cambios) => {
      const fila = sql
        .prepare('SELECT * FROM order_steps WHERE orden_id = ? AND seq = ?')
        .get(ordenId, seq)
      if (fila === undefined) {
        return Promise.resolve({
          ok: false as const,
          error: { codigo: 'PASO_INEXISTENTE' as const, ordenId, seq },
        })
      }

      const siguiente: PasoPersistido = { ...aFila(fila as FilaDePaso), ...cambios }
      sql
        .prepare(
          'UPDATE order_steps SET estado = ?, intentos = ?, finalizado_en = ? WHERE orden_id = ? AND seq = ?',
        )
        .run(siguiente.estado, siguiente.intentos, siguiente.finalizadoEn, ordenId, seq)

      return Promise.resolve({ ok: true as const, valor: siguiente })
    },

    listarPorOrden: (ordenId) =>
      Promise.resolve(
        sql
          .prepare('SELECT * FROM order_steps WHERE orden_id = ? ORDER BY seq')
          .all(ordenId)
          .map((f: unknown) => aFila(f as FilaDePaso)),
      ),
  }
}

interface FilaDePaso {
  readonly orden_id: string
  readonly seq: number
  readonly tipo: string
  readonly dispositivo: string
  readonly estado: string
  readonly intentos: number
  readonly iniciado_en: number
  readonly finalizado_en: number | null
}
