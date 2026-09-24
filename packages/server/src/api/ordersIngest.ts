// RF26 — Ingreso idempotente de pedidos de picking (POST /api/v1/orders).
//
// Es lo unico que el mapeo de los 55 tests manda a `packages/server`: el alta
// nueva responde 202 con `created: true`, el reenvio identico responde 200 con
// `created: false` y CON EL MISMO PEDIDO, y en ningun caso nace una segunda
// orden. Eso se porta literal del legacy; lo que cambia es la clave, que pasa de
// un id numerico a `(siteId, externalOrderId)` (RF26, y su hermano en el agente
// es el indice unico local de RF14).
//
// El caso de uso esta separado del transporte HTTP a proposito: la decision
// "creado o ya existia" y el codigo de respuesta son reglas, y se testean sin
// levantar un listener. El router, el HMAC del body, el anti-replay por
// timestamp y la validacion de `siteId` contra la credencial son T33; la cola
// durable y el long-poll, T34.
//
// ESQUELETO DE CONTRATOS previo a T02: firmas reales, cero implementacion.


import type {
  AltaDePedido,
  PedidoDelServidor,
  RepositorioDePedidos,
} from '../persistence/ordersRepository.js'

/**
 * Que paso con el alta.
 *
 * Union discriminada en vez de un booleano `created` suelto: el booleano es la
 * forma de la respuesta HTTP, no la decision. Los dos casos llevan el pedido,
 * porque el reenvio devuelve el que ya existia, no uno nuevo.
 */
export type ResultadoDeIngreso =
  | { readonly tipo: 'CREADO'; readonly pedido: PedidoDelServidor }
  | { readonly tipo: 'YA_EXISTIA'; readonly pedido: PedidoDelServidor }

/**
 * Admite un pedido, o devuelve el que ya estaba con esa clave.
 *
 * No es "buscar y despues insertar": el alta se intenta y, si la base rechaza la
 * clave duplicada, se relee y se responde YA_EXISTIA. Asi dos altas simultaneas
 * de la misma clave no pueden devolver las dos `created: true`, que es la
 * carrera que el test secuencial del legacy no detectaba.
 */
export async function ingresarPedido(
  repositorio: RepositorioDePedidos,
  alta: AltaDePedido,
): Promise<ResultadoDeIngreso> {
  const insercion = await repositorio.insertar(alta)
  if (insercion.ok) {
    return { tipo: 'CREADO', pedido: insercion.valor }
  }

  // La carrera de dos altas simultaneas la corta la base con CLAVE_DUPLICADA y
  // aca se traduce a "ya existia". El legacy consultaba primero y despues
  // insertaba, y entre las dos lecturas quedaba la ventana.
  const existente = await repositorio.buscarPorClave({
    siteId: alta.siteId,
    externalOrderId: alta.externalOrderId,
  })
  if (existente === null) {
    throw new Error('el alta fue rechazada por clave duplicada pero el pedido no existe')
  }

  return { tipo: 'YA_EXISTIA', pedido: existente }
}

/** Codigos que el contrato actual ya fija: 202 el alta nueva, 200 el reenvio. */
export type EstadoHttpDeIngreso = 202 | 200

/** Envelope `{ ok, data }` de toda la API, mas el `created` de las altas. */
export interface CuerpoDeIngreso {
  readonly ok: true
  readonly data: PedidoDelServidor
  readonly created: boolean
}

/** Respuesta HTTP del alta, sin depender del framework. */
export interface RespuestaDeIngreso {
  readonly estadoHttp: EstadoHttpDeIngreso
  readonly cuerpo: CuerpoDeIngreso
}

/**
 * Traduce el resultado del ingreso a la respuesta HTTP.
 *
 * Funcion total sobre la union: si mañana aparece un tercer caso de ingreso, el
 * compilador obliga a decidir con que codigo se responde.
 */
export function responderIngreso(resultado: ResultadoDeIngreso): RespuestaDeIngreso {
  const created = resultado.tipo === 'CREADO'
  return {
    // 202 en el alta nueva, 200 en el reenvio: el reenvio NO es un error, es la
    // confirmacion de que la orden ya esta tomada.
    estadoHttp: created ? 202 : 200,
    cuerpo: { ok: true, data: resultado.pedido, created },
  }
}
