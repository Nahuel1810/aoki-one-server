import { describe, expect, it } from 'vitest'

import { COMPONENTE, crearLoggerDelServidor, esNivelDeLog } from './registro.js'

function capturar(): { readonly lineas: string[]; readonly escribir: (linea: string) => void } {
  const lineas: string[] = []
  return {
    lineas,
    escribir: (linea) => {
      lineas.push(linea)
    },
  }
}

describe('logger del servidor', () => {
  it('escribe una linea JSON por evento, marcada como del servidor', () => {
    const { lineas, escribir } = capturar()
    const logger = crearLoggerDelServidor({ nivelMinimo: 'INFO', escribir, ahoraMs: () => 0 })

    logger.info('SERVER_LISTENING', { puerto: 8080 })

    expect(lineas).toHaveLength(1)
    expect(JSON.parse(lineas[0] ?? '')).toEqual({
      ts: 0,
      nivel: 'INFO',
      componente: COMPONENTE,
      evento: 'SERVER_LISTENING',
      correlacion: null,
      datos: { puerto: 8080 },
    })
  })

  it('descarta lo que esta por debajo del nivel minimo', () => {
    const { lineas, escribir } = capturar()
    const logger = crearLoggerDelServidor({ nivelMinimo: 'WARN', escribir, ahoraMs: () => 0 })

    logger.info('PURGE_DONE')
    logger.error('PURGE_FAILED')

    expect(lineas).toHaveLength(1)
  })

  it('reconoce los niveles validos y rechaza cualquier otro', () => {
    expect(esNivelDeLog('DEBUG')).toBe(true)
    expect(esNivelDeLog('VERBOSE')).toBe(false)
  })
})
