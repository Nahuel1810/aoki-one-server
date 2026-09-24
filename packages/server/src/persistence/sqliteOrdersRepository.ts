// RF26, RF27, RF28, RF29 — La cola durable sobre SQLite.
//
// Implementa el puerto `RepositorioDePedidos` que ya usaba el ingreso, y le suma
// lo que necesitan la entrega con lease y el reporte de transiciones.

import type { EstadoOrden, Result } from '@aoki-one/domain'

import type { BaseDelServidor } from './database.js'
import type {
  AltaDePedido,
  ClaveDePedido,
  ErrorDeAlmacenamiento,
  PedidoDelServidor,
  RepositorioDePedidos,
} from './ordersRepository.js'

/** Un pedido entregado a un agente, con su lease vigente. */
export interface PedidoConLease extends PedidoDelServidor {
  readonly agentId: string
  readonly leaseVenceEn: number
}

export interface TransicionReportada {
  readonly ordenId: string
  readonly seq: number
  readonly estado: EstadoOrden
  readonly reportadaEn: number
  readonly metadata: Readonly<Record<string, unknown>>
}

export type ResultadoDeTransicion =
  | { readonly tipo: 'APLICADA'; readonly pedido: PedidoDelServidor }
  /** Ya se habia aplicado esa misma seq, o llego una mas vieja. */
  | { readonly tipo: 'DESCARTADA'; readonly motivo: 'SEQ_REPETIDA' | 'SEQ_VIEJA' }
  | { readonly tipo: 'ORDEN_INEXISTENTE' }

export interface ColaDelServidor extends RepositorioDePedidos {
  /**
   * Reclama hasta `limite` pedidos pendientes para un agente (RF28).
   *
   * Corre en UNA transaccion: entre elegir y tomar no puede colarse otro agente.
   * Un lease vencido se considera disponible, asi que la re-entrega es
   * automatica y usa el mismo `externalOrderId` — el dedupe del agente (RF14) la
   * absorbe sin duplicar trabajo fisico.
   */
  readonly reclamar: (
    siteId: string,
    agentId: string,
    limite: number,
    ahoraMs: number,
    duracionDelLeaseMs: number,
  ) => Promise<readonly PedidoConLease[]>
  /** Aplica una transicion reportada por el agente, de forma idempotente (RF29). */
  readonly aplicarTransicion: (transicion: TransicionReportada) => Promise<ResultadoDeTransicion>
  readonly buscarPorId: (ordenId: string) => Promise<PedidoDelServidor | undefined>
  readonly pendientes: (siteId: string, ahoraMs: number) => Promise<number>
}

interface FilaDePedido {
  readonly id: string
  readonly site_id: string
  readonly robot_id: string | null
  readonly external_order_id: string
  readonly tipo: string
  readonly location_code: string
  readonly target_location: string | null
  readonly estado: string
  readonly creada_en: number
  readonly entregada_en: number | null
  readonly finalizada_en: number | null
}

/** Estados en los que la orden ya no vuelve a la cola. */
const TERMINALES: ReadonlySet<EstadoOrden> = new Set<EstadoOrden>(['DONE', 'CANCELED'])

