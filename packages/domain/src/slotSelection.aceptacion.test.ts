// Portado de tests/unit/slotDistance.test.js — RF05, seleccion de slot para PICK.
//
// Conocimiento de planta que protege este archivo: el carro NO cruza de lado (es
// una limitacion fisica, o sea exclusion del ranking y no una penalizacion de
// orden) y el orden de desempate real, el que corre contra el robot.
//
// El orden se porta del legacy (comparePickSlotCandidates en
// src/core/orchestrator/slotDistance.js), NO del enunciado de RF05 en la spec:
// el legacy tiene SEIS criterios y RF05 enumera cuatro. Ver el problema
// reportado sobre el criterio 4 (modulo absoluto menor), que es justamente el
// que decide el tercer test legacy.
//
//   1. mismo nivel que el origen  (redundante con el 2)
//   2. menor distancia de nivel
//   3. menor distancia de modulo
//   4. modulo absoluto ASCENDENTE        <- RF05 no lo nombra
//   5. posicion absoluta ascendente (1 antes que 2 antes que 3)
//   6. orden alfabetico del baseCode     <- RF05 no lo nombra

import { describe, expect, it } from 'vitest'

import { parsearLocationCode } from './locationCode.js'
import type { Result } from './result.js'
import { rankearSlotsParaPick } from './slotSelection.js'
import type { SlotDePickeo } from './slotSelection.js'
import type { EstadoSlot } from './slotStateMachine.js'

function valorDe<T, E>(resultado: Result<T, E>): T {
  if (resultado.ok) {
    return resultado.valor
  }

  throw new Error(`Se esperaba exito y hubo error: ${JSON.stringify(resultado.error)}`)
}

function slot(locationCode: string, estado: EstadoSlot = { estado: 'LIBRE' }): SlotDePickeo {
  return { locationCode, estado }
}

/** Codigos del ranking completo, de mejor a peor. La salida viene normalizada a baseCode. */
function codigosRankeados(origen: string, slots: readonly SlotDePickeo[]): readonly string[] {
  const ubicacion = valorDe(parsearLocationCode(origen))
  return valorDe(rankearSlotsParaPick(ubicacion, slots)).map((candidato) => candidato.locationCode)
}

