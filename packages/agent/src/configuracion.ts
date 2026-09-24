// T26/T38 — Configuracion del proceso del agente, leida del entorno.
//
// El agente corre en una notebook de la sucursal que nadie mira: arranca sola al
// prender la maquina y la unica persona cerca es un operario frente a la tablet.
// Una variable mal puesta no puede degradar en un default silencioso, porque el
// sintoma seria "el robot no se mueve" o, peor, "la API contesta ok y el robot no
// se mueve" (RF20).
//
// Mismo criterio que `packages/server/src/configuracion.ts`: se valida TODO antes
// de abrir la base o el puerto, y se devuelven TODOS los errores juntos, no el
// primero. Quien pone la notebook en marcha esta parado en la sucursal: corrige
// una pasada y no descubre la siguiente variable rota recien en el proximo
// reinicio.

import { parsearLocationCode, type NivelDeLog, type Result } from '@aoki-one/domain'

import type { OpcionesDeEnlaceDelAgente } from './composition.js'
import type { PoliticaDeRetencion } from './persistence/retencion.js'
import { esNivelDeLog, NIVELES } from './registro.js'

/** Sucursal a la que pertenece este agente. La emite el servidor con la credencial. */
export const VARIABLE_DE_SITE_ID = 'AOKI_AGENT_SITE_ID'
export const VARIABLE_DE_AGENT_ID = 'AOKI_AGENT_ID'
export const VARIABLE_DE_RUTA_DE_BASE = 'AOKI_AGENT_RUTA_DE_BASE'
export const VARIABLE_DE_ZONA_DE_PICKEO = 'AOKI_AGENT_ZONA_DE_PICKEO'
export const VARIABLE_DE_MONTAR_API = 'AOKI_AGENT_MONTAR_API'
export const VARIABLE_DE_PUERTO = 'AOKI_AGENT_HTTP_PUERTO'
export const VARIABLE_DE_BIND = 'AOKI_AGENT_HTTP_BIND'
export const VARIABLE_DE_SIMULAR_PLC = 'AOKI_AGENT_SIMULAR_PLC'
export const VARIABLE_DE_TOKEN_DE_MANTENIMIENTO = 'AOKI_AGENT_TOKEN_DE_MANTENIMIENTO'
export const VARIABLE_DE_SERVIDOR_URL = 'AOKI_AGENT_SERVIDOR_URL'
export const VARIABLE_DE_KEY_ID = 'AOKI_AGENT_KEY_ID'
export const VARIABLE_DE_SECRETO = 'AOKI_AGENT_SECRETO'
export const VARIABLE_DE_RETENCION_EVENTOS_DIAS = 'AOKI_AGENT_RETENCION_EVENTOS_DIAS'
export const VARIABLE_DE_RETENCION_PASOS_DIAS = 'AOKI_AGENT_RETENCION_PASOS_DIAS'
export const VARIABLE_DE_PURGA_MINUTOS = 'AOKI_AGENT_PURGA_CADA_MINUTOS'
export const VARIABLE_DE_NIVEL_DE_LOG = 'AOKI_AGENT_NIVEL_DE_LOG'

/** Las tres variables del enlace. O estan las tres o no esta ninguna. */
const VARIABLES_DEL_ENLACE: readonly string[] = [
  VARIABLE_DE_SERVIDOR_URL,
  VARIABLE_DE_KEY_ID,
  VARIABLE_DE_SECRETO,
]

const PUERTO_POR_DEFECTO = 3000

/**
 * Loopback por defecto, y a proposito.
 *
 * RF22 apoya TODA la autorizacion del operario en la red: no hay login, y estar
 * en la LAN de la sucursal equivale a estar parado frente a la tablet. Ese
 * razonamiento se cae si el listener queda en `0.0.0.0`, porque entonces
 * cualquier otra interfaz que la notebook tenga —el wifi de invitados, una VPN,
 * el telefono compartiendo datos— tambien pasa a ser "estar frente a la
 * tablet". Abrirlo a la IP de LAN es una decision explicita que se escribe en el
 * archivo de entorno; el default no puede tomarla por nadie.
 */
const BIND_POR_DEFECTO = '127.0.0.1'

const RETENCION_EVENTOS_DIAS_POR_DEFECTO = 30
const RETENCION_PASOS_DIAS_POR_DEFECTO = 14
const PURGA_MINUTOS_POR_DEFECTO = 60
const NIVEL_POR_DEFECTO: NivelDeLog = 'INFO'

