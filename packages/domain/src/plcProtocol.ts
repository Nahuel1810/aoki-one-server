// RF02 — Traduccion de una ubicacion a comandos de carro y de elevador.
// RF03 — Protocolo del PLC: decodificacion de la respuesta y error fatal.

import type { Accion, AccionBit, LadoBit, Nivel, Posicion, UbicacionParseada } from './locationCode.js'
import { noImplementado } from './noImplementado.js'
import type { Result } from './result.js'

/** Los dos dispositivos de un robot. Cada uno tiene su propio cliente y su propio mutex. */
export type TipoDispositivo = 'CARRO' | 'ELEVADOR'

/**
 * Comando de carro ya armado.
 *
 * Se expone el texto y el numero porque son dos afirmaciones distintas: el texto
 * pinea el layout de digitos (sin ceros a la izquierda de mas ni padding extra) y
 * el numero es lo que viaja al PLC. Las partes quedan expuestas para poder
 * afirmar la composicion, que es el conocimiento caro.
 */
export interface ComandoCarro {
  /** `<posicion><parante:2><ladoBit><accionBit>`, por ejemplo `30201`. */
  readonly texto: string
  /** El mismo valor como numero: `Number(texto)`. */
  readonly codigo: number
  readonly posicion: Posicion
  /** `ceil(modulo / 2)`. Se formatea a 2 digitos con cero a la izquierda. */
  readonly parante: number
  readonly ladoBit: LadoBit
  readonly accionBit: AccionBit
}

export type ErrorComandoCarro = {
  /** La ubicacion no traia sufijo y el llamador no impuso accion. */
  readonly codigo: 'ACCION_INDETERMINADA'
  readonly baseCode: string
}

/**
 * Arma el comando de carro: `<posicion><parante:2><ladoBit><accionBit>`, con
 * `parante = ceil(modulo / 2)` rellenado a dos digitos.
 *
 * Casos verificados contra el robot real:
 * `3X04AA3T` -> `30201`; `3X04AA3` con accion `D` -> `30200`;
 * `3X03AA1T` -> `10211` (modulos 03 y 04 comparten parante `02` y se distinguen
 * solo por el ladoBit).
 *
 * `accionOverride` es lo que usa el paso fisico cuando el locationCode no trae
 * sufijo: CARRO_BUSCA impone `T` y CARRO_DEJA / CARRO_DEVUELVE imponen `D`. Si
 * la ubicacion no trae accion y no se pasa override, es error del dominio.
 */
export function construirComandoCarro(
  ubicacion: UbicacionParseada,
  accionOverride?: Accion,
): Result<ComandoCarro, ErrorComandoCarro> {
  return noImplementado('construirComandoCarro', { ubicacion, accionOverride })
}

/**
 * Comando de ir-a-nivel del elevador: `100 + nivel` (A -> 101 ... L -> 112).
 *
 * Sin clamp: con el nivel tipado 1..12 el clamp a 0..99 del legacy es
 * inalcanzable. No devuelve `Result` porque no tiene forma de fallar.
 */
export function construirComandoElevadorIrNivel(nivel: Nivel): number {
  return noImplementado('construirComandoElevadorIrNivel', { nivel })
}

/**
 * Respuesta del PLC ya decodificada.
 *
 * Reemplaza al objeto con `kind` string suelto del legacy: el compilador obliga
 * a cubrir cada variante.
 *
 * `NIVEL` (200-299) y `PRESENCIA_CARRO` (300/301) se declaran aunque ningun test
 * portado las ejercite —RF03 figura en "RF sin cobertura" del mapeo— y no son
 * superficie de mas: `decodificarRespuesta` es una funcion TOTAL sobre el espacio
 * de valores que el PLC puede devolver, no sobre el subconjunto que la suite mira
 * hoy. Sin esas dos variantes un 205 real caeria en `DESCONOCIDO`, que es una
 * afirmacion FALSA sobre el protocolo de planta: el elevador si responde su nivel
 * ahi. Son los rangos vivos de `QUERY_LEVEL` (200) y `QUERY_CAR_PRESENCE` (300)
 * que el mapeo registra como conocimiento de planta. NO se borran.
 */
export type RespuestaPlc =
  /** `100`: paso confirmado. Es el codigo esperado por defecto de todo paso. */
  | { readonly kind: 'OK' }
  /** `101`-`199`: `codigoError = valor - 100`. */
  | {
      readonly kind: 'ERROR'
      readonly codigoError: number
      /** Texto de planta que ve el operario, resuelto contra la tabla del dispositivo. */
      readonly mensaje: string
      /** `true` solo para el codigo 99: no se reintenta. */
      readonly fatal: boolean
    }
  /** `200`-`299`: `nivel = valor - 200`. */
  | { readonly kind: 'NIVEL'; readonly nivel: number }
  /** `300` = carro presente, `301` = carro ausente. */
  | { readonly kind: 'PRESENCIA_CARRO'; readonly presente: boolean }
  /** Cualquier otro valor. */
  | { readonly kind: 'DESCONOCIDO'; readonly valor: number }

/**
 * Decodifica un valor leido de `messageOut`.
 *
 * `dispositivo` es OBLIGATORIO y ahi esta el arreglo de un bug de planta: el
 * legacy resuelve el texto con `CARRO.ERROR_CODES[c] || ELEVADOR.ERROR_CODES[c]`
 * sin saber quien respondio, y los codigos 1, 2, 17, 18 y 99 existen en las dos
 * tablas con significados distintos (1 = "Carro trabado avanzando" vs
 * "Elev trabado subiendo"; 17/18 = obstaculo del carro vs limite del elevador).
 * Hoy todo error del elevador se le muestra al operario con el texto del carro.
 *
 * El codigo de error 99 ("No logro recuperarse") es FATAL en ambos dispositivos:
 * `fatal: true` y no se reintenta. El resto del rango se reintenta dentro del
 * mismo paso.
 */
export function decodificarRespuesta(valor: number, dispositivo: TipoDispositivo): RespuestaPlc {
  return noImplementado('decodificarRespuesta', { valor, dispositivo })
}
