// RF23 — Tabla `events`.
//
// Un fallo de paso, una reserva de slot o una liberacion manual quedan
// registrados asociados a su entidad y son consultables. Reemplaza al array
// `errors` del snapshot.
//
// El id y el timestamp NO se generan adentro: se inyectan (el dominio y la
// persistencia no llaman a `randomUUID` ni a `Date.now()`), y persistir es una
// responsabilidad distinta de loguear.


import type { BaseDelAgente } from './database.js'

/**
 * Entidad a la que se asocia un evento.
 *
 * No esta `DEVICE`: ningun test portado registra un evento de dispositivo, y una
 * variante que nadie puede producir es superficie que despues hay que sostener.
 * Entra con la task que la necesite.
 */
export type TipoDeEntidad = 'ORDER' | 'SLOT' | 'ROBOT'

export type SeveridadDeEvento = 'INFO' | 'ERROR'

export interface Evento {
  readonly id: string
  readonly ts: number
  readonly tipoDeEntidad: TipoDeEntidad
  readonly entidadId: string
  /** Nombre del evento, por ejemplo `SLOT_RESERVED` o `STEP_FAILED`. */
  readonly evento: string
  readonly severidad: SeveridadDeEvento
  readonly metadata: Readonly<Record<string, unknown>>
}

/**
 * Filtro de consulta.
 *
 * Sin rango de fechas: `desdeMs` / `hastaMs` son el reporte filtrable por rango
 * de RF24, que figura entero en "RF sin cobertura" del mapeo. Entra con su test.
 */
export interface FiltroDeEventos {
  readonly tipoDeEntidad?: TipoDeEntidad
  readonly entidadId?: string
}

export interface EventRepository {
  readonly registrar: (evento: Evento) => Promise<Evento>
  /** Del mas nuevo al mas viejo. */
  readonly listar: (filtro: FiltroDeEventos) => Promise<readonly Evento[]>
}

export function crearEventRepository(base: BaseDelAgente): EventRepository {
  const { sql } = base

  function aFila(fila: FilaDeEvento): Evento {
    return {
      id: fila.id,
      ts: fila.ts,
      tipoDeEntidad: fila.tipo_entidad as TipoDeEntidad,
      entidadId: fila.entidad_id,
      evento: fila.evento,
      severidad: fila.severidad as SeveridadDeEvento,
      metadata: JSON.parse(fila.metadata_json) as Readonly<Record<string, unknown>>,
    }
  }

  return {
    registrar: (evento) => {
      sql
        .prepare(
          `INSERT INTO events (id, ts, tipo_entidad, entidad_id, evento, severidad, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          evento.id,
          evento.ts,
          evento.tipoDeEntidad,
          evento.entidadId,
          evento.evento,
          evento.severidad,
          JSON.stringify(evento.metadata),
        )
      return Promise.resolve(evento)
    },

    listar: (filtro) => {
      const condiciones: string[] = []
      const parametros: unknown[] = []

      if (filtro.tipoDeEntidad !== undefined) {
        condiciones.push('tipo_entidad = ?')
        parametros.push(filtro.tipoDeEntidad)
      }
      if (filtro.entidadId !== undefined) {
        condiciones.push('entidad_id = ?')
        parametros.push(filtro.entidadId)
      }

      const donde = condiciones.length === 0 ? '' : ` WHERE ${condiciones.join(' AND ')}`
      // Del mas nuevo al mas viejo: lo primero que se mira ante un error es lo ultimo
      // que paso.
      const filas = sql
        .prepare(`SELECT * FROM events${donde} ORDER BY ts DESC, id DESC`)
        .all(...parametros)

      return Promise.resolve(filas.map((f: unknown) => aFila(f as FilaDeEvento)))
    },
  }
}

interface FilaDeEvento {
  readonly id: string
  readonly ts: number
  readonly tipo_entidad: string
  readonly entidad_id: string
  readonly evento: string
  readonly severidad: string
  readonly metadata_json: string
}
