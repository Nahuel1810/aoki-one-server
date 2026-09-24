// RF24 — Metricas por orden y su reporte filtrable por rango de fechas.
//
// Las reglas de calculo se portan LITERAL del legacy porque son las que dan los
// numeros que el negocio ya viene mirando, y ninguna tenia test:
//
//   safeStartedAt = startedAt finito y > 0 ? startedAt : finishedAt
//   waitingMs     = max(0, safeStartedAt - createdAt)
//   durationMs    = max(0, finishedAt - safeStartedAt)
//
// El fallback de `startedAt` a `finishedAt` importa: una orden que termina sin
// haber arrancado (se resolvio sin maniobra, RF07) tiene espera completa y
// duracion cero, no una duracion negativa.
//
// La distincion pedido/maniobra tambien se porta tal cual: un pedido se cuenta
// por su PICK, porque el PUT que lo cierra es la otra mitad del mismo pedido y
// no uno nuevo. Las maniobras se cuentan aparte para medir trabajo del robot,
// que es otra pregunta.

import type { EstadoOrden, TipoOrden } from '@aoki-one/domain'

import type { BaseDelAgente } from './database.js'
import type { OrigenDeOrden } from './orderRepository.js'

export interface MetricaDeOrden {
  readonly ordenId: string
  readonly siteId: string
  readonly origen: OrigenDeOrden
  readonly tipo: TipoOrden
  readonly locationCode: string
  readonly waitingMs: number
  readonly durationMs: number
  readonly estado: EstadoOrden
  readonly creadaEn: number
  readonly finalizadaEn: number
}

/** Rango por fecha de FINALIZACION, que es como el legacy filtra. */
export interface RangoDeFechas {
  readonly desdeMs?: number
  readonly hastaMs?: number
}

export interface ResumenDeMetricas {
  /** Pedidos: un buscar y su guardar cuentan como uno. */
  readonly totalOrders: number
  readonly pickingOrders: number
  readonly manualOrders: number
  /** Movimientos fisicos del robot: cada PICK y cada PUT. */
  readonly totalManoeuvres: number
  /** Maniobras que costo cada pedido. Idealmente 2: traer y guardar. */
  readonly manoeuvresPerOrder: number
  readonly failedOrders: number
  /** Milisegundos desde que entra el pedido hasta que el cajon esta listo. */
  readonly avgTimeToSlotMs: number
  readonly maxTimeToSlotMs: number
  /** Cuanto de esa espera fue cola y no maniobra. */
  readonly avgQueueMs: number
}

export interface UbicacionMasPedida {
  readonly locationCode: string
  readonly total: number
}

export interface ReporteDeMetricas {
  readonly total: number
  readonly summary: ResumenDeMetricas
  readonly byLocation: readonly UbicacionMasPedida[]
  readonly items: readonly MetricaDeOrden[]
}

export interface EntradaDeMetrica {
  readonly ordenId: string
  readonly siteId: string
  readonly origen: OrigenDeOrden
  readonly tipo: TipoOrden
  readonly locationCode: string
  readonly estado: EstadoOrden
  readonly creadaEn: number
  /** `null` cuando la orden termino sin llegar a arrancar. */
  readonly iniciadaEn: number | null
  readonly finalizadaEn: number
}

export interface MetricsRepository {
  readonly registrar: (entrada: EntradaDeMetrica) => Promise<MetricaDeOrden>
  readonly reporte: (rango: RangoDeFechas) => Promise<ReporteDeMetricas>
}

/**
 * Calcula espera y duracion de una orden terminada.
 *
 * Exportada aparte de la persistencia para poder afirmarla sin base de datos:
 * es la regla, no el almacenamiento.
 */
export function calcularTiempos(entrada: EntradaDeMetrica): {
  readonly waitingMs: number
  readonly durationMs: number
} {
  const iniciada = entrada.iniciadaEn
  // Una orden que nunca arranco cuenta como espera pura: sin este fallback la
  // duracion saldria negativa.
  const inicioSeguro =
    iniciada !== null && Number.isFinite(iniciada) && iniciada > 0 ? iniciada : entrada.finalizadaEn

  return {
    waitingMs: Math.max(0, inicioSeguro - entrada.creadaEn),
    durationMs: Math.max(0, entrada.finalizadaEn - inicioSeguro),
  }
}

