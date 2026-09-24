// E2E de una orden de PICK de punta a punta, en simulacion.
// RF02, RF04, RF05, RF08, RF20, RF21, RF23, RF25, RF35.
//
// Portado de tests/e2e/repo.e2e.test.js :: "E2E: flujo completo API + orquestador en
// simulacion". Es el test mas integrador de los 55: levanta el agente entero (API HTTP,
// orquestador y base) y recorre el camino completo del cajon, desde el alta de los
// dispositivos hasta el slot de pickeo donde queda apoyado.
//
// Lo unico simulado es el PLC. `simularPlc` va explicito porque RF20 pone el default en
// false: arrancar sin configuracion no puede simular en silencio.

import { setTimeout as dormir } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import { crearAgente } from '../composition.js'

const SITE_ID = 'sucursal-test'
/** RF35: el id externo de una orden local se prefija con la identidad del agente. */
const AGENT_ID = 'AG-TEST'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'

/** Ubicacion de guardado del cajon que se va a buscar. */
const ORIGEN = '3X04AA3'

/**
 * Los 12 slots reales de la zona de pickeo de planta (modulo 02 lado derecho, modulo 01
 * lado izquierdo, solo niveles A, C y E). La zona no es simetrica entre lados.
 */
const ZONA_DE_PICKEO: readonly string[] = [
  '3X02AE1',
  '3X02AC1',
  '3X02AA1',
  '3X01AE1',
  '3X01AE2',
  '3X01AE3',
  '3X01AC1',
  '3X01AC2',
  '3X01AC3',
  '3X01AA1',
  '3X01AA2',
  '3X01AA3',
]

/**
 * El origen 3X04AA3 es modulo 04 (par) -> lado RIGHT, nivel A. El carro NO cruza de lado,
 * asi que los 9 slots del modulo 01 (impar -> LEFT) quedan excluidos y solo compiten
 * 3X02AA1, 3X02AC1 y 3X02AE1. Gana el del mismo nivel que el origen.
 */
const SLOT_GANADOR = '3X02AA1'

/** Traduccion verificada contra el robot real: carro traer 30201, carro dejar 30200. */
const COMANDO_CARRO_TRAER = 30201
const COMANDO_CARRO_DEJAR = 30200
/** Elevador ir-a-nivel: 100 + nivel, con A = 1. */
const COMANDO_ELEVADOR_NIVEL_A = 101
/** INIT del carro, que es el comando del paso HOMING. */
const COMANDO_CARRO_INIT = 41000

const ESPERA_MAXIMA_MS = 10_000
const INTERVALO_DE_SONDEO_MS = 25
const TIMEOUT_DEL_TEST_MS = 30_000

const ESTADOS_FINALES_DE_ORDEN = ['DONE', 'ERROR', 'CANCELED']

interface RespuestaHttp {
  readonly status: number
  readonly cuerpo: unknown
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null
}

/** Lee una ruta con puntos sobre un cuerpo JSON sin tipar. Devuelve undefined si no esta. */
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

function lista(valor: unknown, ruta: string): readonly unknown[] {
  const encontrado = leer(valor, ruta)
  return Array.isArray(encontrado) ? (encontrado as readonly unknown[]) : []
}

function texto(valor: unknown, ruta: string): string {
  const encontrado = leer(valor, ruta)
  if (typeof encontrado !== 'string') {
    throw new Error(`Se esperaba texto en "${ruta}" y llego: ${JSON.stringify(encontrado)}`)
  }
  return encontrado
}

async function obtener(url: string): Promise<RespuestaHttp> {
  const respuesta = await fetch(url)
  const cuerpo: unknown = await respuesta.json()
  return { status: respuesta.status, cuerpo }
}

async function postear(url: string, cuerpo: unknown): Promise<RespuestaHttp> {
  const respuesta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  })
  const recibido: unknown = await respuesta.json()
  return { status: respuesta.status, cuerpo: recibido }
}

function estadoDeOrden(cuerpo: unknown): string {
  const estado = leer(cuerpo, 'data.status')
  return typeof estado === 'string' ? estado : ''
}

