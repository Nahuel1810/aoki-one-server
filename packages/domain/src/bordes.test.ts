// Los bordes del dominio que la suite de aceptacion no ejercita.
//
// T24 pide cobertura completa de `domain`, y el hueco no es decorativo: son las
// ramas de RECHAZO. Un dominio que solo tiene probado el camino feliz no sirve
// para lo que RF06 pide —que una transicion invalida sea error y no un estado
// silencioso—, porque justamente esas ramas son las que nadie mira hasta que el
// robot hace algo raro.

import { describe, expect, it } from 'vitest'

import { nivelDesdeLetra, parsearLocationCode } from './locationCode.js'
import { transicionarOrden } from './order.js'
import type { EstadoOrden, EventoOrden } from './order.js'
import {
  decrementarPendingReturns,
  incrementarPendingReturns,
  resolverPick,
} from './pendingReturns.js'
import { rankearSlotsParaPick } from './slotSelection.js'
import { transicionarSlot } from './slotStateMachine.js'
import type { EstadoSlot, EventoSlot } from './slotStateMachine.js'

describe('locationCode: formatos que se rechazan (RF01)', () => {
  it('rechaza todo lo que no matchea la gramatica', () => {
    const invalidos = [
      '', // vacio
      '3X04AA', // sin posicion
      '3X4AA3', // modulo de un solo digito
      '3X04A3', // sin letra de nivel
      '3X04AM3', // nivel fuera de A-L: lo corta la regex, no el nivel
      '3X04AA3X', // sufijo que no es T, D ni L
      '3X04AA33', // posicion de dos digitos
      'AAAA', // nada que ver
    ]

    for (const codigo of invalidos) {
      const resultado = parsearLocationCode(codigo)
      expect(resultado.ok).toBe(false)
      if (!resultado.ok) {
        expect(resultado.error).toEqual({ codigo: 'FORMATO_INVALIDO', recibido: codigo })
      }
    }
  })

  it('el codigo del error conserva lo que mando el llamador, sin normalizar', () => {
    // Para que el mensaje al operario diga lo que el escribio y no una version
    // limpia que no reconoce.
    const resultado = parsearLocationCode('  no-existe  ')
    expect(resultado.ok).toBe(false)
    if (!resultado.ok) {
      expect(resultado.error).toEqual({ codigo: 'FORMATO_INVALIDO', recibido: '  no-existe  ' })
    }
  })

  it('nivelDesdeLetra cubre los doce niveles y rechaza el resto', () => {
    const letras = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']
    letras.forEach((letra, indice) => {
      expect(nivelDesdeLetra(letra)).toEqual({ ok: true, valor: indice + 1 })
    })

    // El conocimiento de planta: "Nivel invalido. Debe ser entre A y L".
    for (const letra of ['M', 'Z', '1', '', 'AA']) {
      const resultado = nivelDesdeLetra(letra)
      expect(resultado.ok).toBe(false)
      if (!resultado.ok) {
        expect(resultado.error).toEqual({ codigo: 'NIVEL_FUERA_DE_RANGO', letra })
      }
    }
  })
})

describe('transicionarOrden: todas las transiciones invalidas (RF06)', () => {
  const ESTADOS: readonly EstadoOrden[] = ['PENDING', 'IN_PROGRESS', 'DONE', 'ERROR', 'CANCELED']

  const VALIDAS: ReadonlyArray<readonly [EstadoOrden, EventoOrden, EstadoOrden]> = [
    ['PENDING', { tipo: 'INICIAR', robotId: '1' }, 'IN_PROGRESS'],
    ['IN_PROGRESS', { tipo: 'COMPLETAR' }, 'DONE'],
    ['IN_PROGRESS', { tipo: 'FALLAR', motivo: 'boom' }, 'ERROR'],
    ['ERROR', { tipo: 'REINTENTAR' }, 'PENDING'],
    ['IN_PROGRESS', { tipo: 'REHIDRATAR' }, 'PENDING'],
  ]

  it('acepta exactamente las cinco transiciones definidas', () => {
    for (const [desde, evento, esperado] of VALIDAS) {
      expect(transicionarOrden(desde, evento)).toEqual({ ok: true, valor: esperado })
    }
  })

  it('rechaza cualquier otra combinacion con error tipado', () => {
    const eventos: readonly EventoOrden[] = [
      { tipo: 'INICIAR', robotId: '1' },
      { tipo: 'COMPLETAR' },
      { tipo: 'FALLAR', motivo: 'boom' },
      { tipo: 'REINTENTAR' },
      { tipo: 'REHIDRATAR' },
    ]

    for (const desde of ESTADOS) {
      for (const evento of eventos) {
        const esValida = VALIDAS.some(([d, e]) => d === desde && e.tipo === evento.tipo)
        const resultado = transicionarOrden(desde, evento)
        if (esValida) {
          continue
        }
        expect(resultado.ok).toBe(false)
        if (!resultado.ok) {
          expect(resultado.error).toEqual({
            codigo: 'TRANSICION_INVALIDA',
            desde,
            evento: evento.tipo,
          })
        }
      }
    }
  })
})

