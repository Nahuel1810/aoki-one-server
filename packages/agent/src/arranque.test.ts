// El arranque es lo que separa "la sucursal esta operando" de "la notebook tiene
// un proceso prendido que no mueve nada". Lo que se afirma: con el entorno mal
// no levanta y lo dice; con el entorno bien escucha en la LAN, deja escrito que
// capacidades quedaron apagadas y cierra limpio.

import { describe, expect, it } from 'vitest'

import type { Logger } from '@aoki-one/domain'

import { arrancar } from './arranque.js'
import {
  VARIABLE_DE_AGENT_ID,
  VARIABLE_DE_KEY_ID,
  VARIABLE_DE_MONTAR_API,
  VARIABLE_DE_PUERTO,
  VARIABLE_DE_RUTA_DE_BASE,
  VARIABLE_DE_SECRETO,
  VARIABLE_DE_SERVIDOR_URL,
  VARIABLE_DE_SIMULAR_PLC,
  VARIABLE_DE_SITE_ID,
  VARIABLE_DE_ZONA_DE_PICKEO,
} from './configuracion.js'
import { crearLoggerDelAgente } from './registro.js'

interface Captura {
  readonly lineas: readonly string[]
  readonly logger: Logger
  readonly eventos: () => readonly string[]
}

function capturar(): Captura {
  const lineas: string[] = []
  return {
    lineas,
    logger: crearLoggerDelAgente('DEBUG', (linea) => {
      lineas.push(linea)
    }),
    eventos: () => lineas.map((linea) => (JSON.parse(linea) as { readonly evento: string }).evento),
  }
}

const ENTORNO_VALIDO: Readonly<Record<string, string>> = {
  [VARIABLE_DE_SITE_ID]: 'SUC-CENTRO',
  [VARIABLE_DE_AGENT_ID]: 'AG-1',
  // En memoria: el arranque no tiene por que escribir un archivo para probarse.
  [VARIABLE_DE_RUTA_DE_BASE]: ':memory:',
  [VARIABLE_DE_ZONA_DE_PICKEO]: '3X02AE1,3X01AE1',
  // Puerto 0: lo asigna el sistema. Uno fijo es EADDRINUSE en CI.
  [VARIABLE_DE_PUERTO]: '0',
}

