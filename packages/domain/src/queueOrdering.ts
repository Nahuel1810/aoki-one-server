// RF08 — Cola FIFO por robot: cual orden sigue.
//
// Alcance deliberadamente chico. La regla completa de RF09 (PICK antes que PUT,
// con inversion cuando la zona de pickeo DE ESE LADO esta llena) NO se declara
// aca: RF09 figura entero en la seccion "RF sin cobertura" del mapeo y el unico
// test que cae en este archivo (`QueueManager mantiene FIFO por robot`) solo
// prueba FIFO y cola vacia. La superficie de RF09 entra con la task que escriba
// su test (T10).
//
// Funcion pura: la cola concreta (memoria, SQLite, driver externo) es del
// agente; aca solo se decide cual sigue.

import { noImplementado } from './noImplementado.js'

/** Lo minimo que la regla de servicio necesita saber de una orden en espera. */
export interface OrdenEnCola {
  readonly ordenId: string
  /**
   * Antiguedad, en epoch ms. El dominio no llama a `Date.now()`: el instante lo
   * inyecta quien arma la cola. Es lo que hace que una orden rehidratada tras un
   * reinicio no pierda su lugar.
   */
  readonly creadaEn: number
}

/**
 * La proxima orden a servir, o `undefined` si la cola esta vacia.
 *
 * FIFO por `creadaEn`. A igual `creadaEn` se conserva el orden de entrada del
 * arreglo (sort estable).
 *
 * Es `undefined` y no `null` a proposito: el legacy hace `items.shift() || null`
 * y confunde "no hay" con "hay pero el id es falsy".
 *
 * La cola que se pasa es la de un solo robot: el aislamiento entre robots es del
 * agente, que consulta por `(robot_id, status, created_at)`.
 */
export function elegirProximaOrden(cola: readonly OrdenEnCola[]): OrdenEnCola | undefined {
  return noImplementado('elegirProximaOrden', { cola })
}
