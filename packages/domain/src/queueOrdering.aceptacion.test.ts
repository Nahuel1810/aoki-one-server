// Portado de tests/unit/queueManager.test.js :: "QueueManager mantiene FIFO por
// robot" — RF08, RF23. Mas RF09 y RF10, que antes figuraban como deficit del
// mapeo y entran aca.
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
// robot.

import { describe, expect, it } from 'vitest'

import { elegirProximaOrden } from './queueOrdering.js'
import type { ColaDeRobot, OrdenEnCola } from './queueOrdering.js'

function orden(campos: Partial<OrdenEnCola> & Pick<OrdenEnCola, 'ordenId' | 'creadaEn'>): OrdenEnCola {
  return {
    tipo: 'PICK',
    lado: 'LEFT',
    esperandoSlot: false,
    ...campos,
  }
}

function cola(
  ordenes: readonly OrdenEnCola[],
  ladosConZonaLlena: ColaDeRobot['ladosConZonaLlena'] = [],
): ColaDeRobot {
  return { ordenes, ladosConZonaLlena }
}

const PRIMERA = orden({ ordenId: 'o1', creadaEn: 1_000 })
const SEGUNDA = orden({ ordenId: 'o2', creadaEn: 2_000 })

describe('RF08 — cual orden sigue en la cola de un robot', () => {
  it('sirve primero la mas antigua aunque llegue segunda en el arreglo', () => {
    expect(elegirProximaOrden(cola([SEGUNDA, PRIMERA]))).toEqual(PRIMERA)
  })

  it('servida la primera, la que sigue es la otra', () => {
    expect(elegirProximaOrden(cola([SEGUNDA]))).toEqual(SEGUNDA)
  })

  it('la cola vacia no tiene proxima orden: undefined, no null', () => {
    expect(elegirProximaOrden(cola([]))).toBeUndefined()
  })

  it('a igual creadaEn conserva el orden de entrada del arreglo', () => {
    const empateA = orden({ ordenId: 'oA', creadaEn: 1_500 })
    const empateB = orden({ ordenId: 'oB', creadaEn: 1_500 })

    expect(elegirProximaOrden(cola([empateA, empateB]))).toEqual(empateA)
    expect(elegirProximaOrden(cola([empateB, empateA]))).toEqual(empateB)
  })
})

describe('RF10 — una orden en espera no bloquea la cola', () => {
  // El caso que para la planta: el PICK de la izquierda no consigue slot y, sin
  // esta regla, se vuelve a elegir en cada ciclo y el robot no hace nada mas.
  it('saltea la orden que no puede tomar slot y sirve la siguiente, aunque sea mas nueva', () => {
    const bloqueada = orden({ ordenId: 'o-izq', creadaEn: 1_000, esperandoSlot: true })
    const delOtroLado = orden({ ordenId: 'o-der', creadaEn: 2_000, lado: 'RIGHT' })

    expect(elegirProximaOrden(cola([bloqueada, delOtroLado]))).toEqual(delOtroLado)
  })

  it('la orden en espera no pierde su lugar: en cuanto puede avanzar vuelve a encabezar', () => {
    const esperando = orden({ ordenId: 'o-izq', creadaEn: 1_000, esperandoSlot: true })
    const nueva = orden({ ordenId: 'o-der', creadaEn: 2_000, lado: 'RIGHT' })

    expect(elegirProximaOrden(cola([esperando, nueva]))).toEqual(nueva)
    // Mismo `creadaEn`, sin reencolar: se libero un slot y vuelve a ser la primera.
    const liberada = { ...esperando, esperandoSlot: false }
    expect(elegirProximaOrden(cola([liberada, nueva]))).toEqual(liberada)
  })

  it('con todas esperando no hay proxima orden, aunque la cola no este vacia', () => {
    const unaEspera = orden({ ordenId: 'o1', creadaEn: 1_000, esperandoSlot: true })
    const otraEspera = orden({ ordenId: 'o2', creadaEn: 2_000, esperandoSlot: true })

    expect(elegirProximaOrden(cola([unaEspera, otraEspera]))).toBeUndefined()
  })
})

describe('RF09 — PICK antes que PUT, con inversion por zona llena', () => {
  it('con slots libres sirve el PICK aunque el PUT sea mas antiguo', () => {
    const put = orden({ ordenId: 'o-put', creadaEn: 1_000, tipo: 'PUT' })
    const pick = orden({ ordenId: 'o-pick', creadaEn: 2_000, tipo: 'PICK' })

    expect(elegirProximaOrden(cola([put, pick]))).toEqual(pick)
  })

  it('con la zona de ese lado llena el PUT pasa al frente: es el unico que libera un slot', () => {
    const pick = orden({ ordenId: 'o-pick', creadaEn: 1_000, tipo: 'PICK', esperandoSlot: true })
    const put = orden({ ordenId: 'o-put', creadaEn: 2_000, tipo: 'PUT' })

    expect(elegirProximaOrden(cola([pick, put], ['LEFT']))).toEqual(put)
  })

  // La inversion es POR LADO: la zona izquierda llena no reordena la derecha.
  it('la zona llena de un lado no invierte el orden del otro lado', () => {
    const putIzquierdo = orden({ ordenId: 'o-put-izq', creadaEn: 1_000, tipo: 'PUT', lado: 'LEFT' })
    const pickDerecho = orden({ ordenId: 'o-pick-der', creadaEn: 1_100, tipo: 'PICK', lado: 'RIGHT' })
    const putDerecho = orden({ ordenId: 'o-put-der', creadaEn: 1_200, tipo: 'PUT', lado: 'RIGHT' })

    // El PUT izquierdo encabeza por la inversion; entre los del lado derecho
    // sigue mandando PICK antes que PUT.
    expect(elegirProximaOrden(cola([putDerecho, pickDerecho, putIzquierdo], ['LEFT']))).toEqual(
      putIzquierdo,
    )
    expect(elegirProximaOrden(cola([putDerecho, pickDerecho], ['LEFT']))).toEqual(pickDerecho)
  })
})
