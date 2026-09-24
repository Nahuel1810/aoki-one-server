// RF26 — Firma HMAC y anti-replay del ingreso de pedidos.
//
// Es lo unico que separa "la app de picking manda un pedido" de "cualquiera en
// internet le pide al robot que mueva un cajon".

import { describe, expect, it } from 'vitest'

import { firmar, verificarFirma } from './hmac.js'

const SECRETO = 'secreto-de-la-sucursal'
const AHORA = 1_700_000_000_000
const VENTANA = 5 * 60 * 1000
const CUERPO = '{"siteId":"SUC-1","externalOrderId":"p-1","tipo":"PICK","locationCode":"3X04AE1"}'

function verificar(parcial: Partial<Parameters<typeof verificarFirma>[0]> = {}) {
  return verificarFirma({
    cuerpoCrudo: CUERPO,
    firma: firmar(SECRETO, AHORA, CUERPO),
    timestamp: String(AHORA),
    secreto: SECRETO,
    ahoraMs: AHORA,
    ventanaMs: VENTANA,
    ...parcial,
  })
}

describe('verificarFirma', () => {
  it('acepta una firma valida dentro de la ventana', () => {
    expect(verificar()).toEqual({ ok: true })
  })

  it('rechaza si falta la firma o el timestamp', () => {
    expect(verificar({ firma: undefined })).toEqual({ ok: false, error: { codigo: 'FALTA_FIRMA' } })
    expect(verificar({ firma: '' })).toEqual({ ok: false, error: { codigo: 'FALTA_FIRMA' } })
    expect(verificar({ timestamp: undefined })).toEqual({
      ok: false,
      error: { codigo: 'FALTA_TIMESTAMP' },
    })
  })

  it('rechaza un timestamp que no es un numero', () => {
    expect(verificar({ timestamp: 'ayer' })).toEqual({
      ok: false,
      error: { codigo: 'TIMESTAMP_INVALIDO' },
    })
  })

  it('rechaza una request vieja: es el anti-replay', () => {
    const viejo = AHORA - VENTANA - 1
    const resultado = verificar({
      timestamp: String(viejo),
      firma: firmar(SECRETO, viejo, CUERPO),
    })
    expect(resultado.ok).toBe(false)
    if (!resultado.ok) {
      expect(resultado.error.codigo).toBe('TIMESTAMP_FUERA_DE_VENTANA')
    }
  })

  it('rechaza tambien una request del futuro', () => {
    // No es simetria por elegancia: un timestamp futuro significa que algun reloj
    // esta mal, y con el reloj mal la ventana deja de proteger.
    const futuro = AHORA + VENTANA + 1
    const resultado = verificar({
      timestamp: String(futuro),
      firma: firmar(SECRETO, futuro, CUERPO),
    })
    expect(resultado.ok).toBe(false)
    if (!resultado.ok) {
      expect(resultado.error.codigo).toBe('TIMESTAMP_FUERA_DE_VENTANA')
    }
  })

  it('rechaza si el cuerpo cambio aunque la firma sea de un cuerpo valido', () => {
    // El caso que la firma existe para atajar: alguien intercepta un pedido
    // legitimo y le cambia la ubicacion.
    const alterado = CUERPO.replace('3X04AE1', '3X99AL9')
    expect(verificar({ cuerpoCrudo: alterado })).toEqual({
      ok: false,
      error: { codigo: 'FIRMA_INVALIDA' },
    })
  })

  it('rechaza una firma hecha con otro secreto', () => {
    expect(verificar({ firma: firmar('otro-secreto', AHORA, CUERPO) })).toEqual({
      ok: false,
      error: { codigo: 'FIRMA_INVALIDA' },
    })
  })

  it('rechaza si el timestamp firmado no es el que viaja en el header', () => {
    // Reusar una firma vieja con un timestamp nuevo no sirve: el timestamp entra
    // en lo que se firma.
    expect(verificar({ firma: firmar(SECRETO, AHORA - 1, CUERPO) })).toEqual({
      ok: false,
      error: { codigo: 'FIRMA_INVALIDA' },
    })
  })

  it('una firma de largo distinto no rompe la comparacion', () => {
    // timingSafeEqual tira si los buffers no miden igual: el largo se compara antes.
    expect(verificar({ firma: 'corta' })).toEqual({
      ok: false,
      error: { codigo: 'FIRMA_INVALIDA' },
    })
  })

  it('la firma cubre el cuerpo CRUDO: dos JSON equivalentes firman distinto', () => {
    // Por eso se guarda el buffer del body y no se firma el reparseado.
    const reordenado = '{"externalOrderId":"p-1","siteId":"SUC-1","tipo":"PICK","locationCode":"3X04AE1"}'
    expect(firmar(SECRETO, AHORA, CUERPO)).not.toBe(firmar(SECRETO, AHORA, reordenado))
  })
})
