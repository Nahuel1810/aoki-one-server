// RF01 — Gramatica de locationCode y todo lo que se deriva de ella.
//
// Es la puerta de entrada de todo el sistema: de aca salen el lado (que el carro
// no puede cruzar), el nivel al que va el elevador y la posicion que arma el
// comando del carro.

import type { Result } from './result.js'

/**
 * Lado de la estanteria.
 *
 * Los valores van en ingles porque son el contrato ya publicado: `GET /api/slots`
 * expone `side` como `LEFT` / `RIGHT` y el front nuevo lo consume asi.
 * Derivado por PARIDAD DEL MODULO: par = derecho, impar = izquierdo.
 */
export type Lado = 'LEFT' | 'RIGHT'

/** Bit de lado del comando de carro: 0 = derecho (modulo par), 1 = izquierdo (modulo impar). */
export type LadoBit = 0 | 1

/** Letra de nivel. Son doce niveles exactos: fuera de A..L el codigo se rechaza. */
export type NivelLetra = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L'

/**
 * Nivel numerico: A=1 ... L=12.
 *
 * Es una union cerrada a proposito. El legacy tiene la formula del elevador
 * duplicada — `toElevadorGoLevelCommand` hace `100 + nivel` y
 * `plcProtocol.buildElevadorIrNivel` hace lo mismo clampeando el nivel a 0..99 —
 * y ningun test cubre la discrepancia. Con el nivel tipado 1..12 el clamp es
 * inexpresable: la version correcta es la de `100 + nivel` sin clamp.
 */
export type Nivel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12

/**
 * Posicion dentro del modulo: la regex captura `(\d)`, o sea UN solo digito.
 *
 * Union cerrada 0..9, igual que `Nivel` y `NivelLetra`: `number` dejaba pasar
 * valores que la gramatica no puede producir.
 *
 * El 0 entra a proposito. Verificado contra la regex viva: `3X04AA0` matchea y se
 * parsea con posicion 0. Como la posicion es el PRIMER digito del comando de
 * carro (`<posicion><parante:2><ladoBit><accionBit>`), una posicion 0 colapsa el
 * comando de 5 a 4 digitos. En planta no existe la posicion 0 y el parser de hoy
 * tampoco la rechaza; convertirlo en error es decision de T04, no de aca.
 */
export type Posicion = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/** Sufijo de accion tal como aparece en el codigo crudo. */
export type SufijoAccion = 'T' | 'D' | 'L'

/**
 * Accion normalizada: `T` = traer, `D` = dejar/devolver.
 *
 * El sufijo `L` se normaliza a `D` (mismo bit de accion). RF01 nombra [T|D|L]
 * pero nadie fijaba que L equivale a D: el tipo lo hace explicito.
 */
export type Accion = 'T' | 'D'

/** Bit de accion del comando de carro: T = 1 (traer), D/L = 0 (dejar/devolver). */
export type AccionBit = 0 | 1

/** Resultado del parseo de un locationCode. */
export interface UbicacionParseada {
  /** Codigo normalizado (trim + mayusculas) tal como se parseo. */
  readonly codigo: string
  /**
   * Identidad de la ubicacion, sin la accion:
   * `<estanteria><modulo><'A'><nivelLetra><posicion>`.
   * Es la clave con la que se compara una ubicacion contra otra y con la que se
   * deduplican los slots: `3X02AE1T` y `3X02AE1` son el mismo slot.
   */
  readonly baseCode: string
  /** Prefijo de estanteria, alfanumerico y de largo libre (`3X`, `9X`, `RACKA1`). */
  readonly estanteria: string
  /** Modulo como los dos digitos crudos, con el cero a la izquierda (`04`). */
  readonly moduloCode: string
  /** Modulo numerico. Su paridad define el lado. */
  readonly modulo: number
  readonly lado: Lado
  readonly ladoBit: LadoBit
  readonly nivelLetra: NivelLetra
  readonly nivel: Nivel
  readonly posicion: Posicion
  /** Sufijo crudo, antes de normalizar `L` a `D`. `null` si el codigo no traia sufijo. */
  readonly sufijo: SufijoAccion | null
  /** Accion normalizada. `null` si no hay sufijo: entonces el bit lo impone el llamador. */
  readonly accion: Accion | null
  /** `null` si `accion` es `null`. */
  readonly accionBit: AccionBit | null
}

