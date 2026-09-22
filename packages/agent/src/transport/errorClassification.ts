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
  if (esErrorDeConectividad(error)) {
    return { tipo: 'TRANSPORTE', codigo: codigoDeError(error), mensaje: mensajeDeError(error) }
  }

  const mensaje = mensajeDeError(error)
  if (esErrorDeProgramacion(error)) {
    return { tipo: 'PROGRAMACION', mensaje }
  }

  // Las excepciones de aplicacion las tira el PLC por el propio protocolo Modbus:
  // no es un problema de red y reintentar no cambia nada.
  if (/modbus exception|illegal (data|function)|gateway/i.test(mensaje)) {
    return { tipo: 'MODBUS_APLICACION', mensaje }
  }

  // Todo lo demas es bug nuestro: falla rapido y ruidoso en vez de reintentar.
  return { tipo: 'PROGRAMACION', mensaje }
}

/** Atajo de `clasificarError(error).tipo === 'TRANSPORTE'`, que es lo que el test legacy afirma. */
export function esErrorDeConectividad(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false
  }

  const like = error as { connectivity?: unknown; code?: unknown; errno?: unknown }
  if (like.connectivity === true) {
    return true
  }

  const codigo = like.code
  if (typeof codigo === 'string' && CODIGOS_DE_TRANSPORTE.has(codigo)) {
    return true
  }
  const errno = like.errno
  if (errno !== undefined && errno !== null && CODIGOS_DE_TRANSPORTE.has(String(errno))) {
    return true
  }

  // DEFECTO DEL LEGACY que se arregla aca: con 'socket' y 'tcp' entre las frases,
  // un TypeError como "Cannot read properties of undefined (reading 'socket')"
  // se clasificaba como conectividad y entraba al loop de reintentos. La frase
  // sola no alcanza: un error de programacion es de programacion aunque hable de
  // sockets, y RF19 pide que falle rapido.
  if (esErrorDeProgramacion(error)) {
    return false
  }

  const mensaje = mensajeDeError(error).toLowerCase()
  return FRASES_DE_TRANSPORTE.some((frase) => mensaje.includes(frase))
}

/** Funcion total sobre la union: el compilador obliga a decidir cada variante. */
export function esReintentable(fallo: FalloDeEjecucion): boolean {
  switch (fallo.tipo) {
    case 'TRANSPORTE':
      // Lo unico reintentable: el cable, el socket, la red.
      return true
    case 'PLC_ERROR':
      // El 99 ("No logro recuperarse") no se reintenta; el resto del rango si.
      return !fallo.fatal
    case 'PLC_ESTADO_INESPERADO':
      // El PLC devolvio un valor que no es el esperado todavia: reintentar dentro
      // del mismo paso es justamente como se espera la confirmacion.
      return true
    case 'DISPOSITIVO_NO_REGISTRADO':
    case 'RESET_INCOMPLETO':
    case 'MODBUS_APLICACION':
    case 'PROGRAMACION':
      return false
  }
}

/**
 * Los errores nativos de esta familia los tira el motor de JS ante un bug
 * nuestro, nunca la red.
 */
function esErrorDeProgramacion(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof RangeError
  )
}

/** Mensaje legible de cualquier cosa que haya llegado por el canal de error. */
function mensajeDeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  if (typeof error === 'object' && error !== null) {
    // modbus-serial propaga objetos planos con `message` y sin prototipo Error.
    const mensaje = (error as { message?: unknown }).message
    if (typeof mensaje === 'string') {
      return mensaje
    }
  }
  return String(error)
}

/** Codigo de sistema del error, cuando lo trae. */
function codigoDeError(error: unknown): string | null {
  if (error === null || error === undefined) {
    return null
  }
  const codigo = (error as { code?: unknown }).code
  return typeof codigo === 'string' ? codigo : null
}

/**
 * Codigos de sistema que son de transporte, portados literal del legacy.
 */
const CODIGOS_DE_TRANSPORTE: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ESOCKETTIMEDOUT',
  'ERR_SOCKET_CLOSED',
  'EAI_AGAIN',
  'ENOTCONN',
])

/**
 * Frases que delatan un problema de transporte cuando el error no trae codigo.
 * Portadas literal: modbus-serial no siempre propaga `code`.
 */
const FRASES_DE_TRANSPORTE: readonly string[] = [
  'timeout',
  'timed out',
  'econnreset',
  'connection refused',
  'port not open',
  'broken pipe',
  'etimedout',
  'econnrefused',
  'socket',
  'network unreachable',
  'host unreachable',
  'no connection',
  'connection lost',
  'connection closed',
  'write after end',
  'socket hang up',
  'tcp',
]
