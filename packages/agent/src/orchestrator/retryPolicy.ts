// RF13 — Presupuesto de reintentos de un paso.
//
// Sin deadlines. El RNF de latencia pide un techo de tiempo por paso y por orden
// (hoy un paso puede tardar minutos: 90 s de ACK mas hasta 66 s de reintentos de
// conectividad), pero ningun test portado lo ejercita y, al ser campos
// requeridos, cada fixture de esta fase tendria que inventar dos valores que
// nadie afirma. Los deadlines entran con la task que escriba su test, junto con
// la salida `DEADLINE_DE_PASO_VENCIDO` de `ejecutarPasoConReintentos`.


export interface PoliticaDeReintentos {
  /** Intentos TOTALES por paso, no reintentos adicionales: 3 son 3 llamadas al transporte. */
  readonly maxIntentos: number
  readonly baseBackoffMs: number
}

/**
 * `baseMs * 2^(intento - 1)`. Con `intento <= 1` devuelve `baseMs`.
 *
 * Sin jitter: el jitter es del backoff del long-poll (RF37) y vive en otra
 * funcion. Es distinta tambien del backoff del monitor de conectividad, que
 * tiene sus propias constantes y su propio techo.
 */
export function proximoBackoffMs(intento: number, baseMs: number): number {
  // Exponencial desde el primer intento: base * 2^(intento - 1). Portado literal.
  return baseMs * 2 ** Math.max(0, intento - 1)
}
