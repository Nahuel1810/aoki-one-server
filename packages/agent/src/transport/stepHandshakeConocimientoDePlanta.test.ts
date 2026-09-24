// RF17 — Conocimiento de planta del handshake que ningun test sostenia.
//
// Los dos tests portados cubren el camino feliz del split y del reset. Quedaban
// sin afirmar tres cosas que no se pueden re-derivar leyendo el codigo nuevo y
// que, si alguien las "arregla", mueven fierro mal:
//
//   1. el split del CARRO es DECIMAL a 5 digitos, no un split de 16 bits. Es la
//      diferencia entre `10200` -> (1, 200) y `10200` -> (0, 10200);
//   2. un valor de MAS de cinco digitos se trunca EN SILENCIO por la izquierda
//      (`slice(-5)`), portado tal cual de `splitCarroCommandValue`
//      (`src/core/connection/ConnectionService.js:478-490`). Solo el valor NO
//      FINITO falla;
//   3. los comodines de rango `1##` (100-199) y `2##` (200-299) de
//      `matchesExpectedResponse` (misma clase, lineas 460-474). Son los que usa
//      la consulta de nivel del elevador: sin ellos el paso espera para siempre
//      un 100 que nunca llega.
//
// Comparado contra el legacy: IDENTICO en los tres puntos. Lo que faltaba era el
// test.

import { describe, expect, it } from 'vitest'

import type { Reloj } from '../reloj.js'
import type { ModbusClient } from './modbusClient.js'
import {
  ejecutarComandoDePaso,
  partirComandoDeCarro,
  type DependenciasDeHandshake,
  type TiemposDeHandshake,
} from './stepHandshake.js'

interface Escritura {
  readonly direccion: number
  readonly valor: number
}

function crearClienteDoble(secuenciaDeMessageOut: readonly number[]): {
  readonly cliente: ModbusClient
  readonly escrituras: readonly Escritura[]
} {
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

const RELOJ_INMEDIATO: Reloj = { ahoraMs: () => 0, dormir: () => Promise.resolve() }

const TIEMPOS: TiemposDeHandshake = {
  intervaloAckMs: 1,
  maxIntentosAck: 10,
  intervaloResetMs: 1,
  maxIntentosReset: 10,
}

function dependenciasDeElevador(secuencia: readonly number[]): DependenciasDeHandshake {
  return {
    dispositivo: {
      tipo: 'ELEVADOR',
      cliente: crearClienteDoble(secuencia).cliente,
      mapaDeRegistros: { messageIn: 0, messageOut: 0 },
    },
    tiempos: TIEMPOS,
    reloj: RELOJ_INMEDIATO,
  }
}

describe('partirComandoDeCarro: split DECIMAL a cinco digitos', () => {
  it('parte los comandos reales de planta por digito, no por bits', () => {
    // INIT del carro.
    expect(partirComandoDeCarro(41000)).toEqual({ ok: true, valor: { alto: 4, bajo: 1000 } })
    // Carro traer sobre 3X04AA3: posicion 3, parante 02, lado 0, accion 1.
    expect(partirComandoDeCarro(30201)).toEqual({ ok: true, valor: { alto: 3, bajo: 201 } })
    // Carro dejar sobre el mismo: el ultimo digito es el unico que cambia.
    expect(partirComandoDeCarro(30200)).toEqual({ ok: true, valor: { alto: 3, bajo: 200 } })
    // Un split de 16 bits daria (0, 10200) aca: el alto es el PRIMER DIGITO.
    expect(partirComandoDeCarro(10200)).toEqual({ ok: true, valor: { alto: 1, bajo: 200 } })
  })

  it('rellena con ceros a la izquierda los comandos de menos de cinco digitos', () => {
    // 201 -> "00201": alto 0, bajo 0201. El padStart es parte del contrato.
    expect(partirComandoDeCarro(201)).toEqual({ ok: true, valor: { alto: 0, bajo: 201 } })
  })

  it('TRUNCA en silencio lo que pase de cinco digitos, igual que el servidor de hoy', () => {
    // Caso borde portado tal cual: `slice(-5)` descarta los digitos de la
    // izquierda sin avisar. 130201 se manda como 30201, o sea a OTRO parante.
    // Convertirlo en error es una decision de planta que todavia no se tomo; lo
    // que este test garantiza es que nadie la tome sin darse cuenta.
    expect(partirComandoDeCarro(130201)).toEqual({ ok: true, valor: { alto: 3, bajo: 201 } })
  })

  it('el unico rechazo es el valor no finito', () => {
    expect(partirComandoDeCarro(Number.NaN)).toEqual({
      ok: false,
      error: { codigo: 'COMANDO_DE_CARRO_INVALIDO', valor: Number.NaN },
    })
    expect(partirComandoDeCarro(Number.POSITIVE_INFINITY)).toEqual({
      ok: false,
      error: { codigo: 'COMANDO_DE_CARRO_INVALIDO', valor: Number.POSITIVE_INFINITY },
    })
  })
})

describe('comodines de rango de las respuestas esperadas', () => {
  it("'2##' cierra el paso con cualquier nivel del elevador y lo decodifica", async () => {
    // 205 = nivel 5. Con `respuestasEsperadas: [100]` el paso seguiria esperando.
    const resultado = await ejecutarComandoDePaso(dependenciasDeElevador([205, 0]), {
      comando: 200,
      respuestasEsperadas: ['2##'],
    })

    expect(resultado).toEqual({ ok: true, valor: { kind: 'NIVEL', nivel: 5 } })
  })

  it("'1##' matchea el rango de error, y el error sale igual por el canal de error", async () => {
    // 103 sobre el ELEVADOR = codigo 3 = "Nivel incorrecto". El comodin lo deja
    // cerrar el polling, pero la respuesta sigue siendo un ERROR: la rama ok solo
    // puede traer respuestas utiles.
    const resultado = await ejecutarComandoDePaso(dependenciasDeElevador([103, 0]), {
      comando: 105,
      respuestasEsperadas: ['1##'],
    })

    expect(resultado).toEqual({
      ok: false,
      error: {
        tipo: 'PLC_ERROR',
        codigoError: 3,
        mensaje: 'Nivel incorrecto',
        fatal: false,
      },
    })
  })

  it('un valor que no matchea agota el presupuesto de ACK y no resetea nada', async () => {
    // El paso NO avanza por envio (RF12): sin confirmacion no hay reset ni DONE.
    const resultado = await ejecutarComandoDePaso(dependenciasDeElevador(new Array<number>(TIEMPOS.maxIntentosAck).fill(7)), {
      comando: 105,
      respuestasEsperadas: [100],
    })

    expect(resultado).toEqual({
      ok: false,
      error: {
        tipo: 'PLC_ESTADO_INESPERADO',
        valor: 7,
        mensaje: 'El PLC no confirmo el paso dentro del presupuesto de intentos',
      },
    })
  })
})
