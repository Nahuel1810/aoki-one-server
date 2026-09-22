// RF17 y RF12 — Handshake de paso contra el PLC.
//
// Escribir `messageIn` (el CARRO parte el valor en dos registros consecutivos),
// pollear `messageOut` hasta el codigo esperado, resetear `messageIn` y
// verificar `messageOut = 0`. El paso NO cierra por envio: cierra por
// confirmacion mas reset verificado.

import { noImplementado } from '@aoki-one/domain'
import type { Result, RespuestaPlc, TipoDispositivo } from '@aoki-one/domain'

import { noImplementadoAsync } from '../noImplementadoAsync.js'
import type { Reloj } from '../reloj.js'
import type { FalloDeEjecucion } from './errorClassification.js'
import type { ModbusClient } from './modbusClient.js'

/**
 * Las respuestas del PLC que cierran un comando BIEN.
 *
 * UN SOLO CANAL POR ERROR, y este es el estrechamiento que lo fija: un error del
 * PLC se puede escribir de dos formas —`RespuestaPlc` con `kind: 'ERROR'` por la
 * rama ok, o `FalloDeEjecucion` con `tipo: 'PLC_ERROR'` por la rama de error— y
 * los dos tienen los mismos cuatro campos. Con las dos disponibles, dos
 * transportes validos y contradictorios compilan y nada dice cual es el correcto.
 *
 * La decision: `ERROR` sale SIEMPRE por `FalloDeEjecucion.PLC_ERROR` (es lo que
 * clasifica el reintento y lo que lleva la marca de fatalidad del codigo 99) y
 * `DESCONOCIDO` sale SIEMPRE por `FalloDeEjecucion.PLC_ESTADO_INESPERADO`. La
 * rama ok solo puede traer una respuesta util, asi que la eleccion ya no existe.
 *
 * `decodificarRespuesta` del dominio sigue devolviendo la union completa: decodificar
 * un valor y decidir si el paso avanza son dos cosas distintas.
 */
export type RespuestaUtilPlc = Extract<
  RespuestaPlc,
  { readonly kind: 'OK' | 'NIVEL' | 'PRESENCIA_CARRO' }
>

/**
 * Direcciones de los dos registros del dispositivo.
 *
 * Por defecto los dos valen 0 y NO colisionan: `messageIn` es holding register y
 * `messageOut` es input register. El `.env.example` documenta ademas tres
 * variables (MODBUS_COMMAND_REGISTER, MODBUS_VERIFY_REGISTER,
 * MODBUS_RESPONSE_REGISTER) que el codigo no lee en ninguna parte: no existen.
 */
export interface MapaDeRegistros {
  readonly messageIn: number
  readonly messageOut: number
}

/** Tiempos del polling. Se inyectan: en los tests no se duerme de verdad. */
export interface TiemposDeHandshake {
  readonly intervaloAckMs: number
  readonly maxIntentosAck: number
  readonly intervaloResetMs: number
  readonly maxIntentosReset: number
}

/**
 * Un codigo de `messageOut` que cierra un comando.
 *
 * Ademas de los numeros exactos, el matcheo de planta acepta dos comodines de
 * rango: `'1##'` es 100..199 (cualquier respuesta del rango de error) y `'2##'`
 * es 200..299 (cualquier nivel del elevador). Es conocimiento de planta y por eso
 * vive en el tipo y no en un comentario: contra `readonly number[]` un comodin es
 * literalmente inexpresable y la unica forma de escribirlo seria un string
 * colado por casteo.
 */
export type RespuestaEsperada = number | '1##' | '2##'

/**
 * Un comando a mandar al PLC y la respuesta con la que se da por confirmado.
 *
 * NO lleva el tipo de dispositivo: quien lo lleva es el `DispositivoResuelto` de
 * las dependencias, junto con su cliente y su mapa de registros. Con el tipo
 * viajando aparte, mandar un comando de CARRO por el cliente del ELEVADOR
 * compilaba (ver `DispositivoResuelto`).
 */
export interface PedidoDeComando {
  readonly comando: number
  /** Codigos que cierran el paso. Por defecto `[100]` (OK). */
  readonly respuestasEsperadas: readonly RespuestaEsperada[]
}

/** El comando del CARRO partido para escribirlo en dos registros consecutivos. */
export interface ComandoPartido {
  /** Va a `messageIn`. */
  readonly alto: number
  /** Va a `messageIn + 1`. */
  readonly bajo: number
}

/**
 * El unico rechazo de `partirComandoDeCarro`.
 *
 * Es un union propio y chico, no `FalloDeEjecucion`: con el union completo del
 * transporte como canal de error, nada fija con que variante falla un comando
 * invalido y dos implementaciones incompatibles compilan igual.
 */
export type ErrorDeComandoDeCarro = {
  readonly codigo: 'COMANDO_DE_CARRO_INVALIDO'
  readonly valor: number
}

