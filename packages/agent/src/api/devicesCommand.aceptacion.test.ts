// Portado de tests/integration/api.test.js (T02): la mitad de "API permite
// registrar dispositivo y crear orden" que habla del dispositivo, y "API permite
// comando directo y lectura de estado por dispositivo".
//
// ADAPTADO.
//
// Que afirmaba el legacy:
//  - POST /api/devices/register (CARRO, host, port) -> 201.
//  - POST /api/devices/:robotId/carro/command con value 10201 -> 200 con
//    response.ack 'DONE'.
//  - GET /api/devices/:robotId/carro/state -> 200 con type CARRO,
//    values.messageIn1 / messageIn2 / messageOut en 0 y simulated true.
//
// Que afirma ahora y por que cambio:
//  - El 201, el 200, el ack 'DONE' (conocimiento de planta: es el ack del modo
//    simulacion) y el value 10201 se portan literales.
//  - El alta deja de vivir solo como objeto en memoria: se afirma que el
//    dispositivo queda en la tabla devices, que es de donde salen el comando
//    directo, la lectura de registros y el monitor de conectividad (RF23).
//  - Se agrega GET /api/devices/robots, que hoy devuelve {} en queue con driver
//    externo por una Promise sin await. El bug NO se porta: el test afirma el
//    comportamiento correcto (RF21, tabla de diferencias de la spec).
//
// DEFICIT CONOCIDO, y es el que mas duele de este archivo:
//  - RF22 pone el comando directo en el nivel de Mantenimiento, con token
//    estatico por header: es el unico endpoint de la API local que escribe
//    registros Modbus salteandose el orquestador y las maquinas de estado.
//    Ningun test legacy manda credencial y el esqueleto no declara todavia por
//    donde entra el token, asi que ni este caso ni su hermano sin token (401 o
//    403) estan cubiertos. Entra con T19.
//  - La lectura de estado es TAUTOLOGICA en simulacion: los tres registros
//    vuelven en 0 por construccion, el test "de lectura por dispositivo" no lee
//    nada. El handshake real (escribir messageIn partido high/low en el carro,
//    pollear messageOut, resetear y verificar messageOut = 0, RF17) se pinea
//    contra un doble de ModbusClient en transport/stepHandshake.

import { describe, expect, it } from 'vitest'

import { crearAgente, type Agente, type OpcionesDelAgente } from '../composition.js'
import type { CuerpoDeRespuesta } from './httpServer.js'

const SITE_ID = 'SUC-TEST'
const ROBOT_ID = '1'

/** RF22, segundo nivel: el comando directo a PLC va con token. */
const TOKEN_DE_MANTENIMIENTO = 'token-de-prueba'

const OPCIONES: OpcionesDelAgente = {
  siteId: SITE_ID,
  rutaDeBase: ':memory:',
  montarApi: true,
  // RF20: el default es false. Sin esto el comando directo se iria contra un PLC
  // inexistente en vez de simularse.
  simularPlc: true,
  httpPuerto: 0,
  httpBind: '127.0.0.1',
  zonaDePickeo: [],
  // RF22: el comando directo a PLC exige token. Configurado, este fixture lo usa.
  tokenDeMantenimiento: TOKEN_DE_MANTENIMIENTO,
}

interface RespuestaDeComando {
  readonly response: { readonly ack: string }
}

interface EstadoDeDispositivo {
  readonly type: string
  readonly values: {
    readonly messageIn1: number
    readonly messageIn2: number | null
    readonly messageOut: number
  }
  readonly simulated: boolean
}

interface ColaDeRobot {
  readonly robotId: string
  readonly activeOrderId: string | null
  readonly queueLength: number
  readonly paused: boolean
  readonly queuedOrderIds: readonly string[]
}

interface RobotDeApi {
  readonly robotId: string
  readonly queue: ColaDeRobot
}

async function levantarAgente(): Promise<Agente> {
  const agente = crearAgente(OPCIONES)
  await agente.iniciar()

  const guardado = await agente.orquestador.repositorios.robots.guardar({
    id: ROBOT_ID,
    siteId: SITE_ID,
    estanteriaCode: '3X',
    habilitado: true,
    estado: 'IDLE',
    ordenActivaId: null,
  })
  if (!guardado.ok) {
    throw new Error(`no se pudo sembrar el robot: ${guardado.error.codigo}`)
  }

  return agente
}

function urlDe(agente: Agente, ruta: string): string {
  const direccion = agente.direccion()
  if (direccion === null) {
    throw new Error('el agente no monto la API')
  }
  return `http://${direccion.host}:${String(direccion.puerto)}${ruta}`
}

