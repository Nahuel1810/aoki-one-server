// RF16, RF17 y RF23 — El mapa de registros es configuracion POR DISPOSITIVO.
//
// El legacy lo tiene en `src/config/deviceRegisterMaps.js` (default 0/0) mas el
// `registerMap` del alta (`POST /api/devices/register`), y lo resuelve en cada
// operacion con `mergeRegisterMaps`. En el rewrite habia quedado cableado en
// `{ messageIn: 0, messageOut: 0 }` y el campo del alta desaparecio.
//
// Por que es un bug y no una simplificacion: un dispositivo de planta que no usa
// el registro 0 NO falla. El agente le escribe el comando a otra direccion del
// PLC —un registro que hace otra cosa, o ninguna— y el sintoma es "el robot no
// se mueve" o, peor, "el robot hizo algo raro".
//
// El test va contra el cliente Modbus, que es donde se ve la direccion real: un
// doble del puerto de transporte no puede afirmar esto, porque la direccion se
// resuelve justo del otro lado del puerto.

import { describe, expect, it } from 'vitest'

import { LOGGER_SILENCIOSO } from '@aoki-one/domain'

import { crearAgente, type Agente } from '../composition.js'
import { claveDeDispositivo } from '../transport/modbusClient.js'
import type {
  ClaveDeDispositivo,
  DispositivoRegistrado,
  ModbusClient,
  RegistroDeClientes,
} from '../transport/modbusClient.js'
import { HEADER_DE_MANTENIMIENTO, type CuerpoDeRespuesta } from './httpServer.js'

const SITE_ID = 'SUC-REGISTROS'
const ROBOT_ID = '1'
const TOKEN = 'token-de-prueba'

/** Las direcciones del dispositivo de planta que NO usa el registro 0. */
const MESSAGE_IN = 10
const MESSAGE_OUT = 20

/** 30201: el carro lo escribe partido, 3 en messageIn y 201 en messageIn + 1. */
const COMANDO_DE_CARRO = 30201

interface Escritura {
  readonly direccion: number
  readonly valor: number
}

interface ClienteEspia extends ModbusClient {
  readonly escrituras: Escritura[]
  readonly lecturasDeEntrada: number[]
}

/**
 * Cliente que contesta 100 (OK) la primera lectura de `messageOut` y 0 despues,
 * que es la secuencia real: el PLC confirma y despues limpia.
 */
function crearClienteEspia(): ClienteEspia {
  const escrituras: Escritura[] = []
  const lecturasDeEntrada: number[] = []
  let confirmado = false

  return {
    escrituras,
    lecturasDeEntrada,
    conectar: () => Promise.resolve(),
    desconectar: () => Promise.resolve(),
    estaConectado: () => true,
    marcarDesconectado: () => undefined,
    leerRegistrosDeRetencion: (_direccion, cantidad) =>
      Promise.resolve(new Array<number>(cantidad).fill(0)),
    leerRegistrosDeEntrada: (direccion) => {
      lecturasDeEntrada.push(direccion)
      if (!confirmado) {
        confirmado = true
        return Promise.resolve([100])
      }
      return Promise.resolve([0])
    },
    escribirRegistro: (direccion, valor) => {
      escrituras.push({ direccion, valor })
      return Promise.resolve()
    },
  }
}

function crearRegistroEspia(): {
  readonly registro: RegistroDeClientes
  readonly clientes: Map<ClaveDeDispositivo, ClienteEspia>
} {
  const clientes = new Map<ClaveDeDispositivo, ClienteEspia>()

  function asegurar(dispositivo: DispositivoRegistrado): ClienteEspia {
    const clave = claveDeDispositivo(dispositivo.robotId, dispositivo.tipo)
    const existente = clientes.get(clave)
    if (existente !== undefined) {
      return existente
    }
    const creado = crearClienteEspia()
    clientes.set(clave, creado)
    return creado
  }

  return {
    clientes,
    registro: {
      obtener: (clave) => clientes.get(clave),
      asegurar,
      recrear: (dispositivo) => Promise.resolve(asegurar(dispositivo)),
      cerrarTodos: () => {
        clientes.clear()
        return Promise.resolve()
      },
    },
  }
}

