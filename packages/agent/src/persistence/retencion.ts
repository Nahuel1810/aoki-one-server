// RNF de Rendimiento — "El estado persistido no crece sin techo: retencion
// configurable para eventos, comandos y errores, con purga."
//
// El agente corre en una notebook de sucursal que nadie mantiene: no hay DBA, no
// hay alguien que se acuerde de correr un script, y el dia que el disco se llena
// se para el robot. Por eso la purga es periodica y arranca sola con el proceso
// (ver `programarPurga`), no un comando manual.
//
// QUE SE PURGA Y QUE NO. Es la decision de esta task y el error facil es tratar
// a todas las tablas que crecen como si fueran lo mismo:
//
//   - `events` (RF23) SI, por antiguedad. Es la traza de diagnostico: sirve para
//     reconstruir por que una orden quedo donde quedo, y esa pregunta se hace en
//     los dias posteriores, no meses despues.
//   - `order_steps` (RF23) SI, pero solo las de ordenes YA TERMINADAS. Son los
//     comandos mandados al PLC: cinco filas por maniobra, la tabla que mas
//     rapido crece. La guarda de orden terminada no es cosmetica: los pasos de
//     una orden en curso son lo que lee la rehidratacion al arrancar (RF15), y
//     borrarlos deja la orden imposible de reconstruir. Con un reloj corrido
//     hacia atras o una orden muy larga, purgar por `ts` del paso se llevaria
//     los pasos de una maniobra en curso.
//   - `order_metrics` (RF24) NO. Es el HISTORICO con el que se mide la
//     operacion, y su reporte filtra justamente por rango de fechas: purgarlo
//     por antiguedad borra exactamente el dato que el negocio mira. Es una fila
//     por orden, chica y de ancho fijo: crece MUCHO mas lento que los pasos y no
//     es lo que llena el disco. Si algun dia hace falta, lo que corresponde es
//     agregarla (un resumen por dia), no borrarla, y eso es otra task.
//   - `orders` NO. Es la clave del dedupe idempotente por
//     `(siteId, externalOrderId)` (RF14): borrar una orden vieja hace que una
//     re-entrega del servidor se admita como nueva y el robot repita una maniobra
//     que ya hizo. Y sin la fila de la orden, su metrica queda sin contexto.
//   - `outbox` / `outbox_muertas` NO. La primera es trabajo pendiente, no
//     historico. La segunda es la cola muerta (RF34): cambios de estado que la
//     app de picking no vio nunca, que existen justamente para que alguien pueda
//     reconstruirlos. Ninguna de las dos crece con el uso normal.

import type { BaseDelAgente } from './database.js'

export interface PoliticaDeRetencion {
  /** Cuanto se conserva una fila de `events`, en ms. */
  readonly eventosMs: number
  /**
   * Cuanto se conservan los pasos de una orden DESPUES de que la orden termino,
   * en ms. Se mide contra `finalizada_en` de la orden, no contra el paso.
   */
  readonly pasosMs: number
}

/**
 * Defaults pensados para una notebook de sucursal.
 *
 * 30 dias de eventos cubren de sobra la pregunta que se le hace a la traza ("por
 * que se trabo el pedido de la semana pasada"). Los pasos duran la mitad porque
 * son cinco filas por maniobra: son el volumen real, y a los 14 dias su unico
 * lector posible —la rehidratacion de RF15— hace rato que no los mira.
 */
export const RETENCION_POR_DEFECTO: PoliticaDeRetencion = {
  eventosMs: 30 * 24 * 60 * 60 * 1000,
  pasosMs: 14 * 24 * 60 * 60 * 1000,
}

export interface ResultadoDePurga {
  readonly eventosBorrados: number
  readonly pasosBorrados: number
}

export interface PurgaDelAgente {
  /** Una pasada. `ahoraMs` se inyecta: el RNF de Calidad prohibe `Date.now()` en la logica. */
  readonly purgar: (ahoraMs: number) => Promise<ResultadoDePurga>
}

export function crearPurgaDelAgente(
  base: BaseDelAgente,
  politica: PoliticaDeRetencion = RETENCION_POR_DEFECTO,
): PurgaDelAgente {
  const { sql } = base

  // Las dos borradas van en UNA transaccion: una purga a medias dejaria la
  // traza de una orden partida —eventos sin pasos— que es peor para diagnosticar
  // que no haber purgado.
  const purgar = sql.transaction((ahoraMs: number): ResultadoDePurga => {
    const eventos = sql.prepare('DELETE FROM events WHERE ts < ?').run(ahoraMs - politica.eventosMs)

    // La orden manda: sus pasos se van con ella y solo cuando ella ya termino.
    // `finalizada_en IS NOT NULL` deja afuera a toda orden viva, sin importar
    // hace cuanto se creo.
    const pasos = sql
      .prepare(
        `DELETE FROM order_steps WHERE orden_id IN (
           SELECT id FROM orders
           WHERE finalizada_en IS NOT NULL AND finalizada_en < ?
         )`,
      )
      .run(ahoraMs - politica.pasosMs)

    return { eventosBorrados: eventos.changes, pasosBorrados: pasos.changes }
  })

  return {
    purgar: (ahoraMs) => Promise.resolve(purgar(ahoraMs)),
  }
}

export interface PurgaProgramada {
  readonly detener: () => void
}

/**
 * Deja la purga corriendo sola mientras viva el proceso.
 *
 * Corre una vez AL ARRANQUE y despues cada `intervaloMs`. Las dos cosas hacen
 * falta: la notebook de sucursal se apaga a la noche, asi que un agente que solo
 * purgara cada 24 h de uptime no purgaria nunca.
 *
 * El error de una pasada no propaga: una purga que falla no puede tumbar al
 * proceso que maneja el robot. Se avisa por el callback y se vuelve a intentar
 * en la proxima vuelta.
 */
export function programarPurga(opciones: {
  readonly purga: PurgaDelAgente
  readonly intervaloMs: number
  readonly ahoraMs: () => number
  readonly alTerminar: (resultado: ResultadoDePurga) => void
  readonly alFallar: (error: unknown) => void
}): PurgaProgramada {
  const { purga, intervaloMs, ahoraMs, alTerminar, alFallar } = opciones

  const pasada = (): void => {
    purga.purgar(ahoraMs()).then(alTerminar, alFallar)
  }

  pasada()
  const temporizador = setInterval(pasada, intervaloMs)
  // unref: una purga pendiente no tiene que mantener vivo el proceso.
  temporizador.unref()

  return {
    detener: () => {
      clearInterval(temporizador)
    },
  }
}
