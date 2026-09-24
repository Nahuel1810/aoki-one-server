// RF16, RF18 y RF20 — El test que NADIE PODIA FALLAR: alguien tiene que abrir el socket.
//
// POR QUE EXISTE. Todos los dobles de transporte de la suite devuelven
// `estaConectado() === true` y aceptan escrituras sin que nadie les haya llamado
// a `conectar()`. Contra esos dobles, el defecto mas grave del transporte era
// invisible: `crearPuertoDeTransporte` pedia el cliente y le escribia registros
// sin que nadie hubiera hecho el connectTCP. Con SIMULATE_PLC en false —el
// default de RF20— el primer `escribirRegistro` tiraba "Port Not Open", se
// clasificaba TRANSPORTE, se reintentaba tres veces y la orden iba a ERROR. TODA
// orden, SIEMPRE, desde el minuto cero.
//
// EL DOBLE DE ACA ARRANCA DESCONECTADO Y MUERDE: cualquier lectura o escritura
// antes de `conectar()` tira "Port Not Open", igual que el driver real. Es la
// unica forma de que el test pueda fallar cuando nadie conecta.
//
// Ademas afirma las otras dos mitades del mismo agujero:
//   - el monitor de conectividad (RF18) CORRE: estaba completo y testeado, y
//     nadie lo instanciaba;
//   - el estado por dispositivo que ve el operario sale del monitor y no de una
//     constante derivada de si hay simulacion, que en planta dejaba la pantalla
//     en DISCONNECTED para siempre.

import { setTimeout as dormir } from 'node:timers/promises'

import { LOGGER_SILENCIOSO, type TipoDispositivo } from '@aoki-one/domain'
import { afterEach, describe, expect, it } from 'vitest'

import { crearAgente, type Agente } from '../composition.js'
import { claveDeDispositivo } from '../transport/modbusClient.js'
import type {
  ClaveDeDispositivo,
  DispositivoRegistrado,
  ModbusClient,
  RegistroDeClientes,
} from '../transport/modbusClient.js'

const SITE_ID = 'sucursal-conexion'
const AGENT_ID = 'AG-CONEXION'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'
const ORIGEN = '3X04AA3'
const ZONA_DE_PICKEO: readonly string[] = ['3X02AE1', '3X02AC1', '3X02AA1']

/** El PLC confirma un comando con 100 (OK). Es lo que espera todo paso (RF12). */
const RESPUESTA_OK = 100

const ESPERA_MAXIMA_MS = 15_000
const INTERVALO_DE_SONDEO_MS = 20
const TIMEOUT_DEL_TEST_MS = 40_000
/** El monitor va rapido en la suite: sin esto el primer ciclo tarda un segundo. */
const INTERVALO_DE_MONITOREO_MS = 20

const ESTADOS_FINALES = ['DONE', 'ERROR', 'CANCELED']

// ------------------------------------------------------------------ doble de PLC

interface PlcDoble {
  readonly cliente: ModbusClient
  /** Cuantas veces se abrio el socket. Cero = nadie conecto. */
  readonly conexiones: () => number
  /** Operaciones rechazadas por socket cerrado. */
  readonly rechazos: () => number
}

interface OpcionesDelPlcDoble {
  /**
   * El socket se cae solo despues de cada operacion atendida.
   *
   * Es el corte de red corto que el robot absorbe sin que el operario se entere.
   * Solo lo sobrevive quien asegura la conexion ANTES de cada operacion Modbus,
   * como hace `ensureConnected` en el legacy: el monitor no alcanza, porque el
   * corte pasa entre dos operaciones del mismo handshake.
   */
  readonly cortarTrasCadaOperacion: boolean
}

/**
 * Un PLC de mentira que se comporta como el driver real en lo unico que importa
 * aca: con el socket cerrado NO atiende.
 *
 * El protocolo que habla es el minimo del handshake: mientras `messageIn` tenga
 * algo distinto de cero contesta 100 en `messageOut`, y cuando `messageIn` vuelve
 * a cero contesta 0. Alcanza para que un paso confirme y su reset verifique.
 */
