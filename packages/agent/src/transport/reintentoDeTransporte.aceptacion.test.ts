// RF16 y RF19 — Los numeros exactos del reintento interno de transporte.
//
// Portado de `ConnectionService._runModbusOpInner`: 3 intentos por ronda con
// 2000 ms entre ellos, recreacion del cliente al agotar la ronda, y hasta 10
// rondas. Un corte de red de diez segundos —de los que el robot absorbe sin que
// el operario se entere— no puede mandar la orden a ERROR.
//
// El reloj va inyectado: la suite no duerme de verdad, pero SI afirma cuanto se
// habria dormido, que es el dato de planta.

import { describe, expect, it } from 'vitest'

import { clasificarError } from './errorClassification.js'
import { claveDeDispositivo } from './modbusClient.js'
import type { DispositivoRegistrado, ModbusClient, RegistroDeClientes } from './modbusClient.js'
import {
  envolverConReconexion,
  REINTENTO_DE_TRANSPORTE_DEL_LEGACY,
} from './reintentoDeTransporte.js'
import type { TiemposDeReintentoDeTransporte } from './reintentoDeTransporte.js'
import type { Reloj } from '../reloj.js'

const DISPOSITIVO: DispositivoRegistrado = {
  robotId: '1',
  tipo: 'CARRO',
  host: '127.0.0.1',
  puerto: 502,
  unitId: 255,
  timeoutMsDeSocket: 2000,
}

/** Reloj que no duerme pero anota cada espera. */
function crearRelojFalso(): { reloj: Reloj; esperas: readonly number[] } {
  const esperas: number[] = []
  return {
    esperas,
    reloj: {
      ahoraMs: () => 0,
      dormir: (ms) => {
        esperas.push(ms)
        return Promise.resolve()
      },
    },
  }
}

interface ClienteFalso {
  readonly cliente: ModbusClient
  readonly conexiones: () => number
  readonly escrituras: () => number
}

/**
 * Cliente que exige socket abierto y falla las primeras `fallos` escrituras con
 * un error de conectividad.
 */
function crearClienteFalso(fallos: number): ClienteFalso {
  let conectado = false
  let conexiones = 0
  let escrituras = 0
  let restantes = fallos

  return {
    conexiones: () => conexiones,
    escrituras: () => escrituras,
    cliente: {
      conectar: () => {
        if (!conectado) {
          conexiones += 1
          conectado = true
        }
        return Promise.resolve()
      },
      desconectar: () => {
        conectado = false
        return Promise.resolve()
      },
      estaConectado: () => conectado,
      marcarDesconectado: () => {
        conectado = false
      },
      leerRegistrosDeRetencion: (_direccion, cantidad) =>
        Promise.resolve(new Array<number>(cantidad).fill(0)),
      leerRegistrosDeEntrada: (_direccion, cantidad) =>
        Promise.resolve(new Array<number>(cantidad).fill(0)),
      escribirRegistro: () => {
        if (!conectado) {
          return Promise.reject(new Error('Port Not Open'))
        }
        escrituras += 1
        if (restantes > 0) {
          restantes -= 1
          const error: NodeJS.ErrnoException = new Error('read ECONNRESET')
          error.code = 'ECONNRESET'
          return Promise.reject(error)
        }
        return Promise.resolve()
      },
    },
  }
}

interface RegistroFalso {
  readonly registro: RegistroDeClientes
  readonly recreaciones: () => number
  readonly actual: () => ClienteFalso
}

/**
 * Registro que entrega clientes falsos y cuenta las recreaciones.
 *
 * `fallosPorGeneracion[i]` son los fallos del cliente i-esimo: el primero es el
 * original y los siguientes salen de cada recreacion. Agotada la lista se repite
 * el ultimo valor, que es como se expresa "no mejora recrearlo".
 */
function crearRegistroFalso(fallosPorGeneracion: readonly number[]): RegistroFalso {
  let generacion = 0
  let recreaciones = 0

  function fallosDe(indice: number): number {
    return fallosPorGeneracion[indice] ?? fallosPorGeneracion[fallosPorGeneracion.length - 1] ?? 0
  }

  let actual = crearClienteFalso(fallosDe(0))

  return {
    recreaciones: () => recreaciones,
    actual: () => actual,
    registro: {
      obtener: () => actual.cliente,
      asegurar: () => actual.cliente,
      recrear: () => {
        recreaciones += 1
        generacion += 1
        actual = crearClienteFalso(fallosDe(generacion))
        return Promise.resolve(actual.cliente)
      },
      cerrarTodos: () => Promise.resolve(),
    },
  }
}

