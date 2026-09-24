// RF26, RF32 — La autenticacion de la API contra HTTP real.
//
// Lo que se afirma aca es lo que ANTES no se cumplia: la firma era decorativa
// porque el servidor tomaba el secreto del propio request (`x-aoki-agent-secret`)
// para verificarla. Quien podia firmar ya se habia autenticado mandando el
// secreto, y una sola request interceptada alcanzaba para emitir cualquier otra.
//
// Ahora el secreto no viaja: el cliente manda keyId + timestamp + firma y el
// servidor resuelve el secreto por keyId desde su propio almacen. Los cuatro
// endpoints de escritura usan el mismo mecanismo.

import { describe, expect, it } from 'vitest'

import { LOGGER_SILENCIOSO } from '@aoki-one/domain'

import { firmar } from '../api/hmac.js'
import { HEADER_FIRMA, HEADER_KEY_ID, HEADER_TIMESTAMP } from '../api/httpServer.js'
import { crearServidor, type Servidor } from '../composition.js'
import { generarClaveDeCifrado, VARIABLE_DE_CLAVE } from '../persistence/cifrado.js'

/** El header que el diseño viejo usaba para mandar el secreto en claro. */
const HEADER_VIEJO_DE_SECRETO = 'x-aoki-agent-secret'

const ENTORNO = { [VARIABLE_DE_CLAVE]: generarClaveDeCifrado() }

interface Sucursal {
  readonly siteId: string
  readonly keyId: string
  readonly secreto: string
}

const SUC_A: Sucursal = { siteId: 'SUC-A', keyId: 'key-a', secreto: 'secreto-de-a' }
const SUC_B: Sucursal = { siteId: 'SUC-B', keyId: 'key-b', secreto: 'secreto-de-b' }
const AGENT_ID = 'AG-1'

async function levantar(): Promise<{ servidor: Servidor; base: string }> {
  const servidor = crearServidor({
    rutaDeBase: ':memory:',
    httpPuerto: 0,
    httpBind: '127.0.0.1',
    entorno: ENTORNO,
    // Este test rechaza a proposito, y cada rechazo ahora loguea. Silenciado:
    // lo que se afirma es el status, no la linea.
    logger: LOGGER_SILENCIOSO,
    configuracion: { esperaDeLongPollMs: 50, sondeoDeLongPollMs: 10 },
  })
  await servidor.iniciar()
  await servidor.credenciales.alta(SUC_A.keyId, SUC_A.siteId, SUC_A.secreto)
  await servidor.credenciales.alta(SUC_B.keyId, SUC_B.siteId, SUC_B.secreto)

  const direccion = servidor.direccion()
  if (direccion === null) {
    throw new Error('el servidor no quedo escuchando')
  }
  return { servidor, base: `http://${direccion.host}:${String(direccion.puerto)}` }
}

function postear(
  base: string,
  ruta: string,
  cuerpo: unknown,
  cabeceras: Readonly<Record<string, string>>,
): Promise<Response> {
  return fetch(`${base}${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cabeceras },
    body: JSON.stringify(cuerpo),
  })
}

/** Request legitima: keyId, timestamp y firma sobre los bytes exactos del body. */
function firmada(
  base: string,
  ruta: string,
  cuerpo: unknown,
  sucursal: Sucursal,
  ahoraMs = Date.now(),
): Promise<Response> {
  const crudo = JSON.stringify(cuerpo)
  return fetch(`${base}${ruta}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [HEADER_KEY_ID]: sucursal.keyId,
      [HEADER_TIMESTAMP]: String(ahoraMs),
      [HEADER_FIRMA]: firmar(sucursal.secreto, ahoraMs, crudo),
    },
    body: crudo,
  })
}

