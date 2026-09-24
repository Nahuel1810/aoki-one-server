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

import { parsearLocationCode, rankearSlotsParaPick, transicionarSlot } from '@aoki-one/domain'
import { resolverDestinoDePut } from './putTargetResolution.js'
import type {
  ErrorLocationCode,
  ErrorSeleccionSlot,
  Lado,
  NombreEstadoSlot,
  Result,
} from '@aoki-one/domain'

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

export async function resolverSlotDeOrden(
  dependencias: DependenciasDelOrquestador,
  orden: Orden,
): Promise<Result<ResolucionDeSlot, ErrorDeResolucionDeSlot>> {
  const { repositorios } = dependencias

  const origen = parsearLocationCode(orden.locationCode)
  if (!origen.ok) {
    return {
      ok: false,
      error: {
        codigo: 'LOCATION_CODE_INVALIDO',
        recibido: orden.locationCode,
        causa: origen.error,
      },
    }
  }

  const zona = await repositorios.slots.listarPorRobot(orden.robotId)

  if (orden.tipo === 'PUT') {
    // Para un PUT el locationCode ES el slot del que sale el cajon.
    const slot = zona.find((candidato) => candidato.locationCode === origen.valor.baseCode)
    if (slot === undefined) {
      return {
        ok: true,
        valor: {
          tipo: 'EN_ESPERA',
          lado: origen.valor.lado,
          motivo: {
            tipo: 'SLOT_DE_PUT_NO_DISPONIBLE',
            slotLocationCode: origen.valor.baseCode,
            estado: 'ERROR',
          },
        },
      }
    }

    const destino = resolverDestinoDePut({
      slotLocationCode: slot.locationCode,
      estadoDelSlot: slot.estado,
      targetLocationPedido: orden.targetLocation,
    })
    if (!destino.ok) {
      return { ok: false, error: { codigo: 'DESTINO_DE_PUT_INVALIDO', causa: destino.error } }
    }

    if (destino.valor.tipo === 'ESPERAR_SLOT') {
      return {
        ok: true,
        valor: {
          tipo: 'EN_ESPERA',
          lado: origen.valor.lado,
          motivo: {
            tipo: 'SLOT_DE_PUT_NO_DISPONIBLE',
            slotLocationCode: slot.locationCode,
            estado: destino.valor.estado,
          },
        },
      }
    }

    await repositorios.ordenes.actualizar(orden.id, {
      slotLocationCode: slot.locationCode,
      waitingForSlot: false,
    })
    return { ok: true, valor: { tipo: 'SLOT_ASIGNADO', slotLocationCode: slot.locationCode } }
  }

  // PICK: el slot libre mas cercano del MISMO LADO. El ranking es dominio puro.
  const ranking = rankearSlotsParaPick(
    origen.valor,
    zona.map((slot) => ({ locationCode: slot.locationCode, estado: slot.estado })),
  )
  if (!ranking.ok) {
    return { ok: false, error: { codigo: 'SELECCION_INVALIDA', causa: ranking.error } }
  }

  const ganador = ranking.valor[0]
  if (ganador === undefined) {
    // No se reencola ni se toca creadaEn: con eso conserva su lugar en la cola.
    // El legacy hacia clearActive + enqueue y la mandaba al final cada vez.
    // Vuelve a PENDING: suelta el robot pero conserva creadaEn, asi que no pierde
    // su lugar en la cola.
    await repositorios.ordenes.actualizar(orden.id, { estado: 'PENDING', waitingForSlot: true })
    return {
      ok: true,
      valor: {
        tipo: 'EN_ESPERA',
        lado: origen.valor.lado,
        motivo: { tipo: 'SIN_SLOT_LIBRE' },
      },
    }
  }

  // La reserva se persiste al asignar: entre la eleccion y la maniobra no puede
  // colarse otra orden sobre el mismo slot.
  const estadoActual = zona.find((slot) => slot.locationCode === ganador.locationCode)?.estado
  const reserva = transicionarSlot(estadoActual ?? { estado: 'LIBRE' }, {
    tipo: 'RESERVAR_PARA_PICK',
    ordenId: orden.id,
  })
  if (reserva.ok) {
    await repositorios.slots.guardarEstado(orden.robotId, ganador.locationCode, reserva.valor)
  }
  await repositorios.ordenes.actualizar(orden.id, {
    slotLocationCode: ganador.locationCode,
    waitingForSlot: false,
  })

  return { ok: true, valor: { tipo: 'SLOT_ASIGNADO', slotLocationCode: ganador.locationCode } }
}