/**
 * Motivos por los que se rechaza una ubicacion (RF01: "rechaza formatos invalidos").
 *
 * Cada variante tiene un productor distinto y solo uno: `FORMATO_INVALIDO` lo
 * emite `parsearLocationCode` cuando el codigo entero no matchea la gramatica, y
 * `NIVEL_FUERA_DE_RANGO` lo emite `nivelDesdeLetra`. La regex ya rechaza toda
 * letra fuera de A-L, asi que un codigo como `3X04AM3` sale por FORMATO_INVALIDO
 * y nunca por nivel: si el nivel no tuviera funcion propia, esa variante no la
 * podria producir nadie.
 */
export type ErrorLocationCode =
  | { readonly codigo: 'FORMATO_INVALIDO'; readonly recibido: string }
  | { readonly codigo: 'NIVEL_FUERA_DE_RANGO'; readonly letra: string }

/**
 * Gramatica viva, portada literal del legacy.
 *
 * La `A` entre modulo y nivel es un separador LITERAL. El prefijo de estanteria es
 * codicioso y admite digitos, por eso `3X04AA3` parte en `3X` + `04` y no al reves.
 */
const GRAMATICA = /^([A-Z0-9]+)(\d{2})A([A-L])(\d)([TDL])?$/

/**
 * Traduce la letra de nivel a su numero: A=1, B=2, ... L=12.
 *
 * La formula viva es `charCodeAt(letra) - charCodeAt('A') + 1` y el rango es
 * cerrado en doce niveles exactos. El legacy lanza
 * `Error("Nivel invalido. Debe ser entre A y L")` para cualquier otra letra; aca
 * eso es `NIVEL_FUERA_DE_RANGO`, que es la unica forma de poder AFIRMAR ese
 * conocimiento de planta: la gramatica completa nunca deja llegar una `M` hasta
 * el nivel.
 *
 * Toma `string` y no `NivelLetra` justamente para poder expresar el rechazo: con
 * el parametro ya tipado el caso negativo seria inexpresable.
 */
export function nivelDesdeLetra(letra: string): Result<Nivel, ErrorLocationCode> {
  const normalizada = letra.trim().toUpperCase()
  // Formula viva del legacy: charCodeAt - 'A' + 1. Doce niveles exactos.
  const numero = normalizada.charCodeAt(0) - 'A'.charCodeAt(0) + 1
  if (normalizada.length !== 1 || numero < 1 || numero > 12) {
    return { ok: false, error: { codigo: 'NIVEL_FUERA_DE_RANGO', letra } }
  }
  return { ok: true, valor: numero as Nivel }
}

/**
 * Parsea un locationCode con el formato
 * `<estanteria><modulo:2>A<nivel:A-L><posicion:1>[T|D|L]`.
 *
 * Gramatica viva que se porta literal: `/^([A-Z0-9]+)(\d{2})A([A-L])(\d)([TDL])?$/`.
 * La `A` entre modulo y nivel es un separador LITERAL, no parte del nivel, y el
 * prefijo de estanteria es codicioso y admite digitos.
 *
 * La entrada se normaliza antes de parsear: `String(input).trim().toUpperCase()`,
 * o sea que se aceptan minusculas y espacios alrededor.
 *
 * Deriva: baseCode, estanteria, modulo, lado por paridad del modulo (par =
 * `RIGHT`, impar = `LEFT`), nivel numerico (via `nivelDesdeLetra`) y posicion.
 *
 * Todo codigo que no matchee la gramatica sale por `FORMATO_INVALIDO`, incluida
 * una letra de nivel fuera de A-L: la regex la rechaza antes de mirar el nivel.
 *
 * NO deriva robotId: el mapeo estanteria -> robot es configuracion de despliegue
 * (hoy un mapa hardcodeado `{ '3X': '1' }`) y vive en la tabla
 * `robots(site_id, estanteria_code)` del agente, no en el dominio puro.
 */
