// RF17 y RF12 — Handshake de paso contra el PLC.
//
// Escribir `messageIn` (el CARRO parte el valor en dos registros consecutivos),
// pollear `messageOut` hasta el codigo esperado, resetear `messageIn` y
// verificar `messageOut = 0`. El paso NO cierra por envio: cierra por
// confirmacion mas reset verificado.

import { decodificarRespuesta } from '@aoki-one/domain'
import type { Result, RespuestaPlc, TipoDispositivo } from '@aoki-one/domain'

import type { Reloj } from '../reloj.js'
import { clasificarError } from './errorClassification.js'
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
  if (!Number.isFinite(valor)) {
    return { ok: false, error: { codigo: 'COMANDO_DE_CARRO_INVALIDO', valor } }
  }

  // Split DECIMAL a 5 digitos, no binario: 41000 -> alto 4, bajo 1000.
  // NO es `v >> 16` / `v & 0xffff`. Portado literal de splitCarroCommandValue.
  // El slice(-5) TRUNCA en silencio los valores de mas de 5 digitos, igual que el
  // legacy: conservar o no ese truncado es decision de planta y se decide con su test.
  const digitos = String(Math.trunc(valor)).padStart(5, '0').slice(-5)
  return {
    ok: true,
    valor: { alto: Number(digitos[0]), bajo: Number(digitos.slice(1)) },
  }
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
export async function ejecutarComandoDePaso(
  dependencias: DependenciasDeHandshake,
  pedido: PedidoDeComando,
): Promise<Result<RespuestaUtilPlc, FalloDeEjecucion>> {
  const { dispositivo, tiempos, reloj } = dependencias

  // 1. Escribir messageIn. El CARRO va partido en dos registros consecutivos.
  const escritura = await escribirComando(dependencias, pedido.comando)
  if (!escritura.ok) {
    return escritura
  }

  // 2. Pollear messageOut hasta ver el codigo esperado. El paso NO avanza por
  //    envio: avanza por confirmacion (RF12).
  let ultimoValor = 0
  let confirmado = false
  for (let intento = 0; intento < tiempos.maxIntentosAck; intento += 1) {
    const leido = await leerMessageOut(dependencias)
    if (!leido.ok) {
      return leido
    }
    ultimoValor = leido.valor
    if (coincide(ultimoValor, pedido.respuestasEsperadas)) {
      confirmado = true
      break
    }
    await reloj.dormir(tiempos.intervaloAckMs)
  }

  if (!confirmado) {
    return {
      ok: false,
      error: {
        tipo: 'PLC_ESTADO_INESPERADO',
        valor: ultimoValor,
        mensaje: 'El PLC no confirmo el paso dentro del presupuesto de intentos',
      },
    }
  }

  const decodificada = decodificarRespuesta(ultimoValor, dispositivo.tipo)
  if (decodificada.kind === 'ERROR') {
    return {
      ok: false,
      error: {
        tipo: 'PLC_ERROR',
        codigoError: decodificada.codigoError,
        mensaje: decodificada.mensaje,
        fatal: decodificada.fatal,
      },
    }
  }
  if (decodificada.kind === 'DESCONOCIDO') {
    return {
      ok: false,
      error: {
        tipo: 'PLC_ESTADO_INESPERADO',
        valor: decodificada.valor,
        mensaje: 'El PLC respondio un valor fuera del protocolo',
      },
    }
  }

  // 3. Resetear messageIn y verificar que messageOut vuelva a 0. Sin esto el paso
  //    siguiente arrancaria con el registro sucio.
  const reset = await resetearMessageIn(dependencias)
  if (!reset.ok) {
    return reset
  }

  return { ok: true, valor: decodificada }
}

/** Escribe el comando en messageIn, partido si el dispositivo es el CARRO. */
async function escribirComando(
  dependencias: DependenciasDeHandshake,
  comando: number,
): Promise<Result<void, FalloDeEjecucion>> {
  const { dispositivo } = dependencias
  const { cliente, mapaDeRegistros } = dispositivo

  try {
    if (dispositivo.tipo === 'CARRO') {
      const partido = partirComandoDeCarro(comando)
      if (!partido.ok) {
        return {
          ok: false,
          error: { tipo: 'PROGRAMACION', mensaje: 'Comando de carro invalido' },
        }
      }
      await cliente.escribirRegistro(mapaDeRegistros.messageIn, partido.valor.alto)
      await cliente.escribirRegistro(mapaDeRegistros.messageIn + 1, partido.valor.bajo)
    } else {
      await cliente.escribirRegistro(mapaDeRegistros.messageIn, comando)
    }
    return { ok: true, valor: undefined }
  } catch (error) {
    return { ok: false, error: clasificarError(error) }
  }
}

