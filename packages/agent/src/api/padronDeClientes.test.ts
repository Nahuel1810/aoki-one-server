// RF22 — El padron de clientes de la API local.
//
// La API del agente no tiene login: el control es de red. Esto responde la
// pregunta que eso deja abierta —QUIEN esta llamando— y permite cortarle el
// acceso a uno puntual.
//
// Las dos decisiones que estos tests fijan, y que no son intercambiables:
//
//  1. EL DEFAULT ES PERMITIDO. Un padron que exige habilitar antes de dejar
//     pasar deja al robot parado la primera vez que la tablet cambia de IP, y
//     con el robot parado nadie va a estar leyendo documentacion. Se registra
//     todo, se deja pasar, y quien opera banea lo que no reconoce.
//  2. EL BANEO EXIGE CREDENCIAL. No por simetria con el listado: sin ella, quien
//     quiera parar la planta solo tiene que banear la IP de la tablet. La
//     credencial esta para que esta herramienta no sea un interruptor del robot.

import { describe, expect, it } from 'vitest'

import { crearAgente, type Agente, type OpcionesDelAgente } from '../composition.js'
import { HEADER_DE_MANTENIMIENTO, type CuerpoDeRespuesta } from './httpServer.js'

const TOKEN = 'token-de-prueba'

const BASE: OpcionesDelAgente = {
  siteId: 'SUC-TEST',
  agentId: 'AG-TEST',
  rutaDeBase: ':memory:',
  montarApi: true,
  simularPlc: true,
  httpPuerto: 0,
  httpBind: '127.0.0.1',
  zonaDePickeo: [],
  tokenDeMantenimiento: TOKEN,
  enlace: null,
}

interface Cliente {
  readonly ip: string
  readonly calls: number
  readonly status: string
  readonly reason: string | null
  readonly firstSeen: number
  readonly lastSeen: number
}

async function levantar(opciones: OpcionesDelAgente = BASE): Promise<{
  agente: Agente
  base: string
}> {
  const agente = crearAgente(opciones)
  await agente.iniciar()
  const direccion = agente.direccion()
  if (direccion === null) {
    throw new Error('el agente no monto la API')
  }
  return { agente, base: `http://${direccion.host}:${String(direccion.puerto)}` }
}

async function listar(base: string): Promise<readonly Cliente[]> {
  const respuesta = await fetch(`${base}/api/clients`)
  const cuerpo = (await respuesta.json()) as CuerpoDeRespuesta<readonly Cliente[]>
  if (!cuerpo.ok) {
    throw new Error(cuerpo.error)
  }
  return cuerpo.data
}

