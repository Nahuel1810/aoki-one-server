// Suite de aceptacion T02 — port de tests/unit/locationTranslator.test.js (RF01).
//
// Gramatica de locationCode y todo lo que deriva de ella. Es conocimiento de
// planta: los codigos y los numeros de aca salieron del robot real, no de leer
// el codigo. Arranca en rojo porque el esqueleto tira "No implementado".

import { describe, expect, it } from 'vitest'

import { nivelDesdeLetra, parsearLocationCode } from './locationCode.js'
import type { Nivel } from './locationCode.js'
import type { Result } from './result.js'

function valorDe<T, E>(resultado: Result<T, E>): T {
  if (!resultado.ok) {
    throw new Error(`Se esperaba ok y llego error: ${JSON.stringify(resultado.error)}`)
  }
  return resultado.valor
}

function errorDe<T, E>(resultado: Result<T, E>): E {
  if (resultado.ok) {
    throw new Error(`Se esperaba error y llego ok: ${JSON.stringify(resultado.valor)}`)
  }
  return resultado.error
}

/** Las doce letras de nivel con su numero. A=1 ... L=12, rango cerrado. */
const NIVELES: readonly (readonly [string, Nivel])[] = [
  ['A', 1],
  ['B', 2],
  ['C', 3],
  ['D', 4],
  ['E', 5],
  ['F', 6],
  ['G', 7],
  ['H', 8],
  ['I', 9],
  ['J', 10],
  ['K', 11],
  ['L', 12],
]

describe('RF01 — gramatica de locationCode', () => {
  // ADAPTADO. El legacy tambien afirmaba `parsed.robotId === '1'`: ese assert CAE.
  // RF01 enumera lo que deriva el parseo (baseCode, estanteria, modulo, lado, nivel,
  // posicion) y no incluye robotId; el mapeo estanteria -> robot es configuracion de
  // despliegue y se va a la tabla `robots(site_id, estanteria_code)` del agente.
  // Se agregan `baseCode` y `lado`, que el legacy nunca verificaba.
  it('parsea ubicacion con accion traer: modulo par da lado derecho y sufijo T da accionBit 1', () => {
    const ubicacion = valorDe(parsearLocationCode('3X04AA3T'))

    expect(ubicacion.codigo).toBe('3X04AA3T')
    expect(ubicacion.baseCode).toBe('3X04AA3')
    expect(ubicacion.estanteria).toBe('3X')
    expect(ubicacion.moduloCode).toBe('04')
    expect(ubicacion.modulo).toBe(4)
    expect(ubicacion.lado).toBe('RIGHT')
    expect(ubicacion.ladoBit).toBe(0)
    expect(ubicacion.nivelLetra).toBe('A')
    expect(ubicacion.nivel).toBe(1)
    expect(ubicacion.posicion).toBe(3)
    expect(ubicacion.sufijo).toBe('T')
    expect(ubicacion.accion).toBe('T')
    expect(ubicacion.accionBit).toBe(1)
  })

  // DIRECTO. Se le agrega el assert de `lado === 'LEFT'`, que el legacy no hacia:
  // solo miraba el sideBit.
  it('parsea ubicacion con accion devolver: modulo impar da lado izquierdo, nivel L es el tope 12 y sufijo D da accionBit 0', () => {
    const ubicacion = valorDe(parsearLocationCode('3X05AL1D'))

    expect(ubicacion.moduloCode).toBe('05')
    expect(ubicacion.modulo).toBe(5)
    expect(ubicacion.lado).toBe('LEFT')
    expect(ubicacion.ladoBit).toBe(1)
    expect(ubicacion.nivelLetra).toBe('L')
    expect(ubicacion.nivel).toBe(12)
    expect(ubicacion.posicion).toBe(1)
    expect(ubicacion.sufijo).toBe('D')
    expect(ubicacion.accion).toBe('D')
    expect(ubicacion.accionBit).toBe(0)
  })

  // Conocimiento de planta que el legacy nunca afirmo de forma directa: son doce
  // niveles exactos y fuera de A..L el codigo se rechaza ("Nivel invalido. Debe ser
  // entre A y L"). `nivelDesdeLetra` es el unico productor de NIVEL_FUERA_DE_RANGO:
  // la gramatica completa nunca deja llegar una M hasta el nivel.
  it('nivelDesdeLetra pinea los doce niveles A..L como 1..12', () => {
    for (const [letra, esperado] of NIVELES) {
      expect(valorDe(nivelDesdeLetra(letra))).toBe(esperado)
    }
  })

  it('nivelDesdeLetra rechaza toda letra fuera de A..L', () => {
    expect(errorDe(nivelDesdeLetra('M'))).toEqual({
      codigo: 'NIVEL_FUERA_DE_RANGO',
      letra: 'M',
    })
    expect(errorDe(nivelDesdeLetra('Z'))).toEqual({
      codigo: 'NIVEL_FUERA_DE_RANGO',
      letra: 'Z',
    })
  })
})