function crearPlcDoble(opciones: OpcionesDelPlcDoble): PlcDoble {
  let conectado = false
  let conexiones = 0
  let rechazos = 0
  const messageIn = new Map<number, number>()

  function exigirSocketAbierto(): void {
    if (conectado) {
      return
    }
    rechazos += 1
    // El mensaje es literal el del driver real, y es el que `clasificarError`
    // reconoce como TRANSPORTE por la frase 'port not open'.
    throw new Error('Port Not Open')
  }

  function messageOut(): number {
    return [...messageIn.values()].some((valor) => valor !== 0) ? RESPUESTA_OK : 0
  }

  /** El corte de red: el socket queda muerto apenas termina de atender. */
  function cortarSiCorresponde(): void {
    if (opciones.cortarTrasCadaOperacion) {
      conectado = false
    }
  }

  const cliente: ModbusClient = {
    conectar: () => {
      if (!conectado) {
        conexiones += 1
        conectado = true
      }
      return Promise.resolve()
    },
    desconectar: () => {
      conectado = false
      return Promise.resolve()
    },
    estaConectado: () => conectado,
    marcarDesconectado: () => {
      conectado = false
    },
    leerRegistrosDeRetencion: (direccion, cantidad) => {
      exigirSocketAbierto()
      const leido = Array.from({ length: cantidad }, (_, i) => messageIn.get(direccion + i) ?? 0)
      cortarSiCorresponde()
      return Promise.resolve(leido)
    },
    leerRegistrosDeEntrada: (_direccion, cantidad) => {
      exigirSocketAbierto()
      const leido = new Array<number>(cantidad).fill(messageOut())
      cortarSiCorresponde()
      return Promise.resolve(leido)
    },
    escribirRegistro: (direccion, valor) => {
      exigirSocketAbierto()
      messageIn.set(direccion, valor)
      cortarSiCorresponde()
      return Promise.resolve()
    },
  }

  return { cliente, conexiones: () => conexiones, rechazos: () => rechazos }
}

interface RegistroDoble {
  readonly registro: RegistroDeClientes
  readonly plcDe: (clave: ClaveDeDispositivo) => PlcDoble | undefined
}

/** Registro de clientes que entrega PLCs de mentira, uno por dispositivo. */
function crearRegistroDoble(opciones: OpcionesDelPlcDoble): RegistroDoble {
  const plcs = new Map<ClaveDeDispositivo, PlcDoble>()

  function asegurar(dispositivo: DispositivoRegistrado): ModbusClient {
    const clave = claveDeDispositivo(dispositivo.robotId, dispositivo.tipo)
    const existente = plcs.get(clave)
    if (existente !== undefined) {
      return existente.cliente
    }
    const creado = crearPlcDoble(opciones)
    plcs.set(clave, creado)
    return creado.cliente
  }

  return {
    plcDe: (clave) => plcs.get(clave),
    registro: {
      obtener: (clave) => plcs.get(clave)?.cliente,
      asegurar,
      recrear: (dispositivo) => {
        plcs.delete(claveDeDispositivo(dispositivo.robotId, dispositivo.tipo))
        return Promise.resolve(asegurar(dispositivo))
      },
      cerrarTodos: () => {
        plcs.clear()
        return Promise.resolve()
      },
    },
  }
}

// ------------------------------------------------------------------ helpers HTTP

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null
}

function leer(valor: unknown, ruta: string): unknown {
  let actual: unknown = valor
  for (const clave of ruta.split('.')) {
    if (!esObjeto(actual)) {
      return undefined
    }
    actual = actual[clave]
  }
  return actual
}

async function obtener(url: string): Promise<unknown> {
  const respuesta = await fetch(url)
  return respuesta.json()
}

async function postear(url: string, cuerpo: unknown): Promise<unknown> {
  const respuesta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  })
  return respuesta.json()
}

/** Sondea hasta que la condicion se cumple o se agota la espera. */
async function esperarA(condicion: () => Promise<boolean>): Promise<boolean> {
  const limite = Date.now() + ESPERA_MAXIMA_MS
  while (Date.now() < limite) {
    if (await condicion()) {
      return true
    }
    await dormir(INTERVALO_DE_SONDEO_MS)
  }
  return false
}

/**
 * Agente en modo planta —`simularPlc` en FALSE— hablandole a los dobles.
 *
 * En simulacion el transporte contesta OK sin tocar el socket, asi que nada de
 * lo que afirma este archivo se podria afirmar.
 */
async function levantarAgente(dobles: RegistroDoble): Promise<{ agente: Agente; base: string }> {
  const agente = crearAgente({
    siteId: SITE_ID,
    agentId: AGENT_ID,
    rutaDeBase: ':memory:',
    montarApi: true,
    simularPlc: false,
    httpPuerto: 0,
    httpBind: '127.0.0.1',
    zonaDePickeo: ZONA_DE_PICKEO,
    tokenDeMantenimiento: null,
    enlace: null,
    logger: LOGGER_SILENCIOSO,
    registroDeClientes: dobles.registro,
    intervaloDeMonitoreoMs: INTERVALO_DE_MONITOREO_MS,
  })

  await agente.iniciar()

  const direccion = agente.direccion()
  if (direccion === null) {
    throw new Error('El agente se arranco con la API montada y no expuso su direccion')
  }

  const repositorios = agente.orquestador.repositorios
  const altaDelRobot = await repositorios.robots.guardar({
    id: ROBOT_ID,
    siteId: SITE_ID,
    estanteriaCode: ESTANTERIA,
    habilitado: true,
    estado: 'IDLE',
    ordenActivaId: null,
  })
  if (!altaDelRobot.ok) {
    throw new Error('No se pudo dar de alta el robot del fixture')
  }
  await repositorios.slots.sembrarZonaDePickeo(ROBOT_ID, ZONA_DE_PICKEO)

  for (const tipo of ['CARRO', 'ELEVADOR'] as const satisfies readonly TipoDispositivo[]) {
    await repositorios.dispositivos.registrar({
      robotId: ROBOT_ID,
      tipo,
      host: '127.0.0.1',
      puerto: 502,
      unitId: 255,
      timeoutMsDeSocket: 2000,
    })
  }

  return { agente, base: `http://${direccion.host}:${String(direccion.puerto)}` }
}

