// Suite de aceptacion T02 — portado de tests/unit/errorHandler.test.js.
//
// Test DIRECTO: el backoff entre intentos de un paso.

import { describe, expect, it } from 'vitest'

import { proximoBackoffMs } from './retryPolicy.js'

describe('backoff de reintento de paso', () => {
  // Nota del mapeo (auditoria cruzada): bajo el RNF de deadline explicito por
  // paso y por orden, agotar maxIntentos deja de ser la unica condicion de
  // salida. El test se porta tal cual —los deadlines son T16 y todavia no tienen
  // contrato—, asi que esa dimension nueva queda SIN VERIFICAR aca.
  it('calcula el backoff exponencial', () => {
    expect(proximoBackoffMs(1, 100)).toBe(100)
    expect(proximoBackoffMs(2, 100)).toBe(200)
    expect(proximoBackoffMs(3, 100)).toBe(400)
  })
})
