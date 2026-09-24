// RF34 — El punto por el que el orquestador alimenta el outbox.
//
// El orquestador no sabe que hay un servidor: cambia el estado de la orden y
// sigue. Si no hay outbox configurado —enlace APAGADO, que es el modo del
// cutover (T26)— solo se escribe el estado, porque no hay a quien reportarle y
// una cola que nadie drena solo crece.
//
// El estado local y su reporte se escriben en la MISMA transaccion. Separados
// eran dos: si el proceso se moria en el medio, la orden quedaba terminada en la
// sucursal y PENDING para siempre en la app de picking, y nadie lo recuperaba.
//
// Encolar NUNCA puede voltear una maniobra: la orden ya cambio de estado en el
// mundo fisico cuando esto corre, y perder el reporte es recuperable —el servidor
// lo ve en la proxima transicion, o lo reconcilia el enlace cuando re-entrega la
// orden— mientras que abortar la maniobra por un fallo de escritura de la cola de
// salida no lo es. Por eso, si la transaccion no entra, el estado se escribe solo
// y queda la traza del reporte perdido.

import type { EstadoOrden, Result } from '@aoki-one/domain'

import type { DependenciasDelOrquestador } from '../orchestrator/ports.js'
import type { CambiosDeOrden, ErrorDeOrden, Orden } from '../persistence/orderRepository.js'

export async function aplicarTransicionDeOrden(
  dependencias: DependenciasDelOrquestador,
  ordenId: string,
  cambios: CambiosDeOrden,
  estado: EstadoOrden,
  metadata: Readonly<Record<string, unknown>>,
): Promise<Result<Orden, ErrorDeOrden>> {
  const { outbox, repositorios, reloj } = dependencias
  if (outbox === undefined) {
    return repositorios.ordenes.actualizar(ordenId, cambios)
  }

  try {
    const escrito = await outbox.encolarConEstadoDeOrden(
      { ordenId, estado, metadata, creadaEn: reloj.ahoraMs() },
      cambios,
    )
    if (!escrito.ok) {
      return { ok: false, error: escrito.error }
    }
    return { ok: true, valor: escrito.valor.orden }
  } catch (error) {
    // Un disco lleno o una base bloqueada hacen fallar la escritura, y dejar que
    // el fallo suba corta la maniobra a mitad de camino y se lleva puesto el
    // bucle del robot, que no tiene de donde recuperarse. El estado si tiene que
    // quedar: es lo que el operario ve en la tablet y lo que el enlace usa para
    // reconciliar el reporte perdido cuando el servidor re-entregue la orden.
    await registrarFalloDeEncolado(dependencias, ordenId, estado, error)
    return repositorios.ordenes.actualizar(ordenId, cambios)
  }
}

/**
 * Deja la traza del reporte que no se pudo encolar.
 *
 * Tragarse el fallo sin dejar rastro seria cambiar una falla ruidosa por una
 * silenciosa. El evento va a la misma base que acaba de fallar, asi que su propia
 * escritura tambien se protege: es diagnostico, no puede ser el motivo por el que
 * se voltee la maniobra que esto existe para no voltear.
 */
async function registrarFalloDeEncolado(
  dependencias: DependenciasDelOrquestador,
  ordenId: string,
  estado: EstadoOrden,
  error: unknown,
): Promise<void> {
  const { repositorios, generarId, reloj } = dependencias
  try {
    await repositorios.eventos.registrar({
      id: generarId(),
      ts: reloj.ahoraMs(),
      tipoDeEntidad: 'ORDER',
      entidadId: ordenId,
      evento: 'OUTBOX_ENQUEUE_FAILED',
      severidad: 'ERROR',
      metadata: {
        estado,
        motivo: error instanceof Error ? error.message : String(error),
      },
    })
  } catch {
    // Sin traza y sin ruido: la base no acepta escrituras. Lo que importa es que
    // la orden siga su curso.
  }
}
