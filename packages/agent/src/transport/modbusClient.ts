// RF16 — Un cliente Modbus por dispositivo.
//
// El cliente se declara como puerto: los tests portados lo sustituyen por un
// doble que registra las lecturas y escrituras, que es la unica forma de pinear
// el handshake sin un PLC delante.
//
// Conocimiento de planta que la firma preserva a proposito: messageIn se ESCRIBE
// como holding register (FC06) y messageOut se LEE como input register (FC04), y
// el mapa por defecto pone a los DOS en la direccion 0. Coinciden en numero y no
// en espacio de direcciones: un cliente que unifique todo en holding registers
// compila, pasa los tests con dobles y no le habla al PLC. Por eso las lecturas
// son dos metodos distintos y no uno con bandera.

import type { TipoDispositivo } from '@aoki-one/domain'

import type { MapaDeRegistros } from './stepHandshake.js'

/**
 * Identidad de un dispositivo: `<robotId>:<TIPO>` (por ejemplo `3:CARRO`).
 *
 * Es la misma clave con la que se indexan los clientes y con la que se toma el
 * mutex por dispositivo (RF16), asi que hay una sola nocion de "dispositivo".
 */
export type ClaveDeDispositivo = string

export function claveDeDispositivo(robotId: string, tipo: TipoDispositivo): ClaveDeDispositivo {
  return robotId + ':' + tipo
}

/** Dispositivo tal como esta dado de alta: identidad mas datos de conexion. */
export interface DispositivoRegistrado {
  readonly robotId: string
  readonly tipo: TipoDispositivo
  readonly host: string
  readonly puerto: number
  /** `unitId` del esclavo Modbus. Los Festo de planta no usan 1. */
  readonly unitId: number
  readonly timeoutMsDeSocket: number
  /**
   * En que direcciones vive este dispositivo. Ausente = el mapa por defecto
   * (`MAPA_DE_REGISTROS_POR_DEFECTO`, o sea 0 y 0).
   *
   * Es configurable POR DISPOSITIVO porque en planta no todos los PLC usan el
   * registro 0, que es justamente para lo que existia la tabla del legacy
   * (`src/config/deviceRegisterMaps.js` + `registerMap` del alta). Cableado en
   * 0, un dispositivo que usa otra direccion no falla: el agente le escribe el
   * comando a OTRO registro del PLC, que es peor que no escribirlo.
   *
   * Es opcional y no requerido a proposito: un dispositivo sin mapa propio es el
   * caso normal, y obligar a repetir `{ messageIn: 0, messageOut: 0 }` en cada
   * alta y cada fixture convierte el default en ruido copiado a mano.
   */
  readonly mapaDeRegistros?: MapaDeRegistros
}

/** Puerto del cliente Modbus TCP de UN dispositivo. */
export interface ModbusClient {
  readonly conectar: () => Promise<void>
  readonly desconectar: () => Promise<void>
  readonly estaConectado: () => boolean
  /**
   * Baja la bandera de conectado SIN cerrar el socket.
   *
   * Portado de `ModbusClient.markDisconnected` del legacy. Tras un error de
   * conectividad la bandera tiene que quedar en false para que el proximo
   * `conectar()` rehaga el connectTCP en vez de darse por conectado sobre un
   * socket muerto y repetir el mismo fallo. NO se cierra el socket a proposito:
   * `close()` sobre un socket ya roto puede no llamar nunca a su callback y
   * dejar colgado al reintento, que es lo contrario de lo que se busca.
   */
  readonly marcarDesconectado: () => void
  /** FC03. Es por donde se relee `messageIn`. */
  readonly leerRegistrosDeRetencion: (direccion: number, cantidad: number) => Promise<readonly number[]>
  /** FC04. Es por donde se lee `messageOut`. */
  readonly leerRegistrosDeEntrada: (direccion: number, cantidad: number) => Promise<readonly number[]>
  /** FC06. Es por donde se escribe `messageIn`. */
  readonly escribirRegistro: (direccion: number, valor: number) => Promise<void>
}

