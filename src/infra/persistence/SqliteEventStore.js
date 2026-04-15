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
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO events (ts, entity_type, entity_id, event, metadata_json)
      VALUES (@ts, @entityType, @entityId, @event, @metadataJson)
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
}

module.exports = {
  SqliteEventStore,
};