describe('rankearSlotsParaPick', () => {
  // El legacy ponia el unico slot del lado opuesto (3X01AE1, |1-4|=3) MAS LEJOS
  // que el del lado correcto (3X02AE1, |2-4|=2), asi que el assert se cumplia
  // igual sin filtro de lado: ganaba por cercania de modulo. Aca el slot del
  // lado opuesto es ESTRICTAMENTE mas cercano (3X05AE1, |5-4|=1) y se afirma el
  // ranking completo, no solo el ganador: el filtro es lo unico que explica el
  // resultado.
  it('no cruza de lado: excluye los slots del lado opuesto aunque esten mas cerca', () => {
    const ranking = codigosRankeados('3X04AE1', [slot('3X05AE1'), slot('3X02AE1')])

    expect(ranking).toEqual(['3X02AE1'])
  })

  // El legacy lo titulaba "prioriza mismo nivel para evitar elevador" como si
  // fuera un criterio aparte. No lo es: el flag de mismo nivel es equivalente a
  // distancia de nivel 0, que ya es el minimo posible, asi que la rama nunca
  // cambia un resultado. Se conserva como el caso de distancia de nivel 0, sin
  // pretender que cubre un criterio propio.
  it('prefiere el slot del mismo nivel que el origen para no mover el elevador', () => {
    const ranking = codigosRankeados('3X04AE1', [slot('3X02AD3'), slot('3X02AE3')])

    expect(ranking).toEqual(['3X02AE3', '3X02AD3'])
  })

  // Primera mitad del legacy "si no hay mismo nivel, minimiza distancia vertical
  // y luego horizontal", reescrita para que pruebe lo que dice. Origen 3X04AE2:
  //   3X04AC1 -> distancia de nivel 2, distancia de modulo 0
  //   3X08AD1 -> distancia de nivel 1, distancia de modulo 4
  //   3X06AD1 -> distancia de nivel 1, distancia de modulo 2
  // El vertical manda sobre el horizontal: 3X04AC1 queda ultimo aunque este en
  // el mismo modulo que el origen.
  it('minimiza primero la distancia de nivel y recien despues la de modulo', () => {
    const ranking = codigosRankeados('3X04AE2', [slot('3X04AC1'), slot('3X08AD1'), slot('3X06AD1')])

    expect(ranking).toEqual(['3X06AD1', '3X08AD1', '3X04AC1'])
  })

  // Segunda mitad del mismo test legacy, y el hallazgo que tapaba. Los dos
  // candidatos de nivel D del legacy estaban EQUIDISTANTES en modulo (|2-4|=2 y
  // |6-4|=2): el comentario "modulo mas cerca" era falso. Lo que decidia era el
  // criterio 4, que RF05 no menciona. Sin el, un sort estable sobre este mismo
  // arreglo elegiria 3X06AD1 por venir primero.
  it('a igual distancia de modulo gana el modulo de numero menor', () => {
    const ranking = codigosRankeados('3X04AE2', [slot('3X06AD1'), slot('3X02AD1')])

    expect(ranking).toEqual(['3X02AD1', '3X06AD1'])
  })

  // Fusion de los dos tests legacy de posicion: "prioriza posiciones 1 -> 2 -> 3"
  // es un subcaso estricto de "... para cualquier nivel", que ademas afirma dos
  // cosas mas fuertes: que la preferencia NO depende de la posicion del origen
  // (el origen esta en la 2 y gana igual la 1) y que los doce niveles A..L
  // parsean. Se queda el fuerte.
  //
  // Limitacion conocida que se hereda: el desempate 6 (alfabetico del baseCode)
  // produce el mismo orden, asi que este caso no aisla el criterio de posicion.
  // Con los criterios 3 y 4 resolviendose antes que el 5, todo par de candidatos
  // que llegue a la posicion comparte modulo, y entonces sus baseCode solo
  // difieren en el digito de posicion. El criterio 5 es inaislable por
  // construccion.
  it('prefiere la posicion 1 sobre la 2 y la 2 sobre la 3, en los doce niveles A..L', () => {
    const niveles = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']

    for (const nivel of niveles) {
      const ranking = codigosRankeados(`3X04A${nivel}2`, [
        slot(`3X02A${nivel}3`),
        slot(`3X02A${nivel}1`),
        slot(`3X02A${nivel}2`),
      ])

      expect(ranking).toEqual([`3X02A${nivel}1`, `3X02A${nivel}2`, `3X02A${nivel}3`])
    }
  })

  // ADAPTADO. El legacy afirmaba que un slot con status 'OCCUPIED' no entra al
  // ranking, y pasaba por accidente: el slot ocupado estaba en la posicion 3 y
  // perdia igual contra el libre de la posicion 2, aunque no se filtrara nada.
  //
  // Que cambia (RF06 + decision de uniones discriminadas): el estado deja de ser
  // un string suelto, desaparecen el alias 'AVAILABLE', el matcheo
  // case-insensitive y el default permisivo del legacy (un slot SIN status se
  // tomaba por LIBRE, o sea que se podia reservar un slot ocupado). Y el assert
  // se amplia: RESERVADO, BUSCANDO, OCUPADO, DEVOLVIENDO y ERROR quedan TODOS
  // fuera, no solo el ocupado.
  //
  // Los estados no disponibles van ademas en las mejores posiciones posibles,
  // asi que el filtro es lo unico que puede explicar el resultado.
  it('solo rankea slots LIBRE: cualquier otro estado queda fuera', () => {
    const ranking = codigosRankeados('3X04AE1', [
      slot('3X02AE1', {
        estado: 'RESERVADO',
        ordenId: 'orden-1',
        contenido: null,
      }),
      slot('3X02AE2', { estado: 'BUSCANDO', ordenId: 'orden-2' }),
      slot('3X06AE1', {
        estado: 'OCUPADO',
        contenido: {
          cajon: { id: 'ORDER:orden-3', ubicacionDeOrigen: '3X05AE3' },
          pendingReturns: 1,
        },
      }),
      slot('3X06AE2', {
        estado: 'DEVOLVIENDO',
        ordenId: 'orden-4',
        contenido: null,
      }),
      slot('3X08AE1', { estado: 'ERROR', motivo: 'fallo de prueba' }),
      slot('3X02AE3'),
    ])

    expect(ranking).toEqual(['3X02AE3'])
  })
})
