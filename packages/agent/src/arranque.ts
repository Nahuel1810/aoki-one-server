// T26/T38 — Arranque del proceso del agente.
//
// Es el equivalente de `packages/server/src/arranque.ts` del lado de la
// sucursal, y existe por el mismo motivo: `index.ts` toca `process` —senales,
// exit code— y eso no se prueba sin ensuciar el proceso. Aca el fallo es un
// VALOR, asi que un test puede afirmar que con el entorno roto no se levanta.
//
// Lo que junta: configuracion validada antes de abrir la base o el puerto, logs
// estructurados de cada hito del ciclo de vida, y una linea explicita por cada
// capacidad que queda APAGADA. Esto ultimo no es decoracion: los defaults del
// agente fallan cerrados a proposito (RF20 con la simulacion, RF22 con el
// comando directo, T26 con el enlace), y un default que falla cerrado sin
// decirlo se ve en planta como "no anda y no se por que".

import type { Logger, Result } from '@aoki-one/domain'

import type { DireccionDeEscucha } from './api/httpServer.js'
import { crearAgente } from './composition.js'
import type { Agente, OpcionesDelAgente } from './composition.js'
import { describirErrorDeConfiguracion, leerConfiguracion } from './configuracion.js'
import type { ConfiguracionDelAgente, ErrorDeConfiguracion } from './configuracion.js'

export interface DependenciasDeArranque {
  readonly entorno: Readonly<Record<string, string | undefined>>
  readonly logger: Logger
  /**
   * Fabrica del agente. Se inyecta solo para los tests del arranque; en
   * produccion es `crearAgente`.
   */
  readonly crear?: (opciones: OpcionesDelAgente) => Agente
}

export interface ProcesoDelAgente {
  readonly detener: () => Promise<void>
  /** `null` con la API desmontada: el agente ejecuta ordenes igual (RF33). */
  readonly direccion: () => DireccionDeEscucha | null
  readonly configuracion: ConfiguracionDelAgente
}

export type ErrorDeArranque =
  | { readonly codigo: 'CONFIGURACION_INVALIDA'; readonly errores: readonly ErrorDeConfiguracion[] }
  /**
   * La configuracion estaba bien pero el agente no pudo abrir: base con el
   * esquema viejo, puerto ocupado, disco sin permiso de escritura.
   */
  | { readonly codigo: 'NO_PUDO_ABRIR'; readonly detalle: string }

function describirExcepcion(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Deja constancia de lo que quedo apagado.
 *
 * Las tres capacidades que el agente NO habilita sin configuracion explicita se
 * escriben en el log al arrancar, una linea cada una. Es lo que convierte
 * "arranco sin conectarse a nada" en un hecho verificable a las 7 de la manana
 * en la notebook de la sucursal, en vez de un diagnostico de media hora.
 */
function anunciarLoQueEstaApagado(logger: Logger, configuracion: ConfiguracionDelAgente): void {
  if (configuracion.simularPlc) {
    // WARN y no INFO: es el unico de los tres que hace que la API conteste OK
    // sin que el robot se mueva (RF20). En produccion esta linea no deberia
    // existir, y por eso tiene que saltar a la vista cuando existe.
    logger.warn('PLC_SIMULATED')
  }
  if (configuracion.enlace === null) {
    // El modo del cutover (T26): la sucursal corre una jornada completa sola,
    // con su cola local, y recien despues se enciende el enlace.
    logger.info('LINK_DISABLED')
  }
  if (configuracion.tokenDeMantenimiento === null) {
    logger.info('MAINTENANCE_COMMAND_DISABLED')
  }
}

/**
 * Levanta el agente o devuelve por que no pudo.
 *
 * No llama a `process.exit` ni escucha senales: eso es del entry point.
 */
export async function arrancar(
  dependencias: DependenciasDeArranque,
): Promise<Result<ProcesoDelAgente, ErrorDeArranque>> {
  const { entorno, logger } = dependencias

  const configuracion = leerConfiguracion(entorno)
  if (!configuracion.ok) {
    // Una linea por variable rota, no una sola con todo junto: asi se puede
    // filtrar por codigo y se lee igual de bien en un archivo que en la consola
    // que quedo abierta en la notebook.
    for (const error of configuracion.error) {
      logger.error('CONFIG_INVALID', {
        codigo: error.codigo,
        detalle: describirErrorDeConfiguracion(error),
      })
    }
    return { ok: false, error: { codigo: 'CONFIGURACION_INVALIDA', errores: configuracion.error } }
  }

  const valor = configuracion.valor
  const crear = dependencias.crear ?? crearAgente

  let agente: Agente
  try {
    agente = crear({
      siteId: valor.siteId,
      agentId: valor.agentId,
      rutaDeBase: valor.rutaDeBase,
      montarApi: valor.montarApi,
      simularPlc: valor.simularPlc,
      httpPuerto: valor.httpPuerto,
      httpBind: valor.httpBind,
      zonaDePickeo: valor.zonaDePickeo,
      tokenDeMantenimiento: valor.tokenDeMantenimiento,
      enlace: valor.enlace,
      retencion: valor.retencion,
      intervaloDePurgaMs: valor.intervaloDePurgaMs,
      // El MISMO logger del proceso: el nivel configurado vale igual para el
      // ciclo de vida y para las lineas por orden.
      logger,
    })
    await agente.iniciar()
  } catch (error) {
    logger.error('STARTUP_FAILED', { detalle: describirExcepcion(error) })
    return { ok: false, error: { codigo: 'NO_PUDO_ABRIR', detalle: describirExcepcion(error) } }
  }

  const escucha = agente.direccion()
  logger.info('AGENT_STARTED', {
    siteId: valor.siteId,
    agentId: valor.agentId,
    rutaDeBase: valor.rutaDeBase,
    // El secreto del enlace NUNCA sale al log. La URL si: es lo que se mira
    // cuando la sucursal no reporta y hay un proxy o un DNS de por medio.
    servidor: valor.enlace?.urlBase ?? null,
    zonaDePickeo: valor.zonaDePickeo.length,
  })
  anunciarLoQueEstaApagado(logger, valor)

  if (escucha === null) {
    logger.info('AGENT_API_DISABLED')
  } else {
    logger.info('AGENT_LISTENING', { host: escucha.host, puerto: escucha.puerto })
  }

  return {
    ok: true,
    valor: {
      configuracion: valor,
      direccion: () => agente.direccion(),
      detener: async () => {
        await agente.detener()
        logger.info('AGENT_STOPPED')
      },
    },
  }
}
