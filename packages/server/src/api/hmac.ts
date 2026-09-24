// RF26 — Firma HMAC del body mas timestamp anti-replay.
//
// El servidor es el unico componente expuesto a internet, asi que el ingreso de
// pedidos es la superficie que hay que proteger de verdad. Tres cosas, y las
// tres importan:
//
//   1. La firma es sobre el BODY CRUDO, no sobre el JSON reparseado: dos JSON
//      equivalentes tienen bytes distintos y firmarian distinto.
//   2. La comparacion es en tiempo constante. Un `===` sobre el digest filtra,
//      byte a byte, cuanto acerto el atacante.
//   3. El timestamp acota la ventana de replay: una request capturada no sirve
//      para siempre.

import { createHmac, timingSafeEqual } from 'node:crypto'

export type ErrorDeFirma =
  | { readonly codigo: 'FALTA_FIRMA' }
  | { readonly codigo: 'FALTA_TIMESTAMP' }
  | { readonly codigo: 'TIMESTAMP_INVALIDO' }
  /** Fuera de la ventana: o es replay, o los relojes estan muy corridos. */
  | { readonly codigo: 'TIMESTAMP_FUERA_DE_VENTANA'; readonly desvioMs: number }
  | { readonly codigo: 'FIRMA_INVALIDA' }

export interface PedidoDeVerificacion {
  readonly cuerpoCrudo: string
  readonly firma: string | undefined
  readonly timestamp: string | undefined
  readonly secreto: string
  readonly ahoraMs: number
  readonly ventanaMs: number
}

/** Firma que el cliente tiene que mandar: HMAC-SHA256 de `<timestamp>.<body>`. */
export function firmar(secreto: string, timestampMs: number, cuerpoCrudo: string): string {
  return createHmac('sha256', secreto)
    .update(`${String(timestampMs)}.${cuerpoCrudo}`)
    .digest('hex')
}

export function verificarFirma(
  pedido: PedidoDeVerificacion,
): { readonly ok: true } | { readonly ok: false; readonly error: ErrorDeFirma } {
  if (pedido.firma === undefined || pedido.firma === '') {
    return { ok: false, error: { codigo: 'FALTA_FIRMA' } }
  }
  if (pedido.timestamp === undefined || pedido.timestamp === '') {
    return { ok: false, error: { codigo: 'FALTA_TIMESTAMP' } }
  }

  const timestampMs = Number(pedido.timestamp)
  if (!Number.isFinite(timestampMs)) {
    return { ok: false, error: { codigo: 'TIMESTAMP_INVALIDO' } }
  }

  // La ventana es simetrica: una request del futuro tambien se rechaza, porque
  // significa que algun reloj esta mal y la proteccion deja de valer.
  const desvioMs = Math.abs(pedido.ahoraMs - timestampMs)
  if (desvioMs > pedido.ventanaMs) {
    return { ok: false, error: { codigo: 'TIMESTAMP_FUERA_DE_VENTANA', desvioMs } }
  }

  const esperada = firmar(pedido.secreto, timestampMs, pedido.cuerpoCrudo)
  if (!igualEnTiempoConstante(esperada, pedido.firma)) {
    return { ok: false, error: { codigo: 'FIRMA_INVALIDA' } }
  }

  return { ok: true }
}

/**
 * Comparacion sin fuga de tiempo.
 *
 * `timingSafeEqual` exige buffers del mismo largo, asi que el largo se compara
 * antes: esa diferencia no es explotable como si lo es el prefijo comun.
 */
function igualEnTiempoConstante(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8')
  const bufferB = Buffer.from(b, 'utf8')
  if (bufferA.length !== bufferB.length) {
    return false
  }
  return timingSafeEqual(bufferA, bufferB)
}