describe('arranque del proceso del agente', () => {
  it('no levanta con el entorno vacio y loguea cada variable que falta', async () => {
    const captura = capturar()

    const proceso = await arrancar({ entorno: {}, logger: captura.logger })

    expect(proceso.ok).toBe(false)
    if (proceso.ok) {
      return
    }
    expect(proceso.error.codigo).toBe('CONFIGURACION_INVALIDA')
    expect(captura.eventos()).toContain('CONFIG_INVALID')
    // Ruidoso de verdad: la credencial que emitio el servidor se pega en estas
    // variables, y el que esta en la sucursal tiene que leer cual le falta.
    const todo = captura.lineas.join(' ')
    expect(todo).toContain(VARIABLE_DE_SITE_ID)
    expect(todo).toContain(VARIABLE_DE_RUTA_DE_BASE)
    expect(todo).toContain(VARIABLE_DE_ZONA_DE_PICKEO)
  })

  it('no levanta con el enlace configurado a medias', async () => {
    // Una URL sin secreto es un despliegue a medio terminar. Degradarlo a
    // "enlace apagado" deja una sucursal que parece andar y no reporta nada.
    const captura = capturar()

    const proceso = await arrancar({
      entorno: {
        ...ENTORNO_VALIDO,
        [VARIABLE_DE_SERVIDOR_URL]: 'https://pedidos.midominio.com',
        [VARIABLE_DE_KEY_ID]: 'key-1',
      },
      logger: captura.logger,
    })

    expect(proceso.ok).toBe(false)
    if (proceso.ok) {
      return
    }
    expect(proceso.error.codigo).toBe('CONFIGURACION_INVALIDA')
    expect(captura.lineas.join(' ')).toContain(VARIABLE_DE_SECRETO)
  })

  it('traduce la excepcion del agente a un error de arranque, sin stack suelto', async () => {
    const captura = capturar()

    const proceso = await arrancar({
      entorno: ENTORNO_VALIDO,
      logger: captura.logger,
      crear: () => {
        throw new Error('la base tiene el esquema viejo')
      },
    })

    expect(proceso.ok).toBe(false)
    if (proceso.ok) {
      return
    }
    expect(proceso.error.codigo).toBe('NO_PUDO_ABRIR')
    expect(captura.eventos()).toContain('STARTUP_FAILED')
  })

  it('escucha en la LAN, anuncia lo que quedo apagado y cierra limpio', async () => {
    const captura = capturar()

    const proceso = await arrancar({ entorno: ENTORNO_VALIDO, logger: captura.logger })

    expect(proceso.ok).toBe(true)
    if (!proceso.ok) {
      return
    }
    try {
      expect(proceso.valor.direccion()?.host).toBe('127.0.0.1')
      expect(captura.eventos()).toContain('AGENT_LISTENING')
      // T26: sin las tres variables del enlace el agente corre SOLO, con su
      // cola local, y lo deja escrito.
      expect(captura.eventos()).toContain('LINK_DISABLED')
      // RF22: sin token, el comando directo a PLC no existe.
      expect(captura.eventos()).toContain('MAINTENANCE_COMMAND_DISABLED')
      // RF20: no simula, asi que no hay nada que advertir.
      expect(captura.eventos()).not.toContain('PLC_SIMULATED')
    } finally {
      await proceso.valor.detener()
    }
    expect(captura.eventos()).toContain('AGENT_STOPPED')
  })

  it('el secreto del enlace no sale en ninguna linea de log', async () => {
    const captura = capturar()
    const secreto = 'ESTE-SECRETO-NO-PUEDE-APARECER'

    const proceso = await arrancar({
      entorno: {
        ...ENTORNO_VALIDO,
        [VARIABLE_DE_SERVIDOR_URL]: 'http://127.0.0.1:9',
        [VARIABLE_DE_KEY_ID]: 'key-1',
        [VARIABLE_DE_SECRETO]: secreto,
      },
      logger: captura.logger,
    })

    expect(proceso.ok).toBe(true)
    if (!proceso.ok) {
      return
    }
    try {
      // La URL si sale: es lo que se mira cuando la sucursal no reporta y hay un
      // proxy o un DNS de por medio. El secreto no, nunca.
      expect(captura.lineas.join(' ')).toContain('http://127.0.0.1:9')
      expect(captura.lineas.join(' ')).not.toContain(secreto)
      expect(captura.eventos()).not.toContain('LINK_DISABLED')
    } finally {
      await proceso.valor.detener()
    }
  })

  it('con la simulacion encendida lo advierte, porque en produccion no deberia estar', async () => {
    const captura = capturar()

    const proceso = await arrancar({
      entorno: { ...ENTORNO_VALIDO, [VARIABLE_DE_SIMULAR_PLC]: 'true' },
      logger: captura.logger,
    })

    expect(proceso.ok).toBe(true)
    if (!proceso.ok) {
      return
    }
    try {
      const simulado = captura.lineas
        .map((linea) => JSON.parse(linea) as { readonly evento: string; readonly nivel: string })
        .find((registro) => registro.evento === 'PLC_SIMULATED')
      // WARN: es el unico apagado que hace que la API conteste OK sin que el
      // robot se mueva (RF20).
      expect(simulado?.nivel).toBe('WARN')
    } finally {
      await proceso.valor.detener()
    }
  })

  it('sin API montada arranca igual y lo dice: el agente no es su API', async () => {
    const captura = capturar()

    const proceso = await arrancar({
      entorno: { ...ENTORNO_VALIDO, [VARIABLE_DE_MONTAR_API]: 'false' },
      logger: captura.logger,
    })

    expect(proceso.ok).toBe(true)
    if (!proceso.ok) {
      return
    }
    try {
      expect(proceso.valor.direccion()).toBeNull()
      expect(captura.eventos()).toContain('AGENT_API_DISABLED')
      expect(captura.eventos()).not.toContain('AGENT_LISTENING')
    } finally {
      await proceso.valor.detener()
    }
  })
})
