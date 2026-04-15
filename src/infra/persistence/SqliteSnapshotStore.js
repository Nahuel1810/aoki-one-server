const { getSqliteDb } = require("./db");

class SqliteSnapshotStore {
  constructor(options = {}) {
    this.db = getSqliteDb(options);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.upsertStmt = this.db.prepare(`
      INSERT INTO snapshots (id, payload_json, updated_at)
      VALUES (1, @payloadJson, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);

    this.selectStmt = this.db.prepare(`
      SELECT payload_json AS payloadJson
      FROM snapshots
      WHERE id = 1
    `);
  }

  save(snapshot) {
    this.upsertStmt.run({
      payloadJson: JSON.stringify(snapshot || null),
      updatedAt: Date.now(),
    });
  }

  load() {
    const row = this.selectStmt.get();
    if (!row || !row.payloadJson) {
      return null;
    }

    try {
      return JSON.parse(row.payloadJson);
    } catch {
      return null;
    }
  }
}

module.exports = {
  SqliteSnapshotStore,
};