export function parsearLocationCode(codigo: string): Result<UbicacionParseada, ErrorLocationCode> {
  // Normalizacion viva: se aceptan minusculas y espacios alrededor.
  const normalizado = codigo.trim().toUpperCase()
  const match = GRAMATICA.exec(normalizado)
  if (match === null) {
    return { ok: false, error: { codigo: 'FORMATO_INVALIDO', recibido: codigo } }
  }

  const [, estanteria, moduloCode, nivelLetra, posicionCruda, sufijoCrudo] = match

  // Guard INALCANZABLE en runtime: si la regex matcheo, los cinco primeros grupos
  // existen. Esta solo porque noUncheckedIndexedAccess los tipa como
  // `string | undefined`, y se excluye de la cobertura por eso: ningun test puede
  // producirlo sin romper la gramatica, y bajar el umbral por una rama que no se
  // puede ejercitar esconderia las que si.
  /* v8 ignore start -- guard de tipos, no alcanzable con la gramatica */
  if (
    estanteria === undefined ||
    moduloCode === undefined ||
    nivelLetra === undefined ||
    posicionCruda === undefined
  ) {
    return { ok: false, error: { codigo: 'FORMATO_INVALIDO', recibido: codigo } }
  }
  /* v8 ignore stop */

  const nivelParseado = nivelDesdeLetra(nivelLetra)
  // Tambien INALCANZABLE desde aca: la regex ya restringe el nivel a [A-L], asi
  // que nivelDesdeLetra no puede fallar sobre un codigo que matcheo. La rama se
  // deja porque nivelDesdeLetra SI falla cuando se la llama sola, que es como se
  // afirma el "Nivel invalido. Debe ser entre A y L" de planta.
  /* v8 ignore next 3 -- la gramatica ya garantiza el rango */
  if (!nivelParseado.ok) {
    return nivelParseado
  }

  const modulo = Number(moduloCode)
  // Paridad del modulo: par = derecho, impar = izquierdo. El carro no cruza de lado.
  const esPar = modulo % 2 === 0
  const sufijo = (sufijoCrudo ?? null) as SufijoAccion | null
  // El sufijo L se normaliza a D: misma accion, mismo bit.
  const accion: Accion | null = sufijo === null ? null : sufijo === 'T' ? 'T' : 'D'

  return {
    ok: true,
    valor: {
      codigo: normalizado,
      baseCode: `${estanteria}${moduloCode}A${nivelLetra}${posicionCruda}`,
      estanteria,
      moduloCode,
      modulo,
      lado: esPar ? 'RIGHT' : 'LEFT',
      ladoBit: esPar ? 0 : 1,
      nivelLetra: nivelLetra as NivelLetra,
      nivel: nivelParseado.valor,
      posicion: Number(posicionCruda) as Posicion,
      sufijo,
      accion,
      accionBit: accion === null ? null : accion === 'T' ? 1 : 0,
    },
  }
}

/**
 * Indica si un codigo CRUDO termina en sufijo de accion (`/[TDL]$/i`).
 *
 * El alta de orden rechaza los codigos con accion final: la accion se deriva del
 * tipo de orden (PICK/PUT), nunca viaja en la ubicacion. Se mira el string crudo
 * y no el parseo, asi que un codigo bien formado que termine en esas letras
 * tambien queda marcado.
 */
export function tieneSufijoDeAccion(codigo: string): boolean {
  return /[TDL]$/i.test(codigo.trim())
}
