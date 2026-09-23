// RF27 — El servidor es el libro de la ADMISION de pedidos.
//
// Guarda qué pedidos existen, garantiza que un reenvío no cree una segunda orden
// y sobrevive a reinicios del servidor y del agente por separado. El agente, del
// otro lado, es el libro de la EJECUCION: qué está pasando físicamente con el
// robot. Ninguno reescribe el libro del otro.
//
// SQLite y no Postgres por ahora: una sucursal, un agente, escrituras
// serializadas. Postgres se justifica cuando haya varias sucursales concurrentes
// (Fase 2), y los repositorios están detrás de una interfaz para que el cambio
// no toque la lógica.

import Database from 'better-sqlite3'

export interface BaseDelServidor {
  readonly cerrar: () => void
  /** Handle crudo. Solo lo usan los repositorios de este paquete. */
  readonly sql: Database.Database
}

const ESQUEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sites (
    id          TEXT PRIMARY KEY,
    nombre      TEXT NOT NULL,
    creada_en   INTEGER NOT NULL
  );

  -- RF32. El secreto se guarda CIFRADO con la clave del entorno del proceso, no
  -- hasheado: el servidor verifica la firma HMAC de cada request recomputandola y
  -- para eso necesita el material, no un resumen. Quien lea la base sin tener la
  -- clave sigue sin poder hacerse pasar por una sucursal.
  CREATE TABLE IF NOT EXISTS agent_credentials (
    key_id           TEXT PRIMARY KEY,
    site_id          TEXT NOT NULL,
    secreto_cifrado  TEXT NOT NULL,
    revocada_en      INTEGER,
    ultimo_visto     INTEGER
  );
  CREATE INDEX IF NOT EXISTS agent_credentials_site ON agent_credentials (site_id);

  CREATE TABLE IF NOT EXISTS orders (
    id                 TEXT PRIMARY KEY,
    site_id            TEXT NOT NULL,
    robot_id           TEXT,
    external_order_id  TEXT NOT NULL,
    tipo               TEXT NOT NULL,
    location_code      TEXT NOT NULL,
    target_location    TEXT,
    estado             TEXT NOT NULL,
    creada_en          INTEGER NOT NULL,
    entregada_en       INTEGER,
    finalizada_en      INTEGER
  );
  -- El dedupe de RF26 lo rechaza ESTE indice, no un SELECT previo: entre la
  -- consulta y la insercion queda una ventana que dos altas simultaneas cruzan.
  CREATE UNIQUE INDEX IF NOT EXISTS orders_site_external
    ON orders (site_id, external_order_id);
  -- La entrega sale por indice, no por scan del historico.
  CREATE INDEX IF NOT EXISTS orders_site_estado_creada
    ON orders (site_id, estado, creada_en);

  -- RF28. El lease es lo que permite re-entregar sin duplicar: si el agente se
  -- muere con la orden en la mano, vence y la orden vuelve a estar disponible.
  CREATE TABLE IF NOT EXISTS order_leases (
    order_id    TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    otorgado_en INTEGER NOT NULL,
    vence_en    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS order_leases_vence ON order_leases (vence_en);

  -- RF29. La clave (order_id, seq) es la idempotencia: un reporte repetido no
  -- entra dos veces y uno viejo no pisa a uno nuevo.
  CREATE TABLE IF NOT EXISTS order_transitions (
    order_id      TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    estado        TEXT NOT NULL,
    reportada_en  INTEGER NOT NULL,
    metadata_json TEXT NOT NULL,
    PRIMARY KEY (order_id, seq)
  );

  -- RF31. Presencia de cada sucursal, para que la nube sepa cual esta caida.
  CREATE TABLE IF NOT EXISTS agent_heartbeats (
    site_id        TEXT PRIMARY KEY,
    agent_id       TEXT NOT NULL,
    ultimo_latido  INTEGER NOT NULL,
    estado_json    TEXT NOT NULL
  );
`

interface ColumnaDeTabla {
  readonly name: string
}

/**
 * Corta el arranque si la base viene del esquema viejo de credenciales.
 *
 * `CREATE TABLE IF NOT EXISTS` no toca una tabla que ya existe, asi que una base
 * anterior conservaria `secreto_hash` y el servidor arrancaria para despues
 * fallar en cada request. Un hash no se puede convertir en el material del
 * secreto: las credenciales hay que reemitirlas, y eso se dice ahora.
 */
function verificarEsquemaDeCredenciales(sql: Database.Database): void {
  const columnas = sql
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('agent_credentials')
    .map((fila: unknown) => (fila as ColumnaDeTabla).name)

  if (columnas.includes('secreto_hash')) {
    // Se cierra antes de tirar: el proceso muere igual, pero en el test que
    // afirma este arranque fallido el archivo queda liberado.
    sql.close()
    throw new Error(
      'la base tiene el esquema viejo de agent_credentials (secreto_hash). El secreto ahora se ' +
        'guarda cifrado y un hash no se puede migrar: hay que reemitir las credenciales de cada sucursal.',
    )
  }
}

export function abrirBase(ruta: string): BaseDelServidor {
  const sql = new Database(ruta)
  sql.exec(ESQUEMA)
  verificarEsquemaDeCredenciales(sql)
  return {
    sql,
    cerrar: () => {
      sql.close()
    },
  }
}
