// RF23 — Tabla `events`.
//
// Un fallo de paso, una reserva de slot o una liberacion manual quedan
// registrados asociados a su entidad y son consultables. Reemplaza al array
// `errors` del snapshot.
//
// El id y el timestamp NO se generan adentro: se inyectan (el dominio y la
// persistencia no llaman a `randomUUID` ni a `Date.now()`), y persistir es una
// responsabilidad distinta de loguear.

import { noImplementado } from '@aoki-one/domain'

import type { BaseDelAgente } from './database.js'

/**
 * Entidad a la que se asocia un evento.
 *
 * No esta `DEVICE`: ningun test portado registra un evento de dispositivo, y una
 * variante que nadie puede producir es superficie que despues hay que sostener.
 * Entra con la task que la necesite.
 */
export type TipoDeEntidad = 'ORDER' | 'SLOT' | 'ROBOT'

export type SeveridadDeEvento = 'INFO' | 'ERROR'

export interface Evento {
  readonly id: string
  readonly ts: number
  readonly tipoDeEntidad: TipoDeEntidad
  readonly entidadId: string
  /** Nombre del evento, por ejemplo `SLOT_RESERVED` o `STEP_FAILED`. */
  readonly evento: string
  readonly severidad: SeveridadDeEvento
  readonly metadata: Readonly<Record<string, unknown>>
}

/**
 * Filtro de consulta.
 *
 * Sin rango de fechas: `desdeMs` / `hastaMs` son el reporte filtrable por rango
 * de RF24, que figura entero en "RF sin cobertura" del mapeo. Entra con su test.
 */
export interface FiltroDeEventos {
  readonly tipoDeEntidad?: TipoDeEntidad
  readonly entidadId?: string
}

export interface EventRepository {
  readonly registrar: (evento: Evento) => Promise<Evento>
  /** Del mas nuevo al mas viejo. */
  readonly listar: (filtro: FiltroDeEventos) => Promise<readonly Evento[]>
}

export function crearEventRepository(base: BaseDelAgente): EventRepository {
  return noImplementado('crearEventRepository', { base })
}
