// Suite de aceptacion T02 — portado de tests/unit/connectionService.test.js.
//
// RF16: exclusion mutua estricta sobre el mismo socket TCP. La razon es empirica
// y esta documentada en el codigo de planta: modbus-serial usa un socket
// half-duplex y dos requests intercalados corrompen frames (timeout, 'port not
// open', silencio del PLC). Era la causa raiz de los cortes del CARRO.

import { describe, expect, it } from 'vitest'

import { crearDeviceMutex } from './deviceMutex.js'

interface MedidorDeSimultaneidad {
  /** Maximo de operaciones corriendo a la vez que se observo. */
  readonly maximo: () => number
  /** Orden en el que las operaciones ARRANCARON. */
  readonly ordenDeArranque: () => readonly number[]
  readonly correr: (etiqueta: number) => Promise<number>
}

function crearMedidorDeSimultaneidad(): MedidorDeSimultaneidad {
  let activas = 0
  let maximo = 0
  const ordenDeArranque: number[] = []

  return {
    maximo: () => maximo,
    ordenDeArranque: () => ordenDeArranque,
    correr: async (etiqueta: number) => {
      activas += 1
      maximo = Math.max(maximo, activas)
      ordenDeArranque.push(etiqueta)
      // Dos vueltas de microtask: si el mutex no serializa, las operaciones se
      // solapan aca y `maximo` queda > 1. El legacy usaba un setTimeout de 20 ms.
      await Promise.resolve()
      await Promise.resolve()
      activas -= 1
      return etiqueta
    },
  }
}

describe('mutex por dispositivo (RF16)', () => {
  it('serializa las operaciones del mismo dispositivo y deja correr en paralelo a dos distintos', async () => {
    const mutex = crearDeviceMutex()

    const medidor = crearMedidorDeSimultaneidad()
    const concurrentes = Array.from({ length: 10 }, (_valor, indice) =>
      mutex.ejecutar('1:CARRO', () => medidor.correr(indice)),
    )
    const resultados = await Promise.all(concurrentes)

    // Jamas dos frames simultaneos sobre el mismo socket.
    expect(medidor.maximo()).toBe(1)
    // El legacy solo miraba results.length: el cliente falso devolvia 123 y nadie
    // lo miraba. Se afirma que cada operacion devuelve SU valor.
    expect(resultados).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    // Y que la cola es FIFO, que el legacy tampoco afirmaba.
    expect(medidor.ordenDeArranque()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

    // La otra mitad del contrato que el legacy no cubria: el mutex es POR
    // DISPOSITIVO, asi que el CARRO y el ELEVADOR del mismo robot corren juntos.
    const medidorParalelo = crearMedidorDeSimultaneidad()
    const enParalelo = await Promise.all([
      mutex.ejecutar('1:CARRO', () => medidorParalelo.correr(0)),
      mutex.ejecutar('1:ELEVADOR', () => medidorParalelo.correr(1)),
    ])

    expect(enParalelo).toEqual([0, 1])
    expect(medidorParalelo.maximo()).toBe(2)
  })
})
