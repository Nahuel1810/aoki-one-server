// RF15 — Rehidratacion tras reinicio.
//
// Las ordenes IN_PROGRESS vuelven a PENDING y se reencolan respetando su
// antiguedad; los slots CONSERVAN su estado persistido y los robots quedan IDLE
// con `ordenActivaId` en null. Se arranca desde los repositorios, no desde un
// volcado de snapshot: RF23 elimina el snapshot completo.

import { transicionarOrden } from '@aoki-one/domain'
import type { DependenciasDelOrquestador } from './ports.js'

export interface ResumenDeRehidratacion {
  /** Ids de las que estaban IN_PROGRESS y volvieron a PENDING. */
  readonly ordenesRecuperadasDeEnCurso: readonly string[]
  /** Ids de todas las pendientes, de la mas vieja a la mas nueva. Las DONE no entran. */
  readonly ordenesPendientes: readonly string[]
  readonly robotsLiberados: readonly string[]
}

export async function rehidratar(
  dependencias: DependenciasDelOrquestador,
): Promise<ResumenDeRehidratacion> {
  const { repositorios, siteId } = dependencias

  // Las IN_PROGRESS vuelven a PENDING: el proceso murio a mitad de una maniobra y
  // nadie sabe donde quedo el carro, asi que la orden se replaya desde HOMING.
  const enCurso = await repositorios.ordenes.listar({ siteId, estados: ['IN_PROGRESS'] })
  const recuperadas: string[] = []
  for (const orden of enCurso) {
    const siguiente = transicionarOrden(orden.estado, { tipo: 'REHIDRATAR' })
    if (!siguiente.ok) {
      continue
    }
    await repositorios.ordenes.actualizar(orden.id, {
      estado: siguiente.valor,
      currentStepIndex: 0,
      waitingForSlot: false,
    })
    recuperadas.push(orden.id)
  }

  // Los robots quedan IDLE: la orden activa que tenian ya no esta corriendo.
  const robots = await repositorios.robots.listar(siteId)
  const liberados: string[] = []
  for (const robot of robots) {
    if (robot.ordenActivaId !== null) {
      await repositorios.robots.fijarOrdenActiva(robot.id, null)
      liberados.push(robot.id)
    }
  }

  // Los slots NO se tocan: conservan su estado persistido. Un cajon apoyado sigue
  // apoyado aunque el proceso se haya caido.
  const pendientes = await repositorios.ordenes.listar({ siteId, estados: ['PENDING'] })

  return {
    ordenesRecuperadasDeEnCurso: recuperadas,
    // Respetan su antiguedad: listar() ordena por creadaEn.
    ordenesPendientes: pendientes.map((orden) => orden.id),
    robotsLiberados: liberados,
  }
}
