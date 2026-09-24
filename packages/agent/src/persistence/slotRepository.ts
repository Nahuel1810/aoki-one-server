// RF23 — Tabla `slots`.
//
// El estado del slot se guarda como la union discriminada del dominio: quien
// persiste no reinterpreta la maquina de estados, solo la escribe.
//
// `lado` se RECALCULA siempre desde el locationCode al leer y nunca se toma como
// autoridad de la fila: hay filas viejas de antes de que la columna existiera.
// Los slots se identifican y se deduplican por baseCode: `3X02AE1T` y `3X02AE1`
// son el mismo slot.

import type {
  ErrorSeleccionSlot,
  EstadoSlot,
  Lado,
  Result,
  SlotInexistente,
} from '@aoki-one/domain'

import { z } from 'zod'

import type { BaseDelAgente } from './database.js'
import { parsearLocationCode } from '@aoki-one/domain'

export interface SlotDeRobot {
  readonly robotId: string
  /** baseCode, sin sufijo de accion. */
  readonly locationCode: string
  readonly lado: Lado
  readonly estado: EstadoSlot
  readonly actualizadoEn: number
}

/**
 * El slot pedido no existe en la zona de pickeo de ese robot.
 *
 * Es el `SlotInexistente` del dominio, no un gemelo declarado aca: dos tipos con
 * el mismo `codigo` y distinta forma son dos representaciones del mismo rechazo
 * y nada obliga a que el llamador las trate igual. El dominio ya lo declara como
 * el rechazo de "el slot no existe", distinto de `ErrorTransicionSlot`, y quien
 * lo produce es justamente este repositorio.
 */
export type ErrorDeSlot = SlotInexistente

/**
 * Un codigo de la zona de pickeo que no parsea.
 *
 * Es el `ErrorSeleccionSlot` del dominio, no un gemelo: significa exactamente lo
 * mismo —"ese locationCode de slot no cumple la gramatica"— y `slotWait` ya lo
 * transporta con ese sentido. Dos tipos con el mismo `codigo` obligarian al
 * llamador a tratar por separado dos rechazos identicos.
 */
export type ErrorDeZonaDePickeo = ErrorSeleccionSlot

export interface SlotRepository {
  readonly listarPorRobot: (robotId: string) => Promise<readonly SlotDeRobot[]>
  readonly buscar: (robotId: string, locationCode: string) => Promise<SlotDeRobot | undefined>
  /**
   * El slot donde ya esta apoyado el cajon de esa ubicacion de guardado (RF07).
   *
   * Se busca por la ubicacion de origen del cajon normalizada a baseCode, no por
   * id de cajon: el id es sintetico.
   */
  readonly buscarPorCajonDeOrigen: (
    robotId: string,
    ubicacionDeOrigen: string,
  ) => Promise<SlotDeRobot | undefined>
  readonly guardarEstado: (
    robotId: string,
    locationCode: string,
    estado: EstadoSlot,
  ) => Promise<Result<SlotDeRobot, ErrorDeSlot>>
  /**
   * Alta de la zona de pickeo de un robot: los slots que existen fisicamente.
   *
   * Es la UNICA via para poner slots en la tabla, y sin ella `guardarEstado`
   * rechaza todo con SLOT_INEXISTENTE y ningun fixture puede armar un escenario
   * de slots. Todos los demas repositorios tienen su alta (`crear`, `guardar`,
   * `registrar`); este no la tenia.
   *
   * Hace lo que hoy hace `resolvePickSlotsConfig`: normaliza cada codigo a
   * baseCode (se le saca el sufijo de accion T/D/L) y deduplica por baseCode, asi
   * que `3X02AE1T` y `3X02AE1` son una sola fila. `lado` se deriva del codigo, no
   * se recibe. Cada slot nuevo nace LIBRE, que es el estado inicial de planta; un
   * slot que ya estaba en la tabla CONSERVA su estado, porque sembrar la zona al
   * arrancar no puede pisar lo que el robot dejo apoyado (RF15).
   *
   * Devuelve la zona completa del robot, ya deduplicada. La precedencia
   * `options.pickSlots` > `PICK_SLOTS` del entorno > los 12 codigos por defecto se
   * resuelve una capa mas arriba (ver `OpcionesDelAgente.zonaDePickeo`) y entra
   * con la task que la testee: aca solo llegan los codigos ya elegidos.
   */
  readonly sembrarZonaDePickeo: (
    robotId: string,
    locationCodes: readonly string[],
  ) => Promise<Result<readonly SlotDeRobot[], ErrorDeZonaDePickeo>>
}

