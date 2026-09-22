// Suite de aceptacion T02 — portado de tests/unit/connectionService.test.js.
//
// Cuatro tests del monitor de conectividad (RF18): backoff con recreacion de
// cliente, hard-reset de transporte, cesion del socket al orquestador y salteo
// del ciclo cuando el mutex del dispositivo esta tomado.

import { describe, expect, it } from 'vitest'

import type { Reloj } from '../reloj.js'
import {
  calcularBackoffMs,
  crearMonitorDeConexiones,
  type CicloDeDispositivo,
  type DependenciasDeMonitor,
  type ResultadoDeCiclo,
} from './connectionMonitor.js'
import type { DeviceMutex } from './deviceMutex.js'
import type { DispositivoRegistrado, ModbusClient, RegistroDeClientes } from './modbusClient.js'

/** `<robotId>:<TIPO>`, la misma clave con la que se toma el mutex (RF16). */
const CLAVE = '1:CARRO'

const DISPOSITIVO: DispositivoRegistrado = {
  robotId: '1',
  tipo: 'CARRO',
  host: '127.0.0.1',
  puerto: 502,
  // Los Festo de planta no usan 1.
  unitId: 255,
  timeoutMsDeSocket: 2000,
}

interface ClienteContado {
  readonly cliente: ModbusClient
  readonly conexiones: () => number
}

function crearClienteContado(falla: boolean): ClienteContado {
  let conexiones = 0
  const cliente: ModbusClient = {
    conectar: () => {
      conexiones += 1
      if (falla) {
        const error: NodeJS.ErrnoException = new Error('connect ECONNREFUSED 127.0.0.1:502')
        error.code = 'ECONNREFUSED'
        return Promise.reject(error)
      }
      return Promise.resolve()
    },
    desconectar: () => Promise.resolve(),
    estaConectado: () => !falla,
    leerRegistrosDeRetencion: (_direccion, cantidad) =>
      Promise.resolve(new Array<number>(cantidad).fill(0)),
    leerRegistrosDeEntrada: (_direccion, cantidad) =>
      Promise.resolve(new Array<number>(cantidad).fill(0)),
    escribirRegistro: () => Promise.resolve(),
  }

  return { cliente, conexiones: () => conexiones }
}

interface RegistroDoble {
  readonly registro: RegistroDeClientes
  readonly recreaciones: () => number
  readonly cerroTodos: () => boolean
}

function crearRegistroDoble(cliente: ModbusClient): RegistroDoble {
  let recreaciones = 0
  let cerroTodos = false

  const registro: RegistroDeClientes = {
    obtener: () => cliente,
    asegurar: () => cliente,
    recrear: () => {
      recreaciones += 1
      return Promise.resolve(cliente)
    },
    cerrarTodos: () => {
      cerroTodos = true
      return Promise.resolve()
    },
  }

  return { registro, recreaciones: () => recreaciones, cerroTodos: () => cerroTodos }
}

interface MutexDoble {
  readonly mutex: DeviceMutex
  readonly libero: () => boolean
}

/**
 * Mutex deterministico: `tomado()` decide si el dispositivo esta ocupado AHORA.
 * El legacy lo simulaba con una operacion de 80 ms y dependia del timing.
 */
function crearMutexDoble(tomado: () => boolean): MutexDoble {
  let libero = false

  const mutex: DeviceMutex = {
    ejecutar: (_clave, operacion) => operacion(),
    intentarEjecutar: async (_clave, operacion) => {
      if (tomado()) {
        return { ejecutado: false }
      }
      return { ejecutado: true, valor: await operacion() }
    },
    estaTomado: () => tomado(),
    liberarTodo: () => {
      libero = true
    },
  }

  return { mutex, libero: () => libero }
}

interface RelojControlable {
  readonly reloj: Reloj
  readonly avanzar: (ms: number) => void
}

function crearRelojControlable(inicioMs: number): RelojControlable {
  let ahora = inicioMs
  const reloj: Reloj = {
    ahoraMs: () => ahora,
    dormir: () => Promise.resolve(),
  }

  return {
    reloj,
    avanzar: (ms: number) => {
      ahora += ms
    },
  }
}

