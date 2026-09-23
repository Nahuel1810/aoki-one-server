// RF22 / RNF de Seguridad: validacion de entrada por esquema en todos los endpoints.
//
// Lo que se gana no es "rechazar basura": es que el motivo llegue al operario. El
// legacy deja pasar el body crudo hasta el orquestador, donde un locationCode
// vacio revienta con un mensaje que habla de internals. Aca sale un 400 que dice
// que campo esta mal.

import { describe, expect, it } from 'vitest'

import { crearAgente, type Agente, type OpcionesDelAgente } from '../composition.js'
import type { CuerpoDeRespuesta } from './httpServer.js'

const OPCIONES: OpcionesDelAgente = {
  siteId: 'SUC-TEST',
  rutaDeBase: ':memory:',
  montarApi: true,
  simularPlc: true,
  httpPuerto: 0,
  httpBind: '127.0.0.1',
  zonaDePickeo: ['3X02AE1'],
  tokenDeMantenimiento: null,
}

async function levantar(): Promise<Agente> {
  const agente = crearAgente(OPCIONES)
  await agente.iniciar()
  await agente.orquestador.repositorios.robots.guardar({
    id: '1',
    siteId: 'SUC-TEST',
    estanteriaCode: '3X',
    habilitado: true,
    estado: 'IDLE',
    ordenActivaId: null,
  })
  return agente
}

function urlDe(agente: Agente, ruta: string): string {
  const direccion = agente.direccion()
  if (direccion === null) {
    throw new Error('el agente no monto la API')
  }
  return `http://${direccion.host}:${String(direccion.puerto)}${ruta}`
}

async function postear(
  agente: Agente,
  ruta: string,
  cuerpo: unknown,
): Promise<{ status: number; error: string }> {
  const respuesta = await fetch(urlDe(agente, ruta), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  })
  const leido = (await respuesta.json()) as CuerpoDeRespuesta<unknown>
  return { status: respuesta.status, error: leido.ok ? '' : leido.error }
}

describe('validacion de entrada por esquema', () => {
  it('rechaza el alta de orden sin locationCode y dice cual es el campo', async () => {
    const agente = await levantar()

    try {
      const { status, error } = await postear(agente, '/api/orders', { type: 'PICK' })
      expect(status).toBe(400)
      expect(error).toMatch(/locationCode/)
    } finally {
      await agente.detener()
    }
  })

  it('rechaza un type que no es PICK ni PUT', async () => {
    const agente = await levantar()

    try {
      const { status, error } = await postear(agente, '/api/orders', {
        type: 'VOLAR',
        locationCode: '3X04AE1',
      })
      expect(status).toBe(400)
      expect(error).toMatch(/PICK|PUT/)
    } finally {
      await agente.detener()
    }
  })

  it('el siteId del body se ignora: sale de la configuracion del agente', async () => {
    const agente = await levantar()

    try {
      const respuesta = await fetch(urlDe(agente, '/api/orders'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'PICK', locationCode: '3X04AE1', siteId: 'OTRA-SUCURSAL' }),
      })
      expect(respuesta.status).toBe(202)

      const persistidas = await agente.orquestador.repositorios.ordenes.listar({})
      expect(persistidas[0]?.siteId).toBe('SUC-TEST')
    } finally {
      await agente.detener()
    }
  })

  it('rechaza el alta de dispositivo con puerto fuera de rango', async () => {
    const agente = await levantar()

    try {
      const { status, error } = await postear(agente, '/api/devices/register', {
        robotId: '1',
        type: 'CARRO',
        host: '127.0.0.1',
        port: 99999,
      })
      expect(status).toBe(400)
      expect(error).toMatch(/port/)
    } finally {
      await agente.detener()
    }
  })

  it('rechaza el alta de dispositivo con un tipo que no existe', async () => {
    const agente = await levantar()

    try {
      const { status } = await postear(agente, '/api/devices/register', {
        robotId: '1',
        type: 'GRUA',
        host: '127.0.0.1',
      })
      expect(status).toBe(400)
    } finally {
      await agente.detener()
    }
  })

  it('rechaza la simulacion sin locationCode', async () => {
    const agente = await levantar()

    try {
      const { status, error } = await postear(agente, '/api/orders/simulate', {})
      expect(status).toBe(400)
      expect(error).toMatch(/locationCode/)
    } finally {
      await agente.detener()
    }
  })

  it('rechaza un rango de reporte con endDate anterior a startDate', async () => {
    const agente = await levantar()

    try {
      const respuesta = await fetch(
        urlDe(agente, '/api/orders/metrics/report?startDate=2000&endDate=1000'),
      )
      const leido = (await respuesta.json()) as CuerpoDeRespuesta<unknown>
      expect(respuesta.status).toBe(400)
      expect(leido.ok ? '' : leido.error).toMatch(/endDate/)
    } finally {
      await agente.detener()
    }
  })
})
