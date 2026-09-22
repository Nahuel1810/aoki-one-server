// RF23 y RF24 — Tabla `order_steps`.
//
// Cada comando mandado al PLC queda registrado correlacionado a su orden y a su
// numero de paso, y se lee por consulta indexada. Reemplaza al array `commands`
// del snapshot en memoria, que obligaba a serializar el estado completo en cada
// paso.

import { noImplementado } from '@aoki-one/domain'
import type { Result, SeqPaso, TipoDispositivo, TipoPaso } from '@aoki-one/domain'

import type { BaseDelAgente } from './database.js'

/** Un paso nace en SENT (mandado al PLC) y cierra en DONE o en ERROR. */
export type EstadoDePaso = 'SENT' | 'DONE' | 'ERROR'

export interface PasoPersistido {
  readonly ordenId: string
  readonly seq: SeqPaso
  readonly tipo: TipoPaso
  readonly dispositivo: TipoDispositivo
  readonly estado: EstadoDePaso
  /** Intentos consumidos. `maxIntentos` son intentos TOTALES, no adicionales. */
  readonly intentos: number
  readonly iniciadoEn: number
  readonly finalizadoEn: number | null
}

export interface CambiosDePaso {
  readonly estado?: EstadoDePaso
  readonly intentos?: number
  readonly finalizadoEn?: number | null
}

export type ErrorDePaso = {
  readonly codigo: 'PASO_INEXISTENTE'
  readonly ordenId: string
  readonly seq: SeqPaso
}

export interface OrderStepRepository {
  readonly registrar: (paso: PasoPersistido) => Promise<PasoPersistido>
  readonly actualizar: (
    ordenId: string,
    seq: SeqPaso,
    cambios: CambiosDePaso,
  ) => Promise<Result<PasoPersistido, ErrorDePaso>>
  /** Los pasos de la orden, en orden de `seq`. */
  readonly listarPorOrden: (ordenId: string) => Promise<readonly PasoPersistido[]>
}

export function crearOrderStepRepository(base: BaseDelAgente): OrderStepRepository {
  return noImplementado('crearOrderStepRepository', { base })
}
