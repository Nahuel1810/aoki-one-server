// RF23 y RF21 — Tabla `devices`.
//
// Es el alta que hace `POST /api/devices/register` (201) y la consulta de la que
// salen el comando directo a PLC y la lectura de registros por dispositivo. Sin
// esta tabla el dispositivo registrado solo vivia como tipo en `transport/`, o
// sea que el alta no se podia persistir y los tres endpoints de dispositivos no
// se podian servir.
//
// De las dos salidas posibles se eligio ESTA y no exponer el cliente Modbus en
// `DependenciasDeApi`: el comando directo saltea el orquestador, pero no puede
// saltear la resolucion del dispositivo, que es la misma que usan el handshake y
// el monitor de conectividad (`listarDispositivos`). Con dos fuentes de verdad
// para "que dispositivos tiene este robot" se pueden contradecir.
//
// El dispositivo se reusa tal cual lo declara el transporte
// (`DispositivoRegistrado`): identidad `<robotId>:<TIPO>` mas datos de conexion.
// Declararlo de nuevo aca serian dos formas del mismo dato que hay que mantener
// iguales a mano.

import type { TipoDispositivo } from '@aoki-one/domain'

import type { DispositivoRegistrado } from '../transport/modbusClient.js'
import { MAPA_DE_REGISTROS_POR_DEFECTO } from '../transport/stepHandshake.js'
import type { MapaDeRegistros } from '../transport/stepHandshake.js'
import type { BaseDelAgente } from './database.js'

export interface DeviceRepository {
  /**
   * Alta del dispositivo. La clave es `(robotId, tipo)`: un robot tiene un CARRO
   * y un ELEVADOR, y volver a registrar el mismo par actualiza host, puerto,
   * unitId y timeout en vez de crear una segunda fila.
   */
  readonly registrar: (dispositivo: DispositivoRegistrado) => Promise<DispositivoRegistrado>
  readonly buscar: (
    robotId: string,
    tipo: TipoDispositivo,
  ) => Promise<DispositivoRegistrado | undefined>
  /** Los dispositivos dados de alta de ese robot. Es de donde el monitor saca los suyos. */
  readonly listarPorRobot: (robotId: string) => Promise<readonly DispositivoRegistrado[]>
}

export function crearDeviceRepository(base: BaseDelAgente): DeviceRepository {
  const { sql } = base

  function aFila(fila: FilaDeDispositivo): DispositivoRegistrado {
    return {
      robotId: fila.robot_id,
      tipo: fila.tipo as TipoDispositivo,
      host: fila.host,
      puerto: fila.puerto,
      unitId: fila.unit_id,
      timeoutMsDeSocket: fila.timeout_ms_socket,
      mapaDeRegistros: leerMapaDeRegistros(fila.register_map_json),
    }
  }

  return {
    registrar: (dispositivo) => {
      const mapaDeRegistros = dispositivo.mapaDeRegistros ?? MAPA_DE_REGISTROS_POR_DEFECTO
      // La clave es (robotId, tipo): volver a registrar el mismo par actualiza la
      // fila en vez de crear una segunda.
      sql
        .prepare(
          `INSERT INTO devices (robot_id, tipo, host, puerto, unit_id, timeout_ms_socket, register_map_json)
           VALUES (@robotId, @tipo, @host, @puerto, @unitId, @timeoutMsDeSocket, @registerMapJson)
           ON CONFLICT(robot_id, tipo) DO UPDATE SET
             host = excluded.host,
             puerto = excluded.puerto,
             unit_id = excluded.unit_id,
             timeout_ms_socket = excluded.timeout_ms_socket,
             register_map_json = excluded.register_map_json`,
        )
        .run({
          // Se enumeran los campos en vez de esparcir el dispositivo: el mapa de
          // registros se persiste como JSON y una clave de mas en el objeto de
          // bind hace fallar a better-sqlite3.
          robotId: dispositivo.robotId,
          tipo: dispositivo.tipo,
          host: dispositivo.host,
          puerto: dispositivo.puerto,
          unitId: dispositivo.unitId,
          timeoutMsDeSocket: dispositivo.timeoutMsDeSocket,
          registerMapJson: JSON.stringify(mapaDeRegistros),
        })
      // Se devuelve con el mapa ya RESUELTO: quien da de alta sin mapa propio
      // tiene que poder ver cual le quedo, que es lo que el legacy contesta en el
      // 201 (`registerMap` mergeado).
      return Promise.resolve({ ...dispositivo, mapaDeRegistros })
    },

    buscar: (robotId, tipo) => {
      const fila = sql
        .prepare('SELECT * FROM devices WHERE robot_id = ? AND tipo = ?')
        .get(robotId, tipo)
      return Promise.resolve(fila === undefined ? undefined : aFila(fila as FilaDeDispositivo))
    },

    listarPorRobot: (robotId) =>
      Promise.resolve(
        sql
          .prepare('SELECT * FROM devices WHERE robot_id = ? ORDER BY tipo')
          .all(robotId)
          .map((f: unknown) => aFila(f as FilaDeDispositivo)),
      ),
  }
}

interface FilaDeDispositivo {
  readonly robot_id: string
  readonly tipo: string
  readonly host: string
  readonly puerto: number
  readonly unit_id: number
  readonly timeout_ms_socket: number
  /** `null` en las filas que se dieron de alta antes de que la columna existiera. */
  readonly register_map_json: string | null
}

/**
 * El mapa persistido, mergeado sobre el por defecto.
 *
 * Es `mergeRegisterMaps` del legacy: lo que la fila no diga lo pone el default,
 * asi que una fila vieja —o una escrita a mano a medias— no deja al handshake
 * sin direccion. Un JSON roto tampoco puede tumbar el arranque del agente: se
 * cae al default, que es la direccion con la que ya venia operando.
 */
function leerMapaDeRegistros(json: string | null): MapaDeRegistros {
  if (json === null) {
    return MAPA_DE_REGISTROS_POR_DEFECTO
  }
  let crudo: unknown
  try {
    crudo = JSON.parse(json)
  } catch {
    return MAPA_DE_REGISTROS_POR_DEFECTO
  }
  if (typeof crudo !== 'object' || crudo === null) {
    return MAPA_DE_REGISTROS_POR_DEFECTO
  }
  const parcial = crudo as { readonly messageIn?: unknown; readonly messageOut?: unknown }
  return {
    messageIn:
      typeof parcial.messageIn === 'number'
        ? parcial.messageIn
        : MAPA_DE_REGISTROS_POR_DEFECTO.messageIn,
    messageOut:
      typeof parcial.messageOut === 'number'
        ? parcial.messageOut
        : MAPA_DE_REGISTROS_POR_DEFECTO.messageOut,
  }
}
