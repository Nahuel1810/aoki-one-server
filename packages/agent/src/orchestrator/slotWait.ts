// RF10 y RF05 — Que slot usa la orden, o por que espera.
//
// Un PICK toma el slot libre mas cercano del MISMO LADO (el ranking es dominio
// puro). Si no hay ninguno, la orden NO se reencola: queda PENDING con
// `waitingForSlot` en true y el robot se libera. Conserva su `creadaEn`, que es
// como no pierde su lugar: el legacy hace `clearActive` mas `enqueue` y la manda
// al final de la cola cada vez que espera.
//
// Un PUT espera por la misma via cuando el slot que tiene que tomar esta ocupado
// por otra maniobra o inutilizable: esperar es el resultado, no un error (ver
// `resolverDestinoDePut`).
//
// La espera es por lado: una orden esperando el lado izquierdo no bloquea a una
// del derecho.

import type {
  ErrorLocationCode,
  ErrorSeleccionSlot,
  Lado,
  NombreEstadoSlot,
  Result,
} from '@aoki-one/domain'

import { noImplementadoAsync } from '../noImplementadoAsync.js'
import type { Orden } from '../persistence/index.js'
import type { ErrorDeDestinoDePut } from './putTargetResolution.js'
import type { DependenciasDelOrquestador } from './ports.js'

/**
 * Por que espera la orden.
 *
 * Los dos motivos se resuelven distinto y por eso se distinguen: el PICK se
 * reactiva cuando se libera CUALQUIER slot de ese lado, y el PUT cuando se libera
 * EL suyo.
 */
export type MotivoDeEspera =
  /** PICK sin ningun slot LIBRE de ese lado. */
  | { readonly tipo: 'SIN_SLOT_LIBRE' }
  /** PUT sobre un slot que ahora esta RESERVADO, BUSCANDO, DEVOLVIENDO o ERROR. */
  | {
      readonly tipo: 'SLOT_DE_PUT_NO_DISPONIBLE'
      readonly slotLocationCode: string
      readonly estado: NombreEstadoSlot
    }

export type ResolucionDeSlot =
  | { readonly tipo: 'SLOT_ASIGNADO'; readonly slotLocationCode: string }
  /** La orden espera sin perder su lugar y el robot queda libre. */
  | { readonly tipo: 'EN_ESPERA'; readonly lado: Lado; readonly motivo: MotivoDeEspera }

export type ErrorDeResolucionDeSlot =
  | {
      readonly codigo: 'LOCATION_CODE_INVALIDO'
      readonly recibido: string
      readonly causa: ErrorLocationCode
    }
  | { readonly codigo: 'SELECCION_INVALIDA'; readonly causa: ErrorSeleccionSlot }
  /** Solo lo genuinamente invalido de un PUT: un slot tomado sale por EN_ESPERA. */
  | { readonly codigo: 'DESTINO_DE_PUT_INVALIDO'; readonly causa: ErrorDeDestinoDePut }

export function resolverSlotDeOrden(
  dependencias: DependenciasDelOrquestador,
  orden: Orden,
): Promise<Result<ResolucionDeSlot, ErrorDeResolucionDeSlot>> {
  return noImplementadoAsync('resolverSlotDeOrden', { dependencias, orden })
}
