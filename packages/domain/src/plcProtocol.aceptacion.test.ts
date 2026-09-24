// Suite de aceptacion T02 — port de tests/unit/locationTranslator.test.js (RF02).
//
// Traduccion de una ubicacion a comandos de carro y de elevador. Los numeros de
// este archivo (30201, 30200, 10211, 103) son casos verificados contra el robot
// real: se portan literales, no se re-derivan.

import { parsearLocationCode } from './locationCode.js'
import { describe, expect, it } from 'vitest'

import { construirComandoCarro, construirComandoElevadorIrNivel } from './plcProtocol.js'
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

describe('RF02 — comando de carro', () => {
  // DIRECTO. Se conservan el texto Y el numero a proposito: el texto pinea el
  // layout de digitos (sin ceros a la izquierda de mas ni padding extra) y el
  // numero es lo que viaja al PLC.
  it('construye comando de carro desde ubicacion: 3X04AA3T da 30201', () => {
    const ubicacion = valorDe(parsearLocationCode('3X04AA3T'))
    const comando = valorDe(construirComandoCarro(ubicacion))

    expect(comando.texto).toBe('30201')
    expect(comando.codigo).toBe(30201)
    expect(comando.posicion).toBe(3)
    expect(comando.parante).toBe(2)
    expect(comando.ladoBit).toBe(0)
    expect(comando.accionBit).toBe(1)
  })

  // DIRECTO. El sufijo del locationCode es opcional y la accion la impone el paso
  // fisico (RF04: CARRO_BUSCA usa T, CARRO_DEJA / CARRO_DEVUELVE usan D). El unico
  // digito que cambia entre traer y devolver es el ultimo.
  it('permite override de accion para comando carro: mismo codigo da 30201 con T y 30200 con D', () => {
    const ubicacion = valorDe(parsearLocationCode('3X04AA3'))

    expect(ubicacion.sufijo).toBe(null)
    expect(ubicacion.accion).toBe(null)
    expect(ubicacion.accionBit).toBe(null)

    const traer = valorDe(construirComandoCarro(ubicacion, 'T'))
    const devolver = valorDe(construirComandoCarro(ubicacion, 'D'))

    expect(traer.texto).toBe('30201')
    expect(traer.codigo).toBe(30201)
    expect(devolver.texto).toBe('30200')
    expect(devolver.codigo).toBe(30200)
    expect(traer.texto.slice(0, 4)).toBe(devolver.texto.slice(0, 4))
  })

  // Caso que el legacy nunca cubrio (lo marca el mapeo como defecto del test de
  // override): sin sufijo y sin override no hay accion que poner en el ultimo
  // digito, y eso es error del dominio, no un comando inventado.
  it('rechaza el comando de carro cuando no hay sufijo ni override de accion', () => {
    const ubicacion = valorDe(parsearLocationCode('3X04AA3'))

    expect(errorDe(construirComandoCarro(ubicacion))).toEqual({
      codigo: 'ACCION_INDETERMINADA',
      baseCode: '3X04AA3',
    })
  })

  // DIRECTO, renombrado. El nombre legacy ("usa parante redondeado hacia arriba con
  // dos digitos") mentia por omision: lo valioso no es el padding sino el ceil sobre
  // modulo impar y su efecto combinado con el ladoBit.
  it('parante = ceil(modulo / 2): los modulos 03 y 04 comparten parante y se distinguen solo por el ladoBit', () => {
    const impar = valorDe(construirComandoCarro(valorDe(parsearLocationCode('3X03AA1T'))))

    expect(impar.texto).toBe('10211')
    expect(impar.codigo).toBe(10211)
    expect(impar.parante).toBe(2)
    expect(impar.ladoBit).toBe(1)

    const par = valorDe(construirComandoCarro(valorDe(parsearLocationCode('3X04AA1T'))))

    expect(par.parante).toBe(2)
    expect(par.ladoBit).toBe(0)
    expect(par.texto).toBe('10201')
  })

  // Caso agregado: el legacy nunca probo un parante de dos digitos NATURALES
  // (modulo >= 19 -> parante >= 10), asi que el layout de 5 digitos con el parante
  // ya sin cero a la izquierda quedaba sin pinear.
  it('parante de dos digitos naturales: modulo 19 y 20 comparten parante 10 y mantienen el layout de 5 digitos', () => {
    const impar = valorDe(construirComandoCarro(valorDe(parsearLocationCode('3X19AA1T'))))

    expect(impar.parante).toBe(10)
    expect(impar.ladoBit).toBe(1)
    expect(impar.texto).toBe('11011')
    expect(impar.codigo).toBe(11011)

    const par = valorDe(construirComandoCarro(valorDe(parsearLocationCode('3X20AA1T'))))

    expect(par.parante).toBe(10)
    expect(par.ladoBit).toBe(0)
    expect(par.texto).toBe('11001')
    expect(par.codigo).toBe(11001)
  })
})

describe('RF02 — comando de elevador ir-a-nivel', () => {
  // DIRECTO. El caso del legacy es el nivel C = 3 -> 103.
  it('construye comando elevador segun nivel: 3X04AC3T va al nivel 3 y el comando es 103', () => {
    const ubicacion = valorDe(parsearLocationCode('3X04AC3T'))

    expect(ubicacion.nivel).toBe(3)
    expect(construirComandoElevadorIrNivel(ubicacion.nivel)).toBe(103)
  })

  // Caso agregado: el legacy probaba un solo nivel del medio y ninguno de los dos
  // bordes, asi que la formula 100 + nivel quedaba sin pinear en los extremos.
  it('la formula es 100 + nivel en los dos bordes del rango: A = 101 y L = 112', () => {
    expect(construirComandoElevadorIrNivel(1)).toBe(101)
    expect(construirComandoElevadorIrNivel(12)).toBe(112)
  })
})
