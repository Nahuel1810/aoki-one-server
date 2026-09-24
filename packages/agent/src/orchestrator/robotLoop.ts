// RF08, RF09 y RF12 — Un ciclo del loop de un robot.
//
// La invariante de "una sola orden fisica por robot" vive aca y no en la cola: la
// cola entrega la siguiente igual, es el loop el que no la arranca si el robot
// ya tiene una activa.
//
// El ciclo se expone como funcion y no como timer para poder ejercitarlo sin
// relojes: el avance real es por evento y el tick queda solo como red de
// seguridad de baja frecuencia (RNF, sin busy-loops de 300 ms).

import type { EstadoOrden, Lado } from '@aoki-one/domain'

import { noImplementadoAsync } from '../noImplementadoAsync.js'
import type { DependenciasDelOrquestador } from './ports.js'

export type ResultadoDeCicloDeRobot =
  | { readonly tipo: 'ROBOT_NO_REGISTRADO'; readonly robotId: string }
  | { readonly tipo: 'SIN_TRABAJO' }
  /** Ya hay una orden en curso: no se arranca la siguiente. */
  | { readonly tipo: 'ROBOT_OCUPADO'; readonly ordenActivaId: string }
  /** Sin slot disponible de ese lado: la orden espera sin perder su lugar y el robot se libera. */
  | { readonly tipo: 'ORDEN_EN_ESPERA_DE_SLOT'; readonly ordenId: string; readonly lado: Lado }
  | {
      readonly tipo: 'ORDEN_TERMINADA'
      readonly ordenId: string
      readonly estadoFinal: EstadoOrden
      /** False cuando termino por refcount de devoluciones, sin mover el robot (RF07). */
      readonly huboManiobra: boolean
    }

export function ejecutarCicloDeRobot(
  dependencias: DependenciasDelOrquestador,
  robotId: string,
): Promise<ResultadoDeCicloDeRobot> {
  return noImplementadoAsync('ejecutarCicloDeRobot', { dependencias, robotId })
}
