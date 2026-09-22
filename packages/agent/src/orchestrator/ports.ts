// Puertos del orquestador.
//
// Todo el I/O de un paso sale por `PuertoDeTransporte`: el orquestador se puede
// ejercitar entero con un doble, sin Modbus ni HTTP. El mutex por dispositivo y
// la escalera de recuperacion quedan del otro lado del puerto.

import type { Result, TipoDispositivo } from '@aoki-one/domain'

import type { RepositoriosDelAgente } from '../persistence/index.js'
import type { Reloj } from '../reloj.js'
import type { FalloDeEjecucion } from '../transport/errorClassification.js'
import type {
  PedidoDeComando,
  RegistrosDeDispositivo,
  RespuestaUtilPlc,
} from '../transport/stepHandshake.js'
import type { PoliticaDeReintentos } from './retryPolicy.js'

export interface PuertoDeTransporte {
  /**
   * Un comando de punta a punta: escritura, confirmacion y reset verificado
   * (RF12, RF17).
   *
   * El robot y el tipo de dispositivo son el RUTEO: es el puerto el que resuelve
   * el cliente y el mapa de registros de ese dispositivo y se los entrega al
   * handshake como un unico `DispositivoResuelto`. Por eso el pedido ya no los
   * lleva adentro.
   *
   * La rama ok solo trae respuestas utiles: un ERROR del PLC o un valor
   * desconocido salen siempre por `FalloDeEjecucion`, que es el unico canal de
   * error del transporte (ver `RespuestaUtilPlc`).
   */
  readonly ejecutarComandoDePaso: (
    robotId: string,
    dispositivo: TipoDispositivo,
    pedido: PedidoDeComando,
  ) => Promise<Result<RespuestaUtilPlc, FalloDeEjecucion>>
  /** Deja `messageIn` en 0 en los dispositivos del robot antes de reencolar (RF13). */
  readonly resetearMessageIn: (robotId: string) => Promise<Result<void, FalloDeEjecucion>>
  readonly leerRegistros: (
    robotId: string,
    dispositivo: TipoDispositivo,
  ) => Promise<Result<RegistrosDeDispositivo, FalloDeEjecucion>>
}

/** Lo minimo para ejecutar un paso: no necesita la base. */
export interface DependenciasDePaso {
  readonly transporte: PuertoDeTransporte
  readonly reloj: Reloj
  readonly politica: PoliticaDeReintentos
}

export interface DependenciasDelOrquestador extends DependenciasDePaso {
  readonly repositorios: RepositoriosDelAgente
  /** Sale de la configuracion del agente, nunca del request de la tablet. */
  readonly siteId: string
  /** Generador de ids. Se inyecta: la logica no llama a `randomUUID` directo (RNF). */
  readonly generarId: () => string
}
