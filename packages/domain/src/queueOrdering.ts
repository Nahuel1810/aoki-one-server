// RF08, RF09 y RF10 — Cual orden sigue en la cola de un robot.
//
// Tres reglas, y las tres estan aca porque las tres deciden lo mismo:
//   RF08: FIFO por `creadaEn` dentro del robot.
//   RF09: PICK antes que PUT, con INVERSION cuando la zona de pickeo DE ESE LADO
//         esta llena —ahi los PUT pasan al frente, porque son los unicos que
//         liberan el slot que los PICK de ese lado estan esperando.
//   RF10: la orden que no puede tomar slot NO bloquea a las demas. Se saltea en
//         esta eleccion y vuelve sola en cuanto pueda avanzar, sin perder su
//         lugar: el orden se recalcula siempre desde `creadaEn`, que no se toca.
//
// El head-of-line block que esto cierra era una parada de planta: la orden en
// espera se volvia a elegir en cada ciclo y nada mas corria en ese robot, asi
// que un PICK del lado izquierdo con la zona izquierda llena congelaba tambien
// los PICK del lado derecho y TODOS los PUT —justamente los que liberarian el
// slot que esa orden esperaba—. El legacy no tenia el problema porque sacaba la
// orden de la cabeza de la cola (`clearActive` + `enqueue` en
// `deferOrderWaitingForSlot`), aunque al precio de mandarla al final y hacerle
// perder su lugar.
//
// Funcion pura: la cola concreta (memoria, SQLite, driver externo) es del
// agente; aca solo se decide cual sigue. Quien arma la cola es tambien quien
// mira los slots, asi que los dos hechos que dependen del estado de la zona
// —`esperandoSlot` y `ladosConZonaLlena`— entran como datos.

import type { Lado } from './locationCode.js'
import type { TipoOrden } from './order.js'

/** Lo minimo que la regla de servicio necesita saber de una orden en espera. */
export interface OrdenEnCola {
  readonly ordenId: string
  /**
   * Antiguedad, en epoch ms. El dominio no llama a `Date.now()`: el instante lo
   * inyecta quien arma la cola. Es lo que hace que una orden rehidratada tras un
   * reinicio no pierda su lugar.
   */
  readonly creadaEn: number
  readonly tipo: TipoOrden
  /** Lado del `locationCode` de la orden. La espera de RF10 es por (robot, lado). */
  readonly lado: Lado
  /**
   * `true` cuando la orden NO puede avanzar ahora mismo: un PICK sin ningun slot
   * LIBRE de su lado, o un PUT cuyo slot lo tiene tomado otra maniobra.
   *
   * Lo calcula el agente contra el estado vivo de la zona, no contra el flag
   * persistido: asi la orden se reactiva por el solo hecho de que el slot se
   * libere (RF10, "espera por evento") y no queda colgada de que alguien se
   * acuerde de bajarle el flag.
   */
  readonly esperandoSlot: boolean
}

export interface ColaDeRobot {
  /** Las PENDING de ESE robot. El aislamiento entre robots es del agente. */
  readonly ordenes: readonly OrdenEnCola[]
  /**
   * Lados cuya zona de pickeo no tiene ni un slot LIBRE.
   *
   * Es el disparador de la inversion de RF09. Va explicito en vez de derivarse
   * de `esperandoSlot` porque son dos hechos distintos: una zona puede estar
   * llena sin ninguna orden esperandola.
   */
  readonly ladosConZonaLlena: readonly Lado[]
}

/**
 * La proxima orden a servir, o `undefined` si no hay ninguna que pueda avanzar.
 *
 * `undefined` y no `null` a proposito: el legacy hace `items.shift() || null` y
 * confunde "no hay" con "hay pero el id es falsy".
 *
 * `undefined` NO significa cola vacia: puede haber ordenes y estar todas
 * esperando slot. Quien llama distingue los dos casos mirando `cola.ordenes`.
 */
export function elegirProximaOrden(cola: ColaDeRobot): OrdenEnCola | undefined {
  let elegida: OrdenEnCola | undefined
  for (const orden of cola.ordenes) {
    // RF10: la que no puede avanzar se saltea. No se reencola ni pierde su lugar.
    if (orden.esperandoSlot) {
      continue
    }
    if (elegida === undefined || ganaLaPrimera(orden, elegida, cola.ladosConZonaLlena)) {
      elegida = orden
    }
  }
  return elegida
}

/**
 * Prioridad de servicio de RF09: 0 va primero.
 *
 * Con la zona de ese lado llena se invierte y los PUT encabezan: son los unicos
 * que devuelven un cajon y liberan un slot, asi que postergarlos detras de un
 * PICK que no tiene donde dejar el suyo es el deadlock que RF09 nombra.
 */
function prioridad(orden: OrdenEnCola, ladosConZonaLlena: readonly Lado[]): 0 | 1 {
  const tipoQueEncabeza: TipoOrden = ladosConZonaLlena.includes(orden.lado) ? 'PUT' : 'PICK'
  return orden.tipo === tipoQueEncabeza ? 0 : 1
}

/** Desempate estricto: a igualdad total gana la que ya estaba elegida (sort estable). */
function ganaLaPrimera(
  candidata: OrdenEnCola,
  elegida: OrdenEnCola,
  ladosConZonaLlena: readonly Lado[],
): boolean {
  const prioridadCandidata = prioridad(candidata, ladosConZonaLlena)
  const prioridadElegida = prioridad(elegida, ladosConZonaLlena)
  if (prioridadCandidata !== prioridadElegida) {
    return prioridadCandidata < prioridadElegida
  }
  return candidata.creadaEn < elegida.creadaEn
}
