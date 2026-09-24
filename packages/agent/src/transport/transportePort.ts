// Implementacion del puerto de transporte: ruteo de robot+dispositivo al cliente
// Modbus que le corresponde, con modo simulacion.
//
// El ruteo vive aca y no en el handshake a proposito: el handshake recibe un
// `DispositivoResuelto` ({tipo, cliente, mapaDeRegistros}) ya armado, asi que no
// existe la forma de mandarle un comando de CARRO al cliente del ELEVADOR.

import type { Result, TipoDispositivo } from '@aoki-one/domain'

import type { DeviceMutex } from './deviceMutex.js'
import type { FalloDeEjecucion } from './errorClassification.js'
import { claveDeDispositivo, crearModbusClient } from './modbusClient.js'
import type { DispositivoRegistrado, ModbusClient } from './modbusClient.js'
import type {
  MapaDeRegistros,
  PedidoDeComando,
  RegistrosDeDispositivo,
  RespuestaUtilPlc,
  TiemposDeHandshake,
} from './stepHandshake.js'
import {
  ejecutarComandoDePaso,
  leerRegistrosDeDispositivo,
  resetearMessageIn,
} from './stepHandshake.js'
import type { Reloj } from '../reloj.js'

/**
 * Mapa por defecto. messageIn se escribe como holding register y messageOut se
 * lee como input register: coinciden en numero y no en espacio de direcciones.
 */
const MAPA_POR_DEFECTO: MapaDeRegistros = { messageIn: 0, messageOut: 0 }

export interface DependenciasDeTransporte {
  readonly mutex: DeviceMutex
  readonly reloj: Reloj
  readonly tiempos: TiemposDeHandshake
  readonly simularPlc: boolean
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
  readonly resetearMessageIn: (robotId: string) => Promise<Result<void, FalloDeEjecucion>>
  readonly leerRegistros: (
    robotId: string,
    dispositivo: TipoDispositivo,
  ) => Promise<Result<RegistrosDeDispositivo, FalloDeEjecucion>>
  readonly cerrar: () => Promise<void>
}

export function crearPuertoDeTransporte(
  dependencias: DependenciasDeTransporte,
): PuertoDeTransporteConcreto {
  const { mutex, reloj, tiempos, simularPlc, buscarDispositivo } = dependencias
  const clientes = new Map<string, ModbusClient>()

  function clienteDe(dispositivo: DispositivoRegistrado): ModbusClient {
    const clave = claveDeDispositivo(dispositivo.robotId, dispositivo.tipo)
    const existente = clientes.get(clave)
    if (existente !== undefined) {
      return existente
    }
    const creado = crearModbusClient(dispositivo)
    clientes.set(clave, creado)
    return creado
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
          {
            dispositivo: {
              tipo,
              cliente: clienteDe(dispositivo.valor),
              mapaDeRegistros: MAPA_POR_DEFECTO,
            },
            tiempos,
            reloj,
          },
          pedido,
        ),
      )
    },

    resetearMessageIn: async (robotId) => {
      if (simularPlc) {
        return { ok: true, valor: undefined }
      }

      for (const tipo of ['CARRO', 'ELEVADOR'] as const) {
        const dispositivo = await buscarDispositivo(robotId, tipo)
        if (dispositivo === undefined) {
          continue
        }
        const reset = await mutex.ejecutar(claveDeDispositivo(robotId, tipo), () =>
          resetearMessageIn({
            dispositivo: {
              tipo,
              cliente: clienteDe(dispositivo),
              mapaDeRegistros: MAPA_POR_DEFECTO,
            },
            tiempos,
            reloj,
          }),
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
          dispositivo: {
            tipo,
            cliente: clienteDe(dispositivo.valor),
            mapaDeRegistros: MAPA_POR_DEFECTO,
          },
          tiempos,
          reloj,
        }),
      )
    },

    cerrar: async () => {
      for (const cliente of clientes.values()) {
        await cliente.desconectar()
      }
      clientes.clear()
    },
  }
}
