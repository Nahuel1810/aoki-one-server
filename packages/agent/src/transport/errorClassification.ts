// RF19 — Clasificacion de errores: solo el transporte se reintenta.
//
// Invierte la regla del legacy. Hoy `isRetryable` devuelve true para cualquier
// Error salvo que traiga la marca `fatal === true`: reintentable por defecto,
// fatal solo por opt-in. RF19 pide lista blanca: las excepciones Modbus de
// aplicacion y los errores de programacion fallan rapido. El assert legacy
// `isRetryable(new Error('retry')) === true` pasa a `false`.
//
// La marca booleana `.fatal` desaparece como vehiculo: era ambigua (la usaban el
// codigo 99 del PLC, el dispositivo no registrado y el reset incompleto por
// igual) y se reemplaza por esta union, para que `esReintentable` sea una
// funcion total que el compilador obliga a cubrir caso por caso.

import { noImplementado } from '@aoki-one/domain'
import type { TipoDispositivo } from '@aoki-one/domain'

export type FalloDeEjecucion =
  /**
   * Error de socket / red. Es el UNICO reintentable.
   * `codigo` es el `code` o `errno` del error, cuando lo trae.
   */
  | { readonly tipo: 'TRANSPORTE'; readonly codigo: string | null; readonly mensaje: string }
  /**
   * El PLC respondio en el rango 101-199. `codigoError = valor - 100`.
   * `fatal` es true solo para el 99 ("No logro recuperarse"): no se reintenta.
   * `mensaje` es el texto de planta ya resuelto contra la tabla del dispositivo
   * que respondio, y se propaga tal cual al `errorReason` de la orden.
   */
  | {
      readonly tipo: 'PLC_ERROR'
      readonly codigoError: number
      readonly mensaje: string
      readonly fatal: boolean
    }
  /**
   * El PLC respondio algo que no es el codigo esperado y tampoco un error.
   * Se reintenta: es la unica marca de "no fatal" explicita del legacy.
   */
  | { readonly tipo: 'PLC_ESTADO_INESPERADO'; readonly valor: number; readonly mensaje: string }
  /**
   * No hay dispositivo de ese tipo dado de alta para ese robot
   * ("No hay dispositivo <tipo> para robot <id>").
   *
   * Es la tercera de las tres unicas marcas de fatalidad del legacy y NO se
   * reintenta: sin dispositivo registrado no hay a quien mandarle el comando.
   * Tiene variante propia porque no es un bug nuestro —que es lo que dice
   * PROGRAMACION— sino configuracion que falta: el operario no dio de alta el
   * ELEVADOR de ese robot.
   */
  | {
      readonly tipo: 'DISPOSITIVO_NO_REGISTRADO'
      readonly robotId: string
      readonly dispositivo: TipoDispositivo
    }
  /**
   * El paso quedo confirmado pero el reset de registros no se completo.
   * Decision de planta: NO se reintenta. Reintentar sobre un PLC con el registro
   * sucio es peligroso, asi que la orden va directo a ERROR.
   */
  | { readonly tipo: 'RESET_INCOMPLETO'; readonly mensaje: string }
  /** Excepcion Modbus de aplicacion (direccion o funcion ilegal, gateway). Falla rapido. */
  | { readonly tipo: 'MODBUS_APLICACION'; readonly mensaje: string }
  /** Cualquier otra cosa: bug nuestro. Falla rapido y ruidoso. */
  | { readonly tipo: 'PROGRAMACION'; readonly mensaje: string }

/**
 * Traduce una excepcion cruda del transporte a la union.
 *
 * Se mira `error.code` y `error.errno` contra la lista de codigos de socket, y
 * la frase dentro de `error.message` contra la lista de frases; un error ausente
 * (null / undefined) NO es conectividad. Las listas completas (11 codigos y 17
 * frases) son conocimiento de planta y entran con la implementacion.
 *
 * Ojo al implementar: hoy 'socket' y 'tcp' estan entre las frases, asi que un
 * TypeError del estilo "Cannot read properties of undefined (reading 'socket')"
 * se clasifica como conectividad y entra al loop de reintentos, que es lo
 * contrario de lo que pide RF19.
 */
export function clasificarError(error: unknown): FalloDeEjecucion {
  return noImplementado('clasificarError', { error })
}

/** Atajo de `clasificarError(error).tipo === 'TRANSPORTE'`, que es lo que el test legacy afirma. */
export function esErrorDeConectividad(error: unknown): boolean {
  return noImplementado('esErrorDeConectividad', { error })
}

/** Funcion total sobre la union: el compilador obliga a decidir cada variante. */
export function esReintentable(fallo: FalloDeEjecucion): boolean {
  return noImplementado('esReintentable', { fallo })
}
