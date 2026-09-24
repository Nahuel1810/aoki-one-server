// RNF de Observabilidad — logs estructurados con nivel y correlacion por orden.
//
// Lo que se afirma aca es el contrato del logger en si. Que la correlacion
// aparezca de verdad en los dos lados del enlace se afirma donde corre el
// enlace: packages/agent/src/sync/correlacion.test.ts.

import { describe, expect, it } from 'vitest'

import {
  crearLogger,
  formatearRegistro,
  LOGGER_SILENCIOSO,
  type CorrelacionDeOrden,
  type NivelDeLog,
  type RegistroDeLog,
} from './logging.js'

const CORRELACION: CorrelacionDeOrden = {
  siteId: 'SUC-01',
  ordenId: 'remota-9',
  ordenIdLocal: 'local-1',
  externalOrderId: '47',
}

function armar(nivelMinimo: NivelDeLog = 'DEBUG'): {
  readonly logger: ReturnType<typeof crearLogger>
  readonly emitidos: RegistroDeLog[]
} {
  const emitidos: RegistroDeLog[] = []
  let reloj = 1_000
  const logger = crearLogger({
    componente: 'agente',
    nivelMinimo,
    ahoraMs: () => {
      reloj += 1
      return reloj
    },
    emitir: (registro) => emitidos.push(registro),
  })
  return { logger, emitidos }
}

describe('crearLogger', () => {
  it('emite un registro estructurado con nivel, componente, evento y reloj inyectado', () => {
    const { logger, emitidos } = armar()

    logger.info('AGENT_STARTED', { puerto: 8080 })

    expect(emitidos).toEqual([
      {
        ts: 1_001,
        nivel: 'INFO',
        componente: 'agente',
        evento: 'AGENT_STARTED',
        correlacion: null,
        datos: { puerto: 8080 },
      },
    ])
  })

  it('deja datos vacios cuando no se le pasan, en vez de undefined', () => {
    const { logger, emitidos } = armar()

    logger.debug('TICK')

    expect(emitidos[0]?.datos).toEqual({})
  })

  it('escribe los cuatro niveles', () => {
    const { logger, emitidos } = armar()

    logger.debug('A')
    logger.info('B')
    logger.warn('C')
    logger.error('D')

    expect(emitidos.map((registro) => registro.nivel)).toEqual(['DEBUG', 'INFO', 'WARN', 'ERROR'])
  })

  it('descarta lo que esta por debajo del nivel minimo', () => {
    const { logger, emitidos } = armar('WARN')

    logger.debug('A')
    logger.info('B')
    logger.warn('C')
    logger.error('D')

    expect(emitidos.map((registro) => registro.evento)).toEqual(['C', 'D'])
  })

  it('no gasta el reloj en lo que descarta', () => {
    // El nivel se decide ANTES de armar el registro: un DEBUG apagado en
    // produccion no puede costar una llamada por linea.
    const { logger, emitidos } = armar('ERROR')

    logger.debug('A')
    logger.error('B')

    expect(emitidos[0]?.ts).toBe(1_001)
  })

  it('paraOrden pega la correlacion a TODO lo que escribe el hijo', () => {
    const { logger, emitidos } = armar()

    const deLaOrden = logger.paraOrden(CORRELACION)
    deLaOrden.info('ORDER_CLAIMED')
    deLaOrden.error('STEP_FAILED', { seq: 3 })

    expect(emitidos.map((registro) => registro.correlacion)).toEqual([CORRELACION, CORRELACION])
    expect(emitidos[1]?.datos).toEqual({ seq: 3 })
  })

  it('el logger padre sigue sin correlacion despues de derivar un hijo', () => {
    const { logger, emitidos } = armar()

    logger.paraOrden(CORRELACION).info('HIJO')
    logger.info('PADRE')

    expect(emitidos[0]?.correlacion).toEqual(CORRELACION)
    expect(emitidos[1]?.correlacion).toBeNull()
  })

  it('un hijo puede re-correlacionarse a otra orden', () => {
    const { logger, emitidos } = armar()
    const otra: CorrelacionDeOrden = { ...CORRELACION, externalOrderId: '48' }

    logger.paraOrden(CORRELACION).paraOrden(otra).warn('CAMBIO')

    expect(emitidos[0]?.correlacion).toEqual(otra)
  })
})

describe('formatearRegistro', () => {
  const REGISTRO: RegistroDeLog = {
    ts: 1_700_000_000_000,
    nivel: 'ERROR',
    componente: 'servidor',
    evento: 'ORDER_TRANSITION_APPLIED',
    correlacion: CORRELACION,
    datos: { seq: 2 },
  }

  it('serializa una linea JSON con la correlacion adentro', () => {
    expect(JSON.parse(formatearRegistro(REGISTRO))).toEqual(REGISTRO)
  })

  it('no tira con datos que no se pueden serializar, y conserva la correlacion', () => {
    // Un ciclo en `datos` no puede matar al proceso del agente: lo unico que se
    // pierde es el detalle, nunca el id con el que se sigue la orden.
    const ciclico: Record<string, unknown> = {}
    ciclico['yo'] = ciclico

    const linea = formatearRegistro({ ...REGISTRO, datos: ciclico })
    const leido = JSON.parse(linea) as RegistroDeLog

    expect(leido.correlacion).toEqual(CORRELACION)
    expect(leido.evento).toBe('ORDER_TRANSITION_APPLIED')
    expect(Object.keys(leido.datos)).toEqual(['datosNoSerializables'])
  })
})

describe('LOGGER_SILENCIOSO', () => {
  it('no escribe nada y sus hijos tampoco', () => {
    // El contrato que usan los tests del agente y del servidor: inyectarlo tiene
    // que ser indistinguible de no loguear, sin ramas especiales en el codigo.
    expect(() => {
      LOGGER_SILENCIOSO.debug('A')
      LOGGER_SILENCIOSO.info('B')
      LOGGER_SILENCIOSO.warn('C')
      LOGGER_SILENCIOSO.error('D')
      LOGGER_SILENCIOSO.paraOrden(CORRELACION).error('E', { x: 1 })
    }).not.toThrow()
    expect(LOGGER_SILENCIOSO.paraOrden(CORRELACION)).toBe(LOGGER_SILENCIOSO)
  })
})
