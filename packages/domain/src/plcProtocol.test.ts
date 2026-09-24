// La tabla de codigos del PLC, dispositivo por dispositivo.
//
// Es el conocimiento de planta con menos red de todo el sistema: el operario ve
// estos textos en la pantalla cuando el robot se traba, y el legacy los resuelve
// con `CARRO[c] || ELEVADOR[c]` sin saber quien respondio. Los codigos 1, 2, 17,
// 18 y 99 existen en las DOS tablas con significados distintos, asi que hoy un
// error del elevador se le muestra al operario con el texto del carro.

import { describe, expect, it } from 'vitest'

import { decodificarRespuesta } from './plcProtocol.js'
import type { RespuestaPlc, TipoDispositivo } from './plcProtocol.js'

/** Tabla del CARRO, portada literal de src/config/plcProtocol.js. */
const ERRORES_DEL_CARRO: ReadonlyArray<readonly [number, string]> = [
  [1, 'Carro trabado avanzando'],
  [2, 'Carro trabado volviendo'],
  [6, 'No hay cajon'],
  [7, 'Problema con el puente'],
  [14, 'Inicio con cajon cargado'],
  [16, 'Bateria baja'],
  [17, 'Obstaculo volviendo'],
  [18, 'Obstaculo avanzando'],
  [99, 'No logro recuperarse'],
]

/** Tabla del ELEVADOR, portada literal. */
const ERRORES_DEL_ELEVADOR: ReadonlyArray<readonly [number, string]> = [
  [1, 'Elev trabado subiendo'],
  [2, 'Elev trabado bajando'],
  [3, 'Nivel incorrecto'],
  [17, 'Elev llego a limite inferior'],
  [18, 'Elev llego a limite superior'],
  [55, 'Ambas direcciones simultaneas'],
  [66, 'Llego a Home sin ir a Home'],
  [99, 'No logro recuperarse'],
]

function exigirError(respuesta: RespuestaPlc): Extract<RespuestaPlc, { kind: 'ERROR' }> {
  if (respuesta.kind !== 'ERROR') {
    throw new Error(`se esperaba un ERROR y llego ${respuesta.kind}`)
  }
  return respuesta
}

describe('decodificarRespuesta', () => {
  it('100 es el paso confirmado', () => {
    for (const dispositivo of ['CARRO', 'ELEVADOR'] as const) {
      expect(decodificarRespuesta(100, dispositivo)).toEqual({ kind: 'OK' })
    }
  })

  it('traduce la tabla COMPLETA de errores del carro, con codigo = valor - 100', () => {
    for (const [codigo, mensaje] of ERRORES_DEL_CARRO) {
      const respuesta = exigirError(decodificarRespuesta(100 + codigo, 'CARRO'))
      expect(respuesta.codigoError).toBe(codigo)
      expect(respuesta.mensaje).toBe(mensaje)
    }
  })

  it('traduce la tabla COMPLETA de errores del elevador', () => {
    for (const [codigo, mensaje] of ERRORES_DEL_ELEVADOR) {
      const respuesta = exigirError(decodificarRespuesta(100 + codigo, 'ELEVADOR'))
      expect(respuesta.codigoError).toBe(codigo)
      expect(respuesta.mensaje).toBe(mensaje)
    }
  })

  // El bug de planta que el legacy tiene vivo: el mismo numero significa cosas
  // distintas segun quien respondio, y sin el dispositivo no hay forma de saberlo.
  it('el mismo codigo da textos distintos segun el dispositivo que respondio', () => {
    const compartidos = [1, 2, 17, 18]
    for (const codigo of compartidos) {
      const carro = exigirError(decodificarRespuesta(100 + codigo, 'CARRO'))
      const elevador = exigirError(decodificarRespuesta(100 + codigo, 'ELEVADOR'))
      expect(carro.mensaje).not.toBe(elevador.mensaje)
    }
  })

  it('el 99 es fatal en los dos dispositivos y ningun otro lo es', () => {
    for (const dispositivo of ['CARRO', 'ELEVADOR'] as const) {
      expect(exigirError(decodificarRespuesta(199, dispositivo)).fatal).toBe(true)
    }

    const noFatales: ReadonlyArray<readonly [number, TipoDispositivo]> = [
      [1, 'CARRO'],
      [18, 'CARRO'],
      [3, 'ELEVADOR'],
      [66, 'ELEVADOR'],
    ]
    for (const [codigo, dispositivo] of noFatales) {
      expect(exigirError(decodificarRespuesta(100 + codigo, dispositivo)).fatal).toBe(false)
    }
  })

  it('un codigo de error sin texto en la tabla cae a un mensaje generico', () => {
    // 42 no esta en ninguna de las dos tablas.
    expect(exigirError(decodificarRespuesta(142, 'CARRO')).mensaje).toBe('Error PLC')
  })

  it('el rango 200-299 es el nivel que reporta el elevador', () => {
    expect(decodificarRespuesta(200, 'ELEVADOR')).toEqual({ kind: 'NIVEL', nivel: 0 })
    expect(decodificarRespuesta(205, 'ELEVADOR')).toEqual({ kind: 'NIVEL', nivel: 5 })
    expect(decodificarRespuesta(299, 'ELEVADOR')).toEqual({ kind: 'NIVEL', nivel: 99 })
  })

  it('300 y 301 son la presencia del carro', () => {
    expect(decodificarRespuesta(300, 'CARRO')).toEqual({ kind: 'PRESENCIA_CARRO', presente: true })
    expect(decodificarRespuesta(301, 'CARRO')).toEqual({ kind: 'PRESENCIA_CARRO', presente: false })
  })

  it('cualquier otro valor es desconocido y no se inventa un significado', () => {
    for (const valor of [0, 1, 99, 400, -5]) {
      expect(decodificarRespuesta(valor, 'CARRO')).toEqual({ kind: 'DESCONOCIDO', valor })
    }
  })
})
