// T37 — Configuracion del proceso del servidor, leida del entorno.
//
// El servidor corre como unidad de systemd: cuando arranca no hay nadie mirando
// la consola, asi que una variable mal puesta no puede degradar en un default
// silencioso. Se valida TODO antes de abrir la base o el puerto.
//
// Y se devuelven TODOS los errores juntos, no el primero: quien esta poniendo el
// Linux en marcha corrige una pasada y no descubre la siguiente variable rota
// recien en el proximo reinicio.

import type { NivelDeLog, Result } from '@aoki-one/domain'

import { describirErrorDeClave, leerClaveDeCifrado } from './persistence/cifrado.js'
import type { PoliticaDeRetencion } from './persistence/retencion.js'
import { esNivelDeLog, NIVELES } from './registro.js'

/** Archivo SQLite del servidor. Obligatoria: un default apuntaria a un disco que no es el suyo. */
export const VARIABLE_DE_RUTA_DE_BASE = 'AOKI_SERVER_RUTA_DE_BASE'
export const VARIABLE_DE_PUERTO = 'AOKI_SERVER_PUERTO'
export const VARIABLE_DE_BIND = 'AOKI_SERVER_BIND'
export const VARIABLE_DE_RETENCION_DIAS = 'AOKI_SERVER_RETENCION_DIAS'
export const VARIABLE_DE_PURGA_MINUTOS = 'AOKI_SERVER_PURGA_CADA_MINUTOS'
export const VARIABLE_DE_NIVEL_DE_LOG = 'AOKI_SERVER_NIVEL_DE_LOG'

const PUERTO_POR_DEFECTO = 8080

/**
 * Loopback por defecto, y a proposito.
 *
 * El servidor NO termina TLS (ver deploy/README.md): lo hace el reverse proxy que
 * tiene delante. Si el default fuera `0.0.0.0`, un despliegue al que todavia le
 * falta el proxy quedaria publicando HTTP plano en internet sin que nadie lo
 * note. Abrirlo a otras interfaces es una decision explicita.
 */
const BIND_POR_DEFECTO = '127.0.0.1'

const RETENCION_DIAS_POR_DEFECTO = 90
const PURGA_MINUTOS_POR_DEFECTO = 360
const NIVEL_POR_DEFECTO: NivelDeLog = 'INFO'

const MINUTO_MS = 60 * 1000

export interface ConfiguracionDeProceso {
  readonly rutaDeBase: string
  readonly httpPuerto: number
  readonly httpBind: string
  readonly retencion: PoliticaDeRetencion
  readonly intervaloDePurgaMs: number
  readonly nivelDeLog: NivelDeLog
}

export type ErrorDeConfiguracion =
  | { readonly codigo: 'VARIABLE_AUSENTE'; readonly variable: string }
  | {
      readonly codigo: 'VARIABLE_NO_ES_ENTERO'
      readonly variable: string
      readonly recibido: string
    }
  | {
      readonly codigo: 'VARIABLE_FUERA_DE_RANGO'
      readonly variable: string
      readonly recibido: number
      readonly minimo: number
      readonly maximo: number
    }
  /**
   * La clave de cifrado de credenciales ya la valida `crearServidor`, que muere
   * si falta. Se adelanta aca para que el arranque liste de una sola vez todo lo
   * que hay que corregir, en vez de fallar por configuracion, arreglarla y
   * recien entonces enterarse de que ademas falta la clave.
   */
  | { readonly codigo: 'CLAVE_DE_CREDENCIALES_INVALIDA'; readonly detalle: string }
  | {
      readonly codigo: 'NIVEL_DE_LOG_INVALIDO'
      readonly variable: string
      readonly recibido: string
    }

type Entorno = Readonly<Record<string, string | undefined>>

function leerEnteroOpcional(
  entorno: Entorno,
  variable: string,
  porDefecto: number,
  minimo: number,
  maximo: number,
): Result<number, ErrorDeConfiguracion> {
  const crudo = entorno[variable]
  if (crudo === undefined || crudo.trim() === '') {
    return { ok: true, valor: porDefecto }
  }

  const texto = crudo.trim()
  // `Number()` acepta '1e3', ' 12 ' y '0x10'. Para un puerto o una cantidad de
  // dias eso es una errata, no una notacion alternativa.
  if (!/^\d+$/.test(texto)) {
    return { ok: false, error: { codigo: 'VARIABLE_NO_ES_ENTERO', variable, recibido: texto } }
  }

  const numero = Number(texto)
  if (numero < minimo || numero > maximo) {
    return {
      ok: false,
      error: { codigo: 'VARIABLE_FUERA_DE_RANGO', variable, recibido: numero, minimo, maximo },
    }
  }

  return { ok: true, valor: numero }
}

