// T37 — Arranque del proceso del servidor.
//
// Junta las tres cosas que hacen que el servicio sea operable en un Linux:
// configuracion validada antes de abrir nada, logs estructurados de cada hito
// del ciclo de vida, y la purga por retencion corriendo sola.
//
// Vive separado de `index.ts` para poder afirmarlo en un test: `index.ts` toca
// `process` (senales, exit code) y eso no se prueba sin ensuciar el proceso.

import type { Logger, Result } from '@aoki-one/domain'

import { crearServidor } from './composition.js'
import type { DireccionDeEscucha, Servidor } from './composition.js'
import { describirErrorDeConfiguracion, leerConfiguracion } from './configuracion.js'
import type { ConfiguracionDeProceso, ErrorDeConfiguracion } from './configuracion.js'

export interface DependenciasDeArranque {
  readonly entorno: Readonly<Record<string, string | undefined>>
  readonly logger: Logger
  /**
   * Fabrica del servidor. Se inyecta solo para los tests del arranque; en
   * produccion es `crearServidor`.
   */
  readonly crear?: (opciones: Parameters<typeof crearServidor>[0]) => Servidor
}

export interface ProcesoDelServidor {
  readonly detener: () => Promise<void>
  readonly direccion: () => DireccionDeEscucha | null
  readonly configuracion: ConfiguracionDeProceso
}

export type ErrorDeArranque =
  | { readonly codigo: 'CONFIGURACION_INVALIDA'; readonly errores: readonly ErrorDeConfiguracion[] }
  /**
   * La configuracion estaba bien pero el servidor no pudo abrir: base con el
   * esquema viejo, puerto ocupado, directorio sin permiso de escritura.
   */
  | { readonly codigo: 'NO_PUDO_ABRIR'; readonly detalle: string }

function describirExcepcion(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Levanta el servidor o devuelve por que no pudo.
 *
 * No llama a `process.exit` ni escucha senales: eso es del entry point. Aca el
 * fallo es un valor, asi que un test puede afirmarlo.
 */
export async function arrancar(
  dependencias: DependenciasDeArranque,
): Promise<Result<ProcesoDelServidor, ErrorDeArranque>> {
  const { entorno, logger } = dependencias

  const configuracion = leerConfiguracion(entorno)
  if (!configuracion.ok) {
    // Una linea por variable rota, no una sola con todo junto: asi se puede
    // filtrar por codigo y se lee igual de bien en el journal que en la consola.
    for (const error of configuracion.error) {
      logger.error('CONFIG_INVALID', {
        codigo: error.codigo,
        detalle: describirErrorDeConfiguracion(error),
      })
    }
    return { ok: false, error: { codigo: 'CONFIGURACION_INVALIDA', errores: configuracion.error } }
  }

  const { rutaDeBase, httpPuerto, httpBind, retencion, intervaloDePurgaMs } = configuracion.valor
  const crear = dependencias.crear ?? crearServidor

  let servidor: Servidor
  try {
    // El MISMO logger del proceso, no uno nuevo: el nivel configurado y el
    // destino valen igual para el ciclo de vida y para las lineas por orden, y
    // dos loggers distintos sobre el mismo stdout es como se termina con la
    // mitad de las lineas en un nivel que nadie pidio.
    servidor = crear({ rutaDeBase, httpPuerto, httpBind, retencion, entorno, logger })
    await servidor.iniciar()
  } catch (error) {
    logger.error('STARTUP_FAILED', { detalle: describirExcepcion(error) })
    return { ok: false, error: { codigo: 'NO_PUDO_ABRIR', detalle: describirExcepcion(error) } }
  }

  const escucha = servidor.direccion()
  logger.info('SERVER_LISTENING', {
    host: escucha?.host ?? httpBind,
    puerto: escucha?.puerto ?? httpPuerto,
    rutaDeBase,
    // Queda en el log a proposito: es con lo que se diagnostica "el proxy no
    // llega" sin tener que entrar a leer el archivo de entorno.
    retencionDias: retencion.diasDePedidosTerminados,
  })

  function correrPurga(): void {
    try {
      const resultado = servidor.purgar(Date.now())
      logger.info('PURGE_DONE', { ...resultado })
    } catch (error) {
      // Una purga que falla no puede tirar el servicio: lo que se deja de borrar
      // es historia vieja, lo que se dejaria de atender son pedidos de hoy.
      logger.error('PURGE_FAILED', { detalle: describirExcepcion(error) })
    }
  }

  // Una pasada al arrancar: si el servicio se reinicia todos los dias, un
  // intervalo largo por si solo no llegaria a correr nunca.
  correrPurga()
  const temporizador = setInterval(correrPurga, intervaloDePurgaMs)
  // Quien mantiene vivo al proceso es el puerto, no este timer.
  temporizador.unref()

  return {
    ok: true,
    valor: {
      configuracion: configuracion.valor,
      direccion: () => servidor.direccion(),
      detener: async () => {
        clearInterval(temporizador)
        await servidor.detener()
        logger.info('SERVER_STOPPED')
      },
    },
  }
}