export function crearMetricsRepository(base: BaseDelAgente): MetricsRepository {
  const { sql } = base

  function aFila(fila: FilaDeMetrica): MetricaDeOrden {
    return {
      ordenId: fila.orden_id,
      siteId: fila.site_id,
      origen: fila.origen as OrigenDeOrden,
      tipo: fila.tipo as TipoOrden,
      locationCode: fila.location_code,
      waitingMs: fila.waiting_ms,
      durationMs: fila.duration_ms,
      estado: fila.estado as EstadoOrden,
      creadaEn: fila.creada_en,
      finalizadaEn: fila.finalizada_en,
    }
  }

  /** Filtro por fecha de finalizacion, compartido por todas las consultas. */
  function condiciones(rango: RangoDeFechas): {
    readonly donde: string
    readonly parametros: readonly number[]
  } {
    const partes: string[] = []
    const parametros: number[] = []
    if (rango.desdeMs !== undefined) {
      partes.push('finalizada_en >= ?')
      parametros.push(rango.desdeMs)
    }
    if (rango.hastaMs !== undefined) {
      partes.push('finalizada_en <= ?')
      parametros.push(rango.hastaMs)
    }
    return { donde: partes.length === 0 ? '' : ` WHERE ${partes.join(' AND ')}`, parametros }
  }

  function contar(donde: string, parametros: readonly number[]): number {
    const fila = sql.prepare(`SELECT COUNT(*) AS total FROM order_metrics${donde}`).get(...parametros)
    return (fila as { total?: number } | undefined)?.total ?? 0
  }

  return {
    registrar: (entrada) => {
      const { waitingMs, durationMs } = calcularTiempos(entrada)
      const metrica: MetricaDeOrden = {
        ordenId: entrada.ordenId,
        siteId: entrada.siteId,
        origen: entrada.origen,
        tipo: entrada.tipo,
        locationCode: entrada.locationCode,
        waitingMs,
        durationMs,
        estado: entrada.estado,
        creadaEn: entrada.creadaEn,
        finalizadaEn: entrada.finalizadaEn,
      }

      sql
        .prepare(
          `INSERT INTO order_metrics (
             orden_id, site_id, origen, tipo, location_code,
             waiting_ms, duration_ms, estado, creada_en, finalizada_en
           ) VALUES (
             @ordenId, @siteId, @origen, @tipo, @locationCode,
             @waitingMs, @durationMs, @estado, @creadaEn, @finalizadaEn
           )
           ON CONFLICT(orden_id) DO UPDATE SET
             waiting_ms = excluded.waiting_ms,
             duration_ms = excluded.duration_ms,
             estado = excluded.estado,
             finalizada_en = excluded.finalizada_en`,
        )
        .run({ ...metrica })

      return Promise.resolve(metrica)
    },

    reporte: (rango) => {
      const { donde, parametros } = condiciones(rango)
      const dondePick = donde === '' ? " WHERE tipo = 'PICK'" : `${donde} AND tipo = 'PICK'`
      const dondeError = donde === '' ? " WHERE estado = 'ERROR'" : `${donde} AND estado = 'ERROR'`

      const totalManiobras = contar(donde, parametros)
      const totalPedidos = contar(dondePick, parametros)

      const tiempos = sql
        .prepare(
          `SELECT AVG(waiting_ms + duration_ms) AS avgMs,
                  MAX(waiting_ms + duration_ms) AS maxMs,
                  AVG(waiting_ms) AS avgWaitMs
           FROM order_metrics${dondePick} AND estado = 'DONE'`,
        )
        .get(...parametros) as
        | { avgMs?: number | null; maxMs?: number | null; avgWaitMs?: number | null }
        | undefined

      const byLocation = sql
        .prepare(
          `SELECT location_code AS locationCode, COUNT(*) AS total
           FROM order_metrics${dondePick}
           GROUP BY location_code
           ORDER BY total DESC, location_code`,
        )
        .all(...parametros)
        .map((fila: unknown) => fila as UbicacionMasPedida)

      const items = sql
        .prepare(`SELECT * FROM order_metrics${donde} ORDER BY finalizada_en DESC, orden_id`)
        .all(...parametros)
        .map((fila: unknown) => aFila(fila as FilaDeMetrica))

      return Promise.resolve({
        total: totalManiobras,
        summary: {
          totalOrders: totalPedidos,
          pickingOrders: contar(
            `${dondePick} AND origen = 'PICKING'`,
            parametros,
          ),
          manualOrders: contar(`${dondePick} AND origen = 'MANUAL'`, parametros),
          totalManoeuvres: totalManiobras,
          manoeuvresPerOrder: totalPedidos > 0 ? totalManiobras / totalPedidos : 0,
          failedOrders: contar(dondeError, parametros),
          avgTimeToSlotMs: Math.round(tiempos?.avgMs ?? 0),
          maxTimeToSlotMs: Math.round(tiempos?.maxMs ?? 0),
          avgQueueMs: Math.round(tiempos?.avgWaitMs ?? 0),
        },
        byLocation,
        items,
      })
    },
  }
}

interface FilaDeMetrica {
  readonly orden_id: string
  readonly site_id: string
  readonly origen: string
  readonly tipo: string
  readonly location_code: string
  readonly waiting_ms: number
  readonly duration_ms: number
  readonly estado: string
  readonly creada_en: number
  readonly finalizada_en: number
}
