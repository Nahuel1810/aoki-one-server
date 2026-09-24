// T23 — Lectura de la base del robot en produccion.
//
// La base origen se abre EN SOLO LECTURA, y no por prolijidad: el cutover se
// hace con el sistema viejo todavia instalado y la unica garantia real de poder
// volver atras es que la migracion no pudo haberlo tocado. `readonly: true` hace
// que eso lo imponga SQLite y no la disciplina de quien escribio el script: ni
// un flag de "ya migrado", ni el `CREATE TABLE IF NOT EXISTS` que los stores
// viejos ejecutan al construirse. Por eso tampoco se reusa `SqliteEventStore`
// para leer: su constructor escribe.

import Database from 'better-sqlite3'

import type { Result } from '@aoki-one/domain'

export type ErrorDeOrigen =
  | { readonly codigo: 'NO_SE_PUDO_ABRIR'; readonly ruta: string; readonly detalle: string }
  | { readonly codigo: 'TABLA_AUSENTE'; readonly tabla: string }

export interface OrigenLegacy {
  /** El JSON del snapshot completo, tal cual esta guardado. `null` si no hay ninguno. */
  readonly leerSnapshot: () => Result<string | null, ErrorDeOrigen>
  /** Las filas de `order_metrics` sin interpretar: quien las valida es la migracion. */
  readonly leerMetricas: () => Result<readonly unknown[], ErrorDeOrigen>
  readonly cerrar: () => void
}

function existeTabla(sql: Database.Database, tabla: string): boolean {
  const fila = sql
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tabla)
  return fila !== undefined
}

export function abrirOrigenLegacy(ruta: string): Result<OrigenLegacy, ErrorDeOrigen> {
  let sql: Database.Database
  try {
    sql = new Database(ruta, { readonly: true, fileMustExist: true })
  } catch (error) {
    return {
      ok: false,
      error: {
        codigo: 'NO_SE_PUDO_ABRIR',
        ruta,
        // El caso frecuente es una base en WAL con el robot corriendo: un lector
        // de solo lectura necesita poder abrir el -shm. El mensaje de SQLite es
        // el que hay que leer, asi que se pasa tal cual.
        detalle: error instanceof Error ? error.message : String(error),
      },
    }
  }

  return {
    ok: true,
    valor: {
      leerSnapshot: () => {
        if (!existeTabla(sql, 'snapshots')) {
          return { ok: false, error: { codigo: 'TABLA_AUSENTE', tabla: 'snapshots' } }
        }
        const fila = sql.prepare('SELECT payload_json FROM snapshots WHERE id = 1').get()
        if (fila === undefined) {
          return { ok: true, valor: null }
        }
        const payload = (fila as { readonly payload_json: unknown }).payload_json
        return { ok: true, valor: typeof payload === 'string' ? payload : null }
      },

      leerMetricas: () => {
        if (!existeTabla(sql, 'order_metrics')) {
          return { ok: false, error: { codigo: 'TABLA_AUSENTE', tabla: 'order_metrics' } }
        }
        return {
          ok: true,
          valor: sql.prepare('SELECT * FROM order_metrics ORDER BY id').all(),
        }
      },

      cerrar: () => {
        sql.close()
      },
    },
  }
}

export function describirErrorDeOrigen(error: ErrorDeOrigen): string {
  switch (error.codigo) {
    case 'NO_SE_PUDO_ABRIR':
      return `no se pudo abrir la base origen ${error.ruta} en solo lectura: ${error.detalle}`
    case 'TABLA_AUSENTE':
      return `la base origen no tiene la tabla ${error.tabla}: no parece la base del robot.`
  }
}
