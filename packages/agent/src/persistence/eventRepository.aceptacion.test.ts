// Suite de aceptacion T02 — portado de tests/unit/errorHandler.test.js.
//
// Test TRADUCIDO: cambia el componente, no el hecho que se afirma.

import { describe, expect, it } from 'vitest'

import { abrirBase } from './database.js'
import { crearEventRepository, type Evento } from './eventRepository.js'

describe('registro de eventos del agente (RF23)', () => {
  // El legacy afirmaba `ErrorHandler.capture(state, {...})` contra el array
  // `errors` en memoria del StateManager. StateManager desaparece (RF23) y el
  // hecho que importa —que un fallo quede registrado, asociado a su entidad y
  // consultable— se traslada a la tabla `events`. Ademas id, ts y severidad ya no
  // se generan adentro: se inyectan.
  //
  // Se arreglan de paso dos debilidades del legacy: no afirmaba los campos que el
  // propio addError inyectaba (id, timestamp, severity 'ERROR') ni el orden
  // descendente de listErrors.
  it('registra el error de una orden y lo devuelve listable del mas nuevo al mas viejo', async () => {
    const base = abrirBase(':memory:')
    const repositorio = crearEventRepository(base)

    const primero: Evento = {
      id: 'e1',
      ts: 1_700_000_000_000,
      tipoDeEntidad: 'ORDER',
      entidadId: 'o1',
      evento: 'STEP_FAILED',
      severidad: 'ERROR',
      metadata: { mensaje: 'boom', robotId: '1', paso: 3, intento: 2 },
    }
    const segundo: Evento = {
      id: 'e2',
      ts: 1_700_000_001_000,
      tipoDeEntidad: 'ORDER',
      entidadId: 'o1',
      evento: 'STEP_FAILED',
      severidad: 'ERROR',
      metadata: { mensaje: 'boom otra vez', robotId: '1', paso: 3, intento: 3 },
    }

    expect(await repositorio.registrar(primero)).toEqual(primero)
    expect(await repositorio.registrar(segundo)).toEqual(segundo)

    const listados = await repositorio.listar({ tipoDeEntidad: 'ORDER', entidadId: 'o1' })
    expect(listados).toEqual([segundo, primero])

    base.cerrar()
  })
})
