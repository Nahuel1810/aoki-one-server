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

import { noImplementado } from '@aoki-one/domain'
import type { TipoDispositivo } from '@aoki-one/domain'

import type { DispositivoRegistrado } from '../transport/modbusClient.js'
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
  return noImplementado('crearDeviceRepository', { base })
}