/** Los cuatro endpoints de escritura, con un body valido para cada uno. */
const ESCRITURAS: readonly { readonly ruta: string; readonly cuerpo: Record<string, unknown> }[] = [
  {
    ruta: '/api/v1/orders',
    cuerpo: {
      siteId: SUC_A.siteId,
      externalOrderId: 'p-1',
      tipo: 'PICK',
      locationCode: '3X04AE1',
    },
  },
  { ruta: '/api/v1/agent/work', cuerpo: { siteId: SUC_A.siteId, agentId: AGENT_ID, limite: 5 } },
  { ruta: '/api/v1/agent/report', cuerpo: { ordenId: 'o-1', seq: 1, estado: 'DONE', metadata: {} } },
  { ruta: '/api/v1/agent/heartbeat', cuerpo: { siteId: SUC_A.siteId, agentId: AGENT_ID } },
]

describe('la firma es lo unico que autentica (RF26, RF32)', () => {
  it('rechaza cualquier escritura sin firma aunque el keyId sea el correcto', async () => {
    const { servidor, base } = await levantar()

    try {
      for (const escritura of ESCRITURAS) {
        const respuesta = await postear(base, escritura.ruta, escritura.cuerpo, {
          [HEADER_KEY_ID]: SUC_A.keyId,
        })
        expect(respuesta.status, escritura.ruta).toBe(401)
      }
    } finally {
      await servidor.detener()
    }
  })

  it('mandar el secreto en claro ya no autentica nada', async () => {
    const { servidor, base } = await levantar()

    try {
      // Exactamente la request que el diseño viejo aceptaba: keyId + secreto en
      // un header, sin firma. Es la regresion que este test existe para trabar.
      for (const escritura of ESCRITURAS) {
        const respuesta = await postear(base, escritura.ruta, escritura.cuerpo, {
          [HEADER_KEY_ID]: SUC_A.keyId,
          [HEADER_VIEJO_DE_SECRETO]: SUC_A.secreto,
        })
        expect(respuesta.status, escritura.ruta).toBe(401)
      }
    } finally {
      await servidor.detener()
    }
  })

  it('rechaza una firma hecha con el secreto de otra credencial', async () => {
    const { servidor, base } = await levantar()

    try {
      const crudo = JSON.stringify({ siteId: SUC_A.siteId, agentId: AGENT_ID, limite: 5 })
      const ahora = Date.now()
      const respuesta = await fetch(`${base}/api/v1/agent/work`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [HEADER_KEY_ID]: SUC_A.keyId,
          [HEADER_TIMESTAMP]: String(ahora),
          [HEADER_FIRMA]: firmar(SUC_B.secreto, ahora, crudo),
        },
        body: crudo,
      })

      expect(respuesta.status).toBe(401)
    } finally {
      await servidor.detener()
    }
  })

  it('rechaza una firma valida pero vieja: la ventana acota el replay', async () => {
    const { servidor, base } = await levantar()

    try {
      const respuesta = await firmada(
        base,
        '/api/v1/agent/heartbeat',
        { siteId: SUC_A.siteId, agentId: AGENT_ID },
        SUC_A,
        Date.now() - 6 * 60 * 1000,
      )
      expect(respuesta.status).toBe(401)
    } finally {
      await servidor.detener()
    }
  })

  it('rechaza una firma que no cubre el body que se mando', async () => {
    const { servidor, base } = await levantar()

    try {
      // Se firma un limite y se manda otro: si la firma no cubriera el body, el
      // atacante podria reusar una firma interceptada con el cuerpo que quiera.
      const ahora = Date.now()
      const respuesta = await fetch(`${base}/api/v1/agent/work`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [HEADER_KEY_ID]: SUC_A.keyId,
          [HEADER_TIMESTAMP]: String(ahora),
          [HEADER_FIRMA]: firmar(
            SUC_A.secreto,
            ahora,
            JSON.stringify({ siteId: SUC_A.siteId, agentId: AGENT_ID, limite: 1 }),
          ),
        },
        body: JSON.stringify({ siteId: SUC_A.siteId, agentId: AGENT_ID, limite: 50 }),
      })

      expect(respuesta.status).toBe(401)
    } finally {
      await servidor.detener()
    }
  })

  it('acepta la request firmada y revocar la credencial la vuelve a rechazar', async () => {
    const { servidor, base } = await levantar()

    try {
      const aceptada = await firmada(
        base,
        '/api/v1/agent/heartbeat',
        { siteId: SUC_A.siteId, agentId: AGENT_ID },
        SUC_A,
      )
      expect(aceptada.status).toBe(200)

      await servidor.credenciales.revocar(SUC_A.keyId, Date.now())
      const revocada = await firmada(
        base,
        '/api/v1/agent/heartbeat',
        { siteId: SUC_A.siteId, agentId: AGENT_ID },
        SUC_A,
      )
      expect(revocada.status).toBe(401)
    } finally {
      await servidor.detener()
    }
  })
})