/** Da de alta una orden de PICK y espera a que llegue a un estado final. */
async function correrUnaOrden(base: string): Promise<string> {
  const alta = await postear(`${base}/api/orders`, { type: 'PICK', locationCode: ORIGEN })
  const ordenId = leer(alta, 'data.id')
  if (typeof ordenId !== 'string') {
    throw new Error(`El alta de la orden no devolvio id: ${JSON.stringify(alta)}`)
  }

  let ultimoEstado = ''
  await esperarA(async () => {
    const orden = await obtener(`${base}/api/orders/${ordenId}`)
    const estado = leer(orden, 'data.status')
    ultimoEstado = typeof estado === 'string' ? estado : ''
    return ESTADOS_FINALES.includes(ultimoEstado)
  })
  return ultimoEstado
}

// ------------------------------------------------------------------ el test

describe('el transporte abre el socket antes de usarlo', () => {
  let agente: Agente | null = null

  afterEach(async () => {
    const abierto = agente
    agente = null
    if (abierto !== null) {
      await abierto.detener()
    }
  })

  it(
    'lleva una orden a DONE contra un PLC que arranca desconectado, y publica el estado real',
    async () => {
      const dobles = crearRegistroDoble({ cortarTrasCadaOperacion: false })
      const levantado = await levantarAgente(dobles)
      agente = levantado.agente
      const base = levantado.base

      // --- RF18: el monitor corre y abre los sockets SIN que haya ninguna orden.
      const monitoreado = await esperarA(() =>
        Promise.resolve(
          (['CARRO', 'ELEVADOR'] as const).every((tipo) => {
            const plc = dobles.plcDe(claveDeDispositivo(ROBOT_ID, tipo))
            return plc !== undefined && plc.conexiones() > 0
          }),
        ),
      )
      expect(monitoreado).toBe(true)

      // --- El estado que ve el operario sale del monitor, no de `simularPlc`.
      const dispositivos = leer(await obtener(`${base}/api/devices`), 'data')
      expect(Array.isArray(dispositivos)).toBe(true)
      const listados = dispositivos as readonly unknown[]
      expect(listados.map((dispositivo) => leer(dispositivo, 'status'))).toEqual([
        'CONNECTED',
        'CONNECTED',
      ])
      // `lastSeen` deja de ser null: es el ultimo contacto real con el PLC.
      expect(
        listados.every((dispositivo) => typeof leer(dispositivo, 'lastSeen') === 'number'),
      ).toBe(true)

      // --- Y la orden llega a DONE: el handshake corre sobre un socket abierto.
      expect(await correrUnaOrden(base)).toBe('DONE')

      // La afirmacion que hace fallar el bug: si nadie hubiera conectado, cada
      // escritura habria sido un rechazo y la orden estaria en ERROR.
      for (const tipo of ['CARRO', 'ELEVADOR'] as const satisfies readonly TipoDispositivo[]) {
        const plc = dobles.plcDe(claveDeDispositivo(ROBOT_ID, tipo))
        expect(plc?.conexiones()).toBeGreaterThan(0)
        expect(plc?.rechazos()).toBe(0)
      }
    },
    TIMEOUT_DEL_TEST_MS,
  )

  it(
    'absorbe un socket que se cae entre operaciones y igual lleva la orden a DONE',
    async () => {
      // El PLC corta el socket despues de CADA operacion atendida. El monitor no
      // salva esto: el corte pasa entre dos operaciones del mismo handshake, con
      // el mutex del dispositivo tomado por el orquestador. Lo unico que lo
      // sobrevive es asegurar la conexion antes de cada operacion Modbus, que es
      // lo que hace `ensureConnected` en `_runModbusOpInner` del legacy.
      const dobles = crearRegistroDoble({ cortarTrasCadaOperacion: true })
      const levantado = await levantarAgente(dobles)
      agente = levantado.agente

      expect(await correrUnaOrden(levantado.base)).toBe('DONE')

      // Se reconecto muchas veces, una por operacion: es exactamente el corte de
      // red que el robot absorbe sin que el operario se entere.
      const carro = dobles.plcDe(claveDeDispositivo(ROBOT_ID, 'CARRO'))
      expect(carro?.conexiones()).toBeGreaterThan(1)
    },
    TIMEOUT_DEL_TEST_MS,
  )
})
