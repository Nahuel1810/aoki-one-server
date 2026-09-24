// El arranque del servidor depende de la clave con la que se cifran las
// credenciales (RF32).
//
// Sin esa clave el servidor no puede descifrar ningun secreto de sucursal, y sin
// el secreto no puede recomputar ninguna firma: aceptaria trafico que no sabe
// autenticar. Arrancar a medias es peor que no arrancar, asi que falla ruidoso y
// antes de abrir la base o el puerto.

import { describe, expect, it } from 'vitest'

import { LOGGER_SILENCIOSO } from '@aoki-one/domain'

import { crearServidor } from './composition.js'
import { generarClaveDeCifrado, VARIABLE_DE_CLAVE } from './persistence/cifrado.js'

const BASE: Parameters<typeof crearServidor>[0] = {
  rutaDeBase: ':memory:',
  httpPuerto: 0,
  httpBind: '127.0.0.1',
  // El default del servidor escribe a stdout, que es lo que hace falta en
  // produccion y ruido en la suite. Lo que se afirma aca no es el log.
  logger: LOGGER_SILENCIOSO,
}

describe('arranque del servidor sin la clave de cifrado', () => {
  it('no arranca con el entorno vacio y dice que variable falta', () => {
    expect(() => crearServidor({ ...BASE, entorno: {} })).toThrow(VARIABLE_DE_CLAVE)
  })

  it('no arranca con la variable vacia', () => {
    expect(() => crearServidor({ ...BASE, entorno: { [VARIABLE_DE_CLAVE]: '' } })).toThrow(
      VARIABLE_DE_CLAVE,
    )
  })

  it('no arranca con una clave demasiado corta', () => {
    // El caso peligroso: una clave que "parece" configurada. Si se aceptara, el
    // cifrado seria mas debil de lo que dice la documentacion y nadie se enteraria.
    expect(() => crearServidor({ ...BASE, entorno: { [VARIABLE_DE_CLAVE]: 'abcdef' } })).toThrow(
      /32/,
    )
  })

  it('no arranca con una clave que no es hexadecimal', () => {
    expect(() =>
      crearServidor({ ...BASE, entorno: { [VARIABLE_DE_CLAVE]: 'x'.repeat(64) } }),
    ).toThrow(VARIABLE_DE_CLAVE)
  })

  it('arranca con la clave bien configurada', async () => {
    const servidor = crearServidor({
      ...BASE,
      entorno: { [VARIABLE_DE_CLAVE]: generarClaveDeCifrado() },
    })
    await servidor.iniciar()
    try {
      expect(servidor.direccion()).not.toBeNull()
    } finally {
      await servidor.detener()
    }
  })
})
