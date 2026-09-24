// RF05 — El sexto criterio del ranking: orden alfabetico del baseCode.
//
// DIVERGENCIA CORREGIDA contra el servidor de produccion.
// `src/core/orchestrator/slotDistance.js:286` cierra `comparePickSlotCandidates`
// con `a.normalizedLocationCode.localeCompare(b.normalizedLocationCode)`. El
// port lo documentaba en el docblock de `rankearSlotsParaPick` y en la cabecera
// de `slotSelection.aceptacion.test.ts` ("6. orden alfabetico del baseCode"),
// pero el `sort` terminaba en la posicion: el criterio no estaba implementado.
//
// No es un detalle estetico. Dos slots del mismo modulo y la misma posicion
// empatan en TODO lo anterior cuando estan a la misma distancia de nivel a uno y
// otro lado del origen. Sin el desempate, `Array.prototype.sort` es estable y
// devuelve el que vino primero en el arreglo — o sea el orden en que SQLite
// devolvio las filas de `slots`. El mismo pedido sobre la misma zona podia
// elegir distinto slot entre dos corridas, y eso es imposible de reproducir
// cuando el operario reporta "hoy lo dejo arriba y ayer abajo".
//
// El caso se construye con los dos ordenes de entrada posibles: es la unica
// forma de que el test falle si el desempate desaparece.

import { describe, expect, it } from 'vitest'

import { parsearLocationCode } from './locationCode.js'
import type { Result } from './result.js'
import { rankearSlotsParaPick } from './slotSelection.js'
import type { SlotDePickeo } from './slotSelection.js'

function valorDe<T, E>(resultado: Result<T, E>): T {
  if (resultado.ok) {
    return resultado.valor
  }
  throw new Error(`Se esperaba exito y hubo error: ${JSON.stringify(resultado.error)}`)
}

function slot(locationCode: string): SlotDePickeo {
  return { locationCode, estado: { estado: 'LIBRE' } }
}

function codigosRankeados(origen: string, slots: readonly SlotDePickeo[]): readonly string[] {
  const ubicacion = valorDe(parsearLocationCode(origen))
  return valorDe(rankearSlotsParaPick(ubicacion, slots)).map((candidato) => candidato.locationCode)
}

describe('rankearSlotsParaPick: determinismo del ultimo desempate', () => {
  // Origen 3X04AF1 -> nivel F = 6, modulo 04 (par, lado RIGHT).
  //   3X02AE1 -> nivel E = 5, distancia 1
  //   3X02AG1 -> nivel G = 7, distancia 1
  // Mismo modulo (02), misma posicion (1) y la MISMA distancia de nivel: los
  // cinco primeros criterios empatan. Decide el sexto, y gana el baseCode menor,
  // que ademas es el nivel mas bajo (el elevador queda mas cerca del piso).
  it('a igual distancia de nivel por arriba y por abajo gana el baseCode menor', () => {
    expect(codigosRankeados('3X04AF1', [slot('3X02AE1'), slot('3X02AG1')])).toEqual([
      '3X02AE1',
      '3X02AG1',
    ])
  })

  it('el resultado no depende del orden en que la base devolvio los slots', () => {
    // El mismo par, al reves. Sin el desempate alfabetico el sort estable
    // devolveria 3X02AG1 primero y este assert seria el que falla.
    expect(codigosRankeados('3X04AF1', [slot('3X02AG1'), slot('3X02AE1')])).toEqual([
      '3X02AE1',
      '3X02AG1',
    ])
  })

  it('el ganador es el mismo con los tres slots equidistantes y en cualquier orden', () => {
    // 3X02AE1 (nivel 5), 3X02AG1 (nivel 7) y 3X02AE2 (nivel 5, posicion 2).
    // Los tres estan a distancia de nivel 1 del origen y en el mismo modulo, asi
    // que decide primero la POSICION (absoluta, ascendente) y recien entre los
    // dos de posicion 1 decide el alfabetico: E1 -> G1 -> E2, venga como venga.
    const esperado = ['3X02AE1', '3X02AG1', '3X02AE2']

    expect(codigosRankeados('3X04AF1', [slot('3X02AG1'), slot('3X02AE2'), slot('3X02AE1')])).toEqual(
      esperado,
    )
    expect(codigosRankeados('3X04AF1', [slot('3X02AE2'), slot('3X02AE1'), slot('3X02AG1')])).toEqual(
      esperado,
    )
  })
})
