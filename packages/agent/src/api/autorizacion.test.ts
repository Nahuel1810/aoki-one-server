// RF22, segundo nivel: el token de mantenimiento del comando directo a PLC.
//
// Es el unico endpoint que escribe registros salteandose el orquestador y las
// maquinas de estado, asi que falla CERRADO: sin token configurado no hay forma
// de habilitarlo, ni siquiera acertandole al header. Mismo criterio que RF20 con
// la simulacion — arrancar sin configurar no puede habilitar algo peligroso en
// silencio.

import { describe, expect, it } from 'vitest'

import { crearAgente, type Agente, type OpcionesDelAgente } from '../composition.js'
import { HEADER_DE_MANTENIMIENTO } from './httpServer.js'

const TOKEN = 'token-de-prueba'

const BASE: OpcionesDelAgente = {
  siteId: 'SUC-TEST',
  rutaDeBase: ':memory:',
  montarApi: true,
  simularPlc: true,
  // Puerto 0: lo asigna el sistema. Uno fijo es EADDRINUSE en CI.
  httpPuerto: 0,
  httpBind: '127.0.0.1',
  zonaDePickeo: [],
  tokenDeMantenimiento: null,
}

async function levantar(opciones: OpcionesDelAgente): Promise<Agente> {
  const agente = crearAgente(opciones)
  await agente.iniciar()
  return agente
}

function urlDe(agente: Agente, ruta: string): string {
  const direccion = agente.direccion()
  if (direccion === null) {
    throw new Error('el agente no monto la API')
  }
  return `http://${direccion.host}:${String(direccion.puerto)}${ruta}`
}

async function registrarCarro(agente: Agente): Promise<void> {
  const respuesta = await fetch(urlDe(agente, '/api/devices/register'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ robotId: '1', type: 'CARRO', host: '127.0.0.1', port: 502 }),
  })
  expect(respuesta.status).toBe(201)
}

function comando(agente: Agente, headers: Record<string, string>): Promise<Response> {
  return fetch(urlDe(agente, '/api/devices/1/carro/command'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ value: 10201 }),
  })
}

describe('token de mantenimiento del comando directo a PLC (RF22)', () => {
  it('sin token configurado el endpoint esta deshabilitado, no abierto', async () => {
    const agente = await levantar(BASE)

    try {
      await registrarCarro(agente)

      const respuesta = await comando(agente, {})
      // 503 y no 401: no es que falte la credencial, es que la capacidad no esta
      // habilitada en este agente.
      expect(respuesta.status).toBe(503)

      // Y tampoco se abre acertandole al header: no hay token contra el cual comparar.
      const conHeader = await comando(agente, { [HEADER_DE_MANTENIMIENTO]: 'lo-que-sea' })
      expect(conHeader.status).toBe(503)
    } finally {
      await agente.detener()
    }
  })

  it('con token configurado rechaza el pedido sin credencial', async () => {
    const agente = await levantar({ ...BASE, tokenDeMantenimiento: TOKEN })

    try {
      await registrarCarro(agente)
      expect((await comando(agente, {})).status).toBe(401)
    } finally {
      await agente.detener()
    }
  })

  it('con token configurado rechaza un token equivocado', async () => {
    const agente = await levantar({ ...BASE, tokenDeMantenimiento: TOKEN })

    try {
      await registrarCarro(agente)
      expect((await comando(agente, { [HEADER_DE_MANTENIMIENTO]: 'otro' })).status).toBe(401)
    } finally {
      await agente.detener()
    }
  })

  it('con el token correcto ejecuta el comando', async () => {
    const agente = await levantar({ ...BASE, tokenDeMantenimiento: TOKEN })

    try {
      await registrarCarro(agente)
      const respuesta = await comando(agente, { [HEADER_DE_MANTENIMIENTO]: TOKEN })
      expect(respuesta.status).toBe(200)
    } finally {
      await agente.detener()
    }
  })

  it('el resto de la API no pide token: la tablet trabaja sin credencial', async () => {
    const agente = await levantar(BASE)

    try {
      // El primer nivel de RF22 es de red (bind a la LAN), no de credencial.
      expect((await fetch(urlDe(agente, '/health'))).status).toBe(200)
      expect((await fetch(urlDe(agente, '/api/orders'))).status).toBe(200)
      expect((await fetch(urlDe(agente, '/api/slots'))).status).toBe(200)

      // La lectura de estado del dispositivo tampoco: no escribe nada.
      await registrarCarro(agente)
      expect((await fetch(urlDe(agente, '/api/devices/1/carro/state'))).status).toBe(200)
    } finally {
      await agente.detener()
    }
  })
})