export function crearModbusClient(dispositivo: DispositivoRegistrado): ModbusClient {
  // Import diferido: el driver abre un socket al construirse y los tests que usan
  // dobles no tienen por que cargarlo.
  let cliente: ModbusRTU | null = null
  let conectado = false

  async function asegurarCliente(): Promise<ModbusRTU> {
    const existente = cliente
    if (existente !== null) {
      return existente
    }
    // modbus-serial es CommonJS: segun el interop el constructor cae en `default`
    // o en el modulo mismo. Se prueban los dos en vez de asumir uno.
    const modulo: unknown = await import('modbus-serial')
    const Constructor = resolverConstructor(modulo)
    const creado = new Constructor()
    creado.setID(dispositivo.unitId)
    creado.setTimeout(dispositivo.timeoutMsDeSocket)
    cliente = creado
    return creado
  }

  return {
    conectar: async () => {
      const c = await asegurarCliente()
      if (!conectado) {
        await c.connectTCP(dispositivo.host, { port: dispositivo.puerto })
        conectado = true
      }
    },
    desconectar: async () => {
      if (cliente !== null && conectado) {
        await new Promise<void>((resolve) => {
          cliente?.close(() => {
            resolve()
          })
        })
        conectado = false
      }
    },
    estaConectado: () => conectado,
    marcarDesconectado: () => {
      conectado = false
    },
    leerRegistrosDeRetencion: async (direccion, cantidad) => {
      const c = await asegurarCliente()
      const respuesta = await c.readHoldingRegisters(direccion, cantidad)
      return respuesta.data
    },
    leerRegistrosDeEntrada: async (direccion, cantidad) => {
      const c = await asegurarCliente()
      const respuesta = await c.readInputRegisters(direccion, cantidad)
      return respuesta.data
    },
    escribirRegistro: async (direccion, valor) => {
      const c = await asegurarCliente()
      await c.writeRegister(direccion, valor)
    },
  }
}

/** Resuelve el constructor del driver sin depender de la forma del interop. */
function resolverConstructor(modulo: unknown): new () => ModbusRTU {
  const conDefault = modulo as { default?: unknown }
  const candidato = typeof conDefault.default === 'function' ? conDefault.default : modulo
  return candidato as new () => ModbusRTU
}

/** Tipo minimo del driver: solo lo que este cliente usa. */
interface ModbusRTU {
  setID: (id: number) => void
  setTimeout: (ms: number) => void
  connectTCP: (host: string, opciones: { port: number }) => Promise<void>
  close: (callback: () => void) => void
  readHoldingRegisters: (direccion: number, cantidad: number) => Promise<{ data: number[] }>
  readInputRegisters: (direccion: number, cantidad: number) => Promise<{ data: number[] }>
  writeRegister: (direccion: number, valor: number) => Promise<void>
}

/**
 * Los clientes vivos, indexados por dispositivo.
 *
 * `recrear` existe porque la escalera de recuperacion de RF18 rehace el cliente
 * cada N fallos consecutivos, y `cerrarTodos` porque el hard-reset de transporte
 * (ultimo recurso) cierra todo y olvida el estado de recuperacion.
 */
export interface RegistroDeClientes {
  readonly obtener: (clave: ClaveDeDispositivo) => ModbusClient | undefined
  /** Devuelve el cliente del dispositivo, creandolo si todavia no existe. */
  readonly asegurar: (dispositivo: DispositivoRegistrado) => ModbusClient
  /** Cierra el cliente actual del dispositivo y lo reemplaza por uno nuevo. */
  readonly recrear: (dispositivo: DispositivoRegistrado) => Promise<ModbusClient>
  readonly cerrarTodos: () => Promise<void>
}

/**
 * Cierra un cliente sin propagar el fallo, como hace el legacy al recrear
 * ("failed to disconnect stale client": lo loguea y sigue).
 *
 * Se descarta el error a proposito: cerrar un socket que ya esta roto falla
 * seguido, y si eso se propagara, el fallo al despedirse del socket muerto
 * cancelaria justo la recreacion que venia a reemplazarlo, o el apagado del
 * agente.
 */
async function despedirse(cliente: ModbusClient): Promise<void> {
  try {
    await cliente.desconectar()
  } catch {
    // El cliente se descarta igual: no hay nada que reintentar sobre el.
  }
}

export function crearRegistroDeClientes(): RegistroDeClientes {
  const clientes = new Map<ClaveDeDispositivo, ModbusClient>()

  return {
    obtener: (clave) => clientes.get(clave),
    asegurar: (dispositivo) => {
      const clave = claveDeDispositivo(dispositivo.robotId, dispositivo.tipo)
      const existente = clientes.get(clave)
      if (existente !== undefined) {
        return existente
      }
      const creado = crearModbusClient(dispositivo)
      clientes.set(clave, creado)
      return creado
    },
    recrear: async (dispositivo) => {
      const clave = claveDeDispositivo(dispositivo.robotId, dispositivo.tipo)
      const anterior = clientes.get(clave)
      if (anterior !== undefined) {
        await despedirse(anterior)
      }
      const creado = crearModbusClient(dispositivo)
      clientes.set(clave, creado)
      return creado
    },
    cerrarTodos: async () => {
      for (const cliente of clientes.values()) {
        await despedirse(cliente)
      }
      clientes.clear()
    },
  }
}
