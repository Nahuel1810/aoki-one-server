// RF14 y RF21 — Admision de una orden en el agente.
//
// El dedupe es por `(siteId, externalOrderId)` resuelto por el indice unico de
// SQLite, no por un scan lineal sobre las ordenes en memoria ni por una consulta
// previa: dos altas concurrentes con el mismo id externo no pueden crear dos
// ordenes. El `siteId` sale de la configuracion del agente, nunca del request.
//
// El agente conserva su propio indice aunque el dedupe sea responsabilidad del
// servidor: admite ordenes manuales sin enlace (RF35) y una re-entrega del
// servidor tras un lease vencido (RF28) no debe crear una segunda orden.

import { parsearLocationCode, tieneSufijoDeAccion } from '@aoki-one/domain'
import type { ErrorLocationCode, Result, TipoOrden } from '@aoki-one/domain'

import type { Orden, OrigenDeOrden } from '../persistence/index.js'
import type { DependenciasDelOrquestador } from './ports.js'

export interface PedidoDeAltaDeOrden {
  /** `null` cuando se resuelve por la estanteria del locationCode (tabla `robots`). */
  readonly robotId: string | null
  readonly externalOrderId: string | null
  readonly tipo: TipoOrden
  readonly origen: OrigenDeOrden
  readonly locationCode: string
  readonly targetLocation: string | null
}

export type ResultadoDeAdmision =
  | { readonly tipo: 'CREADA'; readonly orden: Orden }
  /** Reenvio del mismo `(siteId, externalOrderId)`: devuelve la orden existente y no encola otra. */
  | { readonly tipo: 'YA_EXISTIA'; readonly orden: Orden }

export type ErrorDeAdmision =
  /** El locationCode trae sufijo T/D/L: la accion se deriva del tipo de orden. */
  | { readonly codigo: 'LOCATION_CODE_CON_ACCION'; readonly recibido: string }
  | {
      readonly codigo: 'LOCATION_CODE_INVALIDO'
      readonly recibido: string
      readonly causa: ErrorLocationCode
    }
  /** No hay fila en `robots` para esa estanteria: ya no existe el fallback identidad. */
  | { readonly codigo: 'ROBOT_NO_REGISTRADO'; readonly estanteriaCode: string }

export async function admitirOrden(
  dependencias: DependenciasDelOrquestador,
  pedido: PedidoDeAltaDeOrden,
): Promise<Result<ResultadoDeAdmision, ErrorDeAdmision>> {
  const { repositorios, siteId, generarId, reloj } = dependencias

  // La accion se deriva del tipo de orden (PICK/PUT), nunca viaja en la ubicacion.
  if (tieneSufijoDeAccion(pedido.locationCode)) {
    return {
      ok: false,
      error: { codigo: 'LOCATION_CODE_CON_ACCION', recibido: pedido.locationCode },
    }
  }

  const ubicacion = parsearLocationCode(pedido.locationCode)
  if (!ubicacion.ok) {
    return {
      ok: false,
      error: {
        codigo: 'LOCATION_CODE_INVALIDO',
        recibido: pedido.locationCode,
        causa: ubicacion.error,
      },
    }
  }

  // El robot sale de la tabla, no del mapa hardcodeado del legacy.
  let robotId = pedido.robotId
  if (robotId === null) {
    const robot = await repositorios.robots.buscarPorEstanteria(siteId, ubicacion.valor.estanteria)
    if (robot === undefined) {
      return {
        ok: false,
        error: { codigo: 'ROBOT_NO_REGISTRADO', estanteriaCode: ubicacion.valor.estanteria },
      }
    }
    robotId = robot.id
  }

  // Dedupe por (siteId, externalOrderId). Un reenvio devuelve la que ya existe.
  if (pedido.externalOrderId !== null) {
    const existente = await repositorios.ordenes.buscarPorExternalOrderId(
      siteId,
      pedido.externalOrderId,
    )
    if (existente !== undefined) {
      return { ok: true, valor: { tipo: 'YA_EXISTIA', orden: existente } }
    }
  }

  const orden: Orden = {
    id: generarId(),
    siteId,
    robotId,
    // RF35: una orden que nace en el agente lleva su propio id externo, asi puede
    // empujarse al servidor cuando vuelva el enlace. El prefijo por agente que
    // evita colisionar con los ids de picking entra con T30.
    externalOrderId: pedido.externalOrderId ?? generarId(),
    tipo: pedido.tipo,
    origen: pedido.origen,
    estado: 'PENDING',
    locationCode: ubicacion.valor.baseCode,
    targetLocation: pedido.targetLocation,
    slotLocationCode: null,
    currentStepIndex: 0,
    waitingForSlot: false,
    errorReason: null,
    creadaEn: reloj.ahoraMs(),
    iniciadaEn: null,
    finalizadaEn: null,
  }

  const creada = await repositorios.ordenes.crear(orden)
  if (!creada.ok) {
    // El indice unico gano una carrera: la orden ya existe y se devuelve esa.
    if (pedido.externalOrderId !== null) {
      const existente = await repositorios.ordenes.buscarPorExternalOrderId(
        siteId,
        pedido.externalOrderId,
      )
      if (existente !== undefined) {
        return { ok: true, valor: { tipo: 'YA_EXISTIA', orden: existente } }
      }
    }
    throw new Error('no se pudo crear la orden y tampoco existe una previa')
  }

  return { ok: true, valor: { tipo: 'CREADA', orden: creada.valor } }
}
