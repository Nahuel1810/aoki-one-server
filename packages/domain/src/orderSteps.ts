// RF04 — Secuencia fisica de una orden: cinco pasos, siempre los mismos.
//
// HOMING -> ELEVADOR(nivel origen) -> CARRO_BUSCA -> ELEVADOR(nivel destino) ->
// CARRO_DEJA (PICK) | CARRO_DEVUELVE (PUT).
//
// Son cinco movimientos reales del robot y el orden no es negociable. Cada paso
// es una interfaz propia con su `seq` literal UNICO, de modo que el numero de
// paso y el tipo de paso quedan correlacionados por el compilador: el paso 2 usa
// el nivel del ORIGEN y el 4 el del DESTINO, y confundirlos ya no compila.
//
// Se declaran UNICAMENTE los tipos de paso: son lo que consume el contexto de
// ejecucion del agente (`ContextoDePaso.paso`). El constructor de la secuencia y
// su tupla NO se declaran aca: RF04 figura entero en "RF sin cobertura" del
// mapeo y ningun test portado lo llama (el e2e observa los cinco pasos por HTTP,
// no construyendolos). Entra con la task que escriba su test.

import type { Nivel } from './locationCode.js'
import type { ComandoCarro } from './plcProtocol.js'

export type TipoPaso =
  | 'HOMING'
  | 'ELEVADOR_NIVEL_ORIGEN'
  | 'CARRO_BUSCA'
  | 'ELEVADOR_NIVEL_DESTINO'
  | 'CARRO_DEJA'
  | 'CARRO_DEVUELVE'

/** Numero de paso dentro de la orden, 1 a 5. Una orden terminada queda en 5. */
export type SeqPaso = 1 | 2 | 3 | 4 | 5

/** Paso 1. Init del carro antes de cualquier movimiento; tambien el punto de replay del retry. */
export interface PasoHoming {
  readonly seq: 1
  readonly tipo: 'HOMING'
  readonly dispositivo: 'CARRO'
  readonly comando: number
}

/** Paso 2. Ir-a-nivel del elevador sobre el nivel del ORIGEN: `100 + nivel`. */
export interface PasoElevadorOrigen {
  readonly seq: 2
  readonly tipo: 'ELEVADOR_NIVEL_ORIGEN'
  readonly dispositivo: 'ELEVADOR'
  readonly nivel: Nivel
  readonly comando: number
}

/** Paso 3. El carro va a buscar el cajon al origen: accion `T` impuesta por el paso. */
export interface PasoCarroBusca {
  readonly seq: 3
  readonly tipo: 'CARRO_BUSCA'
  readonly dispositivo: 'CARRO'
  readonly comando: ComandoCarro
}

/**
 * Paso 4. Ir-a-nivel del elevador sobre el nivel del DESTINO.
 *
 * Es el unico paso de elevador que usa el destino. Que este separado del paso 2
 * en el tipo es el punto: un port silencioso los confunde y el robot va al nivel
 * equivocado con el cajon arriba.
 */
export interface PasoElevadorDestino {
  readonly seq: 4
  readonly tipo: 'ELEVADOR_NIVEL_DESTINO'
  readonly dispositivo: 'ELEVADOR'
  readonly nivel: Nivel
  readonly comando: number
}

/**
 * Paso 5. El carro deja el cajon en el destino con accion `D`.
 *
 * `CARRO_DEJA` en un PICK (el cajon queda en el slot de pickeo) y
 * `CARRO_DEVUELVE` en un PUT (el cajon vuelve a su ubicacion de guardado). Es el
 * unico paso cuyo tipo depende del tipo de orden.
 */
export interface PasoCarroFinal {
  readonly seq: 5
  readonly tipo: 'CARRO_DEJA' | 'CARRO_DEVUELVE'
  readonly dispositivo: 'CARRO'
  readonly comando: ComandoCarro
}

export type PasoDeOrden =
  | PasoHoming
  | PasoElevadorOrigen
  | PasoCarroBusca
  | PasoElevadorDestino
  | PasoCarroFinal
