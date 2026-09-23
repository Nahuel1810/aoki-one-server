// E2E del servidor de pedidos contra HTTP real.
//
// Cubre el recorrido completo de RF26 a RF32: la app de picking da de alta un
// pedido firmado, el agente lo reclama por long-poll, reporta que termino y manda
// heartbeat, y el health refleja la presencia de la sucursal.

import { describe, expect, it } from 'vitest'

import { firmar } from '../api/hmac.js'
import {
  HEADER_FIRMA,
  HEADER_KEY_ID,
  HEADER_SECRETO_DE_AGENTE,
  HEADER_TIMESTAMP,
} from '../api/httpServer.js'
import { crearServidor, type Servidor } from '../composition.js'

const SITE_ID = 'SUC-1'
const KEY_ID = 'key-suc-1'
const SECRETO = 'secreto-de-prueba'
const AGENT_ID = 'agente-1'

async function levantar(): Promise<{ servidor: Servidor; base: string }> {
  const servidor = crearServidor({
    rutaDeBase: ':memory:',
    // Puerto 0: lo asigna el sistema. Uno fijo es EADDRINUSE en CI.
    httpPuerto: 0,
    httpBind: '127.0.0.1',
    // Long-poll corto para que el test no espere 25 s reales.
    configuracion: { esperaDeLongPollMs: 300, sondeoDeLongPollMs: 25 },
  })
  await servidor.iniciar()
  await servidor.credenciales.alta(KEY_ID, SITE_ID, SECRETO)

  const direccion = servidor.direccion()
  if (direccion === null) {
    throw new Error('el servidor no quedo escuchando')
  }
  return { servidor, base: `http://${direccion.host}:${String(direccion.puerto)}` }
}

interface Respuesta {
  readonly status: number
  readonly cuerpo: Record<string, unknown>
}

async function leer(respuesta: Response): Promise<Respuesta> {
  return { status: respuesta.status, cuerpo: (await respuesta.json()) as Record<string, unknown> }
}

/** Alta firmada, como la manda la app de picking. */
async function altaDePedido(base: string, externalOrderId: string): Promise<Respuesta> {
  const cuerpo = JSON.stringify({
    siteId: SITE_ID,
    externalOrderId,
    tipo: 'PICK',
    locationCode: '3X04AE1',
  })
  const ahora = Date.now()

  return leer(
    await fetch(`${base}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [HEADER_KEY_ID]: KEY_ID,
        [HEADER_SECRETO_DE_AGENTE]: SECRETO,
        [HEADER_TIMESTAMP]: String(ahora),
        [HEADER_FIRMA]: firmar(SECRETO, ahora, cuerpo),
      },
      body: cuerpo,
    }),
  )
}

function comoAgente(base: string, ruta: string, cuerpo: unknown): Promise<Response> {
  return fetch(`${base}${ruta}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [HEADER_KEY_ID]: KEY_ID,
      [HEADER_SECRETO_DE_AGENTE]: SECRETO,
    },
    body: JSON.stringify(cuerpo),
  })
}

