// RF22 (nivel mantenimiento) y RF17 — El comando directo a PLC.
//
// DOS DEFECTOS QUE ESTE TEST FIJA:
//
// 1. Se perdio `expectedResponses` del body. El legacy lo lee
//    (`devicesRoutes.js`: `Array.isArray(body.expectedResponses) ? ... :
//    [body.expectedResponse ?? 100]`) y sin el, mover el ELEVADOR a mano —que
//    contesta `2##`, el nivel, y nunca 100— se come los 90 s enteros del
//    presupuesto de ack y termina en 502.
// 2. Ante una respuesta de error el endpoint dejaba `messageIn` ESCRITO. El
//    comando ya se mando: el registro queda con el valor puesto a mano y el
//    proximo paso real arranca con un comando colgado que el PLC puede tomar.
//
// El transporte va inyectado: es la unica forma de ver QUE pedido le llego y si
// alguien limpio despues. El modo simulacion contesta OK siempre y no deja
// afirmar ninguna de las dos cosas.

import { describe, expect, it } from 'vitest'

import { LOGGER_SILENCIOSO, type TipoDispositivo } from '@aoki-one/domain'

import { crearAgente, type Agente } from '../composition.js'
import { HEADER_DE_MANTENIMIENTO, type CuerpoDeRespuesta } from './httpServer.js'
import type { PedidoDeComando, RespuestaEsperada } from '../transport/stepHandshake.js'
import type { PuertoDeTransporteConcreto } from '../transport/transportePort.js'

const SITE_ID = 'SUC-DIRECTO'
const ROBOT_ID = '1'
const TOKEN = 'token-de-prueba'

/** Comando de carro de planta: 3 y 201 partido en dos registros. */
const COMANDO_DE_CARRO = 30201

interface PlcEspia {
  readonly pedidos: PedidoDeComando[]
  readonly resets: { robotId: string; dispositivo: TipoDispositivo | undefined }[]
  /** Cambia en caliente: con `false` el comando vuelve con un error del PLC. */
  responderOk: boolean
  readonly puerto: PuertoDeTransporteConcreto
}

function crearPlcEspia(): PlcEspia {
  const espia: PlcEspia = {
    pedidos: [],
    resets: [],
    responderOk: true,
    puerto: {
      ejecutarComandoDePaso: (_robotId: string, _tipo: TipoDispositivo, pedido) => {
        espia.pedidos.push(pedido)
        if (espia.responderOk) {
          return Promise.resolve({ ok: true, valor: { kind: 'OK' } })
        }
        // Codigo 12 del protocolo: un error del PLC, no fatal.
        return Promise.resolve({
          ok: false,
          error: { tipo: 'PLC_ERROR', codigoError: 12, mensaje: 'error de planta', fatal: false },
        })
      },
      resetearMessageIn: (robotId: string, dispositivo?: TipoDispositivo) => {
        espia.resets.push({ robotId, dispositivo })
        return Promise.resolve({ ok: true, valor: undefined })
      },
      leerRegistros: () =>
        Promise.resolve({ ok: true, valor: { messageIn1: 0, messageIn2: null, messageOut: 0 } }),
      cerrar: () => Promise.resolve(),
    },
  }
  return espia
}

async function levantarAgente(plc: PlcEspia): Promise<Agente> {
  const agente = crearAgente({
    siteId: SITE_ID,
    agentId: 'AG-DIRECTO',
    rutaDeBase: ':memory:',
    montarApi: true,
    // RF20: en vivo. La simulacion contestaria OK sin pasar por el transporte.
    simularPlc: false,
    httpPuerto: 0,
    httpBind: '127.0.0.1',
    zonaDePickeo: [],
    tokenDeMantenimiento: TOKEN,
    enlace: null,
    logger: LOGGER_SILENCIOSO,
    transporte: plc.puerto,
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

function comandar(agente: Agente, dispositivo: string, body: unknown): Promise<Response> {
  return fetch(urlDe(agente, `/api/devices/${ROBOT_ID}/${dispositivo}/command`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', [HEADER_DE_MANTENIMIENTO]: TOKEN },
    body: JSON.stringify(body),
  })
}

describe('comando directo a PLC', () => {
  it('manda al transporte las expectedResponses del body', async () => {
    const plc = crearPlcEspia()
    const agente = await levantarAgente(plc)

    try {
      const respuesta = await comandar(agente, 'elevador', {
        value: 205,
        expectedResponses: ['2##'],
      })
      expect(respuesta.status).toBe(200)

      expect(plc.pedidos).toHaveLength(1)
      expect(plc.pedidos[0]).toEqual({ comando: 205, respuestasEsperadas: ['2##'] })

      // La respuesta las repite: quien diagnostica tiene que poder ver con que
      // criterio se dio por cerrado el comando.
      const cuerpo = (await respuesta.json()) as CuerpoDeRespuesta<{
        readonly expectedResponses: readonly RespuestaEsperada[]
      }>
      expect(cuerpo.ok).toBe(true)
      if (cuerpo.ok) {
        expect(cuerpo.data.expectedResponses).toEqual(['2##'])
      }
    } finally {
      await agente.detener()
    }
  })

  it('acepta la forma singular expectedResponse del legacy', async () => {
    const plc = crearPlcEspia()
    const agente = await levantarAgente(plc)

    try {
      const respuesta = await comandar(agente, 'carro', {
        value: COMANDO_DE_CARRO,
        expectedResponse: 150,
      })
      expect(respuesta.status).toBe(200)
      expect(plc.pedidos[0]).toEqual({ comando: COMANDO_DE_CARRO, respuestasEsperadas: [150] })
    } finally {
      await agente.detener()
    }
  })

  it('sin expectedResponses usa [100, 1##]', async () => {
    const plc = crearPlcEspia()
    const agente = await levantarAgente(plc)

    try {
      await comandar(agente, 'carro', { value: COMANDO_DE_CARRO })
      expect(plc.pedidos[0]).toEqual({
        comando: COMANDO_DE_CARRO,
        respuestasEsperadas: [100, '1##'],
      })
    } finally {
      await agente.detener()
    }
  })

  it('ante un error del PLC resetea messageIn del dispositivo que toco', async () => {
    const plc = crearPlcEspia()
    plc.responderOk = false
    const agente = await levantarAgente(plc)

    try {
      const respuesta = await comandar(agente, 'carro', { value: COMANDO_DE_CARRO })
      expect(respuesta.status).toBe(502)

      // Lo que importa: el registro que este endpoint escribio quedo limpio, y
      // solo el del CARRO —el ELEVADOR no lo toco nadie—.
      expect(plc.resets).toEqual([{ robotId: ROBOT_ID, dispositivo: 'CARRO' }])
    } finally {
      await agente.detener()
    }
  })

  it('cuando el comando sale bien no resetea nada: el handshake ya lo hizo', async () => {
    const plc = crearPlcEspia()
    const agente = await levantarAgente(plc)

    try {
      await comandar(agente, 'carro', { value: COMANDO_DE_CARRO })
      expect(plc.resets).toEqual([])
    } finally {
      await agente.detener()
    }
  })
})
