// Portado de tests/unit/stateManager.test.js — RF06 y RF11.
//
// Cubre la parte de dominio de dos tests legacy:
//   - "StateManager administra slots y los persiste en snapshot" (el ciclo de
//     vida y la exclusividad de la reserva)
//   - "reserveSlotForPut acepta slots LIBRE y OCUPADO, rechaza otros"
//
// El primero era un mega-test de siete comportamientos encadenados: si fallaba
// el tercer assert los cuatro siguientes no corrian y el mensaje no decia que se
// rompio. Aca va abierto en casos independientes.
//
// CAMBIO DE CONTRATO (RF06). Los rechazos del legacy eran `null` silencioso
// (`assert.equal(secondReserve, null)`, `assert.equal(doubleReserve, null)`,
// `assert.equal(blockedReserve, null)`) y el llamador no podia distinguir "no se
// pudo" de "no habia nada". Ahora cada rechazo es un Result de error tipado con
// codigo TRANSICION_INVALIDA, que ademas dice desde que estado y con que evento.
//
// CAMBIO DE CONTRATO (RF11). El `{ slot, previousStatus }` del legacy dejo de
// ser un dato para que el llamador loguee: el estado previo es lo que distingue
// los dos caminos de PUT, y quedo codificado en el `contenido` del slot
// reservado — null si venia de LIBRE (devolucion manual fuera de libros, donde
// el pedido tiene que traer targetLocation o es 400) y el cajon preservado si
// venia de OCUPADO (devolucion estandar, el destino sale de
// `cajon.ubicacionDeOrigen`). El 400 en si no se puede afirmar en el dominio
// puro: lo valida el alta de orden del agente.
//
// Lo que NO se porta: `reserveOccupiedSlotForPut`. Es codigo muerto — no lo
// llama nadie en src/, produccion usa `reserveSlotForPut` — y portarlo seria
// escribir API nueva sin consumidor. Su comportamiento real (reservar para PUT
// un slot OCUPADO preservando el cajon) queda cubierto por RESERVAR_PARA_PUT.
//
// El caso 5 del legacy ("slot inexistente -> rechazo") NO se puede afirmar aca:
// `transicionarSlot` ya recibe el estado resuelto, asi que no puede emitir
// SLOT_INEXISTENTE. Su unico productor es el repositorio de slots del agente y
// el caso vive en packages/agent/src/persistence/slotRepository.aceptacion.test.ts.

import { describe, expect, it } from 'vitest'

import type { Cajon, EstadoSlot } from './slotStateMachine.js'
import { transicionarSlot } from './slotStateMachine.js'

/** Mismo cajon del test legacy: lo que importa es que la ubicacion de origen sobreviva. */
const CAJON: Cajon = { id: 'ORDER:order-pick', ubicacionDeOrigen: '3X05AE3' }

const LIBRE: EstadoSlot = { estado: 'LIBRE' }
const RESERVADO: EstadoSlot = {
  estado: 'RESERVADO',
  ordenId: 'order-1',
  contenido: null,
}
const BUSCANDO: EstadoSlot = { estado: 'BUSCANDO', ordenId: 'order-1' }
const OCUPADO: EstadoSlot = {
  estado: 'OCUPADO',
  contenido: { cajon: CAJON, pendingReturns: 1 },
}
const DEVOLVIENDO: EstadoSlot = {
  estado: 'DEVOLVIENDO',
  ordenId: 'order-put',
  contenido: { cajon: CAJON, pendingReturns: 1 },
}
const EN_ERROR: EstadoSlot = { estado: 'ERROR', motivo: 'fallo de prueba' }

describe('ciclo de vida del slot de pickeo', () => {
  it('LIBRE + RESERVAR_PARA_PICK toma el slot para la orden', () => {
    const resultado = transicionarSlot(LIBRE, {
      tipo: 'RESERVAR_PARA_PICK',
      ordenId: 'order-1',
    })

    expect(resultado).toEqual({
      ok: true,
      valor: { estado: 'RESERVADO', ordenId: 'order-1', contenido: null },
    })
  })

  it('RESERVADO + INICIAR_BUSQUEDA arranca la maniobra de PICK', () => {
    const resultado = transicionarSlot(RESERVADO, {
      tipo: 'INICIAR_BUSQUEDA',
      ordenId: 'order-1',
    })

    expect(resultado).toEqual({
      ok: true,
      valor: { estado: 'BUSCANDO', ordenId: 'order-1' },
    })
  })

  // El legacy lo afirmaba como `assert.equal(occupied.logicalPickStackDepth, 1)`:
  // al ocupar el refcount arranca en 1, no en 0. Uno = una unica devolucion
  // fisica pendiente.
  it('BUSCANDO + OCUPAR apoya el cajon y arranca pendingReturns en 1', () => {
    const resultado = transicionarSlot(BUSCANDO, {
      tipo: 'OCUPAR',
      cajon: CAJON,
    })

    expect(resultado).toEqual({
      ok: true,
      valor: {
        estado: 'OCUPADO',
        contenido: { cajon: CAJON, pendingReturns: 1 },
      },
    })
  })

  it('RESERVADO + INICIAR_DEVOLUCION arranca la maniobra de PUT', () => {
    const reservadoConCajon: EstadoSlot = {
      estado: 'RESERVADO',
      ordenId: 'order-put',
      contenido: { cajon: CAJON, pendingReturns: 1 },
    }

    const resultado = transicionarSlot(reservadoConCajon, {
      tipo: 'INICIAR_DEVOLUCION',
      ordenId: 'order-put',
    })

    expect(resultado).toEqual({
      ok: true,
      valor: {
        estado: 'DEVOLVIENDO',
        ordenId: 'order-put',
        contenido: { cajon: CAJON, pendingReturns: 1 },
      },
    })
  })

  // Legacy: `released.status === FREE` y `released.currentBox === null`.
  it('DEVOLVIENDO + LIBERAR deja el slot LIBRE y sin cajon', () => {
    const resultado = transicionarSlot(DEVOLVIENDO, { tipo: 'LIBERAR' })

    expect(resultado).toEqual({ ok: true, valor: { estado: 'LIBRE' } })
  })
})

