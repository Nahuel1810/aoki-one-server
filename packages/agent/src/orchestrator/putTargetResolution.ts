// RF11 — Destino de una devolucion.
//
// Los dos caminos los distingue el estado del slot, que es justo el discriminante
// del requisito:
//   - slot CON cajon en libros -> el destino es `cajon.ubicacionDeOrigen` y
//     cualquier `targetLocation` recibido se IGNORA;
//   - slot VACIO en libros (devolucion manual fuera-de-libros: alguien saco el
//     cajon a mano, lo restockeo y lo apoya) -> `targetLocation` es OBLIGATORIO y
//     sin el la orden se rechaza con 400.
//
// El legacy nunca lee la ubicacion de origen del cajon: hace `target || source` y
// para un PUT `source` es el propio slot, o sea que sin `targetLocation` devuelve
// el cajon al mismo slot. Ese caso lo cierra el destino obligatorio, y sobre eso
// va ademas el invariante de seguridad: ningun destino de devolucion puede caer
// en la zona de pickeo (ver `ErrorDeDestinoDePut`).
//
// UN SLOT TOMADO NO ES UNA ORDEN INVALIDA. Un PUT sobre un slot RESERVADO,
// BUSCANDO, DEVOLVIENDO o ERROR no se rechaza: la orden ESPERA (queda PENDING con
// `waitingForSlot` y el slot conserva su estado). Por eso ese caso sale por la
// rama ok, como `ESPERAR_SLOT`, y no por el canal de error: es un estado
// transitorio del slot, no un defecto del pedido. En el canal de error queda solo
// lo que ninguna espera arregla.

import { parsearLocationCode } from '@aoki-one/domain'
import type { EstadoSlot, NombreEstadoSlot, Result } from '@aoki-one/domain'

export interface PedidoDeDestinoDePut {
  /** baseCode del slot desde donde sale el cajon. */
  readonly slotLocationCode: string
  readonly estadoDelSlot: EstadoSlot
  /** Lo que mando la tablet, o `null` si no mando nada. */
  readonly targetLocationPedido: string | null
  /**
   * baseCodes de TODA la zona de pickeo de ese robot.
   *
   * Es lo que permite afirmar el invariante de seguridad: una devolucion nunca
   * puede terminar en la zona de pickeo. Sin la zona en la mano, "el destino es
   * un slot" es indecidible desde aca.
   */
  readonly zonaDePickeo: readonly string[]
}

export interface DestinoDePut {
  readonly locationCode: string
  /** De donde salio el destino, para poder afirmar que el pedido se ignoro. */
  readonly resueltoDesde: 'CAJON_EN_LIBROS' | 'PEDIDO'
}

export type ResolucionDeDestinoDePut =
  | { readonly tipo: 'DESTINO_RESUELTO'; readonly destino: DestinoDePut }
  /**
   * El slot no se puede tomar AHORA (RESERVADO, BUSCANDO, DEVOLVIENDO o ERROR).
   * La orden espera y el slot queda como estaba.
   */
  | { readonly tipo: 'ESPERAR_SLOT'; readonly estado: NombreEstadoSlot }

/**
 * Lo genuinamente invalido de un pedido de PUT: no lo arregla esperar.
 *
 * `TARGET_LOCATION_REQUERIDO` es el assert de RF11: slot vacio en libros y sin
 * destino se rechaza.
 *
 * `DESTINO_EN_ZONA_DE_PICKEO` es el INVARIANTE DE SEGURIDAD que el operador ya
 * tiene vivo en el servidor de hoy (`assertReturnTargetIsStorage`, en
 * `src/core/orchestrator/OrchestratorService.js`): una devolucion nunca puede
 * terminar en la zona de pickeo. Si el destino de un PUT es un slot, el robot
 * deja el cajon ahi, la orden pasa a DONE y el slot se libera: el cajon queda
 * fisicamente sobre la zona de pickeo y, en los libros, en ningun lado. Eso
 * rompe el inventario y el proximo PICK sobre ese slot choca con un cajon que no
 * deberia estar. Cubre tanto el propio slot del que sale el cajon —el caso que
 * RF11 nombra— como cualquier OTRO slot de la zona.
 *
 * `TARGET_LOCATION_INVALIDO` existe porque el destino se compara contra la zona
 * por baseCode, y para eso hay que parsearlo: un destino que no parsea no se
 * puede afirmar que esta fuera de la zona, asi que se rechaza en vez de dejarlo
 * pasar sin verificar.
 */