const MINUTO_MS = 60 * 1000
const DIA_MS = 24 * 60 * MINUTO_MS

export interface ConfiguracionDelAgente {
  readonly siteId: string
  readonly agentId: string
  readonly rutaDeBase: string
  readonly montarApi: boolean
  readonly simularPlc: boolean
  readonly httpPuerto: number
  readonly httpBind: string
  readonly zonaDePickeo: readonly string[]
  readonly tokenDeMantenimiento: string | null
  readonly enlace: OpcionesDeEnlaceDelAgente | null
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
  | {
      readonly codigo: 'VARIABLE_NO_ES_BOOLEANO'
      readonly variable: string
      readonly recibido: string
    }
  | {
      readonly codigo: 'NIVEL_DE_LOG_INVALIDO'
      readonly variable: string
      readonly recibido: string
    }
  /** Un codigo de la zona de pickeo no pasa la gramatica de planta. */
  | {
      readonly codigo: 'UBICACION_INVALIDA'
      readonly variable: string
      readonly recibido: string
    }
  | { readonly codigo: 'URL_INVALIDA'; readonly variable: string; readonly recibido: string }
  /**
   * Hay parte de la configuracion del enlace pero no toda.
   *
   * No se degrada a "enlace apagado": una URL sin credencial es un despliegue a
   * medio terminar, y dejarlo arrancar sin servidor produce una sucursal que
   * parece andar y no reporta nada. Es el mismo criterio que ya expresa el tipo
   * `OpcionesDeEnlaceDelAgente`, que no deja construir medio enlace.
   */
  | { readonly codigo: 'ENLACE_INCOMPLETO'; readonly faltan: readonly string[] }

type Entorno = Readonly<Record<string, string | undefined>>

/** El valor de la variable sin espacios, o `''` si no esta. */
function leerTexto(entorno: Entorno, variable: string): string {
  return entorno[variable]?.trim() ?? ''
}

function leerObligatoria(
  entorno: Entorno,
  variable: string,
  errores: ErrorDeConfiguracion[],
): string {
  const valor = leerTexto(entorno, variable)
  if (valor === '') {
    errores.push({ codigo: 'VARIABLE_AUSENTE', variable })
  }
  return valor
}

function leerEnteroOpcional(
  entorno: Entorno,
  variable: string,
  porDefecto: number,
  minimo: number,
  maximo: number,
  errores: ErrorDeConfiguracion[],
): number {
  const texto = leerTexto(entorno, variable)
  if (texto === '') {
    return porDefecto
  }

  // `Number()` acepta '1e3', ' 12 ' y '0x10'. Para un puerto o una cantidad de
  // dias eso es una errata, no una notacion alternativa.
  if (!/^\d+$/.test(texto)) {
    errores.push({ codigo: 'VARIABLE_NO_ES_ENTERO', variable, recibido: texto })
    return porDefecto
  }

  const numero = Number(texto)
  if (numero < minimo || numero > maximo) {
    errores.push({ codigo: 'VARIABLE_FUERA_DE_RANGO', variable, recibido: numero, minimo, maximo })
    return porDefecto
  }

  return numero
}

/**
 * Booleano estricto: solo `true` o `false`.
 *
 * No se aceptan `1`, `si` ni `yes`. Con la simulacion de PLC de por medio, ser
 * permisivo es peligroso al reves de lo que parece: un `SIMULAR_PLC=si` leido
 * como "no lo entiendo, va el default false" arranca contra un PLC que no esta,
 * y un `=no` leido como "algo dice, va true" deja a la planta creyendo que el
 * robot se mueve. Un valor que nadie sabe leer es un error, no un default.
 */
function leerBooleanoOpcional(
  entorno: Entorno,
  variable: string,
  porDefecto: boolean,
  errores: ErrorDeConfiguracion[],
): boolean {
  const texto = leerTexto(entorno, variable).toLowerCase()
  if (texto === '') {
    return porDefecto
  }
  if (texto === 'true') {
    return true
  }
  if (texto === 'false') {
    return false
  }
  errores.push({ codigo: 'VARIABLE_NO_ES_BOOLEANO', variable, recibido: texto })
  return porDefecto
}

/**
 * La zona de pickeo: los slots donde el robot deja lo que saca de la estanteria.
 *
 * Es obligatoria y va validada codigo por codigo contra la gramatica de planta.
 * Un codigo mal escrito no se puede sembrar igual: la seleccion de slot (RF09)
 * elige entre estos y nada mas, asi que un slot fantasma deja ordenes esperando
 * un lugar que no existe, y una zona vacia deja al agente sin poder ejecutar un
 * solo PICK. Las dos cosas se ven en planta como "se colgo".
 */
function leerZonaDePickeo(entorno: Entorno, errores: ErrorDeConfiguracion[]): readonly string[] {
  const crudo = leerTexto(entorno, VARIABLE_DE_ZONA_DE_PICKEO)
  const codigos = crudo
    .split(',')
    .map((codigo) => codigo.trim().toUpperCase())
    .filter((codigo) => codigo !== '')

  if (codigos.length === 0) {
    errores.push({ codigo: 'VARIABLE_AUSENTE', variable: VARIABLE_DE_ZONA_DE_PICKEO })
    return []
  }

  // Se reportan TODOS los invalidos, no el primero: en una lista de doce slots
  // escritos a mano, corregir de a uno por reinicio no es una opcion razonable.
  for (const codigo of codigos) {
    if (!parsearLocationCode(codigo).ok) {
      errores.push({
        codigo: 'UBICACION_INVALIDA',
        variable: VARIABLE_DE_ZONA_DE_PICKEO,
        recibido: codigo,
      })
    }
  }

  return codigos
}

/** True si es una URL http o https. Otro esquema no lo sabe hablar el cliente del enlace. */
function esUrlDeServidor(texto: string): boolean {
  let url: URL
  try {
    url = new URL(texto)
  } catch {
    return false
  }
  return url.protocol === 'http:' || url.protocol === 'https:'
}

/**
 * El enlace con el servidor, o `null` si esta apagado.
 *
 * Apagado es el modo del cutover (T26): la sucursal corre primero SOLA, con su
 * cola local, una jornada completa contra el robot real, y recien despues se
 * enciende el enlace. Nunca las dos cosas el mismo dia.
 */
function leerEnlace(
  entorno: Entorno,
  errores: ErrorDeConfiguracion[],
): OpcionesDeEnlaceDelAgente | null {
  const faltan = VARIABLES_DEL_ENLACE.filter((variable) => leerTexto(entorno, variable) === '')
  if (faltan.length === VARIABLES_DEL_ENLACE.length) {
    return null
  }
  if (faltan.length > 0) {
    errores.push({ codigo: 'ENLACE_INCOMPLETO', faltan })
    return null
  }

  const urlBase = leerTexto(entorno, VARIABLE_DE_SERVIDOR_URL)
  if (!esUrlDeServidor(urlBase)) {
    errores.push({ codigo: 'URL_INVALIDA', variable: VARIABLE_DE_SERVIDOR_URL, recibido: urlBase })
    return null
  }

  return {
    // Sin barra final: el cliente arma las rutas concatenando, y una base
    // terminada en barra mas `/api/v1/...` produce un `//` que un proxy puede no
    // resolver igual que el servidor.
    urlBase: urlBase.replace(/\/+$/, ''),
    keyId: leerTexto(entorno, VARIABLE_DE_KEY_ID),
    secreto: leerTexto(entorno, VARIABLE_DE_SECRETO),
  }
}

/**
 * Lee y valida el entorno del proceso del agente.
 *
 * El entorno entra por parametro y no se lee `process.env` adentro: es lo que
 * permite afirmar el arranque fallido en un test sin ensuciar el proceso.
 */
export function leerConfiguracion(
  entorno: Entorno,
): Result<ConfiguracionDelAgente, readonly ErrorDeConfiguracion[]> {
  const errores: ErrorDeConfiguracion[] = []

  const siteId = leerObligatoria(entorno, VARIABLE_DE_SITE_ID, errores)
  // Obligatorio y sin default: prefija el id externo de las ordenes manuales que
  // se empujan al servidor (RF35), asi que dos notebooks con el mismo valor
  // generarian ids que chocan entre si en el libro del servidor.
  const agentId = leerObligatoria(entorno, VARIABLE_DE_AGENT_ID, errores)
  // Sin default: la base va en el disco de esta notebook y nadie mas sabe cual
  // es. Un default relativo al directorio de trabajo crea una base nueva cada
  // vez que el servicio arranca desde otro lado, y con ella una sucursal sin
  // historia y con las ordenes a medias perdidas.
  const rutaDeBase = leerObligatoria(entorno, VARIABLE_DE_RUTA_DE_BASE, errores)
  const zonaDePickeo = leerZonaDePickeo(entorno, errores)

  const montarApi = leerBooleanoOpcional(entorno, VARIABLE_DE_MONTAR_API, true, errores)
  // RF20: default false. Arrancar sin configuracion no puede simular en silencio.
  const simularPlc = leerBooleanoOpcional(entorno, VARIABLE_DE_SIMULAR_PLC, false, errores)

  // El minimo es 0 y no 1: 0 significa "el que asigne el sistema", y es lo que
  // usan los tests y una prueba a mano para no pelear por un puerto ocupado. El
  // puerto real siempre sale en la linea AGENT_LISTENING, asi que no se pierde.
  const httpPuerto = leerEnteroOpcional(
    entorno,
    VARIABLE_DE_PUERTO,
    PUERTO_POR_DEFECTO,
    0,
    65535,
    errores,
  )

  const bindCrudo = leerTexto(entorno, VARIABLE_DE_BIND)
  const httpBind = bindCrudo === '' ? BIND_POR_DEFECTO : bindCrudo

  // RF22, segundo nivel: `null` = comando directo a PLC DESHABILITADO. Falla
  // cerrado a proposito, igual que RF20 con la simulacion.
  const tokenCrudo = leerTexto(entorno, VARIABLE_DE_TOKEN_DE_MANTENIMIENTO)
  const tokenDeMantenimiento = tokenCrudo === '' ? null : tokenCrudo

  const enlace = leerEnlace(entorno, errores)

  const eventosDias = leerEnteroOpcional(
    entorno,
    VARIABLE_DE_RETENCION_EVENTOS_DIAS,
    RETENCION_EVENTOS_DIAS_POR_DEFECTO,
    1,
    3650,
    errores,
  )
  const pasosDias = leerEnteroOpcional(
    entorno,
    VARIABLE_DE_RETENCION_PASOS_DIAS,
    RETENCION_PASOS_DIAS_POR_DEFECTO,
    1,
    3650,
    errores,
  )
  const purgaMinutos = leerEnteroOpcional(
    entorno,
    VARIABLE_DE_PURGA_MINUTOS,
    PURGA_MINUTOS_POR_DEFECTO,
    1,
    7 * 24 * 60,
    errores,
  )

  const nivelTexto = leerTexto(entorno, VARIABLE_DE_NIVEL_DE_LOG).toUpperCase()
  if (nivelTexto !== '' && !esNivelDeLog(nivelTexto)) {
    errores.push({
      codigo: 'NIVEL_DE_LOG_INVALIDO',
      variable: VARIABLE_DE_NIVEL_DE_LOG,
      recibido: nivelTexto,
    })
  }
  const nivelDeLog: NivelDeLog = esNivelDeLog(nivelTexto) ? nivelTexto : NIVEL_POR_DEFECTO

  if (errores.length > 0) {
    return { ok: false, error: errores }
  }

  return {
    ok: true,
    valor: {
      siteId,
      agentId,
      rutaDeBase,
      montarApi,
      simularPlc,
      httpPuerto,
      httpBind,
      zonaDePickeo,
      tokenDeMantenimiento,
      enlace,
      retencion: { eventosMs: eventosDias * DIA_MS, pasosMs: pasosDias * DIA_MS },
      intervaloDePurgaMs: purgaMinutos * MINUTO_MS,
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
    case 'VARIABLE_NO_ES_BOOLEANO':
      return `la variable de entorno ${error.variable} tiene "${error.recibido}" y se espera true o false.`
    case 'NIVEL_DE_LOG_INVALIDO':
      return `la variable de entorno ${error.variable} tiene "${error.recibido}" y los niveles son ${NIVELES.join(', ')}.`
    case 'UBICACION_INVALIDA':
      return `la variable de entorno ${error.variable} trae el codigo "${error.recibido}", que no es una ubicacion valida.`
    case 'URL_INVALIDA':
      return `la variable de entorno ${error.variable} tiene "${error.recibido}" y se espera una URL http o https.`
    case 'ENLACE_INCOMPLETO':
      return `el enlace con el servidor esta configurado a medias: falta ${error.faltan.join(', ')}. Para dejarlo apagado hay que borrar las tres variables (${VARIABLES_DEL_ENLACE.join(', ')}).`
  }
}
