// RF37 — Backoff exponencial con jitter y techo.
//
// El azar se inyecta, asi que el jitter se puede afirmar exactamente en vez de
// "esta entre dos numeros, mas o menos". Un backoff con jitter que no se puede
// testear es un backoff que nadie verifica.

import { describe, expect, it } from 'vitest'

import { BACKOFF_DEL_ENLACE, calcularEsperaDeBackoff, type Azar } from './backoff.js'

/** Azar deterministico: devuelve siempre el mismo sorteo. */
function azarFijo(valor: number): Azar {
  return { siguiente: () => valor }
}

const SIN_JITTER = { baseMs: 1_000, techoMs: 60_000, fraccionDeJitter: 0 }

describe('backoff del enlace (RF37)', () => {
  it('no espera nada mientras el enlace anda', () => {
    expect(calcularEsperaDeBackoff(SIN_JITTER, 0, azarFijo(0))).toBe(0)
  })

  it('duplica la espera con cada fallo consecutivo', () => {
    const esperas = [1, 2, 3, 4, 5].map((fallos) =>
      calcularEsperaDeBackoff(SIN_JITTER, fallos, azarFijo(0)),
    )
    expect(esperas).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
  })

  it('corta en el techo: un servidor caido no genera esperas de horas', () => {
    expect(calcularEsperaDeBackoff(SIN_JITTER, 20, azarFijo(0))).toBe(60_000)
    // El exponente se acota antes de elevar: sin eso esto seria Infinity.
    expect(calcularEsperaDeBackoff(SIN_JITTER, 1_000, azarFijo(0))).toBe(60_000)
  })

  it('el jitter mueve la espera dentro del tramo y sale del azar inyectado', () => {
    // Con fraccion 0.5, el sorteo solo puede mover la mitad superior del tramo.
    expect(calcularEsperaDeBackoff(BACKOFF_DEL_ENLACE, 1, azarFijo(0))).toBe(500)
    expect(calcularEsperaDeBackoff(BACKOFF_DEL_ENLACE, 1, azarFijo(0.5))).toBe(750)
    expect(calcularEsperaDeBackoff(BACKOFF_DEL_ENLACE, 1, azarFijo(0.999))).toBe(1_000)
  })

  it('dos agentes con distinto azar no reintentan en el mismo instante', () => {
    // Es la razon de ser del jitter en Fase 2: sin el, N agentes golpean juntos
    // al servidor justo cuando vuelve.
    const unAgente = calcularEsperaDeBackoff(BACKOFF_DEL_ENLACE, 4, azarFijo(0.1))
    const otroAgente = calcularEsperaDeBackoff(BACKOFF_DEL_ENLACE, 4, azarFijo(0.9))
    expect(unAgente).not.toBe(otroAgente)
  })
})