function resultadoUnico(ciclos: readonly CicloDeDispositivo[]): ResultadoDeCiclo {
  const primero = ciclos[0]
  if (primero === undefined) {
    throw new Error('el monitor no devolvio ningun ciclo de dispositivo')
  }
  expect(ciclos).toHaveLength(1)
  expect(primero.clave).toBe(CLAVE)
  return primero.resultado
}

// Constantes del test legacy (override local; los defaults de produccion son
// base 2000 ms y max 30000 ms).
const BASE_BACKOFF_MS = 5000
const MAX_BACKOFF_MS = 30000

const CONFIGURACION = {
  baseBackoffMs: BASE_BACKOFF_MS,
  maxBackoffMs: MAX_BACKOFF_MS,
  recrearClienteCadaNFallos: 5,
} as const

describe('monitor de conectividad (RF18)', () => {
  it('aplica backoff y recrea el cliente al quinto fallo consecutivo', async () => {
    const { cliente, conexiones } = crearClienteContado(true)
    const { registro, recreaciones } = crearRegistroDoble(cliente)
    const { mutex } = crearMutexDoble(() => false)
    const { reloj, avanzar } = crearRelojControlable(1_000_000)

    const dependencias: DependenciasDeMonitor = {
      clientes: registro,
      mutex,
      reloj,
      configuracion: CONFIGURACION,
      listarDispositivos: () => Promise.resolve([DISPOSITIVO]),
      orquestadorTienePrioridad: () => false,
      simularPlc: false,
    }

    const monitor = crearMonitorDeConexiones(dependencias)

    expect(resultadoUnico(await monitor.verificarRobot('1'))).toMatchObject({
      tipo: 'FALLO',
      fallosConsecutivos: 1,
      clienteRecreado: false,
      fallo: { tipo: 'TRANSPORTE' },
    })
    expect(conexiones()).toBe(1)

    // Sin avanzar el reloj el ciclo siguiente se saltea: el backoff todavia corre.
    expect(resultadoUnico(await monitor.verificarRobot('1'))).toMatchObject({
      tipo: 'ESPERANDO_BACKOFF',
    })
    expect(conexiones()).toBe(1)

    let ultimo: ResultadoDeCiclo = { tipo: 'SALTEADO_POR_LOCK' }
    for (let intento = 2; intento <= 5; intento += 1) {
      avanzar(MAX_BACKOFF_MS + 1)
      ultimo = resultadoUnico(await monitor.verificarRobot('1'))
    }

    expect(conexiones()).toBe(5)
    // La condicion de recreacion es por modulo (5, 10, 15...), no por umbral.
    expect(recreaciones()).toBe(1)
    expect(ultimo).toMatchObject({
      tipo: 'FALLO',
      fallosConsecutivos: 5,
      clienteRecreado: true,
    })

    // El side effect de estado que el helper legacy recolectaba en 'updates' y
    // ningun assert miraba.
    expect(monitor.estadoDe(CLAVE)).toMatchObject({
      tipo: 'DESCONECTADO',
      fallosConsecutivos: 5,
    })

    // El titulo legacy decia 'aplica backoff' y no afirmaba ningun valor de
    // backoff: la formula que RF18 pide preservar quedaba sin test.
    expect(calcularBackoffMs(1, BASE_BACKOFF_MS, MAX_BACKOFF_MS)).toBe(5000)
    expect(calcularBackoffMs(2, BASE_BACKOFF_MS, MAX_BACKOFF_MS)).toBe(10000)
    expect(calcularBackoffMs(3, BASE_BACKOFF_MS, MAX_BACKOFF_MS)).toBe(20000)
    // Techo en maxMs.
    expect(calcularBackoffMs(4, BASE_BACKOFF_MS, MAX_BACKOFF_MS)).toBe(30000)
    expect(calcularBackoffMs(9, BASE_BACKOFF_MS, MAX_BACKOFF_MS)).toBe(30000)
  })

  it('el hard reset cierra todos los clientes y olvida el estado de recuperacion', async () => {
    // El legacy afirmaba sobre tres Map internos por nombre (service.clients,
    // service.connectionRecovery, service.modbusRecreateStreakByDevice). Esas
    // estructuras no existen mas: se afirma el comportamiento observable
    // equivalente —todo cliente cerrado, backoff olvidado, mutex liberado—, que
    // es lo mismo que el legacy queria decir sin pinear nombres de campo.
    const { cliente } = crearClienteContado(true)
    const { registro, cerroTodos } = crearRegistroDoble(cliente)
    const { mutex, libero } = crearMutexDoble(() => false)
    const { reloj } = crearRelojControlable(1_000_000)

    const monitor = crearMonitorDeConexiones({
      clientes: registro,
      mutex,
      reloj,
      configuracion: CONFIGURACION,
      listarDispositivos: () => Promise.resolve([DISPOSITIVO]),
      orquestadorTienePrioridad: () => false,
      simularPlc: false,
    })

    // Estado de recuperacion que el hard reset tiene que olvidar.
    await monitor.verificarRobot('1')
    expect(monitor.estadoDe(CLAVE)).toMatchObject({ tipo: 'DESCONECTADO' })

    await monitor.hardReset()

    expect(cerroTodos()).toBe(true)
    // El legacy omitia el deviceMutex.clear() que el codigo si hace.
    expect(libero()).toBe(true)
    expect(monitor.estadoDe(CLAVE)).toBeUndefined()
  })

  it('cede el socket y no toca ningun dispositivo cuando el orquestador tiene prioridad', async () => {
    const { cliente, conexiones } = crearClienteContado(false)
    const { registro } = crearRegistroDoble(cliente)
    const { mutex } = crearMutexDoble(() => false)
    const { reloj } = crearRelojControlable(1_000_000)

    let orquestadorOcupado = true
    const robotsConsultados: string[] = []

    const monitor = crearMonitorDeConexiones({
      clientes: registro,
      mutex,
      reloj,
      configuracion: CONFIGURACION,
      listarDispositivos: () => Promise.resolve([DISPOSITIVO]),
      orquestadorTienePrioridad: (robotId) => {
        robotsConsultados.push(robotId)
        return orquestadorOcupado
      },
      simularPlc: false,
    })

    expect(resultadoUnico(await monitor.verificarRobot('1'))).toEqual({
      tipo: 'CEDIDO_AL_ORQUESTADOR',
    })
    expect(conexiones()).toBe(0)
    // El legacy afirmaba solo la ausencia de llamadas: pasaba igual con el monitor
    // roto o con la lista de dispositivos vacia. Se agrega que la cesion es POR
    // ROBOT (el resolver recibe el robotId) y el control positivo de abajo.
    expect(robotsConsultados).toEqual(['1'])

    orquestadorOcupado = false
    expect(resultadoUnico(await monitor.verificarRobot('1'))).toEqual({ tipo: 'CONECTADO' })
    expect(conexiones()).toBe(1)
  })

  it('saltea el ciclo si el mutex del dispositivo ya esta tomado y lo retoma al liberarse', async () => {
    const { cliente, conexiones } = crearClienteContado(false)
    const { registro } = crearRegistroDoble(cliente)
    let ocupado = true
    const { mutex } = crearMutexDoble(() => ocupado)
    const { reloj } = crearRelojControlable(1_000_000)

    const monitor = crearMonitorDeConexiones({
      clientes: registro,
      mutex,
      reloj,
      configuracion: CONFIGURACION,
      listarDispositivos: () => Promise.resolve([DISPOSITIVO]),
      orquestadorTienePrioridad: () => false,
      simularPlc: false,
    })

    // El monitor usa intentarEjecutar y no ejecutar: si el socket esta ocupado
    // SALTEA, no se encola detras de la operacion en curso.
    expect(resultadoUnico(await monitor.verificarRobot('1'))).toEqual({
      tipo: 'SALTEADO_POR_LOCK',
    })
    expect(conexiones()).toBe(0)

    // Control positivo que el legacy no tenia: al liberarse el lock, el ciclo
    // siguiente SI corre.
    ocupado = false
    expect(resultadoUnico(await monitor.verificarRobot('1'))).toEqual({ tipo: 'CONECTADO' })
    expect(conexiones()).toBe(1)
  })
})
