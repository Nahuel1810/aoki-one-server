// RF16 — Mutex por dispositivo.
//
// Exclusion mutua estricta sobre el mismo socket TCP. La razon es empirica y
// esta documentada en el codigo de planta: modbus-serial usa un socket
// half-duplex y dos requests intercalados corrompen frames (timeout,
// 'port not open', silencio del PLC). Era la causa raiz de los cortes del CARRO,
// o sea que buena parte de los ECONNRESET historicos eran autoinfligidos.
//
// Es POR DISPOSITIVO: dos dispositivos distintos corren en paralelo.

import { noImplementado } from '@aoki-one/domain'
import type { ClaveDeDispositivo } from './modbusClient.js'

/**
 * Resultado de un intento sin espera.
 *
 * Union discriminada y no `T | null`: "no corri" y "corri y devolvio null" son
 * cosas distintas, y el monitor decide por esa diferencia.
 */
export type ResultadoDeIntento<T> =
  | { readonly ejecutado: true; readonly valor: T }
  | { readonly ejecutado: false }

export interface DeviceMutex {
  /** Encola la operacion y la corre cuando el dispositivo queda libre. */
  readonly ejecutar: <T>(clave: ClaveDeDispositivo, operacion: () => Promise<T>) => Promise<T>
  /**
   * Corre la operacion solo si el dispositivo esta libre AHORA; si no, no la
   * encola y devuelve `ejecutado: false`.
   *
   * Es lo que usa el monitor de conectividad: si el socket esta ocupado SALTEA
   * el ciclo en vez de sumar una operacion mas a la cola de ese socket.
   */
  readonly intentarEjecutar: <T>(
    clave: ClaveDeDispositivo,
    operacion: () => Promise<T>,
  ) => Promise<ResultadoDeIntento<T>>
  readonly estaTomado: (clave: ClaveDeDispositivo) => boolean
  /** Suelta todos los locks. Solo lo usa el hard-reset de transporte (RF18). */
  readonly liberarTodo: () => void
}

export function crearDeviceMutex(): DeviceMutex {
  return noImplementado('crearDeviceMutex')
}
