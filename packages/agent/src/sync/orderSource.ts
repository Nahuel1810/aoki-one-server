// RF28 y RF33 — De donde salen las ordenes.
//
// El orquestador NO consume de este puerto: consume del espejo en SQLite. Ese es
// justamente el punto de RF33 —toda orden reclamada se persiste antes de empezar
// a ejecutarse— y lo que hace que la maniobra fisica no dependa de que el enlace
// este vivo.
//
// `OrderSource` es lo que alimenta ese espejo. La implementacion de produccion es
// el long-poll contra el servidor; el origen APAGADO es el modo de contingencia
// del cutover (T26), donde el agente corre solo con su cola local. Cambiar de
// long-poll a otra cosa no toca ni una linea del orquestador.

import type { Result, TipoOrden } from '@aoki-one/domain'

import type { ClienteDelServidor, FalloDeEnlace } from './serverClient.js'

/** Una orden que entra al agente desde afuera. */
export interface OrdenEntrante {
  /** Id de la orden en el libro del servidor. Es con el que despues se reporta. */
  readonly ordenIdRemoto: string
  readonly externalOrderId: string
  readonly tipo: TipoOrden
  readonly locationCode: string
}

export interface OrderSource {
  /** Nombre para el diagnostico: lo que se ve en el log cuando algo no entra. */
  readonly nombre: string
  /**
   * `senal` corta el reclamo en vuelo cuando el enlace se detiene. Sin eso el
   * apagado del agente espera a que termine un long-poll que, contra un servidor
   * mudo, no termina nunca.
   */
  readonly reclamar: (
    limite: number,
    senal?: AbortSignal,
  ) => Promise<Result<readonly OrdenEntrante[], FalloDeEnlace>>
}

/**
 * Origen apagado: el default.
 *
 * En el cutover el agente arranca SIN servidor y atiende solo lo que el operario
 * carga desde la tablet. Un origen que devuelve vacio es una respuesta explicita;
 * no configurar el enlace no puede significar "conectar a cualquier lado".
 */
export const ORIGEN_APAGADO: OrderSource = {
  nombre: 'APAGADO',
  reclamar: () => Promise.resolve({ ok: true, valor: [] }),
}

export function crearOrigenPorLongPoll(cliente: ClienteDelServidor): OrderSource {
  return {
    nombre: 'LONG_POLL',
    reclamar: async (limite, senal) => {
      const reclamados = await cliente.reclamarTrabajo(limite, senal)
      if (!reclamados.ok) {
        return reclamados
      }
      return {
        ok: true,
        valor: reclamados.valor.map((pedido) => ({
          ordenIdRemoto: pedido.id,
          externalOrderId: pedido.externalOrderId,
          tipo: pedido.tipo,
          locationCode: pedido.locationCode,
        })),
      }
    },
  }
}
