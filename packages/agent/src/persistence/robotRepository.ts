// RF23 — Tabla `robots`.
//
// Aca vive el mapeo estanteria -> robot que hoy es un mapa hardcodeado
// (`{ '3X': '1' }`) dentro del parser. No es conocimiento de planta ni gramatica
// de locationCode: es configuracion de despliegue, y en un sistema multi-sucursal
// tiene que ser una fila unica por `(site_id, estanteria_code)`. Con eso se cae
// tambien el fallback identidad del legacy ('4X' -> robot '4X'): un robot que no
// esta dado de alta no existe.

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
  /**
   * Pausa o reanuda la COLA del robot (RF21).
   *
   * Pausar no es abortar: lo unico que cambia es que el loop deja de TOMAR
   * ordenes nuevas. La que ya esta en curso la termina el ciclo que la arranco,
   * que no vuelve a pasar por aca.
   */
  readonly fijarPausaDeCola: (
    robotId: string,
    pausada: boolean,
    ahoraMs: number,
  ) => Promise<Result<boolean, ErrorDeRobot>>
  readonly colaPausada: (robotId: string) => Promise<boolean>
}

export function crearRobotRepository(base: BaseDelAgente): RobotRepository {
  const { sql } = base

  function aFila(fila: FilaDeRobot): Robot {
    return {
      id: fila.id,
      siteId: fila.site_id,
      estanteriaCode: fila.estanteria_code,
      habilitado: fila.habilitado === 1,
      estado: fila.estado as EstadoRobot,
      ordenActivaId: fila.orden_activa_id,
    }
  }

  function buscar(robotId: string): Robot | undefined {
    const fila = sql.prepare('SELECT * FROM robots WHERE id = ?').get(robotId)
    return fila === undefined ? undefined : aFila(fila as FilaDeRobot)
  }

  return {
    guardar: (robot) => {
      // El choque de (site_id, estanteria_code) lo rechaza el indice unico: dos
      // robots no pueden decir ser la misma estanteria de la misma sucursal.
      const duplicado = sql
        .prepare('SELECT id FROM robots WHERE site_id = ? AND estanteria_code = ? AND id <> ?')
        .get(robot.siteId, robot.estanteriaCode, robot.id)
      if (duplicado !== undefined) {
        return Promise.resolve({
          ok: false as const,
          error: {
            codigo: 'ESTANTERIA_DUPLICADA' as const,
            siteId: robot.siteId,
            estanteriaCode: robot.estanteriaCode,
          },
        })
      }

      sql
        .prepare(
          `INSERT INTO robots (id, site_id, estanteria_code, habilitado, estado, orden_activa_id)
           VALUES (@id, @siteId, @estanteriaCode, @habilitado, @estado, @ordenActivaId)
           ON CONFLICT(id) DO UPDATE SET
             site_id = excluded.site_id,
             estanteria_code = excluded.estanteria_code,
             habilitado = excluded.habilitado,
             estado = excluded.estado,
             orden_activa_id = excluded.orden_activa_id`,
        )
        .run({
          id: robot.id,
          siteId: robot.siteId,
          estanteriaCode: robot.estanteriaCode,
          habilitado: robot.habilitado ? 1 : 0,
          estado: robot.estado,
          ordenActivaId: robot.ordenActivaId,
        })

      return Promise.resolve({ ok: true as const, valor: robot })
    },

    buscarPorId: (robotId) => Promise.resolve(buscar(robotId)),

    buscarPorEstanteria: (siteId, estanteriaCode) => {
      // Reemplaza al mapa hardcodeado { '3X': '1' }: una estanteria que no esta
      // dada de alta NO existe, no cae al fallback identidad del legacy.
      const fila = sql
        .prepare('SELECT * FROM robots WHERE site_id = ? AND estanteria_code = ?')
        .get(siteId, estanteriaCode)
      return Promise.resolve(fila === undefined ? undefined : aFila(fila as FilaDeRobot))
    },

    listar: (siteId) =>
      Promise.resolve(
        sql
          .prepare('SELECT * FROM robots WHERE site_id = ? ORDER BY id')
          .all(siteId)
          .map((f: unknown) => aFila(f as FilaDeRobot)),
      ),

    fijarOrdenActiva: (robotId, ordenId) => {
      const robot = buscar(robotId)
      if (robot === undefined) {
        return Promise.resolve({
          ok: false as const,
          error: { codigo: 'ROBOT_INEXISTENTE' as const, robotId },
        })
      }

      // El estado del robot deriva de si tiene orden activa: no es un campo suelto
      // que alguien pueda dejar desincronizado.
      const estado: EstadoRobot = ordenId === null ? 'IDLE' : 'BUSY'
      sql
        .prepare('UPDATE robots SET orden_activa_id = ?, estado = ? WHERE id = ?')
        .run(ordenId, estado, robotId)

      return Promise.resolve({
        ok: true as const,
        valor: { ...robot, ordenActivaId: ordenId, estado },
      })
    },

    fijarPausaDeCola: (robotId, pausada, ahoraMs) => {
      // Se exige que el robot exista: pausar la cola de un robot que no esta dado
      // de alta dejaria una fila huerfana que despues pausa al robot que algun dia
      // se registre con ese id.
      if (buscar(robotId) === undefined) {
        return Promise.resolve({
          ok: false as const,
          error: { codigo: 'ROBOT_INEXISTENTE' as const, robotId },
        })
      }

      if (pausada) {
        sql
          .prepare(
            `INSERT INTO colas_pausadas (robot_id, pausada_en) VALUES (?, ?)
             ON CONFLICT(robot_id) DO UPDATE SET pausada_en = excluded.pausada_en`,
          )
          .run(robotId, ahoraMs)
      } else {
        sql.prepare('DELETE FROM colas_pausadas WHERE robot_id = ?').run(robotId)
      }

      return Promise.resolve({ ok: true as const, valor: pausada })
    },

    colaPausada: (robotId) =>
      Promise.resolve(
        sql.prepare('SELECT robot_id FROM colas_pausadas WHERE robot_id = ?').get(robotId) !==
          undefined,
      ),
  }
}

interface FilaDeRobot {
  readonly id: string
  readonly site_id: string
  readonly estanteria_code: string
  readonly habilitado: number
  readonly estado: string
  readonly orden_activa_id: string | null
}