/** Sondea GET /api/orders/:id hasta que la orden llega a un estado final o se agota la espera. */
async function esperarOrdenFinalizada(base: string, ordenId: string): Promise<RespuestaHttp> {
  const limite = Date.now() + ESPERA_MAXIMA_MS
  let ultima = await obtener(`${base}/api/orders/${ordenId}`)
  while (!ESTADOS_FINALES_DE_ORDEN.includes(estadoDeOrden(ultima.cuerpo)) && Date.now() < limite) {
    await dormir(INTERVALO_DE_SONDEO_MS)
    ultima = await obtener(`${base}/api/orders/${ordenId}`)
  }
  return ultima
}

function buscarEnLista(elementos: readonly unknown[], ruta: string, valor: string): unknown {
  return elementos.find((elemento) => leer(elemento, ruta) === valor)
}

describe('e2e del flujo de PICK en simulacion', () => {
  // CAMBIOS DE CONTRATO respecto del test legacy (veredicto ADAPTADO del mapeo T02):
  //
  //  1. /health: el legacy afirmaba solo { ok: true, mode: 'simulation' }. RF25 lo convierte
  //     en health profundo, asi que ahora tambien se afirman conectividad por dispositivo,
  //     profundidad de cola por robot, ultima orden completada, timestamp de arranque y
  //     estado del enlace con el servidor.
  //  2. POST /api/orders: el legacy creaba la orden con origin 'PICKING' por default. RF21 y
  //     RF26 sacan el ingreso de picking de la API local, asi que lo que entra por esta ruta
  //     es una orden MANUAL de la tablet (RF35), con siteId tomado de la configuracion del
  //     agente y no del request. El camino de picking (servidor + long-poll, RF26 y RF28) es
  //     otro test.
  //  3. snapshotStore.last.orders / .slots: RF23 elimina el volcado de snapshot completo y el
  //     store desaparece. Los asserts se hacen contra los repositorios SQLite y contra
  //     GET /api/slots, que ademas ahora expone side y robotId.
  //  4. eventStore.events.length > 0: pasa a leerse de la tabla de eventos, filtrada por
  //     entidad, en vez de contar escrituras sobre un doble inyectado.
  //  5. simulate.data.order.robotId: el legacy lo fijaba contra el mapa hardcodeado
  //     { '3X': '1' }. Ahora es un lookup de robots(site_id, estanteria_code) y el assert se
  //     fija contra la fila del robot dada de alta, no contra la constante.
  //
  // Sobreviven sin tocar: 201 del alta de dispositivo, 200 de simulate, la traduccion
  // 30201 / 101, DONE con currentStepIndex 5, el robot de vuelta en IDLE con la orden activa
  // en null, y 3X02AA1 como slot ganador.
  //
  // Cambia tambien el fixture: la zona de pickeo se siembra con los 12 codigos reales y el
  // robot se da de alta explicitamente (antes salia de un mapa hardcodeado). El puerto es 0 y
  // la direccion se lee de agente.direccion(), porque un puerto fijo es EADDRINUSE en CI.
  it(
    'lleva una orden de PICK a DONE y deja el cajon en el slot mas cercano del mismo lado',
    async () => {
      const agente = crearAgente({
        siteId: SITE_ID,
        agentId: AGENT_ID,
        rutaDeBase: ':memory:',
        montarApi: true,
        simularPlc: true,
        httpPuerto: 0,
        httpBind: '127.0.0.1',
        zonaDePickeo: ZONA_DE_PICKEO,
  // RF22: sin token configurado el comando directo a PLC queda deshabilitado.
  // Este fixture no lo usa, asi que va en null a proposito.
  tokenDeMantenimiento: null,
        // RF36/T26: el enlace con el servidor va APAGADO. Este flujo ejercita el
        // agente solo con su cola local, que es como arranca en el cutover.
        enlace: null,
      })

      await agente.iniciar()

      try {
        const direccion = agente.direccion()
        if (direccion === null) {
          throw new Error('El agente se arranco con la API montada y no expuso su direccion')
        }
        const base = `http://${direccion.host}:${String(direccion.puerto)}`

        const repositorios = agente.orquestador.repositorios

        // Alta del robot: el mapeo estanteria -> robot es una fila, no una constante.
        const altaDelRobot = await repositorios.robots.guardar({
          id: ROBOT_ID,
          siteId: SITE_ID,
          estanteriaCode: ESTANTERIA,
          habilitado: true,
          estado: 'IDLE',
          ordenActivaId: null,
        })
        expect(altaDelRobot.ok).toBe(true)

        // Zona de pickeo: sembrarla es idempotente y cada slot nuevo nace LIBRE.
        const zonaSembrada = await repositorios.slots.sembrarZonaDePickeo(ROBOT_ID, ZONA_DE_PICKEO)
        expect(zonaSembrada.ok).toBe(true)
        if (!zonaSembrada.ok) {
          throw new Error('No se pudo sembrar la zona de pickeo')
        }
        expect(zonaSembrada.valor).toHaveLength(ZONA_DE_PICKEO.length)
        expect(zonaSembrada.valor.every((slot) => slot.estado.estado === 'LIBRE')).toBe(true)

        // --- Alta de los dos dispositivos del robot (201, contrato preservado) ---
        const altaCarro = await postear(`${base}/api/devices/register`, {
          robotId: ROBOT_ID,
          type: 'CARRO',
          host: '127.0.0.1',
          port: 502,
        })
        expect(altaCarro.status).toBe(201)
        expect(leer(altaCarro.cuerpo, 'ok')).toBe(true)

        const altaElevador = await postear(`${base}/api/devices/register`, {
          robotId: ROBOT_ID,
          type: 'ELEVADOR',
          host: '127.0.0.1',
          port: 502,
        })
        expect(altaElevador.status).toBe(201)
        expect(leer(altaElevador.cuerpo, 'ok')).toBe(true)

        const dispositivos = await repositorios.dispositivos.listarPorRobot(ROBOT_ID)
        expect(dispositivos.map((dispositivo) => dispositivo.tipo).sort()).toEqual([
          'CARRO',
          'ELEVADOR',
        ])
        const carroPersistido = await repositorios.dispositivos.buscar(ROBOT_ID, 'CARRO')
        expect(carroPersistido?.host).toBe('127.0.0.1')
        expect(carroPersistido?.puerto).toBe(502)

        // --- Preview de traduccion (200, no crea orden) ---
        const simulacion = await postear(`${base}/api/orders/simulate`, {
          type: 'PICK',
          locationCode: ORIGEN,
        })
        expect(simulacion.status).toBe(200)
        expect(leer(simulacion.cuerpo, 'ok')).toBe(true)

        // El robotId sale de la fila del robot, no de un mapa hardcodeado (cambio 5).
        const robotDeLaEstanteria = await repositorios.robots.buscarPorEstanteria(
          SITE_ID,
          ESTANTERIA,
        )
        expect(robotDeLaEstanteria?.id).toBe(ROBOT_ID)
        expect(leer(simulacion.cuerpo, 'data.order.robotId')).toBe(robotDeLaEstanteria?.id)
        expect(leer(simulacion.cuerpo, 'data.order.locationCode')).toBe(ORIGEN)

        expect(leer(simulacion.cuerpo, 'data.commandPreview.carroBring.commandCode')).toBe(
          COMANDO_CARRO_TRAER,
        )
        expect(leer(simulacion.cuerpo, 'data.commandPreview.carroReturn.commandCode')).toBe(
          COMANDO_CARRO_DEJAR,
        )
        expect(leer(simulacion.cuerpo, 'data.commandPreview.elevadorGoLevel.commandCode')).toBe(
          COMANDO_ELEVADOR_NIVEL_A,
        )
        expect(leer(simulacion.cuerpo, 'data.location.lado')).toBe('RIGHT')
        expect(leer(simulacion.cuerpo, 'data.location.nivel')).toBe(1)

        // Los cinco movimientos fisicos del robot, en orden (RF04).
        const comandosDePaso = lista(simulacion.cuerpo, 'data.stepCommands')
        expect(comandosDePaso).toHaveLength(5)
        expect(comandosDePaso.map((paso) => leer(paso, 'deviceType'))).toEqual([
          'CARRO',
          'ELEVADOR',
          'CARRO',
          'ELEVADOR',
          'CARRO',
        ])
        expect(leer(comandosDePaso[0], 'commandCode')).toBe(COMANDO_CARRO_INIT)
        expect(leer(comandosDePaso[1], 'commandCode')).toBe(COMANDO_ELEVADOR_NIVEL_A)
        expect(leer(comandosDePaso[2], 'commandCode')).toBe(COMANDO_CARRO_TRAER)
        // El preview deja de exponer campos que nunca se calculan.
        expect(leer(comandosDePaso[0], 'address')).toBeUndefined()
        expect(leer(comandosDePaso[0], 'responseAddress')).toBeUndefined()
        expect(leer(comandosDePaso[0], 'verifyAddress')).toBeUndefined()
        expect(leer(comandosDePaso[0], 'expectedValue')).toBeUndefined()

        // --- Alta de la orden: por la API local ya solo entran ordenes MANUALES (cambio 2) ---
        const alta = await postear(`${base}/api/orders`, { type: 'PICK', locationCode: ORIGEN })
        expect(alta.status).toBe(202)
        expect(leer(alta.cuerpo, 'ok')).toBe(true)
        expect(leer(alta.cuerpo, 'created')).toBe(true)
        expect(leer(alta.cuerpo, 'data.type')).toBe('PICK')
        expect(leer(alta.cuerpo, 'data.origin')).toBe('MANUAL')
        expect(leer(alta.cuerpo, 'data.robotId')).toBe(ROBOT_ID)
        expect(leer(alta.cuerpo, 'data.locationCode')).toBe(ORIGEN)
        // El siteId sale de la configuracion del agente, nunca del request de la tablet.
        expect(leer(alta.cuerpo, 'data.siteId')).toBe(SITE_ID)
        // RF35: la orden local nace con externalOrderId propio. El prefijo por agente no
        // tiene test portado (figura en "RF sin cobertura"), asi que solo se exige que exista.
        expect(typeof leer(alta.cuerpo, 'data.externalOrderId')).toBe('string')

        const ordenId = texto(alta.cuerpo, 'data.id')

        // --- El orquestador la ejecuta ---
        const final = await esperarOrdenFinalizada(base, ordenId)
        expect(final.status).toBe(200)
        expect(leer(final.cuerpo, 'data.status')).toBe('DONE')
        // El canario de los cinco pasos: si cambia la cantidad de pasos, cambia este numero.
        expect(leer(final.cuerpo, 'data.currentStepIndex')).toBe(5)
        expect(leer(final.cuerpo, 'data.waitingForSlot')).toBe(false)
        expect(leer(final.cuerpo, 'data.errorReason')).toBeNull()
        expect(leer(final.cuerpo, 'data.slotLocationCode')).toBe(SLOT_GANADOR)

        // --- La fuente de verdad es SQLite, no un snapshot en memoria (cambio 3) ---
        const ordenPersistida = await repositorios.ordenes.buscarPorId(ordenId)
        expect(ordenPersistida?.estado).toBe('DONE')
        expect(ordenPersistida?.origen).toBe('MANUAL')
        expect(ordenPersistida?.siteId).toBe(SITE_ID)
        expect(ordenPersistida?.robotId).toBe(ROBOT_ID)
        expect(ordenPersistida?.currentStepIndex).toBe(5)
        expect(ordenPersistida?.slotLocationCode).toBe(SLOT_GANADOR)
        expect(ordenPersistida?.waitingForSlot).toBe(false)
        expect(ordenPersistida?.errorReason).toBeNull()
        expect(typeof ordenPersistida?.finalizadaEn).toBe('number')

        const pasos = await repositorios.pasos.listarPorOrden(ordenId)
        expect(pasos.map((paso) => paso.seq)).toEqual([1, 2, 3, 4, 5])
        expect(pasos.map((paso) => paso.tipo)).toEqual([
          'HOMING',
          'ELEVADOR_NIVEL_ORIGEN',
          'CARRO_BUSCA',
          'ELEVADOR_NIVEL_DESTINO',
          'CARRO_DEJA',
        ])
        expect(pasos.map((paso) => paso.dispositivo)).toEqual([
          'CARRO',
          'ELEVADOR',
          'CARRO',
          'ELEVADOR',
          'CARRO',
        ])
        expect(pasos.every((paso) => paso.estado === 'DONE')).toBe(true)

        // El cajon quedo apoyado en el slot ganador, con una devolucion pendiente.
        const zona = await repositorios.slots.listarPorRobot(ROBOT_ID)
        expect(zona).toHaveLength(ZONA_DE_PICKEO.length)
        const ganador = zona.find((slot) => slot.locationCode === SLOT_GANADOR)
        expect(ganador?.lado).toBe('RIGHT')
        const estadoDelGanador = ganador?.estado
        if (estadoDelGanador === undefined || estadoDelGanador.estado !== 'OCUPADO') {
          throw new Error(`El slot ${SLOT_GANADOR} tendria que haber quedado OCUPADO`)
        }
        expect(estadoDelGanador.contenido.pendingReturns).toBe(1)
        expect(estadoDelGanador.contenido.cajon.ubicacionDeOrigen).toBe(ORIGEN)
        // Ningun otro slot se toco: los del lado izquierdo ni siquiera compiten.
        const otros = zona.filter((slot) => slot.locationCode !== SLOT_GANADOR)
        expect(otros.every((slot) => slot.estado.estado === 'LIBRE')).toBe(true)

        // Los eventos se leen de su tabla, por entidad (cambio 4).
        const eventosDeLaOrden = await repositorios.eventos.listar({
          tipoDeEntidad: 'ORDER',
          entidadId: ordenId,
        })
        expect(eventosDeLaOrden.length).toBeGreaterThan(0)

        // --- GET /api/slots: ahora expone side y robotId por slot ---
        const slotsHttp = await obtener(`${base}/api/slots`)
        expect(slotsHttp.status).toBe(200)
        expect(leer(slotsHttp.cuerpo, 'ok')).toBe(true)
        const slotsServidos = lista(slotsHttp.cuerpo, 'data')
        expect(slotsServidos).toHaveLength(ZONA_DE_PICKEO.length)
        const ganadorServido = buscarEnLista(slotsServidos, 'locationCode', SLOT_GANADOR)
        expect(leer(ganadorServido, 'status')).toBe('OCUPADO')
        expect(leer(ganadorServido, 'side')).toBe('RIGHT')
        expect(leer(ganadorServido, 'robotId')).toBe(ROBOT_ID)

        // --- El robot vuelve a estar libre ---
        const robotsHttp = await obtener(`${base}/api/devices/robots`)
        expect(robotsHttp.status).toBe(200)
        expect(leer(robotsHttp.cuerpo, 'ok')).toBe(true)
        const robotServido = buscarEnLista(lista(robotsHttp.cuerpo, 'data'), 'id', ROBOT_ID)
        expect(leer(robotServido, 'status')).toBe('IDLE')
        expect(leer(robotServido, 'queue.activeOrderId')).toBeNull()

        const robotPersistido = await repositorios.robots.buscarPorId(ROBOT_ID)
        expect(robotPersistido?.estado).toBe('IDLE')
        expect(robotPersistido?.ordenActivaId).toBeNull()

        // --- /health profundo (cambio 1) ---
        const health = await obtener(`${base}/health`)
        expect(health.status).toBe(200)
        expect(leer(health.cuerpo, 'ok')).toBe(true)
        expect(leer(health.cuerpo, 'mode')).toBe('simulation')
        expect(typeof leer(health.cuerpo, 'startedAt')).toBe('number')
        // Conectividad por dispositivo: los dos dados de alta, conectados en simulacion.
        const dispositivosDeHealth = lista(health.cuerpo, 'devices')
        expect(dispositivosDeHealth).toHaveLength(2)
        const carroDeHealth = buscarEnLista(dispositivosDeHealth, 'type', 'CARRO')
        expect(leer(carroDeHealth, 'robotId')).toBe(ROBOT_ID)
        expect(leer(carroDeHealth, 'connected')).toBe(true)
        // Profundidad de cola por robot y ultima orden completada.
        const robotDeHealth = buscarEnLista(lista(health.cuerpo, 'robots'), 'id', ROBOT_ID)
        expect(leer(robotDeHealth, 'queueDepth')).toBe(0)
        expect(leer(robotDeHealth, 'status')).toBe('IDLE')
        expect(leer(health.cuerpo, 'lastCompletedOrder.id')).toBe(ordenId)
        // Estado del enlace con el servidor: sin modo silencioso, siempre lo dice (RF36).
        expect(typeof leer(health.cuerpo, 'link.status')).toBe('string')
      } finally {
        await agente.detener()
      }
    },
    TIMEOUT_DEL_TEST_MS,
  )
})
