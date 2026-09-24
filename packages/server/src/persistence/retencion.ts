// T37 / RNF de Rendimiento — "El estado persistido no crece sin techo:
// retencion configurable para eventos, comandos y errores, con purga."
//
// Del lado del servidor lo que crece sin freno es el libro de la ADMISION: una
// orden por pedido de cada sucursal y una fila de `order_transitions` por cada
// cambio de estado de cada una de esas ordenes, para siempre.
//
// La unidad de purga es el PEDIDO TERMINADO, no la fila suelta. Borrar
// transiciones dejando viva la orden romperia la idempotencia de RF29:
// `aplicarTransicion` decide DESCARTADA mirando la `seq` ya aplicada y la maxima
// de esa orden, asi que una orden sin su historia vuelve a aceptar un reintento
// tardio del outbox del agente (RF34) y la app de picking veria un pedido
// terminado RETROCEDER de estado. Cuando lo que se va es la orden entera no hay
// tal ventana: `aplicarTransicion` contesta ORDEN_INEXISTENTE, que el outbox del
// agente ya trata como terminal y saca de su cola.
//
// Solo se purga lo TERMINADO (`finalizada_en` no nula y mas vieja que la
// retencion). Un pedido en vuelo no se toca por viejo que sea: puede estar
// esperando a que una sucursal caida vuelva.

import type { BaseDelServidor } from './database.js'

export interface PoliticaDeRetencion {
  /** Dias que se conserva un pedido DESPUES de haber terminado. */
  readonly diasDePedidosTerminados: number
}

const DIA_MS = 24 * 60 * 60 * 1000

/** Cuanto borro la pasada. Se loguea tal cual, asi que los nombres son los del log. */
export interface ResultadoDePurga {
  readonly pedidos: number
  readonly transiciones: number
  readonly leases: number
}

/**
 * Borra los pedidos terminados que ya pasaron la retencion, con su historia.
 *
 * Todo en UNA transaccion: una purga a medias dejaria transiciones colgando de
 * un pedido que ya no existe, que es basura que nadie va a volver a mirar y que
 * ninguna consulta limpia despues.
 */
export function purgar(
  base: BaseDelServidor,
  ahoraMs: number,
  politica: PoliticaDeRetencion,
): ResultadoDePurga {
  const { sql } = base
  const corte = ahoraMs - politica.diasDePedidosTerminados * DIA_MS

  const enUnaTransaccion = sql.transaction((): ResultadoDePurga => {
    const viejos = `
      SELECT id FROM orders
      WHERE finalizada_en IS NOT NULL AND finalizada_en < ?
    `
    // Las hijas primero: mientras la orden siga estando, la seleccion de arriba
    // las sigue encontrando.
    const transiciones = sql
      .prepare(`DELETE FROM order_transitions WHERE order_id IN (${viejos})`)
      .run(corte)
    const leases = sql.prepare(`DELETE FROM order_leases WHERE order_id IN (${viejos})`).run(corte)
    const pedidos = sql
      .prepare('DELETE FROM orders WHERE finalizada_en IS NOT NULL AND finalizada_en < ?')
      .run(corte)

    return {
      pedidos: pedidos.changes,
      transiciones: transiciones.changes,
      leases: leases.changes,
    }
  })

  return enUnaTransaccion()
}