export type ErrorDeDestinoDePut =
  | {
      readonly codigo: 'TARGET_LOCATION_REQUERIDO'
      readonly slotLocationCode: string
    }
  | {
      readonly codigo: 'TARGET_LOCATION_INVALIDO'
      readonly recibido: string
    }
  | {
      readonly codigo: 'DESTINO_EN_ZONA_DE_PICKEO'
      readonly slotLocationCode: string
      /** baseCode del destino rechazado. */
      readonly destino: string
    }

export function resolverDestinoDePut(
  pedido: PedidoDeDestinoDePut,
): Result<ResolucionDeDestinoDePut, ErrorDeDestinoDePut> {
  const { estadoDelSlot, slotLocationCode, targetLocationPedido } = pedido

  // Slot CON cajon en libros: el destino sale del cajon y se IGNORA lo pedido.
  // El legacy nunca lee ubicacionDeOrigen: hace `target || source`, y para un PUT
  // `source` es el propio slot, o sea que sin targetLocation devolvia el cajon al
  // lugar donde ya estaba.
  if (estadoDelSlot.estado === 'OCUPADO') {
    return conDestinoFueraDeLaZona(
      pedido,
      estadoDelSlot.contenido.cajon.ubicacionDeOrigen,
      'CAJON_EN_LIBROS',
    )
  }

  // Slot VACIO en libros: devolucion manual fuera-de-libros. El destino es
  // obligatorio; sin el la orden se rechaza.
  if (estadoDelSlot.estado === 'LIBRE') {
    if (targetLocationPedido === null || targetLocationPedido.trim() === '') {
      return { ok: false, error: { codigo: 'TARGET_LOCATION_REQUERIDO', slotLocationCode } }
    }
    return conDestinoFueraDeLaZona(pedido, targetLocationPedido, 'PEDIDO')
  }

  // RESERVADO, BUSCANDO, DEVOLVIENDO o ERROR: el slot esta tomado AHORA. No es un
  // pedido invalido, es un estado transitorio: la orden espera y el slot conserva
  // su estado.
  return { ok: true, valor: { tipo: 'ESPERAR_SLOT', estado: estadoDelSlot.estado } }
}

/**
 * Ultima barrera antes de armar el comando: el destino se normaliza a baseCode y
 * se verifica que NO sea un slot de la zona de pickeo.
 *
 * Se aplica a los DOS caminos —el destino que sale del cajon en libros y el que
 * manda la tablet— igual que el servidor de hoy, que chequea al crear la orden y
 * otra vez al construir el comando. El cajon en libros parece a salvo por
 * construccion (su `ubicacionDeOrigen` es una ubicacion de guardado), pero un
 * slot sembrado con un cajon de origen invalido, o una zona de pickeo ampliada
 * despues de que el cajon se apoyara, alcanzan para que deje de serlo.
 */
function conDestinoFueraDeLaZona(
  pedido: PedidoDeDestinoDePut,
  destinoCrudo: string,
  resueltoDesde: DestinoDePut['resueltoDesde'],
): Result<ResolucionDeDestinoDePut, ErrorDeDestinoDePut> {
  const destino = parsearLocationCode(destinoCrudo)
  if (!destino.ok) {
    return { ok: false, error: { codigo: 'TARGET_LOCATION_INVALIDO', recibido: destinoCrudo } }
  }

  // El invariante se afirma por baseCode: `3X02AE1T` y `3X02AE1` son el mismo
  // slot, y comparar los codigos crudos dejaria pasar el sufijo.
  if (pedido.zonaDePickeo.includes(destino.valor.baseCode)) {
    return {
      ok: false,
      error: {
        codigo: 'DESTINO_EN_ZONA_DE_PICKEO',
        slotLocationCode: pedido.slotLocationCode,
        destino: destino.valor.baseCode,
      },
    }
  }

  return {
    ok: true,
    valor: {
      tipo: 'DESTINO_RESUELTO',
      destino: { locationCode: destino.valor.baseCode, resueltoDesde },
    },
  }
}
