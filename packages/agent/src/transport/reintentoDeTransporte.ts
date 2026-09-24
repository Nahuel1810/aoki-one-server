// RF16 y RF19 — Reintento interno de transporte, portado de `_runModbusOpInner`.
//
// DOS COSAS QUE FALTABAN Y DEJABAN EL SISTEMA INOPERANTE:
//
// 1. NADIE ABRIA EL SOCKET. `crearPuertoDeTransporte` pedia el cliente y le
//    escribia registros sin que nadie hubiera hecho `conectar()`. Con
//    SIMULATE_PLC en false —el default de RF20— el primer `escribirRegistro`
//    tiraba "Port Not Open", se clasificaba TRANSPORTE, se reintentaba y la
//    orden terminaba en ERROR. TODA orden, SIEMPRE. En el legacy la conexion la
//    asegura `client.ensureConnected()` ANTES de cada operacion Modbus, dentro
//    de `_runModbusOpInner`; aca la asegura este envoltorio, en el mismo lugar.
//
// 2. DESAPARECIO EL REINTENTO INTERNO. El legacy absorbe un corte de red corto
//    sin que la orden se entere: 3 intentos por ronda con 2000 ms entre ellos,
//    y si la ronda entera falla recrea el cliente Modbus y vuelve a empezar,
//    hasta 10 rondas. Sin eso, un corte de 10 segundos —de los que el robot
//    aguanta sin que el operario se entere— manda la orden a ERROR.
//
// La granularidad es la del legacy: se reintenta CADA operacion Modbus suelta
// (una escritura, una lectura), no el handshake entero. Reintentar el handshake
// completo reescribiria `messageIn` sobre un paso ya confirmado a medias, que es
// fierro moviendose dos veces.
//
// El mutex por dispositivo lo toma el puerto de transporte por afuera y lo
// sostiene todo el handshake, asi que este envoltorio NUNCA lo toma: hacerlo
// seria un deadlock consigo mismo.

import { esErrorDeConectividad } from './errorClassification.js'
import type { DispositivoRegistrado, ModbusClient, RegistroDeClientes } from './modbusClient.js'
import type { Reloj } from '../reloj.js'

/** Los numeros del reintento interno. Se inyectan para no dormir de verdad en la suite. */
export interface TiemposDeReintentoDeTransporte {
  /** Intentos sobre el mismo cliente antes de recrearlo. */
  readonly intentosPorRonda: number
  /** Espera entre intentos de la misma ronda. */
  readonly esperaEntreIntentosMs: number
  /** Rondas (cada una con su recreacion de cliente) antes de darse por vencido. */
  readonly maxRondasDeRecreacion: number
}

/**
 * Los numeros exactos del legacy, con sus defaults de env:
 * MODBUS_CONNECTIVITY_INNER_ATTEMPTS=3, MODBUS_CONNECTIVITY_INNER_DELAY_MS=2000,
 * MODBUS_HARD_RESET_AFTER_RECREATES_PER_DEVICE=10.
 *
 * Peor caso: 10 rondas x 3 intentos x 2000 ms = 60 s absorbidos por operacion
 * antes de fallar. Es mucho a proposito: la alternativa es mandar a ERROR una
 * orden que el robot podia terminar.
 */
export const REINTENTO_DE_TRANSPORTE_DEL_LEGACY: TiemposDeReintentoDeTransporte = {
  intentosPorRonda: 3,
  esperaEntreIntentosMs: 2000,
  maxRondasDeRecreacion: 10,
}

export interface DependenciasDeReintentoDeTransporte {
  readonly clientes: RegistroDeClientes
  readonly dispositivo: DispositivoRegistrado
  readonly reloj: Reloj
  readonly tiempos: TiemposDeReintentoDeTransporte
}

