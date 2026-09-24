// Suite de aceptacion T02 — portado de tests/unit/errorHandler.test.js (1 test,
// ADAPTADO) y tests/unit/modbusConnectivity.test.js (2 tests, DIRECTOS).
//
// RF19: solo los errores de transporte se reintentan.

import { describe, expect, it } from 'vitest'

import {
  clasificarError,
  esErrorDeConectividad,
  esReintentable,
  type FalloDeEjecucion,
} from './errorClassification.js'

/**
 * Lista COMPLETA de codigos de socket que el legacy reintenta (11).
 *
 * Se matchea contra `error.code` Y contra `error.errno`, ambos stringificados.
 * El test legacy solo cubria 3 de los 11.
 */
const CODIGOS_DE_TRANSPORTE = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ESOCKETTIMEDOUT',
  'ERR_SOCKET_CLOSED',
  'EAI_AGAIN',
  'ENOTCONN',
] as const

/**
 * Lista COMPLETA de frases que el legacy reintenta (17), por substring y sin
 * distinguir mayusculas. El test legacy solo cubria 2 de las 17.
 */
const FRASES_DE_TRANSPORTE = [
  'timeout',
  'timed out',
  'econnreset',
  'connection refused',
  'port not open',
  'broken pipe',
  'etimedout',
  'econnrefused',
  'socket',
  'network unreachable',
  'host unreachable',
  'no connection',
  'connection lost',
  'connection closed',
  'write after end',
  'socket hang up',
  'tcp',
] as const

describe('clasificacion de errores de transporte (RF19)', () => {
  // CAMBIO DE CONTRATO. El legacy afirmaba
  // `isRetryable(new Error('retry')) === true`: reintentable por DEFECTO, fatal
  // solo por opt-in (`error.fatal === true`). RF19 invierte la regla a lista
  // blanca —solo transporte se reintenta; las excepciones Modbus de aplicacion y
  // los errores de programacion fallan rapido—, asi que ese mismo assert pasa a
  // `false`. Portado literal, el test hubiera quedado en verde tapando la
  // inversion. Se conserva el otro assert del legacy: lo marcado fatal nunca se
  // reintenta, que es el vehiculo del codigo 99 del PLC (RF03).
  it('un Error generico ya NO es reintentable y solo el transporte se reintenta', () => {
    const generico = clasificarError(new Error('retry'))
    expect(generico.tipo).toBe('PROGRAMACION')
    expect(esReintentable(generico)).toBe(false)

    // Unico reintentable.
    expect(
      esReintentable({ tipo: 'TRANSPORTE', codigo: 'ECONNRESET', mensaje: 'socket hang up' }),
    ).toBe(true)

    // Los tres unicos puntos que el legacy marcaba fatal, uno por uno.
    // (a) codigo 99 del PLC, "No logro recuperarse".
    expect(
      esReintentable({
        tipo: 'PLC_ERROR',
        codigoError: 99,
        mensaje: 'No logro recuperarse',
        fatal: true,
      }),
    ).toBe(false)
    // (b) dispositivo no dado de alta.
    expect(
      esReintentable({
        tipo: 'DISPOSITIVO_NO_REGISTRADO',
        robotId: '1',
        dispositivo: 'ELEVADOR',
      }),
    ).toBe(false)
    // (c) paso confirmado pero reset incompleto: decision de planta, no se
    // reintenta sobre un PLC con el registro sucio.
    expect(
      esReintentable({ tipo: 'RESET_INCOMPLETO', mensaje: 'reset de messageIn incompleto' }),
    ).toBe(false)

    // El resto del rango de error del PLC (101-199) SI se reintenta dentro del
    // mismo paso, y el mismatch de estado es la unica marca no-fatal explicita del
    // legacy.
    expect(
      esReintentable({
        tipo: 'PLC_ERROR',
        codigoError: 1,
        mensaje: 'Carro trabado avanzando',
        fatal: false,
      }),
    ).toBe(true)
    expect(
      esReintentable({
        tipo: 'PLC_ESTADO_INESPERADO',
        valor: 7,
        mensaje: 'Estado PLC no coincide con lo esperado',
      }),
    ).toBe(true)

    // Lo que RF19 nombra como fallo rapido y el legacy reintentaba por defecto.
    expect(esReintentable({ tipo: 'MODBUS_APLICACION', mensaje: 'Illegal data address' })).toBe(
      false,
    )
    expect(esReintentable({ tipo: 'PROGRAMACION', mensaje: 'undefined is not a function' })).toBe(
      false,
    )
  })

  it('detecta codigos de socket comunes', () => {
    for (const codigo of CODIGOS_DE_TRANSPORTE) {
      expect(esErrorDeConectividad({ code: codigo })).toBe(true)
      // El matcheo tambien va contra errno, que el legacy no pineaba.
      expect(esErrorDeConectividad({ errno: codigo })).toBe(true)
    }

    for (const frase of FRASES_DE_TRANSPORTE) {
      expect(esErrorDeConectividad(new Error(`modbus: ${frase}`))).toBe(true)
      // Sin distinguir mayusculas.
      expect(esErrorDeConectividad(new Error(`MODBUS: ${frase.toUpperCase()}`))).toBe(true)
    }

    // Los dos casos textuales del legacy, tal cual.
    expect(esErrorDeConectividad({ message: 'Port not open' })).toBe(true)
    expect(esErrorDeConectividad({ message: 'TCP connection timed out' })).toBe(true)

    // Y que la clasificacion completa coincide con el atajo.
    const fallo = clasificarError({ code: 'ECONNRESET', message: 'socket hang up' })
    expect(fallo.tipo).toBe('TRANSPORTE')
    expect(esReintentable(fallo)).toBe(true)
  })

  it('no clasifica como transporte los errores de aplicacion ni los de programacion', () => {
    // Los tres asserts del legacy.
    expect(esErrorDeConectividad({ message: 'Comando de carro invalido' })).toBe(false)
    expect(esErrorDeConectividad({ message: 'No hay dispositivo' })).toBe(false)
    expect(esErrorDeConectividad(null)).toBe(false)
    // Error ausente NO es conectividad: no se reintenta.
    expect(esErrorDeConectividad(undefined)).toBe(false)

    // El legacy pasaba estos dos por accidente (son strings en castellano que no
    // contienen ninguna de las 17 frases inglesas) y no cubria nada de lo que RF19
    // nombra. Las excepciones Modbus de aplicacion fallan rapido.
    for (const mensaje of [
      'Illegal data address',
      'Illegal function',
      'Gateway target device failed to respond',
    ]) {
      const fallo = clasificarError(new Error(mensaje))
      expect(fallo.tipo).toBe('MODBUS_APLICACION')
      expect(esErrorDeConectividad(new Error(mensaje))).toBe(false)
      expect(esReintentable(fallo)).toBe(false)
    }

    // DEFECTO DEL LEGACY que se arregla al portar: con 'socket' y 'tcp' entre las
    // frases, este TypeError de programacion se clasificaba como conectividad y
    // entraba al loop de reintentos (11 rondas x 3 intentos x 2 s), justo lo
    // contrario de "los errores de programacion fallan rapido". La frase sola no
    // alcanza: un error de programacion es de programacion aunque hable de sockets.
    const bugDeProgramacion = new TypeError(
      "Cannot read properties of undefined (reading 'socket')",
    )
    expect(esErrorDeConectividad(bugDeProgramacion)).toBe(false)
    const clasificado: FalloDeEjecucion = clasificarError(bugDeProgramacion)
    expect(clasificado.tipo).toBe('PROGRAMACION')
    expect(esReintentable(clasificado)).toBe(false)
  })
})