/**
 * Lee y valida el entorno del proceso.
 *
 * El entorno entra por parametro y no se lee `process.env` adentro: es lo que
 * permite afirmar el arranque fallido en un test sin ensuciar el proceso, igual
 * que hace `leerClaveDeCifrado`.
 */
export function leerConfiguracion(
  entorno: Entorno,
): Result<ConfiguracionDeProceso, readonly ErrorDeConfiguracion[]> {
  const errores: ErrorDeConfiguracion[] = []

  const rutaCruda = entorno[VARIABLE_DE_RUTA_DE_BASE]
  const rutaDeBase = rutaCruda === undefined ? '' : rutaCruda.trim()
  if (rutaDeBase === '') {
    errores.push({ codigo: 'VARIABLE_AUSENTE', variable: VARIABLE_DE_RUTA_DE_BASE })
  }

  // El minimo es 0 y no 1: 0 significa "el que asigne el sistema", y es lo que
  // usan los tests y una prueba a mano para no pelear por un puerto ocupado. El
  // puerto real siempre sale en la linea SERVER_LISTENING, asi que no se pierde.
  const puerto = leerEnteroOpcional(entorno, VARIABLE_DE_PUERTO, PUERTO_POR_DEFECTO, 0, 65535)
  if (!puerto.ok) {
    errores.push(puerto.error)
  }

  const bindCrudo = entorno[VARIABLE_DE_BIND]
  const httpBind = bindCrudo === undefined || bindCrudo.trim() === '' ? BIND_POR_DEFECTO : bindCrudo.trim()

  // Techo de 3650 dias: mas que eso no es una politica de retencion, es un cero
  // de mas y una purga que nunca corre.
  const retencionDias = leerEnteroOpcional(
    entorno,
    VARIABLE_DE_RETENCION_DIAS,
    RETENCION_DIAS_POR_DEFECTO,
    1,
    3650,
  )
  if (!retencionDias.ok) {
    errores.push(retencionDias.error)
  }

  const purgaMinutos = leerEnteroOpcional(
    entorno,
    VARIABLE_DE_PURGA_MINUTOS,
    PURGA_MINUTOS_POR_DEFECTO,
    1,
    7 * 24 * 60,
  )
  if (!purgaMinutos.ok) {
    errores.push(purgaMinutos.error)
  }

  const nivelCrudo = entorno[VARIABLE_DE_NIVEL_DE_LOG]
  const nivelTexto = nivelCrudo === undefined ? '' : nivelCrudo.trim().toUpperCase()
  const nivelValido = nivelTexto === '' || esNivelDeLog(nivelTexto)
  if (!nivelValido) {
    errores.push({
      codigo: 'NIVEL_DE_LOG_INVALIDO',
      variable: VARIABLE_DE_NIVEL_DE_LOG,
      recibido: nivelTexto,
    })
  }
  const nivelDeLog: NivelDeLog =
    nivelTexto !== '' && esNivelDeLog(nivelTexto) ? nivelTexto : NIVEL_POR_DEFECTO

  const clave = leerClaveDeCifrado(entorno)
  if (!clave.ok) {
    errores.push({
      codigo: 'CLAVE_DE_CREDENCIALES_INVALIDA',
      detalle: describirErrorDeClave(clave.error),
    })
  }

  if (errores.length > 0 || !puerto.ok || !retencionDias.ok || !purgaMinutos.ok) {
    return { ok: false, error: errores }
  }

  return {
    ok: true,
    valor: {
      rutaDeBase,
      httpPuerto: puerto.valor,
      httpBind,
      retencion: { diasDePedidosTerminados: retencionDias.valor },
      intervaloDePurgaMs: purgaMinutos.valor * MINUTO_MS,
      nivelDeLog,
    },
  }
}

/** Mensaje de arranque: que variable, que tiene y que se esperaba. Se lee una sola vez. */
export function describirErrorDeConfiguracion(error: ErrorDeConfiguracion): string {
  switch (error.codigo) {
    case 'VARIABLE_AUSENTE':
      return `falta la variable de entorno ${error.variable}.`
    case 'VARIABLE_NO_ES_ENTERO':
      return `la variable de entorno ${error.variable} tiene "${error.recibido}" y se espera un entero.`
    case 'VARIABLE_FUERA_DE_RANGO':
      return `la variable de entorno ${error.variable} vale ${String(error.recibido)} y el rango es ${String(error.minimo)}..${String(error.maximo)}.`
    case 'CLAVE_DE_CREDENCIALES_INVALIDA':
      return error.detalle
    case 'NIVEL_DE_LOG_INVALIDO':
      return `la variable de entorno ${error.variable} tiene "${error.recibido}" y los niveles son ${NIVELES.join(', ')}.`
  }
}
