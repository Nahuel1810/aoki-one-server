// RF23 — Tabla `robots`.
//
// Aca vive el mapeo estanteria -> robot que hoy es un mapa hardcodeado
// (`{ '3X': '1' }`) dentro del parser. No es conocimiento de planta ni gramatica
// de locationCode: es configuracion de despliegue, y en un sistema multi-sucursal
// tiene que ser una fila unica por `(site_id, estanteria_code)`. Con eso se cae
// tambien el fallback identidad del legacy ('4X' -> robot '4X'): un robot que no
// esta dado de alta no existe.

import { noImplementado } from '@aoki-one/domain'
import type { Result } from '@aoki-one/domain'

import type { BaseDelAgente } from './database.js'

/** El robot esta libre o tiene una orden en curso. Una sola orden activa (RF08). */
export type EstadoRobot = 'IDLE' | 'BUSY'

export interface Robot {
  readonly id: string
  readonly siteId: string
  readonly estanteriaCode: string
  readonly habilitado: boolean
  readonly estado: EstadoRobot
  /** `null` cuando esta IDLE. No sobrevive a un reinicio (RF15). */
  readonly ordenActivaId: string | null
}

export type ErrorDeRobot =
  | { readonly codigo: 'ROBOT_INEXISTENTE'; readonly robotId: string }
  | {
      readonly codigo: 'ESTANTERIA_DUPLICADA'
      readonly siteId: string
      readonly estanteriaCode: string
    }

export interface RobotRepository {
  readonly guardar: (robot: Robot) => Promise<Result<Robot, ErrorDeRobot>>
  readonly buscarPorId: (robotId: string) => Promise<Robot | undefined>
  /** El lookup que reemplaza al mapa hardcodeado. */
  readonly buscarPorEstanteria: (
    siteId: string,
    estanteriaCode: string,
  ) => Promise<Robot | undefined>
  readonly listar: (siteId: string) => Promise<readonly Robot[]>
  /** Toma o suelta la orden activa. Es la invariante de "una orden fisica por robot". */
  readonly fijarOrdenActiva: (
    robotId: string,
    ordenId: string | null,
  ) => Promise<Result<Robot, ErrorDeRobot>>
}

export function crearRobotRepository(base: BaseDelAgente): RobotRepository {
  return noImplementado('crearRobotRepository', { base })
}
