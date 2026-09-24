// Suite de aceptacion T02 — port de tests/unit/locationTranslator.test.js ::
// "mapeo de estanteria a robot configurable" (RF23).
//
// ADAPTADO (correccion de la auditoria cruzada: el mapeo individual lo marcaba
// "traducido"). El componente no solo se mueve: el CONTRATO cambia.
//
// Que afirmaba el legacy, con sus tres defectos, y por que no se reproduce:
//   1. `inferRobotIdFromEstanteria('3X') === '1'` por un mapa hardcodeado dentro
//      del parser. Ahora es un lookup por `(site_id, estanteria_code)`: es
//      configuracion de despliegue multi-sucursal, no gramatica de locationCode.
//   2. Fallback identidad: `'4X' -> '4X'` y `'3Y' -> '3Y'`. CAE. Con
//      `robots(id, site_id, estanteria_code)` el id del robot esta separado del
//      codigo de estanteria, y una estanteria que no esta dada de alta no existe:
//      el lookup devuelve `undefined`, no se inventa un robot.
//   3. `options.robotByEstanteria` ("configurable"): el legacy nunca lo usaba en
//      produccion y ademas REEMPLAZABA el default en vez de extenderlo (con
//      options, '3X' dejaba de mapear a '1'). El test legacy no lo detectaba
//      porque probaba con otra estanteria. No se porta la opcion; lo que se porta
//      es el invariante real: la unicidad por `(siteId, estanteriaCode)`.

import { describe, expect, it } from 'vitest'

import type { Result } from '@aoki-one/domain'

import { abrirBase } from './database.js'
import { crearRobotRepository } from './robotRepository.js'
import type { Robot } from './robotRepository.js'

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

function robot(id: string, siteId: string, estanteriaCode: string): Robot {
  return {
    id,
    siteId,
    estanteriaCode,
    habilitado: true,
    estado: 'IDLE',
    ordenActivaId: null,
  }
}

describe('RF23 — el mapeo estanteria -> robot es una fila de la tabla robots', () => {
  it('resuelve el robot por su codigo de estanteria dentro de la sucursal', async () => {
    const base = abrirBase(':memory:')
    const repositorio = crearRobotRepository(base)

    valorDe(await repositorio.guardar(robot('1', 'sucursal-centro', '3X')))

    const encontrado = await repositorio.buscarPorEstanteria('sucursal-centro', '3X')

    expect(encontrado?.id).toBe('1')
    base.cerrar()
  })

  it('una estanteria que no esta dada de alta no resuelve ningun robot: cae el fallback identidad del legacy', async () => {
    const base = abrirBase(':memory:')
    const repositorio = crearRobotRepository(base)

    valorDe(await repositorio.guardar(robot('1', 'sucursal-centro', '3X')))

    expect(await repositorio.buscarPorEstanteria('sucursal-centro', '4X')).toBe(undefined)
    expect(await repositorio.buscarPorEstanteria('sucursal-centro', '3Y')).toBe(undefined)
    base.cerrar()
  })

  it('el codigo de estanteria es unico por sucursal y el mismo codigo en otra sucursal es otro robot', async () => {
    const base = abrirBase(':memory:')
    const repositorio = crearRobotRepository(base)

    valorDe(await repositorio.guardar(robot('1', 'sucursal-centro', '3X')))

    expect(errorDe(await repositorio.guardar(robot('99', 'sucursal-centro', '3X')))).toEqual({
      codigo: 'ESTANTERIA_DUPLICADA',
      siteId: 'sucursal-centro',
      estanteriaCode: '3X',
    })

    valorDe(await repositorio.guardar(robot('99', 'sucursal-norte', '3X')))

    const otraSucursal = await repositorio.buscarPorEstanteria('sucursal-norte', '3X')

    expect(otraSucursal?.id).toBe('99')
    base.cerrar()
  })
})