/** messageOut se lee como input register (FC04), no como holding. */
async function leerMessageOut(
  dependencias: DependenciasDeHandshake,
): Promise<Result<number, FalloDeEjecucion>> {
  try {
    const registros = await dependencias.dispositivo.cliente.leerRegistrosDeEntrada(
      dependencias.dispositivo.mapaDeRegistros.messageOut,
      1,
    )
    return { ok: true, valor: registros[0] ?? 0 }
  } catch (error) {
    return { ok: false, error: clasificarError(error) }
  }
}

/**
 * Comodines de rango del legacy: `1##` cubre 100..199 y `2##` cubre 200..299,
 * ademas de los numeros exactos.
 */
function coincide(valor: number, esperadas: readonly RespuestaEsperada[]): boolean {
  return esperadas.some((esperada) => {
    if (typeof esperada === 'number') {
      return valor === esperada
    }
    if (esperada === '1##') {
      return valor >= 100 && valor <= 199
    }
    return valor >= 200 && valor <= 299
  })
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
export async function leerRegistrosDeDispositivo(
  dependencias: DependenciasDeHandshake,
): Promise<Result<RegistrosDeDispositivo, FalloDeEjecucion>> {
  const { dispositivo } = dependencias
  const { cliente, mapaDeRegistros } = dispositivo
  const esCarro = dispositivo.tipo === 'CARRO'

  try {
    // messageIn se lee como holding register; messageOut como input register.
    const entrada = await cliente.leerRegistrosDeRetencion(
      mapaDeRegistros.messageIn,
      esCarro ? 2 : 1,
    )
    const salida = await cliente.leerRegistrosDeEntrada(mapaDeRegistros.messageOut, 1)
    return {
      ok: true,
      valor: {
        messageIn1: entrada[0] ?? 0,
        messageIn2: esCarro ? (entrada[1] ?? 0) : null,
        messageOut: salida[0] ?? 0,
      },
    }
  } catch (error) {
    return { ok: false, error: clasificarError(error) }
  }
}

/**
 * Deja `messageIn` en 0 en el dispositivo resuelto.
 *
 * El CARRO escribe 0 en `messageIn` y `messageIn + 1`; el ELEVADOR solo en
 * `messageIn`. Es parte del retry de orden (RF13): sin este reset el PLC arranca
 * el reintento con el comando anterior colgado. Recorrer los dispositivos de un
 * robot es trabajo del puerto de transporte, que es el que los resuelve.
 */
export async function resetearMessageIn(
  dependencias: DependenciasDeHandshake,
): Promise<Result<void, FalloDeEjecucion>> {
  const { dispositivo, tiempos, reloj } = dependencias
  const { cliente, mapaDeRegistros } = dispositivo

  try {
    await cliente.escribirRegistro(mapaDeRegistros.messageIn, 0)
    if (dispositivo.tipo === 'CARRO') {
      // El CARRO ocupa dos registros: resetear uno solo deja el otro sucio.
      await cliente.escribirRegistro(mapaDeRegistros.messageIn + 1, 0)
    }
  } catch (error) {
    return { ok: false, error: clasificarError(error) }
  }

  // El reset no se da por hecho al escribir: se verifica que messageOut vuelva a 0.
  for (let intento = 0; intento < tiempos.maxIntentosReset; intento += 1) {
    const leido = await leerMessageOut(dependencias)
    if (!leido.ok) {
      return leido
    }
    if (leido.valor === 0) {
      return { ok: true, valor: undefined }
    }
    await reloj.dormir(tiempos.intervaloResetMs)
  }

  return {
    ok: false,
    error: { tipo: 'RESET_INCOMPLETO', mensaje: 'messageOut no volvio a 0 tras el reset' },
  }
}
