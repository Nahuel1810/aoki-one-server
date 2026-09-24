// RF37 — Backoff exponencial con jitter y techo para la reconexion del enlace.
//
// La espera crece con cada fallo consecutivo y se corta en un techo: un servidor
// caido no puede generar una tormenta de reintentos desde la sucursal.
//
// El jitter no es cosmetico. Importa de verdad en Fase 2: con N agentes
// reintentando, sin jitter todos golpean el servidor en el mismo instante justo
// cuando vuelve, que es cuando menos lo aguanta. Y el azar se INYECTA porque un
// backoff con jitter que no se puede testear es un backoff que nadie verifica.

/** Fuente de azar inyectable. Devuelve un numero en [0, 1), como `Math.random`. */
export interface Azar {
  readonly siguiente: () => number
}

/** Azar real. Solo lo arma la composicion, igual que el reloj del sistema. */
export function crearAzarDelSistema(): Azar {
  return { siguiente: () => Math.random() }
}

export interface PoliticaDeBackoff {
  /** Espera del primer reintento, antes de aplicar el jitter. */
  readonly baseMs: number
  /** Techo de la espera. Sin el, 2^n se va a horas en una caida larga. */
  readonly techoMs: number
  /** Porcion de la espera que sortea el azar, entre 0 y 1. */
  readonly fraccionDeJitter: number
}

/**
 * Un minuto de techo desde un segundo de base.
 *
 * Con jitter 0.5 la espera de cada agente cae en la mitad superior del tramo, o
 * sea que dos agentes nunca vuelven a coincidir despues del primer fallo.
 */
export const BACKOFF_DEL_ENLACE: PoliticaDeBackoff = {
  baseMs: 1_000,
  techoMs: 60_000,
  fraccionDeJitter: 0.5,
}

/**
 * Cuanto esperar antes del proximo intento.
 *
 * `fallosConsecutivos` es 0 mientras el enlace anda: ahi no hay espera y el
 * long-poll vuelve a salir enseguida, que es todo el punto de que sea long-poll
 * y no polling.
 */
export function calcularEsperaDeBackoff(
  politica: PoliticaDeBackoff,
  fallosConsecutivos: number,
  azar: Azar,
): number {
  if (fallosConsecutivos <= 0) {
    return 0
  }

  // El exponente se acota antes de elevar: sin esto una caida larga desborda a
  // Infinity y el min contra el techo pasa a operar sobre un numero que no es un
  // numero.
  const exponente = Math.min(fallosConsecutivos - 1, 30)
  const crudo = Math.min(politica.baseMs * Math.pow(2, exponente), politica.techoMs)

  const fija = crudo * (1 - politica.fraccionDeJitter)
  const sorteada = crudo * politica.fraccionDeJitter * azar.siguiente()
  return Math.round(fija + sorteada)
}