describe('transicionarSlot: las transiciones invalidas que el legacy silenciaba', () => {
  const ESTADOS: readonly EstadoSlot[] = [
    { estado: 'LIBRE' },
    { estado: 'RESERVADO', ordenId: 'o-1', contenido: null },
    { estado: 'BUSCANDO', ordenId: 'o-1' },
    { estado: 'OCUPADO', contenido: { cajon: { id: 'c', ubicacionDeOrigen: '3X04AA1' }, pendingReturns: 1 } },
    { estado: 'DEVOLVIENDO', ordenId: 'o-1', contenido: null },
    { estado: 'ERROR', motivo: 'inutilizable' },
  ]

  const EVENTOS: readonly EventoSlot[] = [
    { tipo: 'RESERVAR_PARA_PICK', ordenId: 'o-2' },
    { tipo: 'RESERVAR_PARA_PUT', ordenId: 'o-2' },
    { tipo: 'INICIAR_BUSQUEDA', ordenId: 'o-2' },
    { tipo: 'OCUPAR', cajon: { id: 'c2', ubicacionDeOrigen: '3X06AA1' } },
    { tipo: 'INICIAR_DEVOLUCION', ordenId: 'o-2' },
    { tipo: 'LIBERAR' },
  ]

  /** Las unicas combinaciones que la maquina define. */
  const PERMITIDAS: ReadonlySet<string> = new Set([
    'LIBRE|RESERVAR_PARA_PICK',
    'LIBRE|RESERVAR_PARA_PUT',
    'OCUPADO|RESERVAR_PARA_PUT',
    'RESERVADO|INICIAR_BUSQUEDA',
    'BUSCANDO|OCUPAR',
    'RESERVADO|INICIAR_DEVOLUCION',
    'DEVOLVIENDO|LIBERAR',
    'OCUPADO|LIBERAR',
  ])

  it('cada par (estado, evento) fuera de la maquina devuelve error, nunca null', () => {
    for (const estado of ESTADOS) {
      for (const evento of EVENTOS) {
        const resultado = transicionarSlot(estado, evento)
        const permitida = PERMITIDAS.has(`${estado.estado}|${evento.tipo}`)
        expect(resultado.ok).toBe(permitida)
        if (!permitida && !resultado.ok) {
          expect(resultado.error).toEqual({
            codigo: 'TRANSICION_INVALIDA',
            desde: estado.estado,
            evento: evento.tipo,
          })
        }
      }
    }
  })

  it('un slot en ERROR no acepta ningun evento: para eso existe el estado', () => {
    for (const evento of EVENTOS) {
      expect(transicionarSlot({ estado: 'ERROR', motivo: 'roto' }, evento).ok).toBe(false)
    }
  })
})

describe('pendingReturns: los bordes del contador (RF07)', () => {
  it('rechaza incrementar desde un valor que no es un entero valido', () => {
    for (const actual of [0, -1, 1.5, Number.NaN]) {
      const resultado = incrementarPendingReturns(actual)
      expect(resultado.ok).toBe(false)
      if (!resultado.ok) {
        expect(resultado.error).toEqual({ codigo: 'PENDING_RETURNS_FUERA_DE_RANGO', actual })
      }
    }
  })

  it('rechaza decrementar desde 1 o menos: el contador no llega a 0 por esta via', () => {
    for (const actual of [1, 0, -3, 2.5]) {
      const resultado = decrementarPendingReturns(actual)
      expect(resultado.ok).toBe(false)
    }
    expect(decrementarPendingReturns(2)).toEqual({ ok: true, valor: 1 })
    expect(decrementarPendingReturns(5)).toEqual({ ok: true, valor: 4 })
  })

  it('resolverPick manda a ejecutar la maniobra cuando el cajon no esta en ningun slot', () => {
    expect(resolverPick(null)).toEqual({ ok: true, valor: { tipo: 'EJECUTAR_MANIOBRA' } })
  })

  it('resolverPick propaga el error cuando el contador del slot esta corrupto', () => {
    const resultado = resolverPick({
      cajon: { id: 'c', ubicacionDeOrigen: '3X04AA1' },
      // Un slot ocupado nunca deberia tener 0: si paso, no se sigue adelante.
      pendingReturns: 0,
    })
    expect(resultado.ok).toBe(false)
    if (!resultado.ok) {
      expect(resultado.error.codigo).toBe('PENDING_RETURNS_FUERA_DE_RANGO')
    }
  })
})

describe('rankearSlotsParaPick: entradas invalidas (RF05)', () => {
  it('rechaza la zona entera si un slot trae un codigo que no parsea', () => {
    const origen = parsearLocationCode('3X04AE1')
    expect(origen.ok).toBe(true)
    if (!origen.ok) {
      return
    }

    const resultado = rankearSlotsParaPick(origen.valor, [
      { locationCode: '3X02AE1', estado: { estado: 'LIBRE' } },
      { locationCode: 'no-es-un-codigo', estado: { estado: 'LIBRE' } },
    ])

    // No se saltea el slot roto: una zona mal configurada tiene que doler ahora y
    // no mandar el carro a un lugar que no existe.
    expect(resultado.ok).toBe(false)
    if (!resultado.ok) {
      expect(resultado.error.codigo).toBe('SLOT_CON_CODIGO_INVALIDO')
      expect(resultado.error.locationCode).toBe('no-es-un-codigo')
    }
  })

  it('devuelve lista vacia cuando no hay ninguno libre del mismo lado', () => {
    const origen = parsearLocationCode('3X04AE1')
    if (!origen.ok) {
      throw new Error('el origen del fixture tiene que parsear')
    }

    const resultado = rankearSlotsParaPick(origen.valor, [
      // Lado opuesto (modulo impar) aunque este libre.
      { locationCode: '3X01AE1', estado: { estado: 'LIBRE' } },
      // Mismo lado pero ocupado.
      {
        locationCode: '3X02AE1',
        estado: {
          estado: 'OCUPADO',
          contenido: { cajon: { id: 'c', ubicacionDeOrigen: '3X08AA1' }, pendingReturns: 1 },
        },
      },
    ])

    expect(resultado).toEqual({ ok: true, valor: [] })
  })
})
