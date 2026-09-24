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

  -- foreign_keys queda ENCENDIDA aunque hoy NINGUNA tabla declare un REFERENCES,
  -- asi que no exige nada. Se deja dicho por que, para que quien lea el esquema no
  -- asuma una integridad que no existe:
  --
  --   - Varias relaciones NO PUEDEN tener FK porque los ciclos de vida difieren a
  --     proposito. order_metrics sobrevive a la purga de orders (es el historico
  --     con el que se mide la operacion) y outbox_muertas archiva transiciones de
  --     ordenes que tal vez ya se purgaron. Una FK ahi obligaria a elegir entre
  --     bloquear la purga o borrar el historico, y las dos son peores que no
  --     tenerla.
  --   - El resto (slots, devices, order_steps contra su robot o su orden) SI
  --     podria tenerla, pero hay un solo escritor y las escrituras van por
  --     repositorios tipados. Agregar constraints a una base que ya opera un robot
  --     cambia el modo de falla de "fila huerfana" a "insert que revienta en
  --     planta", y eso se decide con la planta parada, no de paso.
  --   - CREATE TABLE IF NOT EXISTS no agrega constraints a una tabla que ya
  --     existe, asi que sumarlas mas adelante es una migracion de verdad y no una
  --     linea en este archivo.
  --
  -- O sea: la integridad la sostiene el codigo, no la base. Si eso cambia, se
  -- cambia aca y con su migracion.

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

  -- OJO: hay DOS tablas llamadas orders en este repositorio, en dos bases
  -- distintas y de dos procesos distintos, y significan cosas distintas.
  --
  --   ESTA (packages/server)     la ADMISION. Que pedidos existen y cual ya se
  --                              atendio. No sabe de slots, ni de cajones, ni de
  --                              PLCs.
  --   packages/agent             la EJECUCION. Que esta haciendo el robot con
  --                              cada orden: que slot tomo, en que paso va,
  --                              cuantos intentos lleva.
  --
  -- Ninguna reescribe el libro de la otra, y el puente entre las dos es
  -- sync_ordenes (id local <-> id remoto). El nombre se conserva igual en las dos
  -- porque las rutas HTTP que las exponen —/api/orders aca y /api/v1/orders
  -- alla— son contrato con la tablet y con la app de picking: renombrar la tabla
  -- sin poder renombrar la ruta cambiaria una confusion por otra.
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