function banear(base: string, ip: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${base}/api/clients/${ip}/ban`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ motivo: 'no lo reconozco' }),
  })
}

describe('padron de clientes de la API local', () => {
  it('un cliente que nunca se vio ENTRA, y queda anotado', async () => {
    const { agente, base } = await levantar()

    try {
      // Sin haberlo habilitado antes: pasa. Es la decision 1.
      expect((await fetch(`${base}/api/slots`)).status).toBe(200)

      const clientes = await listar(base)
      expect(clientes).toHaveLength(1)
      expect(clientes[0]?.ip).toBe('127.0.0.1')
      expect(clientes[0]?.status).toBe('PERMITIDO')
    } finally {
      await agente.detener()
    }
  })

  it('cuenta las llamadas y mueve el ultimo visto', async () => {
    const { agente, base } = await levantar()

    try {
      await fetch(`${base}/api/slots`)
      await fetch(`${base}/api/orders`)
      const clientes = await listar(base)

      // Tres: las dos de arriba mas el propio listado.
      expect(clientes[0]?.calls).toBe(3)
      expect(clientes[0]?.lastSeen).toBeGreaterThanOrEqual(clientes[0]?.firstSeen ?? 0)
    } finally {
      await agente.detener()
    }
  })

  it('baneado: 403 en toda la API, pero /health sigue contestando', async () => {
    const { agente, base } = await levantar()

    try {
      await fetch(`${base}/api/slots`)

      // El baneo se aplica POR EL REPOSITORIO y no por el endpoint: el endpoint
      // no deja banear loopback (ver el test de abajo) y en la suite todas las
      // requests salen de ahi. Lo que se afirma aca es la APLICACION del baneo,
      // que es del middleware; que no se pueda banear loopback a mano es otra
      // regla y tiene su propio test.
      agente.orquestador.repositorios.clientes.banear('127.0.0.1', 1000, 'prueba')

      const cortado = await fetch(`${base}/api/slots`)
      expect(cortado.status).toBe(403)
      const cuerpo = (await cortado.json()) as CuerpoDeRespuesta<never>
      expect(cuerpo.ok).toBe(false)

      // Ni siquiera las rutas de lectura: un baneo es un corte, no un modo lectura.
      expect((await fetch(`${base}/api/orders`)).status).toBe(403)
      expect((await fetch(`${base}/api/clients`)).status).toBe(403)

      // /health NO: es la sonda de vida, no da ningun control, y un baneo no
      // tiene por que apagar el monitoreo de la sucursal.
      expect((await fetch(`${base}/health`)).status).toBe(200)

      // Y el desbaneo lo devuelve.
      agente.orquestador.repositorios.clientes.desbanear('127.0.0.1')
      expect((await fetch(`${base}/api/slots`)).status).toBe(200)
    } finally {
      await agente.detener()
    }
  })

  it('no se puede banear loopback: es desde donde se administra el agente', async () => {
    // Si se pudiera, un baneo con la IP equivocada dejaria sin acceso a la propia
    // notebook —incluido el endpoint de desbaneo— y la unica salida seria editar
    // SQLite a mano.
    const { agente, base } = await levantar()

    try {
      await fetch(`${base}/api/slots`)
      const respuesta = await banear(base, '127.0.0.1', { [HEADER_DE_MANTENIMIENTO]: TOKEN })
      expect(respuesta.status).toBe(400)

      // Y siguio pasando: el rechazo no lo dejo a medias.
      expect((await fetch(`${base}/api/slots`)).status).toBe(200)
    } finally {
      await agente.detener()
    }
  })

  it('el baneo exige credencial: sin ella no se puede usar como interruptor del robot', async () => {
    const { agente, base } = await levantar()

    try {
      await fetch(`${base}/api/slots`)

      expect((await banear(base, '10.0.0.9', {})).status).toBe(401)
      expect((await banear(base, '10.0.0.9', { [HEADER_DE_MANTENIMIENTO]: 'otro' })).status).toBe(
        401,
      )

      // Y el desbaneo tambien: si no, alcanzaria con desbanear para deshacer un
      // corte legitimo.
      const desbaneo = await fetch(`${base}/api/clients/10.0.0.9/unban`, { method: 'POST' })
      expect(desbaneo.status).toBe(401)
    } finally {
      await agente.detener()
    }
  })

  it('el listado NO exige credencial: es lo que se mira cuando se sospecha algo', async () => {
    const { agente, base } = await levantar()

    try {
      const respuesta = await fetch(`${base}/api/clients`)
      expect(respuesta.status).toBe(200)
    } finally {
      await agente.detener()
    }
  })

  it('banear una IP que nunca llamo es 404, no un baneo fantasma', async () => {
    const { agente, base } = await levantar()

    try {
      const respuesta = await banear(base, '10.0.0.77', { [HEADER_DE_MANTENIMIENTO]: TOKEN })
      expect(respuesta.status).toBe(404)
    } finally {
      await agente.detener()
    }
  })

  it('sin token configurado no se puede banear a nadie', async () => {
    // Falla del lado que no frena la planta: sin credencial configurada, la
    // herramienta que podria dejar a la tablet afuera queda deshabilitada.
    const { agente, base } = await levantar({ ...BASE, tokenDeMantenimiento: null })

    try {
      await fetch(`${base}/api/slots`)
      const respuesta = await banear(base, '10.0.0.9', {})
      expect(respuesta.status).toBe(503)
    } finally {
      await agente.detener()
    }
  })

  it('X-Forwarded-For no cambia quien sos', async () => {
    // Si el padron leyera ese header, esquivar un baneo seria mandar otra IP: lo
    // escribe quien llama. La identidad sale del socket.
    const { agente, base } = await levantar()

    try {
      await fetch(`${base}/api/slots`, { headers: { 'X-Forwarded-For': '1.2.3.4' } })

      const clientes = await listar(base)
      expect(clientes.map((cliente) => cliente.ip)).toEqual(['127.0.0.1'])
    } finally {
      await agente.detener()
    }
  })
})
