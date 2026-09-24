// Implementacion del puerto de transporte: ruteo de robot+dispositivo al cliente
// Modbus que le corresponde, con modo simulacion.
//
// El ruteo vive aca y no en el handshake a proposito: el handshake recibe un
// `DispositivoResuelto` ({tipo, cliente, mapaDeRegistros}) ya armado, asi que no
// existe la forma de mandarle un comando de CARRO al cliente del ELEVADOR.

import type { Result, TipoDispositivo } from '@aoki-one/domain'

import type { DeviceMutex } from './deviceMutex.js'
import type { FalloDeEjecucion } from './errorClassification.js'
import { claveDeDispositivo } from './modbusClient.js'
import type { DispositivoRegistrado, ModbusClient, RegistroDeClientes } from './modbusClient.js'
import { envolverConReconexion } from './reintentoDeTransporte.js'
import type { TiemposDeReintentoDeTransporte } from './reintentoDeTransporte.js'
import type {
  DispositivoResuelto,
  PedidoDeComando,
  RegistrosDeDispositivo,
  RespuestaUtilPlc,
  TiemposDeHandshake,
} from './stepHandshake.js'
import {
  ejecutarComandoDePaso,
  leerRegistrosDeDispositivo,
  MAPA_DE_REGISTROS_POR_DEFECTO,
  resetearMessageIn,
} from './stepHandshake.js'
import type { Reloj } from '../reloj.js'

export interface DependenciasDeTransporte {
  /**
   * Los clientes vivos. Es el MISMO registro que usa el monitor de conectividad
   * (RF18) a proposito: con dos registros distintos el monitor conectaria y
   * reconectaria sockets que el handshake no usa, y el handshake escribiria por
   * sockets que el monitor nunca reviso. Un dispositivo, un cliente.
   */
  readonly clientes: RegistroDeClientes
  readonly mutex: DeviceMutex
  readonly reloj: Reloj
  readonly tiempos: TiemposDeHandshake
  readonly simularPlc: boolean
  /** Numeros del reintento interno de transporte, portados del legacy. */
  readonly reintento: TiemposDeReintentoDeTransporte
  readonly buscarDispositivo: (
    robotId: string,
    tipo: TipoDispositivo,
  ) => Promise<DispositivoRegistrado | undefined>
}

export interface PuertoDeTransporteConcreto {
  readonly ejecutarComandoDePaso: (
    robotId: string,
    dispositivo: TipoDispositivo,
    pedido: PedidoDeComando,
  ) => Promise<Result<RespuestaUtilPlc, FalloDeEjecucion>>
  /**
   * Deja `messageIn` en 0. Sin `dispositivo` recorre los del robot (es el reset
   * previo al retry de RF13); con `dispositivo` toca SOLO ese, que es lo que
   * necesita el comando directo a PLC para limpiar lo que acaba de escribir sin
   * meterse con el otro dispositivo del robot.
   */
  readonly resetearMessageIn: (
    robotId: string,
    dispositivo?: TipoDispositivo,
  ) => Promise<Result<void, FalloDeEjecucion>>
  readonly leerRegistros: (
    robotId: string,
    dispositivo: TipoDispositivo,
  ) => Promise<Result<RegistrosDeDispositivo, FalloDeEjecucion>>
  readonly cerrar: () => Promise<void>
}

export function crearPuertoDeTransporte(
  dependencias: DependenciasDeTransporte,
): PuertoDeTransporteConcreto {
  const { clientes, mutex, reloj, tiempos, simularPlc, reintento, buscarDispositivo } =
    dependencias

  /**
   * El cliente del dispositivo, envuelto en el reintento interno de transporte.
   *
   * El envoltorio es lo que ASEGURA LA CONEXION antes de cada operacion: sin el,
   * el handshake le escribia registros a un cliente al que nadie le habia hecho
   * connectTCP y toda orden moria en "Port Not Open".
   */
  function clienteDe(dispositivo: DispositivoRegistrado): ModbusClient {
    return envolverConReconexion({ clientes, dispositivo, reloj, tiempos: reintento })
  }

  /**
   * El dispositivo listo para el handshake: su tipo, su cliente y SU mapa de
   * registros, el que se le configuro en el alta. Sin mapa propio va el por
   * defecto, que es lo que hace `mergeRegisterMaps` del legacy.
   */
  function resolverParaHandshake(dispositivo: DispositivoRegistrado): DispositivoResuelto {
    return {
      tipo: dispositivo.tipo,
      cliente: clienteDe(dispositivo),
      mapaDeRegistros: dispositivo.mapaDeRegistros ?? MAPA_DE_REGISTROS_POR_DEFECTO,
    }
  }

  async function resolver(
    robotId: string,
    tipo: TipoDispositivo,
  ): Promise<Result<DispositivoRegistrado, FalloDeEjecucion>> {
    const dispositivo = await buscarDispositivo(robotId, tipo)
    if (dispositivo === undefined) {
      // No es un bug nuestro: es configuracion que falta. Por eso tiene su propia
      // variante y no cae en PROGRAMACION.
      return {
        ok: false,
        error: { tipo: 'DISPOSITIVO_NO_REGISTRADO', robotId, dispositivo: tipo },
      }
    }
    return { ok: true, valor: dispositivo }
  }

  return {
    ejecutarComandoDePaso: async (robotId, tipo, pedido) => {
      if (simularPlc) {
        // La simulacion confirma el paso sin tocar el socket. Es lo que permite
        // correr el flujo completo sin PLC.
        return { ok: true, valor: { kind: 'OK' } }
      }

      const dispositivo = await resolver(robotId, tipo)
      if (!dispositivo.ok) {
        return dispositivo
      }

      // Todo el comando va bajo el mutex del dispositivo: jamas dos operaciones
      // simultaneas sobre el mismo socket.
      return mutex.ejecutar(claveDeDispositivo(robotId, tipo), () =>
        ejecutarComandoDePaso(
          { dispositivo: resolverParaHandshake(dispositivo.valor), tiempos, reloj },
          pedido,
        ),
      )
    },

    resetearMessageIn: async (robotId, soloEste) => {
      if (simularPlc) {
        return { ok: true, valor: undefined }
      }

      const tipos: readonly TipoDispositivo[] =
        soloEste === undefined ? ['CARRO', 'ELEVADOR'] : [soloEste]

      for (const tipo of tipos) {
        const dispositivo = await buscarDispositivo(robotId, tipo)
        if (dispositivo === undefined) {
          continue
        }
        const reset = await mutex.ejecutar(claveDeDispositivo(robotId, tipo), () =>
          resetearMessageIn({ dispositivo: resolverParaHandshake(dispositivo), tiempos, reloj }),
        )
        if (!reset.ok) {
          return reset
        }
      }
      return { ok: true, valor: undefined }
    },

    leerRegistros: async (robotId, tipo) => {
      if (simularPlc) {
        return {
          ok: true,
          valor: { messageIn1: 0, messageIn2: tipo === 'CARRO' ? 0 : null, messageOut: 0 },
        }
      }

      const dispositivo = await resolver(robotId, tipo)
      if (!dispositivo.ok) {
        return dispositivo
      }

      return mutex.ejecutar(claveDeDispositivo(robotId, tipo), () =>
        leerRegistrosDeDispositivo({
          dispositivo: resolverParaHandshake(dispositivo.valor),
          tiempos,
          reloj,
        }),
      )
    },

    cerrar: async () => {
      await clientes.cerrarTodos()
    },
  }
}