describe('e2e del servidor de pedidos', () => {
  it('recorre alta firmada, reclamo por long-poll, reporte y presencia', async () => {
    const { servidor, base } = await levantar()

    try {
      // --- La app de picking da de alta un pedido ---
      const alta = await altaDePedido(base, 'pedido-1')
      expect(alta.status).toBe(202)
      expect(alta.cuerpo['created']).toBe(true)

      // El reenvio identico NO crea una segunda orden (RF26).
      const reenvio = await altaDePedido(base, 'pedido-1')
      expect(reenvio.status).toBe(200)
      expect(reenvio.cuerpo['created']).toBe(false)

      // --- El agente reclama trabajo ---
      const trabajo = await leer(
        await comoAgente(base, '/api/v1/agent/work', {
          siteId: SITE_ID,
          agentId: AGENT_ID,
          limite: 10,
        }),
      )
      expect(trabajo.status).toBe(200)
      const pedidos = trabajo.cuerpo['data'] as ReadonlyArray<Record<string, unknown>>
      expect(pedidos).toHaveLength(1)
      expect(pedidos[0]?.['externalOrderId']).toBe('pedido-1')
      const ordenId = String(pedidos[0]?.['id'])

      // Un segundo reclamo no devuelve lo mismo: el lease esta vigente.
      const segundo = await leer(
        await comoAgente(base, '/api/v1/agent/work', {
          siteId: SITE_ID,
          agentId: 'otro-agente',
          limite: 10,
        }),
      )
      expect(segundo.cuerpo['data']).toEqual([])

      // --- El agente reporta que la ejecuto ---
      const reporte = await leer(
        await comoAgente(base, '/api/v1/agent/report', {
          ordenId,
          seq: 1,
          estado: 'DONE',
          metadata: { robotId: '1' },
        }),
      )
      expect(reporte.status).toBe(200)

      // El reporte repetido no es error: el outbox reintenta hasta confirmar.
      const repetido = await leer(
        await comoAgente(base, '/api/v1/agent/report', {
          ordenId,
          seq: 1,
          estado: 'DONE',
          metadata: {},
        }),
      )
      expect(repetido.status).toBe(200)

      // --- La app de picking consulta el estado ---
      const consulta = await leer(
        await fetch(`${base}/api/v1/orders/pedido-1`, { headers: { [HEADER_KEY_ID]: KEY_ID } }),
      )
      expect(consulta.status).toBe(200)
      expect((consulta.cuerpo['data'] as Record<string, unknown>)['estado']).toBe('DONE')

      // --- Heartbeat y presencia ---
      const latido = await leer(
        await comoAgente(base, '/api/v1/agent/heartbeat', {
          siteId: SITE_ID,
          agentId: AGENT_ID,
          estado: { robots: 1 },
        }),
      )
      expect(latido.status).toBe(200)

      const health = await leer(await fetch(`${base}/health`))
      expect(health.status).toBe(200)
      const datos = health.cuerpo['data'] as Record<string, unknown>
      const sitios = datos['sites'] as ReadonlyArray<Record<string, unknown>>
      expect(sitios).toHaveLength(1)
      expect(sitios[0]?.['siteId']).toBe(SITE_ID)
      // Recien latio: no esta caida. RF31 pide que se diga siempre, no solo cuando falla.
      expect(sitios[0]?.['caida']).toBe(false)
      expect(sitios[0]?.['pendientes']).toBe(0)
    } finally {
      await servidor.detener()
    }
  })

  it('el long-poll contesta vacio al vencer el timeout, no con un error', async () => {
    const { servidor, base } = await levantar()

    try {
      const sinTrabajo = await leer(
        await comoAgente(base, '/api/v1/agent/work', {
          siteId: SITE_ID,
          agentId: AGENT_ID,
          limite: 10,
        }),
      )
      // 200 con lista vacia: el agente vuelve a pedir enseguida. Un error lo
      // mandaria al backoff sin motivo.
      expect(sinTrabajo.status).toBe(200)
      expect(sinTrabajo.cuerpo['data']).toEqual([])
    } finally {
      await servidor.detener()
    }
  })

  it('rechaza el alta sin firma y con firma invalida', async () => {
    const { servidor, base } = await levantar()

    try {
      const cuerpo = JSON.stringify({
        siteId: SITE_ID,
        externalOrderId: 'p-x',
        tipo: 'PICK',
        locationCode: '3X04AE1',
      })

      const sinFirma = await leer(
        await fetch(`${base}/api/v1/orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [HEADER_KEY_ID]: KEY_ID,
            [HEADER_SECRETO_DE_AGENTE]: SECRETO,
          },
          body: cuerpo,
        }),
      )
      expect(sinFirma.status).toBe(401)

      const firmaMala = await leer(
        await fetch(`${base}/api/v1/orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [HEADER_KEY_ID]: KEY_ID,
            [HEADER_SECRETO_DE_AGENTE]: SECRETO,
            [HEADER_TIMESTAMP]: String(Date.now()),
            [HEADER_FIRMA]: 'a'.repeat(64),
          },
          body: cuerpo,
        }),
      )
      expect(firmaMala.status).toBe(401)
    } finally {
      await servidor.detener()
    }
  })

  it('una sucursal no puede crear ordenes de otra', async () => {
    const { servidor, base } = await levantar()

    try {
      // La credencial es de SUC-1 y el body dice SUC-2.
      const cuerpo = JSON.stringify({
        siteId: 'SUC-2',
        externalOrderId: 'p-ajeno',
        tipo: 'PICK',
        locationCode: '3X04AE1',
      })
      const ahora = Date.now()

      const respuesta = await leer(
        await fetch(`${base}/api/v1/orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [HEADER_KEY_ID]: KEY_ID,
            [HEADER_SECRETO_DE_AGENTE]: SECRETO,
            [HEADER_TIMESTAMP]: String(ahora),
            [HEADER_FIRMA]: firmar(SECRETO, ahora, cuerpo),
          },
          body: cuerpo,
        }),
      )

      expect(respuesta.status).toBe(403)
    } finally {
      await servidor.detener()
    }
  })

  it('el agente sin credencial no reclama trabajo', async () => {
    const { servidor, base } = await levantar()

    try {
      const respuesta = await fetch(`${base}/api/v1/agent/work`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: SITE_ID, agentId: AGENT_ID }),
      })
      expect(respuesta.status).toBe(401)

      // Y con una credencial revocada tampoco.
      await servidor.credenciales.revocar(KEY_ID, Date.now())
      const revocada = await comoAgente(base, '/api/v1/agent/work', {
        siteId: SITE_ID,
        agentId: AGENT_ID,
      })
      expect(revocada.status).toBe(401)
    } finally {
      await servidor.detener()
    }
  })
})
