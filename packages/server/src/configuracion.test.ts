// Lo que se afirma aca no es el parseo: es que un despliegue mal configurado no
// arranque a medias y que el operador se entere de TODO lo que falta de una vez.

import { describe, expect, it } from 'vitest'

import {
  describirErrorDeConfiguracion,
  leerConfiguracion,
  VARIABLE_DE_BIND,
  VARIABLE_DE_PUERTO,
  VARIABLE_DE_RETENCION_DIAS,
  VARIABLE_DE_RUTA_DE_BASE,
} from './configuracion.js'
import { generarClaveDeCifrado, VARIABLE_DE_CLAVE } from './persistence/cifrado.js'

const MINIMO = {
  [VARIABLE_DE_RUTA_DE_BASE]: '/var/lib/aoki-one/servidor.db',
  [VARIABLE_DE_CLAVE]: generarClaveDeCifrado(),
} as const

describe('configuracion del proceso', () => {
  it('con lo minimo aplica los defaults de despliegue', () => {
    const configuracion = leerConfiguracion(MINIMO)

    expect(configuracion.ok).toBe(true)
    if (!configuracion.ok) {
      return
    }
    expect(configuracion.valor.rutaDeBase).toBe('/var/lib/aoki-one/servidor.db')
    expect(configuracion.valor.httpPuerto).toBe(8080)
    // Loopback: sin proxy delante el puerto no se publica solo.
    expect(configuracion.valor.httpBind).toBe('127.0.0.1')
    expect(configuracion.valor.retencion.diasDePedidosTerminados).toBe(90)
  })

  it('lista TODOS los errores juntos y no solo el primero', () => {
    const configuracion = leerConfiguracion({
      [VARIABLE_DE_PUERTO]: 'ocho mil',
      [VARIABLE_DE_RETENCION_DIAS]: '0',
    })

    expect(configuracion.ok).toBe(false)
    if (configuracion.ok) {
      return
    }
    const codigos = configuracion.error.map((error) => error.codigo)
    expect(codigos).toContain('VARIABLE_AUSENTE')
    expect(codigos).toContain('VARIABLE_NO_ES_ENTERO')
    expect(codigos).toContain('VARIABLE_FUERA_DE_RANGO')
    expect(codigos).toContain('CLAVE_DE_CREDENCIALES_INVALIDA')
  })

  it('nombra la variable que hay que corregir en el mensaje', () => {
    const configuracion = leerConfiguracion({ [VARIABLE_DE_CLAVE]: generarClaveDeCifrado() })

    expect(configuracion.ok).toBe(false)
    if (configuracion.ok) {
      return
    }
    const mensajes = configuracion.error.map(describirErrorDeConfiguracion).join(' ')
    expect(mensajes).toContain(VARIABLE_DE_RUTA_DE_BASE)
  })

  it('rechaza un puerto fuera de rango en vez de truncarlo', () => {
    const configuracion = leerConfiguracion({ ...MINIMO, [VARIABLE_DE_PUERTO]: '70000' })

    expect(configuracion.ok).toBe(false)
  })

  it('rechaza notaciones que Number() aceptaria pero son erratas', () => {
    // '1e3' seria 1000 con Number(). En un archivo de entorno es un dedazo.
    const configuracion = leerConfiguracion({ ...MINIMO, [VARIABLE_DE_PUERTO]: '1e3' })

    expect(configuracion.ok).toBe(false)
  })

  it('permite abrir el bind explicitamente', () => {
    const configuracion = leerConfiguracion({ ...MINIMO, [VARIABLE_DE_BIND]: '0.0.0.0' })

    expect(configuracion.ok).toBe(true)
    if (!configuracion.ok) {
      return
    }
    expect(configuracion.valor.httpBind).toBe('0.0.0.0')
  })
})
