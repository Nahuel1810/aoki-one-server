// RF22 — El padron de clientes de la API local.
//
// La API del agente no tiene login: el control es de red (ver `exposicionDeRed`).
// Eso deja una pregunta sin responder: QUIEN esta llamando. Esta tabla la
// responde — cada cliente que aparece se anota solo, con desde cuando se lo ve y
// cuantas veces llamo— y permite cortarle el acceso a uno puntual.
//
// EL DEFAULT ES PERMITIDO, y es la decision de diseno central.
//
// Un padron que exige habilitar antes de dejar pasar deja al robot parado la
// primera vez que la tablet cambia de IP —un DHCP que renueva, un equipo que se
// reemplaza— y con el robot parado nadie va a estar leyendo documentacion para
// entender por que. Acá se deja pasar, se registra, y quien opera mira la lista y
// banea lo que no reconoce. Se cambia seguridad preventiva por seguridad
// observable, que es la que no puede frenar la planta.

import type { BaseDelAgente } from './database.js'

export type EstadoDeCliente = 'PERMITIDO' | 'BANEADO'

export interface ClienteDeApi {
  /** La direccion desde la que se llamo. Es la identidad que hay: no hay login. */
  readonly ip: string
  readonly primeraVez: number
  readonly ultimoVisto: number
  readonly llamadas: number
  readonly estado: EstadoDeCliente
  readonly baneadoEn: number | null
  readonly motivo: string | null
}

export interface ClientRepository {
  /**
   * Anota la visita y dice si el cliente esta baneado.
   *
   * Las dos cosas juntas y no en dos llamadas porque corre en CADA request: dos
   * viajes a SQLite por request, sobre una notebook que ademas tiene que mover
   * un robot, es costo que no hace falta pagar.
   */
  readonly registrarVisita: (ip: string, ahoraMs: number) => EstadoDeCliente
  readonly listar: () => readonly ClienteDeApi[]
  readonly banear: (ip: string, ahoraMs: number, motivo: string | null) => ClienteDeApi | undefined
  readonly desbanear: (ip: string) => ClienteDeApi | undefined
  readonly buscar: (ip: string) => ClienteDeApi | undefined
}

interface FilaDeCliente {
  readonly ip: string
  readonly primera_vez: number
  readonly ultimo_visto: number
  readonly llamadas: number
  readonly estado: string
  readonly baneado_en: number | null
  readonly motivo: string | null
}

function aCliente(fila: FilaDeCliente): ClienteDeApi {
  return {
    ip: fila.ip,
    primeraVez: fila.primera_vez,
    ultimoVisto: fila.ultimo_visto,
    llamadas: fila.llamadas,
    // Cualquier cosa que no sea BANEADO se lee como permitido: si la columna
    // trae basura, el lado seguro del error es dejar trabajar al operario, no
    // cortarle el acceso por un dato corrupto.
    estado: fila.estado === 'BANEADO' ? 'BANEADO' : 'PERMITIDO',
    baneadoEn: fila.baneado_en,
    motivo: fila.motivo,
  }
}

export function crearClientRepository(base: BaseDelAgente): ClientRepository {
  const { sql } = base

  // Se preparan una vez: `registrarVisita` corre en cada request.
  const upsert = sql.prepare(
    `INSERT INTO clientes_api (ip, primera_vez, ultimo_visto, llamadas, estado)
     VALUES (?, ?, ?, 1, 'PERMITIDO')
     ON CONFLICT(ip) DO UPDATE SET
       ultimo_visto = excluded.ultimo_visto,
       llamadas = llamadas + 1
     RETURNING estado`,
  )
  const porIp = sql.prepare('SELECT * FROM clientes_api WHERE ip = ?')

  function buscar(ip: string): ClienteDeApi | undefined {
    const fila = porIp.get(ip) as FilaDeCliente | undefined
    return fila === undefined ? undefined : aCliente(fila)
  }

  return {
    registrarVisita: (ip, ahoraMs) => {
      const fila = upsert.get(ip, ahoraMs, ahoraMs) as { readonly estado: string } | undefined
      return fila?.estado === 'BANEADO' ? 'BANEADO' : 'PERMITIDO'
    },

    listar: () =>
      (sql.prepare('SELECT * FROM clientes_api ORDER BY ultimo_visto DESC').all() as FilaDeCliente[])
        .map(aCliente),

    banear: (ip, ahoraMs, motivo) => {
      sql
        .prepare(
          `UPDATE clientes_api SET estado = 'BANEADO', baneado_en = ?, motivo = ? WHERE ip = ?`,
        )
        .run(ahoraMs, motivo, ip)
      return buscar(ip)
    },

    desbanear: (ip) => {
      sql
        .prepare(
          `UPDATE clientes_api SET estado = 'PERMITIDO', baneado_en = NULL, motivo = NULL WHERE ip = ?`,
        )
        .run(ip)
      return buscar(ip)
    },

    buscar,
  }
}
