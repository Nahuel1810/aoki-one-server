// Portado de tests/unit/queueManager.test.js :: "QueueManager mantiene FIFO por
// robot" — RF08, RF23.
//
// TRADUCIDO. La cola concreta desaparece: el orquestador consume el puerto de
// origen de ordenes y la decision de "cual sigue" se extrae a funcion pura del
// dominio. El legacy encolaba y desencolaba contra un array en memoria
// (`enqueue` / `dequeueNext`); aca se le pasa la cola del robot y se pregunta
// cual sigue.
//
// CAMBIO DE CONTRATO: la cola vacia devolvia `null` (`items.shift() || null`) y
// ahora devuelve `undefined`. El `|| null` del legacy confunde "no hay orden"
// con "hay pero su id es falsy" (cadena vacia, 0); el contrato nuevo lo separa.
//
// El orden ya no es el de insercion en un array sino `creadaEn`, que es lo que
// hace que una orden rehidratada tras un reinicio no pierda su lugar (RF15): por
// eso el caso principal pasa la cola DESORDENADA, cosa que el legacy no podia
// expresar.
//
// El nombre del test legacy mentia ("por robot" y solo usaba el robot '1'): el
// aislamiento entre robots no es de esta funcion, que recibe la cola de un solo
// robot. La regla completa de RF09 (PICK antes que PUT, con inversion por zona
// llena) no se afirma aca: figura como deficit conocido del mapeo y entra con su
// propia task.

import { describe, expect, it } from 'vitest'

import { elegirProximaOrden } from './queueOrdering.js'
import type { OrdenEnCola } from './queueOrdering.js'

const PRIMERA: OrdenEnCola = { ordenId: 'o1', creadaEn: 1_000 }
const SEGUNDA: OrdenEnCola = { ordenId: 'o2', creadaEn: 2_000 }

describe('RF08 — cual orden sigue en la cola de un robot', () => {
  it('sirve primero la mas antigua aunque llegue segunda en el arreglo', () => {
    expect(elegirProximaOrden([SEGUNDA, PRIMERA])).toEqual(PRIMERA)
  })

  it('servida la primera, la que sigue es la otra', () => {
    expect(elegirProximaOrden([SEGUNDA])).toEqual(SEGUNDA)
  })

  it('la cola vacia no tiene proxima orden: undefined, no null', () => {
    expect(elegirProximaOrden([])).toBeUndefined()
  })

  it('a igual creadaEn conserva el orden de entrada del arreglo', () => {
    const empateA: OrdenEnCola = { ordenId: 'oA', creadaEn: 1_500 }
    const empateB: OrdenEnCola = { ordenId: 'oB', creadaEn: 1_500 }

    expect(elegirProximaOrden([empateA, empateB])).toEqual(empateA)
    expect(elegirProximaOrden([empateB, empateA])).toEqual(empateB)
  })
})
