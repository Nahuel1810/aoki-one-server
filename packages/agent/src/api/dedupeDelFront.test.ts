// RF14, RF21 y RF35 — El `id` del body es por donde el front dedupea.
//
// EL CASO DE PLANTA: la tablet manda `{id: 1234}` y espera que el segundo toque
// del boton devuelva LA MISMA orden. El agente habia dejado de leer ese campo y
// generaba un externalOrderId propio cada vez, asi que cada toque creaba una
// orden nueva: un doble tap sobre un PUT son DOS maniobras, y la segunda va a
// buscar un cajon que ya no esta.
//
// El legacy lo hace en `ordersRoutes.js` + `submitOrder`: `Number(input.id)`,
// entero obligatorio, y si ya existe una orden con ese externalOrderId devuelve
// esa con `created: false` y 200.
//
// Lo que NO se rompe: una orden sin `id` sigue naciendo con el externalOrderId
// local prefijado por agente (RF35), que nunca es solo digitos y por eso no puede
// colisionar con un id de picking.

import { describe, expect, it } from 'vitest'

import { LOGGER_SILENCIOSO } from '@aoki-one/domain'

import { crearAgente, type Agente } from '../composition.js'
import type { CuerpoDeRespuesta } from './httpServer.js'

const SITE_ID = 'SUC-DEDUPE'
const AGENT_ID = 'AG-DEDUPE'
const ROBOT_ID = '1'
const ORIGEN = '3X04AA3'

/** El numero que manda hoy la tablet. */
const ID_DEL_FRONT = 1234

interface OrdenDeApi {
  readonly id: string
  readonly externalOrderId: string
  readonly locationCode: string
}

async function levantarAgente(): Promise<Agente> {
  const agente = crearAgente({
    siteId: SITE_ID,
    agentId: AGENT_ID,
    rutaDeBase: ':memory:',
    montarApi: true,
    simularPlc: true,
    httpPuerto: 0,
    httpBind: '127.0.0.1',
    zonaDePickeo: ['3X02AE1'],
    tokenDeMantenimiento: null,
    enlace: null,
    logger: LOGGER_SILENCIOSO,
  })

  const robot = await agente.orquestador.repositorios.robots.guardar({
    id: ROBOT_ID,
    siteId: SITE_ID,
    estanteriaCode: '3X',
    habilitado: true,
    estado: 'IDLE',
    ordenActivaId: null,
  })
  if (!robot.ok) {
    throw new Error(`no se pudo sembrar el robot: ${robot.error.codigo}`)
  }

  await agente.iniciar()
  // La cola se pausa: el test afirma sobre el ALTA, y con el loop tomando la
  // orden el estado cambia debajo de las afirmaciones.
  await agente.orquestador.repositorios.robots.fijarPausaDeCola(ROBOT_ID, true, 0)
  return agente
}

function urlDe(agente: Agente, ruta: string): string {
  const direccion = agente.direccion()
  if (direccion === null) {
    throw new Error('el agente no monto la API')
  }
  return `http://${direccion.host}:${String(direccion.puerto)}${ruta}`
}

async function altaDeOrden(
  agente: Agente,
  body: unknown,
): Promise<{ status: number; cuerpo: CuerpoDeRespuesta<OrdenDeApi> & { created?: boolean } }> {
  const respuesta = await fetch(urlDe(agente, '/api/orders'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return {
    status: respuesta.status,
    cuerpo: (await respuesta.json()) as CuerpoDeRespuesta<OrdenDeApi>,
  }
}

describe('POST /api/orders con el id del front', () => {
  it('el mismo id no crea una segunda orden: 202 la primera, 200 la segunda', async () => {
    const agente = await levantarAgente()

    try {
      const primera = await altaDeOrden(agente, {
        id: ID_DEL_FRONT,
        type: 'PICK',
        locationCode: ORIGEN,
      })
      expect(primera.status).toBe(202)
      expect(primera.cuerpo.created).toBe(true)

      const segunda = await altaDeOrden(agente, {
        id: ID_DEL_FRONT,
        type: 'PICK',
        locationCode: ORIGEN,
      })
      expect(segunda.status).toBe(200)
      expect(segunda.cuerpo.created).toBe(false)

      if (!primera.cuerpo.ok || !segunda.cuerpo.ok) {
        throw new Error('el alta respondio error')
      }
      // La MISMA orden, no una copia: es lo unico que evita la segunda maniobra.
      expect(segunda.cuerpo.data.id).toBe(primera.cuerpo.data.id)
      expect(primera.cuerpo.data.externalOrderId).toBe('1234')

      const ordenes = await agente.orquestador.repositorios.ordenes.listar({ siteId: SITE_ID })
      expect(ordenes).toHaveLength(1)
    } finally {
      await agente.detener()
    }
  })

  it('el id en texto y el id numerico son el mismo pedido', async () => {
    const agente = await levantarAgente()

    try {
      const numerico = await altaDeOrden(agente, { id: 77, locationCode: ORIGEN })
      const texto = await altaDeOrden(agente, { id: '77', locationCode: ORIGEN })

      expect(numerico.status).toBe(202)
      expect(texto.status).toBe(200)

      const ordenes = await agente.orquestador.repositorios.ordenes.listar({ siteId: SITE_ID })
      expect(ordenes).toHaveLength(1)
      expect(ordenes[0]?.externalOrderId).toBe('77')
    } finally {
      await agente.detener()
    }
  })

  it('un id que no es entero se rechaza con 400, como el legacy', async () => {
    const agente = await levantarAgente()

    try {
      const respuesta = await altaDeOrden(agente, { id: 'no-soy-un-numero', locationCode: ORIGEN })

      expect(respuesta.status).toBe(400)
      expect(respuesta.cuerpo.ok).toBe(false)
      if (!respuesta.cuerpo.ok) {
        expect(respuesta.cuerpo.error).toContain('id debe ser numerico entero')
      }

      const ordenes = await agente.orquestador.repositorios.ordenes.listar({ siteId: SITE_ID })
      expect(ordenes).toHaveLength(0)
    } finally {
      await agente.detener()
    }
  })

  it('sin id, la orden local conserva su externalOrderId prefijado (RF35)', async () => {
    const agente = await levantarAgente()

    try {
      const respuesta = await altaDeOrden(agente, { locationCode: ORIGEN })
      expect(respuesta.status).toBe(202)
      if (!respuesta.cuerpo.ok) {
        throw new Error('el alta respondio error')
      }

      expect(respuesta.cuerpo.data.externalOrderId.startsWith(`local-${AGENT_ID}-`)).toBe(true)
    } finally {
      await agente.detener()
    }
  })
})