/**
 * Parte el comando de carro en alto y bajo.
 *
 * NO es un split de 16 bits: es un split DECIMAL a 5 digitos.
 * `String(trunc(valor)).padStart(5, '0').slice(-5)`, alto = primer digito,
 * bajo = los cuatro restantes. `41000` -> alto 4, bajo 1000; `30201` -> alto 3,
 * bajo 201. Reimplementarlo como `v >> 16` / `v & 0xffff` compila, pasa el
 * type-check y manda el carro a otro parante.
 *
 * CASO BORDE DE PLANTA, se porta tal cual: el legacy solo falla con
 * "Comando de carro invalido" para valores NO FINITOS. Un valor de mas de cinco
 * digitos NO falla: `slice(-5)` descarta los digitos de la izquierda EN SILENCIO
 * (por ejemplo `130201` se manda como `30201`). Conservar o no ese truncado es
 * decision de planta y se toma en T14 con el test delante; lo que este contrato
 * garantiza es que la implementacion no pueda elegir en silencio entre truncar y
 * fallar.
 *
 * El ELEVADOR no se parte: escribe el valor completo en un solo registro.
 */
export function partirComandoDeCarro(
  valor: number,
): Result<ComandoPartido, ErrorDeComandoDeCarro> {
  return noImplementado('partirComandoDeCarro', { valor })
}

/**
 * Un dispositivo ya resuelto: su tipo, su cliente y su mapa de registros juntos.
 *
 * Es UNA sola nocion de dispositivo a proposito. Antes el handshake recibia el
 * cliente y el mapa por un lado y el tipo por otro (en el pedido y como parametro
 * suelto), y nada en los tipos ligaba las dos mitades: pasar el cliente del
 * ELEVADOR con el tipo CARRO compilaba y partia el comando high/low sobre los
 * registros equivocados, que es fierro real moviendose mal. Al venir los tres
 * datos en el mismo valor, esa combinacion ya no se puede escribir.
 */
export interface DispositivoResuelto {
  readonly tipo: TipoDispositivo
  readonly cliente: ModbusClient
  readonly mapaDeRegistros: MapaDeRegistros
}

export interface DependenciasDeHandshake {
  readonly dispositivo: DispositivoResuelto
  readonly tiempos: TiemposDeHandshake
  readonly reloj: Reloj
}

/**
 * Ejecuta un comando de punta a punta y devuelve la respuesta ya decodificada.
 *
 * Secuencia: escribir `messageIn` (partido si es CARRO) -> pollear `messageOut`
 * hasta una de las respuestas esperadas -> resetear `messageIn` (el CARRO
 * escribe 0 en los DOS registros, el ELEVADOR solo en uno) -> verificar que
 * `messageOut` quedo en 0. Si el reset queda incompleto es RESET_INCOMPLETO y NO
 * se reintenta.
 *
 * La rama ok solo puede traer una `RespuestaUtilPlc`: un `ERROR` del PLC sale por
 * `PLC_ERROR` y un valor desconocido por `PLC_ESTADO_INESPERADO`, siempre por el
 * canal de error. Ver `RespuestaUtilPlc`.
 */
export function ejecutarComandoDePaso(
  dependencias: DependenciasDeHandshake,
  pedido: PedidoDeComando,
): Promise<Result<RespuestaUtilPlc, FalloDeEjecucion>> {
  return noImplementadoAsync('ejecutarComandoDePaso', { dependencias, pedido })
}

/** Lectura cruda de los registros de un dispositivo, para diagnostico. */
export interface RegistrosDeDispositivo {
  readonly messageIn1: number
  /** Solo el CARRO tiene el segundo registro; en el ELEVADOR es `null`. */
  readonly messageIn2: number | null
  readonly messageOut: number
}

/**
 * Lee el estado de registros de un dispositivo.
 *
 * `messageIn` se relee con holding registers (2 registros en el CARRO, 1 en el
 * ELEVADOR) y `messageOut` con input registers.
 */
export function leerRegistrosDeDispositivo(
  dependencias: DependenciasDeHandshake,
): Promise<Result<RegistrosDeDispositivo, FalloDeEjecucion>> {
  return noImplementadoAsync('leerRegistrosDeDispositivo', { dependencias })
}

/**
 * Deja `messageIn` en 0 en el dispositivo resuelto.
 *
 * El CARRO escribe 0 en `messageIn` y `messageIn + 1`; el ELEVADOR solo en
 * `messageIn`. Es parte del retry de orden (RF13): sin este reset el PLC arranca
 * el reintento con el comando anterior colgado. Recorrer los dispositivos de un
 * robot es trabajo del puerto de transporte, que es el que los resuelve.
 */
export function resetearMessageIn(
  dependencias: DependenciasDeHandshake,
): Promise<Result<void, FalloDeEjecucion>> {
  return noImplementadoAsync('resetearMessageIn', { dependencias })
}
