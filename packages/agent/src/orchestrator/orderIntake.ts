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
  /**
   * PUT sobre un `locationCode` que no es un slot de la zona de pickeo.
   *
   * Para un PUT el `locationCode` ES el slot del que sale el cajon, asi que uno
   * que no existe no es una devolucion posible: es un typo. El legacy lo
   * rechazaba al crear la orden ("PUT requiere locationCode de zona pickeo
   * configurada", `OrchestratorService.js`), y sin este rechazo la orden entraba
   * con 202, quedaba PENDING para siempre esperando un slot que no va a existir
   * nunca y se llevaba puesta la cola del robot.
   */
  | { readonly codigo: 'PUT_FUERA_DE_ZONA_DE_PICKEO'; readonly recibido: string }

/**
 * Id externo de una orden que nace en el agente (RF35).
 *
 * El prefijo por agente es lo que evita chocar con los ids que maneja la app de
 * picking. Una colision no falla ruidosamente: dedupea dos ordenes distintas en
 * una sola y deja un pedido sin atender, asi que se previene por construccion y
 * no por suerte.
 */
export function externalOrderIdLocal(agentId: string, id: string): string {
  return `local-${agentId}-${id}`
}

export async function admitirOrden(
  dependencias: DependenciasDelOrquestador,
  pedido: PedidoDeAltaDeOrden,
): Promise<Result<ResultadoDeAdmision, ErrorDeAdmision>> {
  const { repositorios, siteId, agentId, generarId, reloj } = dependencias

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

  // Paridad con el legacy: un PUT solo puede salir de un slot configurado. Se
  // valida ACA, en la admision, y no mas adelante en el loop, porque es la unica
  // capa que puede contestarle 400 a la tablet mientras el operario todavia esta
  // mirando la pantalla.
  if (pedido.tipo === 'PUT') {
    const slot = await repositorios.slots.buscar(robotId, ubicacion.valor.baseCode)
    if (slot === undefined) {
      return {
        ok: false,
        error: { codigo: 'PUT_FUERA_DE_ZONA_DE_PICKEO', recibido: ubicacion.valor.baseCode },
      }
    }
  }

  const orden: Orden = {
    id: generarId(),
    siteId,
    robotId,
    // RF35: una orden que nace en el agente lleva su propio id externo, asi puede
    // empujarse al servidor cuando vuelva el enlace, y prefijado por agente para
    // no colisionar con los ids de picking.
    externalOrderId: pedido.externalOrderId ?? externalOrderIdLocal(agentId, generarId()),
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
