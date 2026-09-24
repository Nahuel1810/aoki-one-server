// Composicion del servidor de pedidos.

import { randomUUID } from 'node:crypto'
import process from 'node:process'

import type { Logger } from '@aoki-one/domain'

import { crearServidorHttp } from './api/httpServer.js'
import type { ConfiguracionDelServidor, DireccionDeEscucha, ServidorHttp } from './api/httpServer.js'
import { describirErrorDeClave, leerClaveDeCifrado } from './persistence/cifrado.js'
import { abrirBase } from './persistence/database.js'
import { crearCredentialsRepository } from './persistence/credentialsRepository.js'
import type { CredentialsRepository } from './persistence/credentialsRepository.js'
import { purgar } from './persistence/retencion.js'
import type { PoliticaDeRetencion, ResultadoDePurga } from './persistence/retencion.js'
import { crearColaDelServidor } from './persistence/sqliteOrdersRepository.js'
import type { ColaDelServidor } from './persistence/sqliteOrdersRepository.js'
import { crearLoggerDelServidor } from './registro.js'

export interface OpcionesDelServidor {
  readonly rutaDeBase: string
  readonly httpPuerto: number
  readonly httpBind: string
  readonly configuracion?: Partial<ConfiguracionDelServidor>
  /** Cuanto se conserva un pedido terminado antes de purgarlo. */
  readonly retencion?: PoliticaDeRetencion
  /**
   * Entorno del que sale la clave de cifrado de credenciales.
   *
   * Se inyecta en vez de leer `process.env` adentro para que los tests puedan
   * afirmar el arranque fallido sin pisar el proceso. En produccion se omite.
   */
  readonly entorno?: Readonly<Record<string, string | undefined>>
  /**
   * Destino de los logs estructurados (RNF de Observabilidad).
   *
   * Ausente = stdout, igual que en el agente. El default NO es silencioso a
   * proposito: el modo de falla que importa es quedarse sin la mitad del
   * enlace en produccion sin que nada avise, y eso es justo lo que produce un
   * default que no escribe. En los tests se inyecta `LOGGER_SILENCIOSO`, o un
   * doble cuando lo que se afirma es lo que se loguea.
   */
  readonly logger?: Logger
}

export interface Servidor {
  readonly iniciar: () => Promise<void>
  readonly detener: () => Promise<void>
  readonly direccion: () => DireccionDeEscucha | null
  readonly cola: ColaDelServidor
  readonly credenciales: CredentialsRepository
  /**
   * Borra lo que ya paso la retencion y dice cuanto borro.
   *
   * Lo expone el servidor y no un modulo suelto porque el dueno de la base es
   * el: nadie de afuera deberia tener que abrir una segunda conexion al mismo
   * archivo SQLite para limpiarlo. Quien decide CUANDO corre es el arranque.
   */
  readonly purgar: (ahoraMs: number) => ResultadoDePurga
}

/**
 * Tres meses de historico terminado. Es lo que alcanza para reclamos y para
 * mirar hacia atras una temporada completa sin que el archivo crezca sin techo.
 */
export const RETENCION_POR_DEFECTO: PoliticaDeRetencion = { diasDePedidosTerminados: 90 }

/**
 * Defaults pensados para una sucursal.
 *
 * El long-poll de 25 s queda por debajo del timeout tipico de un proxy (30 s) y
 * de los 60 s de un balanceador: si el servidor contesta primero, la conexion se
 * cierra limpia en vez de cortarse desde el medio.
 *
 * El lease de 60 s es mas largo que la maniobra fisica mas lenta, para que no
 * venza mientras el robot todavia se esta moviendo.
 */
export const CONFIGURACION_POR_DEFECTO: ConfiguracionDelServidor = {
  ventanaDeFirmaMs: 5 * 60 * 1000,
  esperaDeLongPollMs: 25 * 1000,
  sondeoDeLongPollMs: 250,
  duracionDelLeaseMs: 60 * 1000,
  toleranciaDeLatidoMs: 90 * 1000,
}

export function crearServidor(opciones: OpcionesDelServidor): Servidor {
  // Antes de abrir nada: un servidor que arranca sin poder descifrar las
  // credenciales no puede verificar una sola firma, y aceptar trafico que no se
  // puede autenticar es peor que no estar. Muere aca, ruidoso y temprano.
  const clave = leerClaveDeCifrado(opciones.entorno ?? process.env)
  if (!clave.ok) {
    throw new Error(`el servidor no puede arrancar: ${describirErrorDeClave(clave.error)}`)
  }

  const base = abrirBase(opciones.rutaDeBase)
  const cola = crearColaDelServidor(
    base,
    () => randomUUID(),
    () => Date.now(),
  )
  const credenciales = crearCredentialsRepository(base, clave.valor)

  const configuracion: ConfiguracionDelServidor = {
    ...CONFIGURACION_POR_DEFECTO,
    ...opciones.configuracion,
  }

  const http = crearServidorHttp({
    cola,
    credenciales,
    ahora: () => Date.now(),
    dormir: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    configuracion,
    logger: opciones.logger ?? crearLoggerDelServidor({ nivelMinimo: 'INFO' }),
  })

  let direccion: DireccionDeEscucha | null = null

  const retencion = opciones.retencion ?? RETENCION_POR_DEFECTO

  return {
    cola,
    credenciales,
    direccion: () => direccion,

    purgar: (ahoraMs) => purgar(base, ahoraMs, retencion),

    iniciar: async () => {
      direccion = await http.escuchar(opciones.httpPuerto, opciones.httpBind)
    },

    detener: async () => {
      await http.cerrar()
      direccion = null
      base.cerrar()
    },
  }
}

export type {
  ConfiguracionDelServidor,
  DireccionDeEscucha,
  PoliticaDeRetencion,
  ResultadoDePurga,
  ServidorHttp,
}
