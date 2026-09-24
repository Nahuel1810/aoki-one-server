// RF22, segundo nivel: el token de mantenimiento.
//
// Cubre las DOS operaciones que deciden que hace el robot:
//
//   - el comando directo a PLC, que escribe registros salteandose el orquestador
//     y las maquinas de estado;
//   - el ALTA DE DISPOSITIVO, que dice por que host, puerto y unitId se le habla
//     al PLC. Sin credencial, cualquiera que llegue al puerto del agente reapunta
//     el Modbus del robot a una maquina suya y a partir de ahi el robot le
//     obedece a otro. Escribe un solo registro de la base, pero decide TODOS los
//     que se escriben despues.
//
// Las dos fallan CERRADO: sin token configurado no hay forma de habilitarlas, ni
// siquiera acertandole al header. Mismo criterio que RF20 con la simulacion —
// arrancar sin configurar no puede habilitar algo peligroso en silencio.
//
// El resto de la API sigue SIN credencial y eso tambien se afirma aca: el
// operario tiene que poder trabajar sin un secreto cargado en la tablet.

import { describe, expect, it } from 'vitest'

import { crearAgente, type Agente, type OpcionesDelAgente } from '../composition.js'
import { HEADER_DE_MANTENIMIENTO } from './httpServer.js'

const TOKEN = 'token-de-prueba'

const BASE: OpcionesDelAgente = {
  siteId: 'SUC-TEST',
  agentId: 'AG-TEST',
  rutaDeBase: ':memory:',
  montarApi: true,
  simularPlc: true,
  // Puerto 0: lo asigna el sistema. Uno fijo es EADDRINUSE en CI.
  httpPuerto: 0,
  httpBind: '127.0.0.1',
  zonaDePickeo: [],
  tokenDeMantenimiento: null,
  // RF36/T26: el enlace con el servidor va APAGADO. Estos fixtures ejercitan el
  // agente solo con su cola local, que es como arranca en el cutover.
  enlace: null,
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

function altaDeCarro(agente: Agente, headers: Record<string, string>): Promise<Response> {
  return fetch(urlDe(agente, '/api/devices/register'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ robotId: '1', type: 'CARRO', host: '127.0.0.1', port: 502 }),
  })
}

async function registrarCarro(agente: Agente): Promise<void> {
  const respuesta = await altaDeCarro(agente, { [HEADER_DE_MANTENIMIENTO]: TOKEN })
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
      // Setup por el repositorio: este agente no tiene token, asi que el alta por
      // HTTP tampoco estaria disponible — y lo que se afirma aca es el COMANDO.
      await agente.orquestador.repositorios.dispositivos.registrar({
        robotId: '1',
        tipo: 'CARRO',
        host: '127.0.0.1',
        puerto: 502,
        unitId: 1,
        timeoutMsDeSocket: 2000,
      })

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

  it('el alta de dispositivo exige el token: sin el no se reapunta el PLC', async () => {
    const agente = await levantar({ ...BASE, tokenDeMantenimiento: TOKEN })

    try {
      expect((await altaDeCarro(agente, {})).status).toBe(401)
      expect((await altaDeCarro(agente, { [HEADER_DE_MANTENIMIENTO]: 'otro' })).status).toBe(401)

      // Y el rechazo es ANTES de tocar la base: el dispositivo no quedo dado de alta.
      const dispositivo = await agente.orquestador.repositorios.dispositivos.buscar('1', 'CARRO')
      expect(dispositivo).toBeUndefined()

      expect((await altaDeCarro(agente, { [HEADER_DE_MANTENIMIENTO]: TOKEN })).status).toBe(201)
    } finally {
      await agente.detener()
    }
  })

  it('sin token configurado el alta tampoco se abre, igual que el comando', async () => {
    const agente = await levantar(BASE)

    try {
      expect((await altaDeCarro(agente, {})).status).toBe(503)
      expect((await altaDeCarro(agente, { [HEADER_DE_MANTENIMIENTO]: 'lo-que-sea' })).status).toBe(
        503,
      )
    } finally {
      await agente.detener()
    }
  })

  it('el resto de la API no pide token: la tablet trabaja sin credencial', async () => {
    const agente = await levantar({ ...BASE, tokenDeMantenimiento: TOKEN })

    try {
      // El primer nivel de RF22 es de red (bind a la LAN), no de credencial.
      // Estas son las rutas que usa la tablet en la jornada y NINGUNA lleva header.
      expect((await fetch(urlDe(agente, '/health'))).status).toBe(200)
      expect((await fetch(urlDe(agente, '/api/orders'))).status).toBe(200)
      expect((await fetch(urlDe(agente, '/api/slots'))).status).toBe(200)
      expect((await fetch(urlDe(agente, '/api/orders/queue/status'))).status).toBe(200)
      expect((await fetch(urlDe(agente, '/api/devices'))).status).toBe(200)

      // La lectura de estado del dispositivo tampoco: no escribe nada.
      await registrarCarro(agente)
      expect((await fetch(urlDe(agente, '/api/devices/1/carro/state'))).status).toBe(200)
    } finally {
      await agente.detener()
    }
  })
})