describe('la credencial autoriza sobre su propia sucursal (RF32)', () => {
  it('una sucursal no puede reportar transiciones de ordenes de otra', async () => {
    const { servidor, base } = await levantar()

    try {
      const alta = await servidor.cola.insertar({
        siteId: SUC_A.siteId,
        externalOrderId: 'p-de-a',
        tipo: 'PICK',
        locationCode: '3X04AE1',
      })
      if (!alta.ok) {
        throw new Error('no se pudo sembrar el pedido de SUC-A')
      }

      // SUC-B firma bien: esta autenticada. Lo que no tiene es autorizacion sobre
      // una orden que no es suya, y el ordenId lo elige el cliente.
      const respuesta = await firmada(
        base,
        '/api/v1/agent/report',
        { ordenId: alta.valor.id, seq: 1, estado: 'DONE', metadata: {} },
        SUC_B,
      )
      expect(respuesta.status).toBe(403)

      // Y lo que importa de verdad: la transicion NO se aplico.
      const pedido = await servidor.cola.buscarPorClave({
        siteId: SUC_A.siteId,
        externalOrderId: 'p-de-a',
      })
      expect(pedido?.estado).toBe('PENDING')
    } finally {
      await servidor.detener()
    }
  })

  it('la duena de la orden si la puede reportar', async () => {
    const { servidor, base } = await levantar()

    try {
      const alta = await servidor.cola.insertar({
        siteId: SUC_A.siteId,
        externalOrderId: 'p-de-a',
        tipo: 'PICK',
        locationCode: '3X04AE1',
      })
      if (!alta.ok) {
        throw new Error('no se pudo sembrar el pedido de SUC-A')
      }

      const respuesta = await firmada(
        base,
        '/api/v1/agent/report',
        { ordenId: alta.valor.id, seq: 1, estado: 'DONE', metadata: {} },
        SUC_A,
      )
      expect(respuesta.status).toBe(200)

      const pedido = await servidor.cola.buscarPorClave({
        siteId: SUC_A.siteId,
        externalOrderId: 'p-de-a',
      })
      expect(pedido?.estado).toBe('DONE')
    } finally {
      await servidor.detener()
    }
  })

  it('una orden que no existe sigue contestando 200 con ORDEN_INEXISTENTE', async () => {
    const { servidor, base } = await levantar()

    try {
      // El chequeo de sucursal NO puede convertir esto en un 4xx: el outbox del
      // agente saca la fila con el cuerpo, y un error lo haria reintentar para
      // siempre una orden que el servidor no tiene (RF34).
      const respuesta = await firmada(
        base,
        '/api/v1/agent/report',
        { ordenId: 'no-existe', seq: 1, estado: 'DONE', metadata: {} },
        SUC_A,
      )
      expect(respuesta.status).toBe(200)
      const cuerpo = (await respuesta.json()) as { readonly data: { readonly tipo: string } }
      expect(cuerpo.data.tipo).toBe('ORDEN_INEXISTENTE')
    } finally {
      await servidor.detener()
    }
  })
})
