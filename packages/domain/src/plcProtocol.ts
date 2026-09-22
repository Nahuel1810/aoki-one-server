// RF02 — Traduccion de una ubicacion a comandos de carro y de elevador.
// RF03 — Protocolo del PLC: decodificacion de la respuesta y error fatal.

import type { Accion, AccionBit, LadoBit, Nivel, Posicion, UbicacionParseada } from './locationCode.js'
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
  const accion = accionOverride ?? ubicacion.accion
  if (accion === null) {
    return { ok: false, error: { codigo: 'ACCION_INDETERMINADA', baseCode: ubicacion.baseCode } }
  }

  // Dos modulos consecutivos comparten parante y se distinguen solo por el ladoBit.
  const parante = Math.ceil(ubicacion.modulo / 2)
  const accionBit: AccionBit = accion === 'T' ? 1 : 0
  const texto = `${String(ubicacion.posicion)}${String(parante).padStart(2, '0')}${String(ubicacion.ladoBit)}${String(accionBit)}`

  return {
    ok: true,
    valor: {
      texto,
      codigo: Number(texto),
      posicion: ubicacion.posicion,
      parante,
      ladoBit: ubicacion.ladoBit,
      accionBit,
    },
  }
}

/**
 * Comando de ir-a-nivel del elevador: `100 + nivel` (A -> 101 ... L -> 112).
 *
 * Sin clamp: con el nivel tipado 1..12 el clamp a 0..99 del legacy es
 * inalcanzable. No devuelve `Result` porque no tiene forma de fallar.
 */
export function construirComandoElevadorIrNivel(nivel: Nivel): number {
  return 100 + nivel
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
 * Tabla de errores del CARRO, portada literal de `src/config/plcProtocol.js`.
 *
 * Los codigos 1, 2, 17, 18 y 99 tambien existen en la tabla del elevador con
 * OTRO significado: por eso `decodificarRespuesta` necesita saber quien respondio.
 */
const ERRORES_CARRO: Readonly<Record<number, string>> = {
  1: 'Carro trabado avanzando',
  2: 'Carro trabado volviendo',
  6: 'No hay cajon',
  7: 'Problema con el puente',
  14: 'Inicio con cajon cargado',
  16: 'Bateria baja',
  17: 'Obstaculo volviendo',
  18: 'Obstaculo avanzando',
  99: 'No logro recuperarse',
}

/** Tabla de errores del ELEVADOR, portada literal de `src/config/plcProtocol.js`. */
const ERRORES_ELEVADOR: Readonly<Record<number, string>> = {
  1: 'Elev trabado subiendo',
  2: 'Elev trabado bajando',
  3: 'Nivel incorrecto',
  17: 'Elev llego a limite inferior',
  18: 'Elev llego a limite superior',
  55: 'Ambas direcciones simultaneas',
  66: 'Llego a Home sin ir a Home',
  99: 'No logro recuperarse',
}

/** `99` = "No logro recuperarse": el unico fatal, en los dos dispositivos. */
const CODIGO_ERROR_FATAL = 99

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
  if (valor === 100) {
    return { kind: 'OK' }
  }

  if (valor >= 101 && valor <= 199) {
    const codigoError = valor - 100
    const tabla = dispositivo === 'CARRO' ? ERRORES_CARRO : ERRORES_ELEVADOR
    return {
      kind: 'ERROR',
      codigoError,
      // Se resuelve contra la tabla del dispositivo que respondio, no contra las dos.
      mensaje: tabla[codigoError] ?? 'Error PLC',
      fatal: codigoError === CODIGO_ERROR_FATAL,
    }
  }

  if (valor >= 200 && valor <= 299) {
    return { kind: 'NIVEL', nivel: valor - 200 }
  }

  if (valor === 300 || valor === 301) {
    return { kind: 'PRESENCIA_CARRO', presente: valor === 300 }
  }

  return { kind: 'DESCONOCIDO', valor }
}