describe('exclusividad de la reserva', () => {
  // ADAPTADO. El legacy afirmaba `assert.equal(secondReserve, null)`: la segunda
  // reserva del mismo slot devolvia null en silencio. RF06 exige que una
  // transicion invalida sea error del dominio, asi que el assert pasa de "es
  // null" a "es un Err con codigo TRANSICION_INVALIDA".
  it('un slot RESERVADO rechaza una segunda reserva de PICK con error tipado', () => {
    const resultado = transicionarSlot(RESERVADO, {
      tipo: 'RESERVAR_PARA_PICK',
      ordenId: 'order-2',
    })

    expect(resultado).toEqual({
      ok: false,
      error: {
        codigo: 'TRANSICION_INVALIDA',
        desde: 'RESERVADO',
        evento: 'RESERVAR_PARA_PICK',
      },
    })
  })
})

describe('reserva de PUT', () => {
  // Caso 1 del legacy: slot LIBRE -> reserva permitida con previousStatus FREE.
  // Es la devolucion manual de un cajon fuera-de-libros. El `previousStatus`
  // ahora se lee del `contenido` en null.
  it('acepta la reserva sobre un slot LIBRE y lo deja sin cajon', () => {
    const resultado = transicionarSlot(LIBRE, {
      tipo: 'RESERVAR_PARA_PUT',
      ordenId: 'order-put-free',
    })

    expect(resultado).toEqual({
      ok: true,
      valor: {
        estado: 'RESERVADO',
        ordenId: 'order-put-free',
        contenido: null,
      },
    })
  })

  // Caso 2 del legacy: slot OCUPADO -> reserva permitida, previousStatus
  // OCCUPIED y currentBox preservado (el legacy verificaba que
  // `currentBox.sourceLocationCode` siguiera siendo 3X05AE3). Es el dato del que
  // RF11 saca el destino de la devolucion estandar.
  it('acepta la reserva sobre un slot OCUPADO y preserva el cajon con su ubicacion de origen', () => {
    const resultado = transicionarSlot(OCUPADO, {
      tipo: 'RESERVAR_PARA_PUT',
      ordenId: 'order-put-occ',
    })

    expect(resultado).toEqual({
      ok: true,
      valor: {
        estado: 'RESERVADO',
        ordenId: 'order-put-occ',
        contenido: { cajon: CAJON, pendingReturns: 1 },
      },
    })
  })

  // Caso 3 del legacy, adaptado: era `assert.equal(doubleReserve, null)`.
  it('rechaza la reserva sobre un slot ya RESERVADO', () => {
    const resultado = transicionarSlot(RESERVADO, {
      tipo: 'RESERVAR_PARA_PUT',
      ordenId: 'order-put-other',
    })

    expect(resultado).toEqual({
      ok: false,
      error: {
        codigo: 'TRANSICION_INVALIDA',
        desde: 'RESERVADO',
        evento: 'RESERVAR_PARA_PUT',
      },
    })
  })

  // Caso 4 del legacy, adaptado: era `blockSlot` + `assert.equal(blockedReserve,
  // null)`. El estado sigue siendo valido (RF13 lo acota a un slot realmente
  // inutilizable), pero el rechazo ya no es null y el setup se escribe como dato
  // porque el `blockSlot` del camino de error desaparece.
  it('rechaza la reserva sobre un slot en ERROR', () => {
    const resultado = transicionarSlot(EN_ERROR, {
      tipo: 'RESERVAR_PARA_PUT',
      ordenId: 'order-put-blocked',
    })

    expect(resultado).toEqual({
      ok: false,
      error: {
        codigo: 'TRANSICION_INVALIDA',
        desde: 'ERROR',
        evento: 'RESERVAR_PARA_PUT',
      },
    })
  })

  // Hueco del legacy: el comentario del metodo prometia rechazar tambien
  // BUSCANDO y DEVOLVIENDO, y ningun caso los cubria.
  it('rechaza la reserva sobre un slot BUSCANDO', () => {
    const resultado = transicionarSlot(BUSCANDO, {
      tipo: 'RESERVAR_PARA_PUT',
      ordenId: 'order-put-buscando',
    })

    expect(resultado).toEqual({
      ok: false,
      error: {
        codigo: 'TRANSICION_INVALIDA',
        desde: 'BUSCANDO',
        evento: 'RESERVAR_PARA_PUT',
      },
    })
  })

  it('rechaza la reserva sobre un slot DEVOLVIENDO', () => {
    const resultado = transicionarSlot(DEVOLVIENDO, {
      tipo: 'RESERVAR_PARA_PUT',
      ordenId: 'order-put-devolviendo',
    })

    expect(resultado).toEqual({
      ok: false,
      error: {
        codigo: 'TRANSICION_INVALIDA',
        desde: 'DEVOLVIENDO',
        evento: 'RESERVAR_PARA_PUT',
      },
    })
  })
})