export function crearColaDelServidor(
  base: BaseDelServidor,
  generarId: () => string,
  ahora: () => number,
): ColaDelServidor {
  const { sql } = base

  function aPedido(fila: FilaDePedido): PedidoDelServidor {
    return {
      id: fila.id,
      siteId: fila.site_id,
      externalOrderId: fila.external_order_id,
      tipo: fila.tipo as PedidoDelServidor['tipo'],
      locationCode: fila.location_code,
      estado: fila.estado as EstadoOrden,
      creadaEn: fila.creada_en,
    }
  }

  function buscarFila(ordenId: string): FilaDePedido | undefined {
    const fila = sql.prepare('SELECT * FROM orders WHERE id = ?').get(ordenId)
    return fila === undefined ? undefined : (fila as FilaDePedido)
  }

  return {
    buscarPorClave: (clave: ClaveDePedido) => {
      const fila = sql
        .prepare('SELECT * FROM orders WHERE site_id = ? AND external_order_id = ?')
        .get(clave.siteId, clave.externalOrderId)
      return Promise.resolve(fila === undefined ? null : aPedido(fila as FilaDePedido))
    },

    insertar: (alta: AltaDePedido) => {
      const pedido: PedidoDelServidor = {
        id: generarId(),
        siteId: alta.siteId,
        externalOrderId: alta.externalOrderId,
        tipo: alta.tipo,
        locationCode: alta.locationCode,
        estado: 'PENDING',
        creadaEn: ahora(),
      }

      try {
        sql
          .prepare(
            `INSERT INTO orders (
               id, site_id, robot_id, external_order_id, tipo, location_code,
               target_location, estado, creada_en, entregada_en, finalizada_en
             ) VALUES (@id, @siteId, NULL, @externalOrderId, @tipo, @locationCode,
                       NULL, @estado, @creadaEn, NULL, NULL)`,
          )
          .run({ ...pedido })
        const exito: Result<PedidoDelServidor, ErrorDeAlmacenamiento> = { ok: true, valor: pedido }
        return Promise.resolve(exito)
      } catch (error) {
        if (esClaveDuplicada(error)) {
          const fallo: Result<PedidoDelServidor, ErrorDeAlmacenamiento> = {
            ok: false,
            error: { codigo: 'CLAVE_DUPLICADA' },
          }
          return Promise.resolve(fallo)
        }
        throw error
      }
    },

    reclamar: (siteId, agentId, limite, ahoraMs, duracionDelLeaseMs) => {
      const reclamo = sql.transaction((): readonly PedidoConLease[] => {
        // Disponible = pendiente y sin lease vigente. El lease vencido NO se
        // borra antes: se sobreescribe al re-entregar, asi queda la traza.
        const filas = sql
          .prepare(
            `SELECT o.* FROM orders o
             LEFT JOIN order_leases l ON l.order_id = o.id
             WHERE o.site_id = ?
               AND o.estado = 'PENDING'
               AND (l.order_id IS NULL OR l.vence_en <= ?)
             ORDER BY o.creada_en, o.id
             LIMIT ?`,
          )
          .all(siteId, ahoraMs, limite) as FilaDePedido[]

        const venceEn = ahoraMs + duracionDelLeaseMs
        const tomar = sql.prepare(
          `INSERT INTO order_leases (order_id, agent_id, otorgado_en, vence_en)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(order_id) DO UPDATE SET
             agent_id = excluded.agent_id,
             otorgado_en = excluded.otorgado_en,
             vence_en = excluded.vence_en`,
        )
        const marcar = sql.prepare('UPDATE orders SET entregada_en = ? WHERE id = ?')

        return filas.map((fila) => {
          tomar.run(fila.id, agentId, ahoraMs, venceEn)
          marcar.run(ahoraMs, fila.id)
          return { ...aPedido(fila), agentId, leaseVenceEn: venceEn }
        })
      })

      return Promise.resolve(reclamo())
    },

    aplicarTransicion: (transicion) => {
      const aplicar = sql.transaction((): ResultadoDeTransicion => {
        const fila = buscarFila(transicion.ordenId)
        if (fila === undefined) {
          return { tipo: 'ORDEN_INEXISTENTE' }
        }

        const repetida = sql
          .prepare('SELECT seq FROM order_transitions WHERE order_id = ? AND seq = ?')
          .get(transicion.ordenId, transicion.seq)
        if (repetida !== undefined) {
          // Reintento del outbox: ya se aplico, no es un error.
          return { tipo: 'DESCARTADA', motivo: 'SEQ_REPETIDA' }
        }

        const ultima = sql
          .prepare('SELECT MAX(seq) AS maxima FROM order_transitions WHERE order_id = ?')
          .get(transicion.ordenId) as { maxima: number | null } | undefined
        const maxima = ultima?.maxima ?? 0
        if (transicion.seq < maxima) {
          // Con outbox y reintentos, un reporte fuera de orden es lo normal. Si se
          // aplicara, la app de picking veria la orden RETROCEDER de estado.
          return { tipo: 'DESCARTADA', motivo: 'SEQ_VIEJA' }
        }

        sql
          .prepare(
            `INSERT INTO order_transitions (order_id, seq, estado, reportada_en, metadata_json)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            transicion.ordenId,
            transicion.seq,
            transicion.estado,
            transicion.reportadaEn,
            JSON.stringify(transicion.metadata),
          )

        const terminal = TERMINALES.has(transicion.estado) || transicion.estado === 'ERROR'
        sql
          .prepare('UPDATE orders SET estado = ?, finalizada_en = ? WHERE id = ?')
          .run(transicion.estado, terminal ? transicion.reportadaEn : null, transicion.ordenId)

        // Una orden que termino suelta su lease: no hay nada que re-entregar.
        if (TERMINALES.has(transicion.estado)) {
          sql.prepare('DELETE FROM order_leases WHERE order_id = ?').run(transicion.ordenId)
        }

        const actualizada = buscarFila(transicion.ordenId)
        if (actualizada === undefined) {
          return { tipo: 'ORDEN_INEXISTENTE' }
        }
        return { tipo: 'APLICADA', pedido: aPedido(actualizada) }
      })

      return Promise.resolve(aplicar())
    },

    buscarPorId: (ordenId) => {
      const fila = buscarFila(ordenId)
      return Promise.resolve(fila === undefined ? undefined : aPedido(fila))
    },

    pendientes: (siteId, ahoraMs) => {
      const fila = sql
        .prepare(
          `SELECT COUNT(*) AS total FROM orders o
           LEFT JOIN order_leases l ON l.order_id = o.id
           WHERE o.site_id = ? AND o.estado = 'PENDING'
             AND (l.order_id IS NULL OR l.vence_en <= ?)`,
        )
        .get(siteId, ahoraMs) as { total?: number } | undefined
      return Promise.resolve(fila?.total ?? 0)
    },
  }
}

/** SQLite marca la violacion de indice unico con este prefijo. */
function esClaveDuplicada(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false
  }
  const codigo = (error as { code?: unknown }).code
  return typeof codigo === 'string' && codigo.startsWith('SQLITE_CONSTRAINT')
}
