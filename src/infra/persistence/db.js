const path = require("node:path");

const dbCache = new Map();

function resolveDbPath(dbPath) {
  if (dbPath) {
    return dbPath;
  }

  return path.join(process.cwd(), "data", "persistence.db");
}

function createDatabase(dbPath) {
  // Lazy require keeps file-mode deployments working even without sqlite dependency.
  const Database = require("better-sqlite3");
  const database = new Database(dbPath);

  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");

  return database;
}

function getSqliteDb(options = {}) {
  const dbPath = resolveDbPath(options.dbPath || process.env.SQLITE_DB_PATH);

  if (!dbCache.has(dbPath)) {
    const database = createDatabase(dbPath);
    dbCache.set(dbPath, database);
  }

  return dbCache.get(dbPath);
}

module.exports = {
  getSqliteDb,
  resolveDbPath,
};
