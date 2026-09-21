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
    const pickingWhere = where ? `${where} AND origin = 'PICKING'` : "WHERE origin = 'PICKING'";
    const pickWhere = where ? `${where} AND type = 'PICK'` : "WHERE type = 'PICK'";
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM order_metrics ${where}`)
      .get(params);
    const pickingRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM order_metrics ${pickingWhere}`)
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
    return {
      total,
      summary: {
        totalManoeuvres: total,
        pickingOrders: Number(pickingRow?.total || 0),
      },
      byLocation,
      items,
    };
  }
}

module.exports = {
  SqliteEventStore,
};
