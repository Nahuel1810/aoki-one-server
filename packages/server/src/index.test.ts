import { describe, expect, it } from 'vitest'

import { PACKAGE_NAME } from '@aoki-one/domain'

import { main, PACKAGE_NAME_SERVER } from './index.js'

describe('andamiaje del servidor', () => {
  it('resuelve el import desde @aoki-one/domain', () => {
    expect(PACKAGE_NAME).toBe('@aoki-one/domain')
  })

  it('expone main() como funcion sin auto-ejecutarla al importar', () => {
    expect(typeof main).toBe('function')
  })

  it('se identifica con su propio nombre de paquete', () => {
    expect(PACKAGE_NAME_SERVER).toBe('@aoki-one/server')
  })
})
