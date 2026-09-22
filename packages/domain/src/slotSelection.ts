// RF05 — Seleccion de slot de pickeo para un PICK.
//
// Solo slots del MISMO LADO que el origen (el carro no cruza de lado: es
// exclusion, no penalizacion de orden) y solo slots LIBRE, ordenados por
// cercania.

import type { ErrorLocationCode, UbicacionParseada } from './locationCode.js'
import { noImplementado } from './noImplementado.js'
import type { Result } from './result.js'
import type { EstadoSlot } from './slotStateMachine.js'

/** Slot de pickeo tal como entra al ranking. */
export interface SlotDePickeo {
  /** Puede venir con sufijo de accion; el ranking lo normaliza a baseCode. */
  readonly locationCode: string
  /**
   * Estado actual. Es obligatorio: desaparecen el alias `AVAILABLE`, el matcheo
   * case-insensitive y el default permisivo del legacy, donde un slot sin status
   * se tomaba por LIBRE y se podia reservar un slot ocupado.
   */
  readonly estado: EstadoSlot
}

/** Slot candidato, ya normalizado y parseado. */
export interface SlotRankeado {
  /** baseCode: el locationCode SIN el sufijo de accion T/D/L. */
  readonly locationCode: string
  readonly ubicacion: UbicacionParseada
  readonly estado: EstadoSlot
}

export type ErrorSeleccionSlot = {
  readonly codigo: 'SLOT_CON_CODIGO_INVALIDO'
  readonly locationCode: string
  readonly causa: ErrorLocationCode
}

/**
 * Ordena los slots candidatos para un PICK desde `origen`, de mejor a peor.
 *
 * Filtra primero, de forma dura: queda afuera todo slot cuyo lado difiera del
 * origen y todo slot que no este LIBRE.
 *
 * Desempates, en este orden exacto (los seis criterios del ranking vivo; RF05
 * solo enumera el 1, el 2, el 3 y el 5, pero el 4 y el 6 estan pineados por los
 * tests portados y por el determinismo de la eleccion):
 *   1. mismo nivel que el origen  — redundante con el 2, se puede colapsar
 *   2. menor distancia de nivel
 *   3. menor distancia de modulo
 *   4. modulo absoluto ASCENDENTE (sesgo hacia el inicio de la estanteria)
 *   5. posicion absoluta ascendente: 1 antes que 2 antes que 3. Es ABSOLUTA, no
 *      la distancia a la posicion del origen — un origen en posicion 2 sigue
 *      prefiriendo la posicion 1
 *   6. orden alfabetico del baseCode, para que dos corridas elijan el mismo slot
 *
 * La salida normaliza `locationCode` a baseCode: los asserts del ganador
 * dependen de esa normalizacion.
 */
export function rankearSlotsParaPick(
  origen: UbicacionParseada,
  slots: readonly SlotDePickeo[],
): Result<readonly SlotRankeado[], ErrorSeleccionSlot> {
  return noImplementado('rankearSlotsParaPick', { origen, slots })
}
