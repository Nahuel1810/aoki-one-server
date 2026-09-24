// Suite de aceptacion T02 — portado de tests/unit/connectionService.test.js.
//
// Dos tests DIRECTOS. Lo que protegen es el handshake de paso (RF17): el paso no
// cierra por envio sino por confirmacion mas reset verificado.

import { describe, expect, it } from 'vitest'

import type { Reloj } from '../reloj.js'
import type { ModbusClient } from './modbusClient.js'
import {
  ejecutarComandoDePaso,
  type DependenciasDeHandshake,
  type TiemposDeHandshake,
} from './stepHandshake.js'

interface Escritura {
  readonly direccion: number
  readonly valor: number
}

interface ClienteDoble {
  readonly cliente: ModbusClient
  readonly escrituras: readonly Escritura[]
}

/**
 * Cliente falso: registra cada escritura en orden y devuelve `messageOut` de una
 * secuencia fija. Es la unica forma de pinear el handshake sin un PLC delante.
 */
function crearClienteDoble(secuenciaDeMessageOut: readonly number[]): ClienteDoble {
  const escrituras: Escritura[] = []
  const pendientes = [...secuenciaDeMessageOut]

  const cliente: ModbusClient = {
    conectar: () => Promise.resolve(),
    desconectar: () => Promise.resolve(),
    estaConectado: () => true,
    // El doble no tiene socket que bajar: la bandera de conectado es fija.
    marcarDesconectado: () => undefined,
    leerRegistrosDeRetencion: (_direccion, cantidad) =>
      Promise.resolve(new Array<number>(cantidad).fill(0)),
    leerRegistrosDeEntrada: () => Promise.resolve([pendientes.shift() ?? 0]),
    escribirRegistro: (direccion, valor) => {
      escrituras.push({ direccion, valor })
      return Promise.resolve()
    },
  }

  return { cliente, escrituras }
}

// El legacy dormia ~2,5 s (CARRO) y ~4,5 s (ELEVADOR) reales porque el sleep
// estaba cableado adentro. Aca el reloj se inyecta y no se duerme de verdad.
const RELOJ_INMEDIATO: Reloj = {
  ahoraMs: () => 0,
  dormir: () => Promise.resolve(),
}

const TIEMPOS: TiemposDeHandshake = {
  intervaloAckMs: 1,
  maxIntentosAck: 10,
  intervaloResetMs: 1,
  maxIntentosReset: 10,
}

describe('handshake de paso contra el PLC (RF17)', () => {
  it('parte el comando de CARRO en dos registros y resetea messageIn1 y messageIn2', async () => {
    const { cliente, escrituras } = crearClienteDoble([100, 100, 0])
    const dependencias: DependenciasDeHandshake = {
      dispositivo: {
        tipo: 'CARRO',
        cliente,
        mapaDeRegistros: { messageIn: 0, messageOut: 0 },
      },
      tiempos: TIEMPOS,
      reloj: RELOJ_INMEDIATO,
    }

    const resultado = await ejecutarComandoDePaso(dependencias, {
      comando: 41000,
      respuestasEsperadas: [100],
    })

    expect(resultado).toEqual({ ok: true, valor: { kind: 'OK' } })

    // Conocimiento de planta, afirmado explicito: el valor del CARRO se parte en
    // DOS registros consecutivos con un split DECIMAL a 5 digitos (41000 -> alto 4,
    // bajo 1000; NO es `v >> 16` / `v & 0xffff`), y el reset escribe 0 en AMBOS.
    expect(escrituras).toEqual([
      { direccion: 0, valor: 4 },
      { direccion: 1, valor: 1000 },
      { direccion: 0, valor: 0 },
      { direccion: 1, valor: 0 },
    ])
  })

  it('espera messageOut=100 antes de resetear y el ELEVADOR escribe un solo registro', async () => {
    // La primera lectura devuelve 0: el paso NO avanza hasta ver el codigo esperado.
    const { cliente, escrituras } = crearClienteDoble([0, 100, 100, 0])
    const dependencias: DependenciasDeHandshake = {
      dispositivo: {
        tipo: 'ELEVADOR',
        cliente,
        mapaDeRegistros: { messageIn: 0, messageOut: 0 },
      },
      tiempos: TIEMPOS,
      reloj: RELOJ_INMEDIATO,
    }

    const resultado = await ejecutarComandoDePaso(dependencias, {
      comando: 107,
      respuestasEsperadas: [100],
    })

    // El legacy afirmaba response.raw.reset.messageInReset y .messageOutReset en
    // true. Bajo el contrato nuevo esas dos banderas no existen: si el reset queda
    // incompleto la funcion devuelve RESET_INCOMPLETO por la rama de error, asi que
    // la rama ok YA significa "reset verificado". Es el mismo hecho, sin la bandera.
    expect(resultado).toEqual({ ok: true, valor: { kind: 'OK' } })

    // El ELEVADOR no se parte: 107 = 100 + nivel entero en un unico registro, y el
    // reset es una sola escritura.
    expect(escrituras).toEqual([
      { direccion: 0, valor: 107 },
      { direccion: 0, valor: 0 },
    ])
  })
})