/**
 * La forma persistida de cada variante de `EstadoSlot`.
 *
 * Se valida al LEER y no solo al escribir porque la fila puede venir de una
 * migracion, de una version anterior del esquema o de alguien que edito SQLite
 * a mano para destrabar algo — que es exactamente lo que pasa en una sucursal a
 * las 3 AM. El resto de los JSON de esta base ya se validan asi
 * (`leerMapaDeRegistros` en deviceRepository); este era el unico que entraba con
 * un cast, y es el dato del accidente.
 */
const CAJON_EN_SLOT = z.object({
  cajon: z.object({ id: z.string(), ubicacionDeOrigen: z.string() }),
  pendingReturns: z.number().int(),
})

const ESTADO_PERSISTIDO = z.discriminatedUnion('estado', [
  z.object({ estado: z.literal('LIBRE') }),
  z.object({
    estado: z.literal('RESERVADO'),
    ordenId: z.string(),
    contenido: CAJON_EN_SLOT.nullable(),
  }),
  z.object({ estado: z.literal('BUSCANDO'), ordenId: z.string() }),
  z.object({ estado: z.literal('OCUPADO'), contenido: CAJON_EN_SLOT }),
  z.object({
    estado: z.literal('DEVOLVIENDO'),
    ordenId: z.string(),
    contenido: CAJON_EN_SLOT.nullable(),
  }),
  z.object({ estado: z.literal('ERROR'), motivo: z.string() }),
])

/**
 * El estado del slot, o ERROR si la fila no se puede interpretar.
 *
 * ERROR y NO `LIBRE`: un slot que no se entiende puede tener un cajon apoyado, y
 * declararlo libre es exactamente la mentira que hace que el proximo PICK mande
 * el carro contra ese cajon. Tirar tampoco sirve —un slot ilegible dejaria al
 * robot entero sin arrancar—, asi que el slot queda fuera de juego, con el
 * motivo adentro, hasta que alguien lo mire. Es el mismo criterio con el que la
 * migracion aterriza un OCUPADO que no puede traducir.
 */
function leerEstadoDeSlot(json: string, locationCode: string): EstadoSlot {
  let crudo: unknown
  try {
    crudo = JSON.parse(json)
  } catch {
    return {
      estado: 'ERROR',
      motivo: `el estado guardado de ${locationCode} no es JSON valido. Mira el slot y liberalo a mano cuando sepas que tiene.`,
    }
  }

  const validado = ESTADO_PERSISTIDO.safeParse(crudo)
  if (!validado.success) {
    return {
      estado: 'ERROR',
      motivo: `el estado guardado de ${locationCode} no es un estado de slot conocido. Mira el slot y liberalo a mano cuando sepas que tiene.`,
    }
  }
  return validado.data
}