async function levantarAgente(registroDeClientes: RegistroDeClientes): Promise<Agente> {
  const agente = crearAgente({
    siteId: SITE_ID,
    agentId: 'AG-REGISTROS',
    rutaDeBase: ':memory:',
    montarApi: true,
    // En vivo: en simulacion nadie toca un registro y no habria direccion que mirar.
    simularPlc: false,
    httpPuerto: 0,
    httpBind: '127.0.0.1',
    zonaDePickeo: [],
    tokenDeMantenimiento: TOKEN,
    enlace: null,
    logger: LOGGER_SILENCIOSO,
    registroDeClientes,
    // El monitor no tiene que correr durante el test: su ciclo toca los mismos
    // clientes y ensuciaria las lecturas que se afirman.
    intervaloDeMonitoreoMs: 60_000,
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
  return agente
}

function urlDe(agente: Agente, ruta: string): string {
  const direccion = agente.direccion()
  if (direccion === null) {
    throw new Error('el agente no monto la API')
  }
  return `http://${direccion.host}:${String(direccion.puerto)}${ruta}`
}

  // El alta de dispositivo exige el token de mantenimiento: decide por que host y
  // puerto se le habla al PLC. Va en el helper para que lo que estos tests afirman
  // siga siendo la VALIDACION del cuerpo y no la autorizacion.
function registrarDispositivo(agente: Agente, body: unknown): Promise<Response> {
  return fetch(urlDe(agente, '/api/devices/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', [HEADER_DE_MANTENIMIENTO]: TOKEN },
    body: JSON.stringify(body),
  })
}

describe('mapa de registros por dispositivo', () => {
  it('el alta lo acepta, lo persiste y lo devuelve', async () => {
    const espia = crearRegistroEspia()
    const agente = await levantarAgente(espia.registro)

    try {
      const respuesta = await registrarDispositivo(agente, {
        robotId: ROBOT_ID,
        type: 'CARRO',
        host: '127.0.0.1',
        port: 502,
        registerMap: { messageIn: MESSAGE_IN, messageOut: MESSAGE_OUT },
      })
      expect(respuesta.status).toBe(201)

      const cuerpo = (await respuesta.json()) as CuerpoDeRespuesta<{
        readonly registerMap: { readonly messageIn: number; readonly messageOut: number }
      }>
      expect(cuerpo.ok).toBe(true)
      if (cuerpo.ok) {
        expect(cuerpo.data.registerMap).toEqual({ messageIn: MESSAGE_IN, messageOut: MESSAGE_OUT })
      }

      const guardado = await agente.orquestador.repositorios.dispositivos.buscar(ROBOT_ID, 'CARRO')
      expect(guardado?.mapaDeRegistros).toEqual({
        messageIn: MESSAGE_IN,
        messageOut: MESSAGE_OUT,
      })
    } finally {
      await agente.detener()
    }
  })

  it('el dispositivo sin registerMap queda en el default del legacy: 0 y 0', async () => {
    const espia = crearRegistroEspia()
    const agente = await levantarAgente(espia.registro)

    try {
      const respuesta = await registrarDispositivo(agente, {
        robotId: ROBOT_ID,
        type: 'ELEVADOR',
        host: '127.0.0.1',
      })
      expect(respuesta.status).toBe(201)

      const guardado = await agente.orquestador.repositorios.dispositivos.buscar(
        ROBOT_ID,
        'ELEVADOR',
      )
      expect(guardado?.mapaDeRegistros).toEqual({ messageIn: 0, messageOut: 0 })
    } finally {
      await agente.detener()
    }
  })

  it('rechaza una direccion que no existe en Modbus', async () => {
    const espia = crearRegistroEspia()
    const agente = await levantarAgente(espia.registro)

    try {
      const respuesta = await registrarDispositivo(agente, {
        robotId: ROBOT_ID,
        type: 'CARRO',
        host: '127.0.0.1',
        registerMap: { messageIn: -1 },
      })
      expect(respuesta.status).toBe(400)

      const guardado = await agente.orquestador.repositorios.dispositivos.buscar(ROBOT_ID, 'CARRO')
      expect(guardado).toBeUndefined()
    } finally {
      await agente.detener()
    }
  })

  it('el comando sale por las direcciones configuradas, no por la 0', async () => {
    const espia = crearRegistroEspia()
    const agente = await levantarAgente(espia.registro)

    try {
      await registrarDispositivo(agente, {
        robotId: ROBOT_ID,
        type: 'CARRO',
        host: '127.0.0.1',
        registerMap: { messageIn: MESSAGE_IN, messageOut: MESSAGE_OUT },
      })

      const respuesta = await fetch(urlDe(agente, `/api/devices/${ROBOT_ID}/carro/command`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', [HEADER_DE_MANTENIMIENTO]: TOKEN },
        body: JSON.stringify({ value: COMANDO_DE_CARRO }),
      })
      expect(respuesta.status).toBe(200)

      const cliente = espia.clientes.get(claveDeDispositivo(ROBOT_ID, 'CARRO'))
      expect(cliente).toBeDefined()

      // 30201 partido: 3 en messageIn, 201 en messageIn + 1. Y despues el reset
      // de los dos, que es lo que cierra el paso (RF17).
      expect(cliente?.escrituras).toEqual([
        { direccion: MESSAGE_IN, valor: 3 },
        { direccion: MESSAGE_IN + 1, valor: 201 },
        { direccion: MESSAGE_IN, valor: 0 },
        { direccion: MESSAGE_IN + 1, valor: 0 },
      ])

      // messageOut se pollea en SU direccion, no en la 0.
      expect(cliente?.lecturasDeEntrada).toEqual([MESSAGE_OUT, MESSAGE_OUT])
    } finally {
      await agente.detener()
    }
  })
})
