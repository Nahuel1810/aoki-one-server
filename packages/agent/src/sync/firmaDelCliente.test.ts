// RF26, RF32 — Como se autentica el agente contra el servidor.
//
// El secreto de la sucursal es lo unico que el agente no puede dejar salir: con
// el, cualquiera emite ordenes y reporta transiciones como si fuera la sucursal.
// Antes viajaba en un header en CADA llamada, asi que alcanzaba con interceptar
// una. Estos tests miran el cable: que sale y que no.

import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  crearClienteHttp,
  HEADER_FIRMA,
  HEADER_KEY_ID,
  HEADER_TIMESTAMP,
  TIEMPOS_DEL_CLIENTE_POR_DEFECTO,
} from './serverClient.js'

const URL_BASE = 'http://servidor-de-prueba'
const SITE_ID = 'SUC-1'
const AGENT_ID = 'AG-1'
const KEY_ID = 'key-suc-1'
const SECRETO = 'secreto-de-la-sucursal'
const AHORA_MS = 1_700_000_000_000

interface LlamadaObservada {
  readonly url: string
  readonly cabeceras: Headers
  readonly cuerpo: string
}

interface Banco {
  readonly llamadas: readonly LlamadaObservada[]
  readonly cliente: ReturnType<typeof crearClienteHttp>
}

/** Respuesta valida para cada ruta, para que el cliente no se corte antes de tiempo. */
function responder(ruta: string): Response {
  const datos: Record<string, unknown> = {
    '/api/v1/agent/work': [],
    '/api/v1/agent/report': { tipo: 'APLICADA' },
    '/api/v1/agent/heartbeat': { siteId: SITE_ID, recibidoEn: AHORA_MS },
    '/api/v1/orders': {
      id: 'o-remota-1',
      externalOrderId: 'local-AG-1-1',
      tipo: 'PICK',
      locationCode: '3X04AE1',
    },
  }
  return new Response(JSON.stringify({ ok: true, data: datos[ruta] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function montar(): Banco {
  const llamadas: LlamadaObservada[] = []

  const pedir: typeof fetch = (entrada, init) => {
    if (typeof entrada !== 'string') {
      throw new Error('el cliente del agente siempre pide por URL en texto')
    }
    const url = entrada
    const cuerpo = typeof init?.body === 'string' ? init.body : ''
    llamadas.push({ url, cabeceras: new Headers(init?.headers), cuerpo })
    return Promise.resolve(responder(new URL(url).pathname))
  }

  return {
    llamadas,
    cliente: crearClienteHttp({
      urlBase: URL_BASE,
      siteId: SITE_ID,
      agentId: AGENT_ID,
      credencial: { keyId: KEY_ID, secreto: SECRETO },
      tiempos: TIEMPOS_DEL_CLIENTE_POR_DEFECTO,
      pedir,
      ahoraMs: () => AHORA_MS,
    }),
  }
}

/** Las cuatro llamadas que el agente le hace al servidor. */
async function llamarATodo(banco: Banco): Promise<void> {
  await banco.cliente.reclamarTrabajo(10)
  await banco.cliente.reportarTransicion({
    ordenIdRemoto: 'o-remota-1',
    seq: 1,
    estado: 'DONE',
    metadata: { robotId: '1' },
  })
  await banco.cliente.latir({ robots: 1 })
  await banco.cliente.empujarOrden({
    externalOrderId: 'local-AG-1-1',
    tipo: 'PICK',
    locationCode: '3X04AE1',
  })
}

describe('el secreto de la sucursal no viaja (RF32)', () => {
  it('no aparece en ningun header ni body de ninguna llamada legitima', async () => {
    const banco = montar()
    await llamarATodo(banco)

    expect(banco.llamadas).toHaveLength(4)
    for (const llamada of banco.llamadas) {
      for (const [nombre, valor] of llamada.cabeceras.entries()) {
        expect(valor, `${llamada.url} / ${nombre}`).not.toContain(SECRETO)
      }
      expect(llamada.cuerpo, llamada.url).not.toContain(SECRETO)
    }
  })

  it('no manda el header de secreto del contrato viejo', async () => {
    const banco = montar()
    await llamarATodo(banco)

    for (const llamada of banco.llamadas) {
      expect(llamada.cabeceras.has('x-aoki-agent-secret'), llamada.url).toBe(false)
    }
  })
})

describe('todas las llamadas van firmadas (RF26)', () => {
  it('manda keyId, timestamp y firma en las cuatro rutas', async () => {
    const banco = montar()
    await llamarATodo(banco)

    for (const llamada of banco.llamadas) {
      expect(llamada.cabeceras.get(HEADER_KEY_ID), llamada.url).toBe(KEY_ID)
      expect(llamada.cabeceras.get(HEADER_TIMESTAMP), llamada.url).toBe(String(AHORA_MS))
      expect(llamada.cabeceras.get(HEADER_FIRMA), llamada.url).not.toBeNull()
    }
  })

  it('firma los bytes exactos que manda, no un JSON equivalente', async () => {
    // Serializar dos veces —una para firmar y otra para enviar— da bytes
    // distintos y el servidor rechazaria la firma. Se recomputa sobre el body
    // TAL COMO salio al cable.
    const banco = montar()
    await llamarATodo(banco)

    for (const llamada of banco.llamadas) {
      const esperada = createHmac('sha256', SECRETO)
        .update(`${String(AHORA_MS)}.${llamada.cuerpo}`)
        .digest('hex')
      expect(llamada.cabeceras.get(HEADER_FIRMA), llamada.url).toBe(esperada)
    }
  })
})