export function crearSlotRepository(base: BaseDelAgente): SlotRepository {
  const { sql } = base

  function aFila(fila: FilaDeSlot): SlotDeRobot {
    return {
      robotId: fila.robot_id,
      locationCode: fila.location_code,
      lado: fila.lado as Lado,
      estado: leerEstadoDeSlot(fila.estado_json, fila.location_code),
      actualizadoEn: fila.actualizado_en,
    }
  }

  return {
    listarPorRobot: (robotId) =>
      Promise.resolve(
        sql
          .prepare('SELECT * FROM slots WHERE robot_id = ? ORDER BY location_code')
          .all(robotId)
          .map((f: unknown) => aFila(f as FilaDeSlot)),
      ),

    buscar: (robotId, locationCode) => {
      const fila = sql
        .prepare('SELECT * FROM slots WHERE robot_id = ? AND location_code = ?')
        .get(robotId, locationCode)
      return Promise.resolve(fila === undefined ? undefined : aFila(fila as FilaDeSlot))
    },

    buscarPorCajonDeOrigen: (robotId, ubicacionDeOrigen) => {
      // Se compara por baseCode: el id del cajon es sintetico y no sirve de clave.
      const encontrado = sql
        .prepare('SELECT * FROM slots WHERE robot_id = ?')
        .all(robotId)
        .map((f: unknown) => aFila(f as FilaDeSlot))
        .find((slot: SlotDeRobot) => {
          const contenido =
            'contenido' in slot.estado ? slot.estado.contenido : null
          return contenido?.cajon.ubicacionDeOrigen === ubicacionDeOrigen
        })
      return Promise.resolve(encontrado)
    },

    guardarEstado: (robotId, locationCode, estado) => {
      const existente = sql
        .prepare('SELECT * FROM slots WHERE robot_id = ? AND location_code = ?')
        .get(robotId, locationCode)
      if (existente === undefined) {
        // No se crea al vuelo: un slot que no esta en la zona de pickeo no existe.
        return Promise.resolve({
          ok: false as const,
          error: { codigo: 'SLOT_INEXISTENTE' as const, locationCode },
        })
      }

      const actualizadoEn = (existente as FilaDeSlot).actualizado_en + 1
      sql
        .prepare(
          'UPDATE slots SET estado_json = ?, actualizado_en = ? WHERE robot_id = ? AND location_code = ?',
        )
        .run(JSON.stringify(estado), actualizadoEn, robotId, locationCode)

      return Promise.resolve({
        ok: true as const,
        valor: {
          robotId,
          locationCode,
          lado: (existente as FilaDeSlot).lado as Lado,
          estado,
          actualizadoEn,
        },
      })
    },

    sembrarZonaDePickeo: (robotId, locationCodes) => {
      const vistos = new Set<string>()

      for (const codigo of locationCodes) {
        const parseado = parsearLocationCode(codigo)
        if (!parseado.ok) {
          return Promise.resolve({
            ok: false as const,
            error: {
              codigo: 'SLOT_CON_CODIGO_INVALIDO' as const,
              locationCode: codigo,
              causa: parseado.error,
            },
          })
        }

        // Deduplicado por baseCode: 3X02AE1T y 3X02AE1 son una sola fila.
        const baseCode = parseado.valor.baseCode
        if (vistos.has(baseCode)) {
          continue
        }
        vistos.add(baseCode)

        // INSERT OR IGNORE: un slot que ya estaba CONSERVA su estado. Sembrar la
        // zona al arrancar no puede pisar lo que el robot dejo apoyado (RF15).
        sql
          .prepare(
            'INSERT OR IGNORE INTO slots (robot_id, location_code, lado, estado_json, actualizado_en) VALUES (?, ?, ?, ?, 0)',
          )
          .run(robotId, baseCode, parseado.valor.lado, JSON.stringify({ estado: 'LIBRE' }))
      }

      const zona = sql
        .prepare('SELECT * FROM slots WHERE robot_id = ? ORDER BY location_code')
        .all(robotId)
        .map((f: unknown) => aFila(f as FilaDeSlot))

      return Promise.resolve({ ok: true as const, valor: zona })
    },
  }
}

interface FilaDeSlot {
  readonly robot_id: string
  readonly location_code: string
  readonly lado: string
  readonly estado_json: string
  readonly actualizado_en: number
}