/**
 * Devuelve un `ModbusClient` que, en cada operacion, asegura la conexion y
 * reintenta los errores de conectividad recreando el cliente entre rondas.
 *
 * Solo se reintenta lo que `esErrorDeConectividad` reconoce (RF19): una
 * excepcion Modbus de aplicacion o un bug nuestro salen derecho, sin dormir.
 */
export function envolverConReconexion(
  dependencias: DependenciasDeReintentoDeTransporte,
): ModbusClient {
  const { clientes, dispositivo, reloj, tiempos } = dependencias

  async function conReconexion<T>(operacion: (cliente: ModbusClient) => Promise<T>): Promise<T> {
    for (let ronda = 0; ronda < tiempos.maxRondasDeRecreacion; ronda += 1) {
      const ultimaRonda = ronda === tiempos.maxRondasDeRecreacion - 1

      for (let intento = 1; intento <= tiempos.intentosPorRonda; intento += 1) {
        // El cliente se pide DE NUEVO en cada intento: entre rondas se recrea, y
        // quedarse con la referencia vieja seria seguir hablandole al socket que
        // justamente se descarto.
        const cliente = clientes.asegurar(dispositivo)
        try {
          await cliente.conectar()
          return await operacion(cliente)
        } catch (error) {
          if (!esErrorDeConectividad(error)) {
            throw error
          }
          // Sin esto el proximo `conectar()` se da por conectado sobre el socket
          // muerto y el intento siguiente repite el mismo fallo sin reconectar.
          cliente.marcarDesconectado()

          if (ultimaRonda && intento === tiempos.intentosPorRonda) {
            // Se recrea igual antes de rendirse, como hace el legacy: el cliente
            // que quedo en el registro es el del socket muerto, y dejarlo ahi le
            // pasa el problema a la proxima operacion del dispositivo.
            await recrearSinPropagar()
            // Se relanza el error ORIGINAL y no uno nuevo con el resumen: es el
            // que `clasificarError` reconoce como TRANSPORTE —por su codigo de
            // socket o su frase— y el que el operario lee en el `errorReason` de
            // la orden. Un Error del estilo "fallida tras N rondas" no tiene ni
            // codigo ni frase, asi que caeria en PROGRAMACION y convertiria un
            // cable desenchufado en un bug nuestro.
            throw error
          }
          if (intento < tiempos.intentosPorRonda) {
            await reloj.dormir(tiempos.esperaEntreIntentosMs)
          }
        }
      }

      await recrearSinPropagar()
    }

    // Inalcanzable con al menos una ronda configurada. Existe para que
    // `maxRondasDeRecreacion: 0` no devuelva undefined en silencio.
    throw new Error('Reintento de transporte configurado sin ninguna ronda')
  }

  /**
   * Recrear implica cerrar el cliente anterior, y cerrar un socket ya roto puede
   * fallar. El legacy lo loguea y sigue: si la recreacion se propagara, el fallo
   * al despedirse del socket muerto cancelaria justo la recuperacion.
   */
  async function recrearSinPropagar(): Promise<void> {
    try {
      await clientes.recrear(dispositivo)
    } catch {
      // Nada que hacer: el cliente nuevo se pide en el proximo intento.
    }
  }

  return {
    conectar: () => conReconexion(() => Promise.resolve(undefined)),
    desconectar: () => clientes.asegurar(dispositivo).desconectar(),
    estaConectado: () => clientes.asegurar(dispositivo).estaConectado(),
    marcarDesconectado: () => {
      clientes.asegurar(dispositivo).marcarDesconectado()
    },
    leerRegistrosDeRetencion: (direccion, cantidad) =>
      conReconexion((cliente) => cliente.leerRegistrosDeRetencion(direccion, cantidad)),
    leerRegistrosDeEntrada: (direccion, cantidad) =>
      conReconexion((cliente) => cliente.leerRegistrosDeEntrada(direccion, cantidad)),
    escribirRegistro: (direccion, valor) =>
      conReconexion((cliente) => cliente.escribirRegistro(direccion, valor)),
  }
}
