// El cifrado en reposo de los secretos de sucursal (RF32).

import { describe, expect, it } from 'vitest'

import {
  cifrar,
  descifrar,
  generarClaveDeCifrado,
  leerClaveDeCifrado,
  VARIABLE_DE_CLAVE,
  type ClaveDeCifrado,
} from './cifrado.js'

function clave(hex = generarClaveDeCifrado()): ClaveDeCifrado {
  const leida = leerClaveDeCifrado({ [VARIABLE_DE_CLAVE]: hex })
  if (!leida.ok) {
    throw new Error(`la clave de prueba tenia que ser valida: ${leida.error.codigo}`)
  }
  return leida.valor
}

describe('lectura de la clave del entorno', () => {
  it('rechaza el entorno sin la variable', () => {
    const leida = leerClaveDeCifrado({})
    expect(leida).toEqual({ ok: false, error: { codigo: 'CLAVE_AUSENTE', variable: VARIABLE_DE_CLAVE } })
  })

  it('rechaza la variable vacia igual que la ausente', () => {
    const leida = leerClaveDeCifrado({ [VARIABLE_DE_CLAVE]: '   ' })
    expect(leida.ok).toBe(false)
  })

  it('rechaza una clave que no es hexadecimal en vez de truncarla', () => {
    // `Buffer.from(x, 'hex')` corta en el primer caracter invalido: sin la guarda,
    // una errata se convierte en una clave mas corta y el servidor arranca igual.
    const leida = leerClaveDeCifrado({ [VARIABLE_DE_CLAVE]: `zz${generarClaveDeCifrado().slice(2)}` })
    expect(leida).toEqual({
      ok: false,
      error: { codigo: 'CLAVE_NO_ES_HEXADECIMAL', variable: VARIABLE_DE_CLAVE },
    })
  })

  it('rechaza una clave de menos de 32 bytes', () => {
    const leida = leerClaveDeCifrado({ [VARIABLE_DE_CLAVE]: 'abcdef' })
    expect(leida).toMatchObject({
      ok: false,
      error: { codigo: 'CLAVE_DE_LARGO_INVALIDO', bytesRecibidos: 3, bytesEsperados: 32 },
    })
  })
})

describe('sobre cifrado', () => {
  it('devuelve el secreto original al descifrar con la misma clave', () => {
    const k = clave()
    const sobre = cifrar(k, 'secreto-de-la-sucursal')
    expect(descifrar(k, sobre)).toEqual({ ok: true, valor: 'secreto-de-la-sucursal' })
  })

  it('no guarda el secreto en claro', () => {
    const sobre = cifrar(clave(), 'secreto-de-la-sucursal')
    expect(sobre).not.toContain('secreto-de-la-sucursal')
  })

  it('cifra el mismo secreto distinto cada vez', () => {
    // IV aleatorio por sobre. Reusarlo en GCM rompe la confidencialidad de los
    // dos mensajes, y ademas delataria que dos sucursales comparten secreto.
    const k = clave()
    expect(cifrar(k, 'igual')).not.toBe(cifrar(k, 'igual'))
  })

  it('con otra clave no devuelve un secreto distinto: falla', () => {
    const sobre = cifrar(clave(), 'secreto-de-la-sucursal')
    expect(descifrar(clave(), sobre)).toEqual({ ok: false, error: { codigo: 'NO_AUTENTICA' } })
  })

  it('rechaza un sobre alterado', () => {
    const k = clave()
    const sobre = cifrar(k, 'secreto-de-la-sucursal')
    const partes = sobre.split('.')
    const cifrado = partes[3] ?? ''
    const alterado = [...partes.slice(0, 3), `${cifrado.slice(0, -1)}${cifrado.endsWith('0') ? '1' : '0'}`].join('.')

    expect(descifrar(k, alterado)).toEqual({ ok: false, error: { codigo: 'NO_AUTENTICA' } })
  })

  it('rechaza cualquier cosa que no tenga la forma del sobre', () => {
    const k = clave()
    for (const basura of ['', 'secreto-en-claro', 'v1.aa.bb', 'v2.aa.bb.cc', 'v1.zz.bb.cc']) {
      expect(descifrar(k, basura)).toEqual({ ok: false, error: { codigo: 'SOBRE_INVALIDO' } })
    }
  })
})
