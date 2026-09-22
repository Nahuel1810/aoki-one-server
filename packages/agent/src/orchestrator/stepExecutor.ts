// RF12, RF13 y RF19 — Ejecucion de un paso con reintentos.
//
// Un paso avanza por CONFIRMACION del PLC, no por envio. Se reintenta solo lo
// que RF19 permite reintentar; el codigo de error 99 del PLC es fatal y corta en
// el primer intento, con su mensaje propagado tal cual al `errorReason` de la
// orden.
//
// RF13: un paso que falla NO manda el slot a ERROR. El slot conserva su estado
// (RESERVADO si fallo un PICK, OCUPADO si fallo un PUT) a la espera del retry.
// Es el cambio de contrato mas importante del grupo: el legacy llama `blockSlot`
// y deja el slot inutilizable para siempre, porque el retry no lo desbloquea.

import { esReintentable } from '../transport/errorClassification.js'
import { proximoBackoffMs } from './retryPolicy.js'
import type { PasoDeOrden, Result } from '@aoki-one/domain'

import type { FalloDeEjecucion } from '../transport/errorClassification.js'
import type { PedidoDeComando, RespuestaUtilPlc } from '../transport/stepHandshake.js'
import type { DependenciasDePaso } from './ports.js'

export interface ContextoDePaso {
  readonly ordenId: string
  readonly robotId: string
  readonly paso: PasoDeOrden
}

/**
 * Traduce un paso de la secuencia al comando que viaja al PLC.
 *
 * HOMING es el INIT del carro; los pasos 2 y 4 son el ir-a-nivel del elevador; 3
 * y 5 son el comando de carro ya armado. La respuesta esperada por defecto es
 * `[100]`.
 *
 * No toma `robotId` ni devuelve el tipo de dispositivo: el ruteo sale del propio
 * paso (`PasoDeOrden` ya declara su `dispositivo`) y del contexto, y el pedido es
 * solo que mandar y con que respuesta se da por cerrado.
 */
export function pedidoDeComandoDePaso(paso: PasoDeOrden): PedidoDeComando {
  // El comando del carro viaja como numero; el del elevador ya lo es.
  const comando = typeof paso.comando === 'number' ? paso.comando : paso.comando.codigo
  // Todo paso espera el 100 (OK) y nada mas: un codigo del rango 1## es un error
  // del PLC y tiene que salir por el canal de fallo, no confirmar el paso.
  return { comando, respuestasEsperadas: [100] }
}


export interface PasoEjecutado {
  /** Un paso del camino feliz consume exactamente 1 intento. */
  readonly intentos: number
  /** Solo una respuesta util: un ERROR del PLC sale por `FalloDeEjecucion`. */
  readonly respuesta: RespuestaUtilPlc
}

export type ErrorDeEjecucionDePaso =
  /** Fatal: una sola llamada al transporte, sin reintento. */
  | { readonly codigo: 'FALLO_FATAL'; readonly intentos: number; readonly fallo: FalloDeEjecucion }
  | {
      readonly codigo: 'REINTENTOS_AGOTADOS'
      readonly intentos: number
      readonly ultimoFallo: FalloDeEjecucion
    }

/**
 * Ejecuta el paso, reintentando con backoff exponencial entre intentos.
 *
 * `maxIntentos` son intentos TOTALES: con 3 y tres fallos seguidos hay
 * exactamente 3 llamadas al transporte y despues REINTENTOS_AGOTADOS. Agotar los
 * intentos es por ahora la unica salida: el corte por deadline entra con su test
 * (ver `PoliticaDeReintentos`).
 */
export async function ejecutarPasoConReintentos(
  dependencias: DependenciasDePaso,
  contexto: ContextoDePaso,
): Promise<Result<PasoEjecutado, ErrorDeEjecucionDePaso>> {
  const { transporte, reloj, politica } = dependencias
  const pedido = pedidoDeComandoDePaso(contexto.paso)

  let intentos = 0
  let ultimoFallo: FalloDeEjecucion | undefined

  while (intentos < politica.maxIntentos) {
    intentos += 1

    const resultado = await transporte.ejecutarComandoDePaso(
      contexto.robotId,
      contexto.paso.dispositivo,
      pedido,
    )

    if (resultado.ok) {
      return { ok: true, valor: { intentos, respuesta: resultado.valor } }
    }

    ultimoFallo = resultado.error

    // El 99 del PLC corta en el primer intento: "No logro recuperarse" significa
    // que el propio PLC ya agoto su recuperacion, y reintentar solo demora el
    // aviso al operario.
    if (!esReintentable(resultado.error)) {
      return { ok: false, error: { codigo: 'FALLO_FATAL', intentos, fallo: resultado.error } }
    }

    if (intentos < politica.maxIntentos) {
      await reloj.dormir(proximoBackoffMs(intentos, politica.baseBackoffMs))
    }
  }

  return {
    ok: false,
    error: {
      codigo: 'REINTENTOS_AGOTADOS',
      intentos,
      // Solo se llega aca despues de al menos un fallo reintentable.
      ultimoFallo: ultimoFallo ?? {
        tipo: 'PROGRAMACION',
        mensaje: 'se agotaron los reintentos sin registrar ningun fallo',
      },
    },
  }
}
