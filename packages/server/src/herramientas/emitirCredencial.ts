// T37 — Emision de la credencial de una sucursal.
//
// Es la operacion que hay que poder hacer el dia que se da de alta una sucursal
// y el dia que se rota su secreto, y la unica forma de que el agente pueda
// firmar (RF32). Va como herramienta de linea de comandos y no como endpoint: un
// endpoint que emite credenciales es, por definicion, un endpoint que entrega el
// material con el que se firma, y no existe ninguna credencial previa con la que
// autenticarlo. Quien tiene shell en el Linux ya tiene la base y la clave.
//
// El secreto se imprime UNA sola vez, porque despues queda cifrado en la base y
// no hay forma de volver a mostrarlo sin descifrarlo a mano.

import { randomBytes, randomUUID } from 'node:crypto'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import type { Result } from '@aoki-one/domain'

import { VARIABLE_DE_RUTA_DE_BASE } from '../configuracion.js'
import { describirErrorDeClave, leerClaveDeCifrado } from '../persistence/cifrado.js'
import { crearCredentialsRepository } from '../persistence/credentialsRepository.js'
import { abrirBase } from '../persistence/database.js'

const BYTES_DE_SECRETO = 32

export interface CredencialEmitida {
  readonly keyId: string
  readonly siteId: string
  /** En claro. Se muestra una sola vez y se copia al agente. */
  readonly secreto: string
}

export type ErrorDeEmision =
  | { readonly codigo: 'FALTA_SITE_ID' }
  | { readonly codigo: 'FALTA_RUTA_DE_BASE' }
  | { readonly codigo: 'CLAVE_INVALIDA'; readonly detalle: string }

export interface OpcionesDeEmision {
  readonly rutaDeBase: string
  readonly siteId: string
  /** Se genera uno si no se pasa. Repetir uno existente ROTA su secreto. */
  readonly keyId?: string
  readonly entorno: Readonly<Record<string, string | undefined>>
}

export async function emitirCredencial(
  opciones: OpcionesDeEmision,
): Promise<Result<CredencialEmitida, ErrorDeEmision>> {
  if (opciones.siteId.trim() === '') {
    return { ok: false, error: { codigo: 'FALTA_SITE_ID' } }
  }
  if (opciones.rutaDeBase.trim() === '') {
    return { ok: false, error: { codigo: 'FALTA_RUTA_DE_BASE' } }
  }

  const clave = leerClaveDeCifrado(opciones.entorno)
  if (!clave.ok) {
    return {
      ok: false,
      error: { codigo: 'CLAVE_INVALIDA', detalle: describirErrorDeClave(clave.error) },
    }
  }

  const base = abrirBase(opciones.rutaDeBase)
  try {
    const credenciales = crearCredentialsRepository(base, clave.valor)
    const keyId = opciones.keyId ?? randomUUID()
    const secreto = randomBytes(BYTES_DE_SECRETO).toString('hex')
    await credenciales.alta(keyId, opciones.siteId, secreto)
    return { ok: true, valor: { keyId, siteId: opciones.siteId, secreto } }
  } finally {
    base.cerrar()
  }
}

export function describirErrorDeEmision(error: ErrorDeEmision): string {
  switch (error.codigo) {
    case 'FALTA_SITE_ID':
      return 'falta --site-id: es el identificador de la sucursal que va a firmar.'
    case 'FALTA_RUTA_DE_BASE':
      return 'falta --base o la variable de entorno AOKI_SERVER_RUTA_DE_BASE.'
    case 'CLAVE_INVALIDA':
      return error.detalle
  }
}

/** `--clave valor`. Devuelve undefined si el flag no esta o viene sin valor. */
export function leerFlag(argv: readonly string[], nombre: string): string | undefined {
  const indice = argv.indexOf(`--${nombre}`)
  if (indice === -1) {
    return undefined
  }
  return argv[indice + 1]
}

async function principal(): Promise<void> {
  const argv = process.argv.slice(2)
  const keyId = leerFlag(argv, 'key-id')
  const resultado = await emitirCredencial({
    rutaDeBase: leerFlag(argv, 'base') ?? process.env[VARIABLE_DE_RUTA_DE_BASE] ?? '',
    siteId: leerFlag(argv, 'site-id') ?? '',
    // Se omite la propiedad entera en vez de mandar undefined: con
    // exactOptionalPropertyTypes no son lo mismo.
    ...(keyId === undefined ? {} : { keyId }),
    entorno: process.env,
  })

  if (!resultado.ok) {
    console.error(`no se pudo emitir la credencial: ${describirErrorDeEmision(resultado.error)}`)
    process.exitCode = 1
    return
  }

  console.log('Credencial emitida. El secreto se muestra UNA sola vez:')
  console.log(`  AOKI_AGENT_SITE_ID=${resultado.valor.siteId}`)
  console.log(`  AOKI_AGENT_KEY_ID=${resultado.valor.keyId}`)
  console.log(`  AOKI_AGENT_SECRETO=${resultado.valor.secreto}`)
}

function esEntryPoint(): boolean {
  const ejecutado = process.argv[1]
  if (ejecutado === undefined) {
    return false
  }
  return fileURLToPath(import.meta.url) === ejecutado
}

if (esEntryPoint()) {
  void principal()
}