describe('reintento interno de transporte', () => {
  it('conserva los numeros del legacy', () => {
    // MODBUS_CONNECTIVITY_INNER_ATTEMPTS=3, MODBUS_CONNECTIVITY_INNER_DELAY_MS=2000,
    // MODBUS_HARD_RESET_AFTER_RECREATES_PER_DEVICE=10. Son conocimiento de planta,
    // no afinado: cambiarlos cambia cuanto corte de red absorbe el robot.
    expect(REINTENTO_DE_TRANSPORTE_DEL_LEGACY).toEqual({
      intentosPorRonda: 3,
      esperaEntreIntentosMs: 2000,
      maxRondasDeRecreacion: 10,
    })
  })

  it('asegura la conexion antes de cada operacion', async () => {
    // El defecto que dejaba el sistema inoperante: nadie hacia connectTCP y la
    // primera escritura tiraba "Port Not Open".
    const clientes = crearRegistroFalso([0])
    const { reloj } = crearRelojFalso()
    const envuelto = envolverConReconexion({
      clientes: clientes.registro,
      dispositivo: DISPOSITIVO,
      reloj,
      tiempos: REINTENTO_DE_TRANSPORTE_DEL_LEGACY,
    })

    await envuelto.escribirRegistro(0, 30201)

    expect(clientes.actual().conexiones()).toBe(1)
    expect(clientes.actual().escrituras()).toBe(1)
  })

  it('reintenta tres veces con 2000 ms y recien ahi recrea el cliente', async () => {
    const clientes = crearRegistroFalso([3, 0])
    const { reloj, esperas } = crearRelojFalso()
    const envuelto = envolverConReconexion({
      clientes: clientes.registro,
      dispositivo: DISPOSITIVO,
      reloj,
      tiempos: REINTENTO_DE_TRANSPORTE_DEL_LEGACY,
    })

    await envuelto.escribirRegistro(0, 30201)

    // Tres intentos fallados, dos esperas entre ellos (no se duerme despues del
    // ultimo: ahi se recrea el cliente y se arranca la ronda siguiente).
    expect(esperas).toEqual([2000, 2000])
    expect(clientes.recreaciones()).toBe(1)
  })

  it('un error que no es de conectividad sale derecho, sin dormir', async () => {
    const clientes: RegistroDeClientes = {
      obtener: () => undefined,
      asegurar: () => ({
        conectar: () => Promise.resolve(),
        desconectar: () => Promise.resolve(),
        estaConectado: () => true,
        marcarDesconectado: () => undefined,
        leerRegistrosDeRetencion: () => Promise.resolve([]),
        leerRegistrosDeEntrada: () => Promise.resolve([]),
        escribirRegistro: () => Promise.reject(new Error('Modbus exception 2: Illegal data address')),
      }),
      recrear: () => Promise.reject(new Error('no deberia recrearse')),
      cerrarTodos: () => Promise.resolve(),
    }
    const { reloj, esperas } = crearRelojFalso()
    const envuelto = envolverConReconexion({
      clientes,
      dispositivo: DISPOSITIVO,
      reloj,
      tiempos: REINTENTO_DE_TRANSPORTE_DEL_LEGACY,
    })

    // RF19: una excepcion Modbus de aplicacion falla rapido. Reintentarla 30
    // veces contra un PLC que ya dijo "esa direccion no existe" es solo demora.
    await expect(envuelto.escribirRegistro(0, 30201)).rejects.toThrow(/Illegal data address/)
    expect(esperas).toEqual([])
  })

  it('al agotar las rondas relanza el error de conectividad original', async () => {
    const tiempos: TiemposDeReintentoDeTransporte = {
      intentosPorRonda: 2,
      esperaEntreIntentosMs: 2000,
      maxRondasDeRecreacion: 2,
    }
    // Siempre falla: ningun cliente nuevo mejora nada.
    const clientes = crearRegistroFalso([Number.MAX_SAFE_INTEGER])
    const { reloj } = crearRelojFalso()
    const envuelto = envolverConReconexion({
      clientes: clientes.registro,
      dispositivo: DISPOSITIVO,
      reloj,
      tiempos,
    })

    const fallo = await envuelto.escribirRegistro(0, 30201).then(
      () => null,
      (error: unknown) => error,
    )

    // Lo que importa no es el mensaje sino la CLASIFICACION: un Error nuevo con
    // el resumen ("fallida tras N rondas") no tiene codigo ni frase de socket, y
    // caeria en PROGRAMACION, convirtiendo un cable desenchufado en un bug.
    expect(clasificarError(fallo).tipo).toBe('TRANSPORTE')
    expect(clientes.recreaciones()).toBe(2)
  })

  it('la clave del dispositivo es la misma que la del mutex y la del registro', () => {
    // No es decoracion: el reintento pide el cliente por dispositivo y el mutex
    // se toma por la misma clave. Dos nociones de "dispositivo" serian dos
    // sockets para el mismo PLC.
    expect(claveDeDispositivo(DISPOSITIVO.robotId, DISPOSITIVO.tipo)).toBe('1:CARRO')
  })
})
