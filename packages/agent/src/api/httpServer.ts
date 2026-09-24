// RF21 y RF22 — API HTTP local, solo hacia la LAN de la sucursal.
//
// El ingreso de pedidos de picking ya no entra por aca: entra por el servidor
// (RF26). Quedan las ordenes MANUALES de la tablet, la consulta, retry, cancel,
// pausa y reanudacion de cola, dispositivos, comando directo a PLC, slots,
// metricas y health.
//
// Sin login de operario: todo lo que consume la tablet va sin credencial y el
// control es de red (el listener bindea a la IP de LAN, no a 0.0.0.0).
//
// El segundo nivel de autorizacion de RF22 —el token de mantenimiento del
// comando directo a PLC, el unico endpoint que escribe registros salteandose el
// orquestador y las maquinas de estado— NO esta declarado: RF22 figura entero en
// "RF sin cobertura" y ningun test portado manda credencial. Entra con su test.

import { noImplementado } from '@aoki-one/domain'

import type { DependenciasDelOrquestador } from '../orchestrator/ports.js'

/**
 * Envelope de respuesta de TODA la API, tal como lo consume el front.
 *
 * `created` solo aparece en las altas: `true` con 202 cuando la orden es nueva,
 * `false` con 200 cuando el alta se dedupica contra una existente.
 */
export type CuerpoDeRespuesta<T> =
  | { readonly ok: true; readonly data: T; readonly created?: boolean }
  | { readonly ok: false; readonly error: string }

export interface DependenciasDeApi {
  readonly orquestador: DependenciasDelOrquestador
  /** RF20: el default es `false`. Arrancar sin configuracion no simula en silencio. */
  readonly simularPlc: boolean
}

export interface DireccionDeEscucha {
  readonly host: string
  readonly puerto: number
}

export interface ServidorHttp {
  /**
   * Levanta el listener. `bind` es la interfaz de escucha y por defecto NO es
   * `0.0.0.0`; el puerto se respeta (hoy `3000` esta cableado en el codigo).
   * Con puerto 0 el sistema asigna uno libre, que es lo que usan los tests.
   */
  readonly escuchar: (puerto: number, bind: string) => Promise<DireccionDeEscucha>
  readonly cerrar: () => Promise<void>
}

export function crearServidorHttp(dependencias: DependenciasDeApi): ServidorHttp {
  return noImplementado('crearServidorHttp', { dependencias })
}