async function leerCuerpo<T>(respuesta: Response): Promise<CuerpoDeRespuesta<T>> {
  const cuerpo: unknown = await respuesta.json()
  return cuerpo as CuerpoDeRespuesta<T>
}

function datosDe<T>(cuerpo: CuerpoDeRespuesta<T>): T {
  if (!cuerpo.ok) {
    throw new Error(`la API respondio error: ${cuerpo.error}`)
  }
  return cuerpo.data
}

function registrarCarro(agente: Agente): Promise<Response> {
  return fetch(urlDe(agente, '/api/devices/register'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ robotId: ROBOT_ID, type: 'CARRO', host: '192.168.1.10', port: 502 }),
  })
}

describe('API local de dispositivos', () => {
  it('POST /api/devices/register responde 201 y deja el dispositivo en libros', async () => {
    const agente = await levantarAgente()

    try {
      const respuesta = await registrarCarro(agente)
      expect(respuesta.status).toBe(201)

      // Sin credencial: el alta de dispositivos es nivel operario (RF22).
      const persistido = await agente.orquestador.repositorios.dispositivos.buscar(
        ROBOT_ID,
        'CARRO',
      )
      expect(persistido?.robotId).toBe(ROBOT_ID)
      expect(persistido?.tipo).toBe('CARRO')
      expect(persistido?.host).toBe('192.168.1.10')
      expect(persistido?.puerto).toBe(502)
    } finally {
      await agente.detener()
    }
  })

  it('POST /api/devices/:robotId/carro/command ejecuta el comando directo', async () => {
    const agente = await levantarAgente()

    try {
      expect((await registrarCarro(agente)).status).toBe(201)

      const respuesta = await fetch(urlDe(agente, `/api/devices/${ROBOT_ID}/carro/command`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Aoki-Maintenance-Token': TOKEN_DE_MANTENIMIENTO,
        },
        // Comando de planta: posicion 1, parante 02, ladoBit 0, accionBit 1.
        body: JSON.stringify({ value: 10201 }),
      })
      const cuerpo = await leerCuerpo<RespuestaDeComando>(respuesta)

      expect(respuesta.status).toBe(200)
      expect(cuerpo.ok).toBe(true)
      expect(datosDe(cuerpo).response.ack).toBe('DONE')
    } finally {
      await agente.detener()
    }
  })

  it('GET /api/devices/:robotId/carro/state devuelve los registros del dispositivo', async () => {
    const agente = await levantarAgente()

    try {
      expect((await registrarCarro(agente)).status).toBe(201)

      const respuesta = await fetch(urlDe(agente, `/api/devices/${ROBOT_ID}/carro/state`))
      const cuerpo = await leerCuerpo<EstadoDeDispositivo>(respuesta)

      expect(respuesta.status).toBe(200)
      expect(cuerpo.ok).toBe(true)

      const estado = datosDe(cuerpo)
      expect(estado.type).toBe('CARRO')
      // En simulacion los tres vuelven en 0 por construccion: ver el deficit de
      // la cabecera. Lo que si aporta el assert es que el CARRO tiene los DOS
      // registros de messageIn (el split high/low), no uno.
      expect(estado.values.messageIn1).toBe(0)
      expect(estado.values.messageIn2).toBe(0)
      expect(estado.values.messageOut).toBe(0)
      expect(estado.simulated).toBe(true)
    } finally {
      await agente.detener()
    }
  })

  // Sin test legacy: es el bug que la spec manda corregir. Con driver de cola
  // externo el endpoint serializa una Promise sin await y queue sale {}. Se
  // afirma el comportamiento CORRECTO, no el actual.
  it('GET /api/devices/robots devuelve la cola resuelta de cada robot, no un objeto vacio', async () => {
    const agente = await levantarAgente()

    try {
      const respuesta = await fetch(urlDe(agente, '/api/devices/robots'))
      const cuerpo = await leerCuerpo<readonly RobotDeApi[]>(respuesta)

      expect(respuesta.status).toBe(200)
      expect(cuerpo.ok).toBe(true)

      const robot = datosDe(cuerpo).find((candidato) => candidato.robotId === ROBOT_ID)
      expect(robot).toBeDefined()
      expect(Object.keys(robot?.queue ?? {})).not.toHaveLength(0)
      expect(robot?.queue.robotId).toBe(ROBOT_ID)
      expect(typeof robot?.queue.queueLength).toBe('number')
      expect(robot?.queue.paused).toBe(false)
      expect(Array.isArray(robot?.queue.queuedOrderIds)).toBe(true)
    } finally {
      await agente.detener()
    }
  })
})
