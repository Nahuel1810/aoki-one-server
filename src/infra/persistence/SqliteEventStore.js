const { getSqliteDb } = require("./db");

class SqliteEventStore {
  constructor(options = {}) {
    this.db = getSqliteDb(options);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS order_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL UNIQUE,
        origin TEXT NOT NULL,
        type TEXT NOT NULL,
        location_code TEXT NOT NULL,
        waiting_ms INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL
      );
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO events (ts, entity_type, entity_id, event, metadata_json)
      VALUES (@ts, @entityType, @entityId, @event, @metadataJson)
    `);

    this.insertMetricsStmt = this.db.prepare(`
      INSERT INTO order_metrics (order_id, origin, type, location_code, waiting_ms, duration_ms, status, created_at, finished_at)
      VALUES (@orderId, @origin, @type, @locationCode, @waitingMs, @durationMs, @status, @createdAt, @finishedAt)
    `);
  }

  append(event) {
    const payload = event || {};
    this.insertStmt.run({
      ts: Date.now(),
      entityType: String(payload.entityType || "UNKNOWN"),
      entityId: String(payload.entityId || "UNKNOWN"),
      event: String(payload.event || "UNKNOWN"),
      metadataJson: payload.metadata ? JSON.stringify(payload.metadata) : null,
    });
  }

  insertMetrics(m) {
    try {
      this.insertMetricsStmt.run({
        orderId: String(m.orderId),
        origin: String(m.origin || "PICKING"),
        type: String(m.type || "PICK"),
        locationCode: String(m.locationCode),
        waitingMs: Number(m.waitingMs || 0),
        durationMs: Number(m.durationMs || 0),
        status: String(m.status || "DONE"),
        createdAt: Number(m.createdAt),
        finishedAt: Number(m.finishedAt || Date.now()),
      });
    } catch (error) {
      console.error("[SqliteEventStore] Error al guardar métricas:", error.message);
    }
  }

  getMetricsReport(range = {}) {
    const filters = [];
    const params = {};
    if (Number.isFinite(range.startDate)) {
      filters.push("finished_at >= @startDate");
      params.startDate = Number(range.startDate);
    }
    if (Number.isFinite(range.endDate)) {
      filters.push("finished_at <= @endDate");
      params.endDate = Number(range.endDate);
    }

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const pickWhere = where ? `${where} AND type = 'PICK'` : "WHERE type = 'PICK'";

    /**
     * Un pedido se cuenta por su PICK. El PUT que lo cierra es la otra mitad
     * del mismo pedido, no uno nuevo: "traer el cajon y guardarlo" es 1.
     * Las maniobras (cada PICK y cada PUT) se siguen exponiendo aparte para
     * medir trabajo del robot, que es otra pregunta.
     */
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM order_metrics ${where}`)
      .get(params);
    const ordersRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM order_metrics ${pickWhere}`)
      .get(params);
    const pickingRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM order_metrics ${pickWhere} AND origin = 'PICKING'`)
      .get(params);
    const manualRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM order_metrics ${pickWhere} AND origin = 'MANUAL'`)
      .get(params);

    /**
     * Cuanto tarda un cajon en estar disponible, medido de punta a punta:
     * desde que entro el pedido hasta que la maniobra termino. Es el numero
     * que responde "cuanto espera el que vino a buscar el cajon".
     */
    const timingRow = this.db
      .prepare(
        `SELECT AVG(waiting_ms + duration_ms) as avgMs,
                MAX(waiting_ms + duration_ms) as maxMs,
                AVG(waiting_ms) as avgWaitMs
         FROM order_metrics
         ${pickWhere} AND status = 'DONE'`
      )
      .get(params);

    const failedWhere = where ? `${where} AND status = 'ERROR'` : "WHERE status = 'ERROR'";
    const failedRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM order_metrics ${failedWhere}`)
      .get(params);
    const byLocation = this.db
      .prepare(
        `SELECT location_code as locationCode, COUNT(*) as total
         FROM order_metrics
         ${pickWhere}
         GROUP BY location_code
         ORDER BY total DESC`
      )
      .all(params);
    const items = this.db
      .prepare(
        `SELECT order_id as orderId,
                origin,
                type,
                location_code as locationCode,
                waiting_ms as waitingMs,
                duration_ms as durationMs,
                status,
                created_at as createdAt,
                finished_at as finishedAt
         FROM order_metrics
         ${where}
         ORDER BY finished_at DESC`
      )
      .all(params);

    const total = Number(totalRow?.total || 0);
    const totalOrders = Number(ordersRow?.total || 0);

    return {
      total,
      summary: {
        /** Pedidos: un buscar + su guardar cuentan como uno. */
        totalOrders,
        pickingOrders: Number(pickingRow?.total || 0),
        manualOrders: Number(manualRow?.total || 0),
        /** Movimientos fisicos del robot: cada PICK y cada PUT. */
        totalManoeuvres: total,
        /** Maniobras que costo cada pedido. Idealmente 2 (traer y guardar). */
        manoeuvresPerOrder: totalOrders > 0 ? total / totalOrders : 0,
        failedOrders: Number(failedRow?.total || 0),
        /** Milisegundos desde que entra el pedido hasta que el cajon esta listo. */
        avgTimeToSlotMs: Math.round(Number(timingRow?.avgMs || 0)),
        maxTimeToSlotMs: Math.round(Number(timingRow?.maxMs || 0)),
        /** Cuanto de esa espera fue cola y no maniobra. */
        avgQueueMs: Math.round(Number(timingRow?.avgWaitMs || 0)),
      },
      byLocation,
      items,
    };
  }
}

module.exports = {
  SqliteEventStore,
};
