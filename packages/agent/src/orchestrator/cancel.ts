// RF21 — Cancelacion de una orden desde la tablet.
//
// Es el boton "Cancelar" del front: un pedido que se mando por equivocacion, o
// que ya no hace falta, se saca de la cola sin esperar a que el robot lo haga.
//
// Cancelar es sacar de la cola, NO abortar una maniobra. Por eso hay dos cortes,
// y los dos protegen lo mismo: que no quede un cajon a mitad de camino con los
// libros diciendo que no hay nada en curso.
//
//   1. El estado. Solo se cancela una orden PENDING; lo decide la maquina de
//      estados del dominio, que rechaza IN_PROGRESS y las terminales.
//   2. El slot. Una orden PENDING puede seguir RETENIENDO su slot: es lo que
//      pasa despues de un retry (RF13) y despues de una rehidratacion (RF15),
//      donde la orden vuelve a la cola con el slot todavia en BUSCANDO o
//      DEVOLVIENDO. Ahi cancelar abandonaria el slot para siempre, porque el
//      unico evento que lo saca de BUSCANDO es el OCUPAR de la maniobra que ya
//      no va a correr, y la zona de pickeo se comeria un slot por cada
//      cancelacion. El operario tiene `POST /api/orders/:id/retry` para esas.

import { transicionarOrden } from '@aoki-one/domain'
import type { EstadoOrden, Result } from '@aoki-one/domain'

import type { Orden } from '../persistence/index.js'
import { aplicarTransicionDeOrden } from '../sync/transitions.js'
import type { DependenciasDelOrquestador } from './ports.js'
import { ordenQueRetiene } from './slotWait.js'

export type ErrorDeCancelacionDeOrden =
  | { readonly codigo: 'ORDEN_INEXISTENTE'; readonly ordenId: string }
  | {
      readonly codigo: 'ORDEN_NO_CANCELABLE'
      readonly ordenId: string
      readonly estado: EstadoOrden
    }
  /** La orden volvio a la cola con su slot todavia tomado (retry o rehidratacion). */
  | {
      readonly codigo: 'ORDEN_CON_SLOT_TOMADO'
      readonly ordenId: string
      readonly slotLocationCode: string
    }

export async function cancelarOrden(
  dependencias: DependenciasDelOrquestador,
  ordenId: string,
): Promise<Result<Orden, ErrorDeCancelacionDeOrden>> {
  const { repositorios, reloj } = dependencias

  const orden = await repositorios.ordenes.buscarPorId(ordenId)
  if (orden === undefined) {
    return { ok: false, error: { codigo: 'ORDEN_INEXISTENTE', ordenId } }
  }

  const siguiente = transicionarOrden(orden.estado, { tipo: 'CANCELAR' })
  if (!siguiente.ok) {
    return {
      ok: false,
      error: { codigo: 'ORDEN_NO_CANCELABLE', ordenId, estado: orden.estado },
    }
  }

  const retenido = await slotRetenidoPor(dependencias, orden)
  if (retenido !== null) {
    return {
      ok: false,
      error: { codigo: 'ORDEN_CON_SLOT_TOMADO', ordenId, slotLocationCode: retenido },
    }
  }

  // RF34: cancelar es un cambio de estado como cualquier otro y viaja al servidor
  // en la misma transaccion. Del otro lado CANCELED es terminal y suelta el
  // lease; sin el reporte, el servidor re-entregaria para siempre un pedido que
  // la sucursal ya descarto.
  const actualizada = await aplicarTransicionDeOrden(
    dependencias,
    ordenId,
    {
      estado: siguiente.valor,
      waitingForSlot: false,
      errorReason: null,
      finalizadaEn: reloj.ahoraMs(),
    },
    siguiente.valor,
    { motivo: 'CANCELACION_MANUAL' },
  )
  if (!actualizada.ok) {
    return { ok: false, error: { codigo: 'ORDEN_INEXISTENTE', ordenId } }
  }

  // La cancelacion la pide una persona y no deja rastro fisico: sin este evento
  // no hay forma de reconstruir por que un pedido de picking nunca se hizo.
  await repositorios.eventos.registrar({
    id: dependencias.generarId(),
    ts: reloj.ahoraMs(),
    tipoDeEntidad: 'ORDER',
    entidadId: ordenId,
    evento: 'ORDER_CANCELED',
    severidad: 'INFO',
    metadata: { robotId: orden.robotId, estadoPrevio: orden.estado },
  })

  // No se registra metrica: `order_metrics` mide maniobras del robot y esta orden
  // no llego a mover nada. Contarla como una mas diluiria el tiempo por pedido
  // con ordenes que nunca se ejecutaron.
  return { ok: true, valor: actualizada.valor }
}

/** El slot que esta orden todavia tiene tomado, o `null` si no retiene ninguno. */
async function slotRetenidoPor(
  dependencias: DependenciasDelOrquestador,
  orden: Orden,
): Promise<string | null> {
  if (orden.slotLocationCode === null) {
    return null
  }
  const slot = await dependencias.repositorios.slots.buscar(orden.robotId, orden.slotLocationCode)
  if (slot === undefined) {
    return null
  }
  return ordenQueRetiene(slot.estado) === orden.id ? slot.locationCode : null
}
