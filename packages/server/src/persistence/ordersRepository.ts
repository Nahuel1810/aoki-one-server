// RF26 — Puerto de persistencia del ingreso de pedidos.
//
// El servidor es el libro de la ADMISION: guarda el pedido que manda la app de
// picking y garantiza que un reenvio no cree una segunda orden. La clave de
// dedupe es `(siteId, externalOrderId)` y la resuelve un INDICE UNICO, no un
// scan: el legacy deduplicaba por id numerico leyendo la lista entera y con dos
// lecturas del mismo indice (una en la ruta para calcular `created` y otra en el
// alta), lo que deja una ventana de carrera entre las dos.
//
// Por eso el puerto expone el alta como una operacion que PUEDE fallar con
// CLAVE_DUPLICADA en vez de un "insertar si no existe" silencioso: la carrera de
// dos altas simultaneas la corta la base, y el caso de uso la traduce a "ya
// existia". Un fake en memoria implementa lo mismo con un Map.
//
// Esto es el ESQUELETO DE CONTRATOS previo a T02. La implementacion sobre SQLite
// es T33; aca solo esta la forma contra la que se escribe el test.

import type { EstadoOrden, Result, TipoOrden } from '@aoki-one/domain'

/**
 * Clave de dedupe de un pedido.
 *
 * Los dos campos son strings y van juntos a proposito: pasarlos sueltos como dos
 * parametros deja intercambiarlos sin que el compilador diga nada.
 *
 * `externalOrderId` es el id que maneja la app de picking. Deja de estar
 * restringido a entero (el legacy lo trataba como numero): el servidor no
 * interpreta su contenido, solo lo usa como clave.
 */
export interface ClaveDePedido {
  readonly siteId: string
  readonly externalOrderId: string
}

/** Pedido tal como lo admitio y guardo el servidor. */
export interface PedidoDelServidor extends ClaveDePedido {
  /** Id propio del servidor, distinto del `externalOrderId` de la app. */
  readonly id: string
  readonly tipo: TipoOrden
  /** Ubicacion de origen del pedido, sin interpretar. La parsea el agente. */
  readonly locationCode: string
  readonly estado: EstadoOrden
  /** Instante de admision, en epoch ms. Lo pone el repositorio, no el request. */
  readonly creadaEn: number
}

/** Datos con los que nace un pedido. El `id`, el `estado` y `creadaEn` los pone el repositorio. */
export interface AltaDePedido extends ClaveDePedido {
  readonly tipo: TipoOrden
  readonly locationCode: string
}

/**
 * El alta choco contra el indice unico `(site_id, external_order_id)`.
 *
 * No es un error del cliente: es la carrera entre dos altas de la misma clave.
 * Quien pierde vuelve a leer y responde con el pedido que ya existe.
 */
export type ErrorDeAlmacenamiento = { readonly codigo: 'CLAVE_DUPLICADA' }

/** Acceso al libro de admision del servidor. */
export interface RepositorioDePedidos {
  /** El pedido de esa clave, o null si no hay ninguno. Una sola lectura del indice. */
  buscarPorClave(clave: ClaveDePedido): Promise<PedidoDelServidor | null>

  /** Inserta un pedido nuevo. Falla con CLAVE_DUPLICADA si la clave ya esta tomada. */
  insertar(alta: AltaDePedido): Promise<Result<PedidoDelServidor, ErrorDeAlmacenamiento>>
}
