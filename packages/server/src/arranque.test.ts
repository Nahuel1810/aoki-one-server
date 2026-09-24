// El arranque es lo que separa "el servicio esta andando" de "systemd reinicia
// un proceso roto para siempre". Lo que se afirma: con el entorno mal no levanta
// y lo dice; con el entorno bien escucha y deja corriendo la purga.

import { describe, expect, it } from 'vitest'

import { arrancar } from './arranque.js'
import { VARIABLE_DE_PUERTO, VARIABLE_DE_RUTA_DE_BASE } from './configuracion.js'
import { generarClaveDeCifrado, VARIABLE_DE_CLAVE } from './persistence/cifrado.js'
import { crearLoggerDelServidor } from './registro.js'
import type { Logger } from '@aoki-one/domain'

interface Captura {
  readonly lineas: readonly string[]
  readonly logger: Logger
  readonly eventos: () => readonly string[]
}

function capturar(): Captura {
  const lineas: string[] = []
  return {
    lineas,
    logger: crearLoggerDelServidor({
      nivelMinimo: 'DEBUG',
      escribir: (linea) => {
        lineas.push(linea)
      },
      ahoraMs: () => 0,
    }),
    eventos: () =>
      lineas.map((linea) => (JSON.parse(linea) as { readonly evento: string }).evento),
  }
}

const ENTORNO_VALIDO = {
  // En memoria: el arranque no tiene por que escribir un archivo para probarse.
  [VARIABLE_DE_RUTA_DE_BASE]: ':memory:',
  [VARIABLE_DE_PUERTO]: '0',
  [VARIABLE_DE_CLAVE]: generarClaveDeCifrado(),
} as const

describe('arranque del proceso', () => {
  it('no levanta sin la clave de credenciales y loguea que falta', async () => {
    const captura = capturar()

    const proceso = await arrancar({
      entorno: { [VARIABLE_DE_RUTA_DE_BASE]: ':memory:' },
      logger: captura.logger,
    })

    expect(proceso.ok).toBe(false)
    if (proceso.ok) {
      return
    }
    expect(proceso.error.codigo).toBe('CONFIGURACION_INVALIDA')
    expect(captura.eventos()).toContain('CONFIG_INVALID')
    expect(captura.lineas.join(' ')).toContain(VARIABLE_DE_CLAVE)
  })

  it('traduce la excepcion del servidor a un error de arranque, sin stack suelto', async () => {
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

  it('escucha, purga al arrancar y cierra limpio', async () => {
    const captura = capturar()

    const proceso = await arrancar({ entorno: ENTORNO_VALIDO, logger: captura.logger })

    expect(proceso.ok).toBe(true)
    if (!proceso.ok) {
      return
    }
    try {
      expect(proceso.valor.direccion()).not.toBeNull()
      // La purga corre una vez al arrancar: con un intervalo largo y reinicios
      // diarios, si no, no correria nunca.
      expect(captura.eventos()).toContain('PURGE_DONE')
      expect(captura.eventos()).toContain('SERVER_LISTENING')
    } finally {
      await proceso.valor.detener()
    }
    expect(captura.eventos()).toContain('SERVER_STOPPED')
  })
})
