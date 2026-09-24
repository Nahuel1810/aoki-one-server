// RF23 — SQLite como fuente de verdad de la EJECUCION.
//
// El Map en memoria deja de ser autoritativo y el volcado de snapshot completo
// desaparece: cada entidad se escribe incrementalmente por su repositorio. El
// servidor sigue siendo fuente de verdad de la ADMISION de pedidos; el agente
// nunca lo consulta para decidir un paso fisico.

import Database from 'better-sqlite3'

export interface BaseDelAgente {
  readonly cerrar: () => void
  /** Handle crudo. Solo lo usan los repositorios de este paquete. */
  readonly sql: Database.Database
}

/**
 * Esquema del agente. Se aplica completo al abrir: es idempotente y barato, y
 * evita tener que versionar migraciones antes de que exista la primera base en
 * produccion.
 *
 * `slots` lleva el estado como JSON porque `EstadoSlot` es una union
 * discriminada con forma distinta por variante: aplanarla a columnas obligaria a
 * dejar media tabla en NULL y a reconstruir la union a mano en cada lectura.
 */
const ESQUEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS robots (
    id               TEXT PRIMARY KEY,
    site_id          TEXT NOT NULL,
    estanteria_code  TEXT NOT NULL,
    habilitado       INTEGER NOT NULL DEFAULT 1,
    estado           TEXT NOT NULL DEFAULT 'IDLE',
    orden_activa_id  TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS robots_site_estanteria
    ON robots (site_id, estanteria_code);

  CREATE TABLE IF NOT EXISTS devices (
    robot_id            TEXT NOT NULL,
    tipo                TEXT NOT NULL,
    host                TEXT NOT NULL,
    puerto              INTEGER NOT NULL,
    unit_id             INTEGER NOT NULL,
    timeout_ms_socket   INTEGER NOT NULL,
    PRIMARY KEY (robot_id, tipo)
  );

  CREATE TABLE IF NOT EXISTS slots (
    robot_id        TEXT NOT NULL,
    location_code   TEXT NOT NULL,
    lado            TEXT NOT NULL,
    estado_json     TEXT NOT NULL,
    actualizado_en  INTEGER NOT NULL,
    PRIMARY KEY (robot_id, location_code)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id                 TEXT PRIMARY KEY,
    site_id            TEXT NOT NULL,
    robot_id           TEXT NOT NULL,
    external_order_id  TEXT,
    tipo               TEXT NOT NULL,
    origen             TEXT NOT NULL,
    estado             TEXT NOT NULL,
    location_code      TEXT NOT NULL,
    target_location    TEXT,
    slot_location_code TEXT,
    current_step_index INTEGER NOT NULL DEFAULT 0,
    waiting_for_slot   INTEGER NOT NULL DEFAULT 0,
    error_reason       TEXT,
    creada_en          INTEGER NOT NULL,
    iniciada_en        INTEGER,
    finalizada_en      INTEGER
  );
  -- Cierra la ventana de carrera del dedupe: lo rechaza el indice, no un SELECT previo.
  CREATE UNIQUE INDEX IF NOT EXISTS orders_site_external
    ON orders (site_id, external_order_id)
    WHERE external_order_id IS NOT NULL;
  -- La cola FIFO por robot sale por indice, no por scan del historico.
  CREATE INDEX IF NOT EXISTS orders_robot_estado_creada
    ON orders (robot_id, estado, creada_en);

  CREATE TABLE IF NOT EXISTS order_steps (
    orden_id      TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    tipo          TEXT NOT NULL,
    dispositivo   TEXT NOT NULL,
    estado        TEXT NOT NULL,
    intentos      INTEGER NOT NULL DEFAULT 0,
    iniciado_en   INTEGER NOT NULL,
    finalizado_en INTEGER,
    PRIMARY KEY (orden_id, seq)
  );

  CREATE TABLE IF NOT EXISTS events (
    id             TEXT PRIMARY KEY,
    ts             INTEGER NOT NULL,
    tipo_entidad   TEXT NOT NULL,
    entidad_id     TEXT NOT NULL,
    evento         TEXT NOT NULL,
    severidad      TEXT NOT NULL,
    metadata_json  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_entidad ON events (tipo_entidad, entidad_id, ts);
`

export function abrirBase(ruta: string): BaseDelAgente {
  const sql = new Database(ruta)
  sql.exec(ESQUEMA)
  return {
    sql,
    cerrar: () => {
      sql.close()
    },
  }
}
