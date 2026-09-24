// RF26, RF32 — Cifrado en reposo del material de las credenciales de sucursal.
//
// El servidor verifica la firma HMAC de cada request RECOMPUTANDOLA, asi que
// necesita el secreto de la sucursal, no un resumen de el: un hash sirve para
// verificar una password que el cliente manda, y mandar el secreto es
// exactamente lo que hay que evitar (quien lo manda ya no necesita firmar nada).
//
// Pero el secreto en claro en la base convierte cualquier backup, dump o replica
// en la llave de TODAS las sucursales. Por eso se guarda cifrado con una clave
// que vive en el entorno del proceso y nunca en la base: separar los dos hace
// que filtrar uno solo no alcance.
//
// AES-256-GCM y no AES-CBC: GCM autentica el texto cifrado, asi que un byte
// cambiado en la fila no produce un secreto distinto (y firmas que no validan
// nunca), produce un fallo explicito al descifrar.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import type { Result } from '@aoki-one/domain'

/** Variable de entorno de la que sale la clave maestra, en hexadecimal. */
export const VARIABLE_DE_CLAVE = 'AOKI_SERVER_CLAVE_DE_CREDENCIALES'

const BYTES_DE_CLAVE = 32
const BYTES_DE_IV = 12
/** El sobre lleva version para poder rotar el algoritmo sin adivinar el formato. */
const VERSION = 'v1'
const SOLO_HEX = /^[0-9a-fA-F]+$/

/**
 * Clave maestra ya validada.
 *
 * Es un tipo propio y no un `Buffer` suelto para que no se pueda pasar por error
 * cualquier cosa del entorno: la unica forma de construirla es `leerClaveDeCifrado`.
 */
export interface ClaveDeCifrado {
  readonly bytes: Buffer
}

export type ErrorDeClave =
  | { readonly codigo: 'CLAVE_AUSENTE'; readonly variable: string }
  | { readonly codigo: 'CLAVE_NO_ES_HEXADECIMAL'; readonly variable: string }
  | {
      readonly codigo: 'CLAVE_DE_LARGO_INVALIDO'
      readonly variable: string
      readonly bytesRecibidos: number
      readonly bytesEsperados: number
    }

export type ErrorDeDescifrado =
  /** El sobre no tiene la forma `v1.<iv>.<tag>.<cifrado>`. */
  | { readonly codigo: 'SOBRE_INVALIDO' }
  /** GCM rechazo el tag: o la clave no es la que cifro, o la fila esta alterada. */
  | { readonly codigo: 'NO_AUTENTICA' }

/**
 * Lee la clave maestra del entorno.
 *
 * El entorno se recibe por parametro en vez de leer `process.env` adentro para
 * que el test pueda afirmar el arranque fallido sin ensuciar el proceso.
 */
export function leerClaveDeCifrado(
  entorno: Readonly<Record<string, string | undefined>>,
): Result<ClaveDeCifrado, ErrorDeClave> {
  const crudo = entorno[VARIABLE_DE_CLAVE]
  if (crudo === undefined || crudo.trim() === '') {
    return { ok: false, error: { codigo: 'CLAVE_AUSENTE', variable: VARIABLE_DE_CLAVE } }
  }

  const texto = crudo.trim()
  // `Buffer.from(x, 'hex')` corta en el primer caracter que no es hexadecimal en
  // vez de fallar: sin esta guarda, una clave con una errata se convertiria en
  // una clave mas corta y el servidor arrancaria igual.
  if (!SOLO_HEX.test(texto) || texto.length % 2 !== 0) {
    return { ok: false, error: { codigo: 'CLAVE_NO_ES_HEXADECIMAL', variable: VARIABLE_DE_CLAVE } }
  }

  const bytes = Buffer.from(texto, 'hex')
  if (bytes.length !== BYTES_DE_CLAVE) {
    return {
      ok: false,
      error: {
        codigo: 'CLAVE_DE_LARGO_INVALIDO',
        variable: VARIABLE_DE_CLAVE,
        bytesRecibidos: bytes.length,
        bytesEsperados: BYTES_DE_CLAVE,
      },
    }
  }

  return { ok: true, valor: { bytes } }
}

/** Mensaje de arranque. Dice que falta y como generarlo, porque se lee una sola vez. */
export function describirErrorDeClave(error: ErrorDeClave): string {
  switch (error.codigo) {
    case 'CLAVE_AUSENTE':
      return `falta la variable de entorno ${error.variable}: sin ella el servidor no puede verificar ninguna firma. Generar una con ${String(BYTES_DE_CLAVE)} bytes en hexadecimal.`
    case 'CLAVE_NO_ES_HEXADECIMAL':
      return `la variable de entorno ${error.variable} no es hexadecimal valido.`
    case 'CLAVE_DE_LARGO_INVALIDO':
      return `la variable de entorno ${error.variable} tiene ${String(error.bytesRecibidos)} bytes y se esperan ${String(error.bytesEsperados)}.`
  }
}

/** Clave nueva, en el formato que espera la variable de entorno. Para operaciones. */
export function generarClaveDeCifrado(): string {
  return randomBytes(BYTES_DE_CLAVE).toString('hex')
}

/**
 * Cifra un secreto y devuelve el sobre que va a la base.
 *
 * El IV es aleatorio por sobre: reutilizarlo con la misma clave en GCM rompe la
 * confidencialidad de los dos mensajes, no solo la de uno.
 */
export function cifrar(clave: ClaveDeCifrado, textoPlano: string): string {
  const iv = randomBytes(BYTES_DE_IV)
  const cifrador = createCipheriv('aes-256-gcm', clave.bytes, iv)
  const cifrado = Buffer.concat([cifrador.update(textoPlano, 'utf8'), cifrador.final()])
  const tag = cifrador.getAuthTag()
  return [VERSION, iv.toString('hex'), tag.toString('hex'), cifrado.toString('hex')].join('.')
}

export function descifrar(
  clave: ClaveDeCifrado,
  sobre: string,
): Result<string, ErrorDeDescifrado> {
  const partes = sobre.split('.')
  const [version, ivHex, tagHex, cifradoHex] = partes
  if (
    partes.length !== 4 ||
    version !== VERSION ||
    ivHex === undefined ||
    tagHex === undefined ||
    cifradoHex === undefined ||
    !SOLO_HEX.test(ivHex) ||
    !SOLO_HEX.test(tagHex) ||
    (cifradoHex !== '' && !SOLO_HEX.test(cifradoHex))
  ) {
    return { ok: false, error: { codigo: 'SOBRE_INVALIDO' } }
  }

  const iv = Buffer.from(ivHex, 'hex')
  if (iv.length !== BYTES_DE_IV) {
    return { ok: false, error: { codigo: 'SOBRE_INVALIDO' } }
  }

  try {
    const descifrador = createDecipheriv('aes-256-gcm', clave.bytes, iv)
    descifrador.setAuthTag(Buffer.from(tagHex, 'hex'))
    const plano = Buffer.concat([
      descifrador.update(Buffer.from(cifradoHex, 'hex')),
      descifrador.final(),
    ])
    return { ok: true, valor: plano.toString('utf8') }
  } catch {
    // `final()` tira cuando el tag no cierra. Es el caso normal de "esta no es la
    // clave con la que se cifro", no una excepcion que deba subir.
    return { ok: false, error: { codigo: 'NO_AUTENTICA' } }
  }
}
