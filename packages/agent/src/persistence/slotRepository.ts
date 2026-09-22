// RF23 — Tabla `slots`.
//
// El estado del slot se guarda como la union discriminada del dominio: quien
// persiste no reinterpreta la maquina de estados, solo la escribe.
//
// `lado` se RECALCULA siempre desde el locationCode al leer y nunca se toma como
// autoridad de la fila: hay filas viejas de antes de que la columna existiera.
// Los slots se identifican y se deduplican por baseCode: `3X02AE1T` y `3X02AE1`
// son el mismo slot.

import { noImplementado } from '@aoki-one/domain'
import type {
  ErrorSeleccionSlot,
  EstadoSlot,
  Lado,
  Result,
  SlotInexistente,
} from '@aoki-one/domain'

import type { BaseDelAgente } from './database.js'

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

export function crearSlotRepository(base: BaseDelAgente): SlotRepository {
  return noImplementado('crearSlotRepository', { base })
}
