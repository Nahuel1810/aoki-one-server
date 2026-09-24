// RF21 — Las tres rutas que el front ya llamaba y el agente no tenia:
// POST /api/orders/:id/cancel y POST /api/orders/queue/:robotId/pause|resume.
//
// Hasta ahora las tres daban 404 y `snapshotDeCola` devolvia `paused: false`
// cableado, o sea que el boton de pausar de la tablet no pausaba nada y el
// indicador del header decia "En marcha" pasara lo que pasara.
//
// Las dos afirmaciones que importan son sobre el MUNDO FISICO y por eso se
// cuentan maniobras, no estados:
//
//   - cancelar una orden que el robot ya esta ejecutando tiene que FALLAR. El
//     ciclo que la ejecuta esta adentro del handshake con el PLC y no mira el
//     estado de la orden: marcarla cancelada no frena al carro, deja el cajon a
//     mitad de camino y los libros diciendo que no hay nada en curso.
//   - pausar NO es abortar. La orden en vuelo tiene que terminar sus cinco
//     movimientos igual; lo unico que se detiene es la toma de ordenes nuevas.
//
// El PLC se inyecta como puerto de transporte porque el modo simulacion contesta
// OK siempre y no deja RETENER un comando, que es lo unico que permite parar el
// tiempo en el medio exacto de una maniobra y preguntar ahi.

import { setTimeout as dormir } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LOGGER_SILENCIOSO, type TipoDispositivo } from '@aoki-one/domain'

import { crearAgente, type Agente } from '../composition.js'
import type { PuertoDeTransporteConcreto } from '../transport/transportePort.js'

const SITE_ID = 'sucursal-cola'
const AGENT_ID = 'AG-COLA'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'

/** Dos origenes del mismo lado en niveles distintos: cada uno gana un slot propio. */
const ORIGEN_A = '3X04AA3'
const ORIGEN_E = '3X06AE1'

const ZONA_DE_PICKEO: readonly string[] = [
  '3X02AE1',
  '3X02AC1',
  '3X02AA1',
  '3X01AE1',
  '3X01AC1',
  '3X01AA1',
]

/** Los cinco movimientos fisicos de una orden. Es el canario de "hubo maniobra". */
const MANIOBRAS_POR_ORDEN = 5

const ESPERA_MAXIMA_MS = 10_000
const INTERVALO_DE_SONDEO_MS = 20
const TIMEOUT_DEL_TEST_MS = 30_000

/**
 * Margen para afirmar que algo NO pasa.
 *
 * Tiene que superar al tick de seguridad del loop (250 ms): con una espera mas
 * corta, "el robot no arranco" seria "el robot todavia no llego a mirar".
 */
const MARGEN_PARA_AFIRMAR_QUE_NO_PASA_MS = 500

// ------------------------------------------------------------- el PLC simulado

interface PlcSimulado {
  /** Que hacer con cada comando. Se cambia en caliente durante el test. */
  politica: (numeroDeComando: number) => 'OK' | 'RETENER'
  readonly comandos: number[]
  readonly puerto: PuertoDeTransporteConcreto
  /** Resuelve cuando un comando queda retenido. */
  readonly esperarRetenido: () => Promise<void>
  readonly soltar: () => void
}

function crearPlcSimulado(): PlcSimulado {
  const comandos: number[] = []
  let soltarRetenido: (() => void) | null = null
  let avisarRetencion: (() => void) | null = null
  let hayRetenido = false

  const plc: PlcSimulado = {
    politica: () => 'OK',
    comandos,

    esperarRetenido: () =>
      new Promise<void>((resolve) => {
        if (hayRetenido) {
          resolve()
          return
        }
        avisarRetencion = resolve
      }),

    soltar: () => {
      soltarRetenido?.()
      soltarRetenido = null
      hayRetenido = false
    },

    puerto: {
      ejecutarComandoDePaso: async (_robotId: string, _tipo: TipoDispositivo, pedido) => {
        comandos.push(pedido.comando)
        if (plc.politica(comandos.length) === 'RETENER') {
          await new Promise<void>((resolve) => {
            soltarRetenido = resolve
            hayRetenido = true
            avisarRetencion?.()
            avisarRetencion = null
          })
        }
        return { ok: true, valor: { kind: 'OK' } }
      },

      resetearMessageIn: () => Promise.resolve({ ok: true, valor: undefined }),
      leerRegistros: () =>
        Promise.resolve({ ok: true, valor: { messageIn1: 0, messageIn2: null, messageOut: 0 } }),
      cerrar: () => Promise.resolve(),
    },
  }

  return plc
}

// ----------------------------------------------------------------- el banco

let agente: Agente | null = null
let plc: PlcSimulado
let base = ''

beforeEach(async () => {
  plc = crearPlcSimulado()
  agente = crearAgente({
    siteId: SITE_ID,
    agentId: AGENT_ID,
    rutaDeBase: ':memory:',
    montarApi: true,
    simularPlc: true,
    httpPuerto: 0,
    httpBind: '127.0.0.1',
    zonaDePickeo: ZONA_DE_PICKEO,
    tokenDeMantenimiento: null,
    // Sin enlace: estas tres rutas son de la LAN de la sucursal y no dependen del
    // servidor de pedidos. Que la cancelacion llegue al servidor se afirma en el
    // e2e, que si tiene los dos procesos.
    enlace: null,
    logger: LOGGER_SILENCIOSO,
    transporte: plc.puerto,
  })

  const robot = await agente.orquestador.repositorios.robots.guardar({
    id: ROBOT_ID,
    siteId: SITE_ID,
    estanteriaCode: ESTANTERIA,
    habilitado: true,
    estado: 'IDLE',
    ordenActivaId: null,
  })
  if (!robot.ok) {
    throw new Error('no se pudo sembrar el robot')
  }

  await agente.iniciar()
  const direccion = agente.direccion()
  if (direccion === null) {
    throw new Error('el agente se arranco con la API montada y no expuso su direccion')
  }
  base = `http://${direccion.host}:${String(direccion.puerto)}`
})

afterEach(async () => {
  // Un comando retenido cuelga `detener()` para siempre: espera al ciclo que lo
  // tiene tomado.
  plc.politica = () => 'OK'
  plc.soltar()
  await agente?.detener()
  agente = null
})

// ---------------------------------------------------------------- ayudantes

interface RespuestaHttp {
  readonly status: number
  readonly cuerpo: Record<string, unknown>
}

async function postear(ruta: string): Promise<RespuestaHttp> {
  const respuesta = await fetch(`${base}${ruta}`, { method: 'POST' })
  return { status: respuesta.status, cuerpo: (await respuesta.json()) as Record<string, unknown> }
}

async function leer(ruta: string): Promise<RespuestaHttp> {
  const respuesta = await fetch(`${base}${ruta}`)
  return { status: respuesta.status, cuerpo: (await respuesta.json()) as Record<string, unknown> }
}

/** Alta de una orden manual por la misma ruta que usa la tablet. */
async function altaDeOrden(locationCode: string): Promise<string> {
  const respuesta = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'PICK', locationCode }),
  })
  expect(respuesta.status).toBe(202)
  const cuerpo = (await respuesta.json()) as { data: Record<string, unknown> }
  return String(cuerpo.data['id'])
}

async function estadoDeOrden(ordenId: string): Promise<string> {
  const respuesta = await leer(`/api/orders/${ordenId}`)
  return String((respuesta.cuerpo['data'] as Record<string, unknown>)['status'])
}

async function colaDelRobot(): Promise<Record<string, unknown>> {
  const respuesta = await leer('/api/orders/queue/status')
  const filas = respuesta.cuerpo['data'] as Record<string, unknown>[]
  const fila = filas[0]
  if (fila === undefined) {
    throw new Error('la cola no trajo ninguna fila')
  }
  return fila
}

async function esperarA(que: string, condicion: () => Promise<boolean>): Promise<void> {
  const limite = Date.now() + ESPERA_MAXIMA_MS
  for (;;) {
    if (await condicion()) {
      return
    }
    if (Date.now() >= limite) {
      throw new Error(`se agoto la espera: ${que}`)
    }
    await dormir(INTERVALO_DE_SONDEO_MS)
  }
}

const esperarOrdenEn = (ordenId: string, estado: string): Promise<void> =>
  esperarA(`la orden ${ordenId} tendria que quedar en ${estado}`, async () => {
    return (await estadoDeOrden(ordenId)) === estado
  })

// ------------------------------------------------------------------- tests

describe('POST /api/orders/:id/cancel (RF21)', () => {
  it(
    'saca de la cola un pedido PENDING y el robot no lo ejecuta nunca',
    async () => {
      // El primer comando queda retenido: el robot queda ocupado con la primera
      // orden y la segunda espera en la cola, que es donde se la cancela.
      plc.politica = (numero) => (numero === 1 ? 'RETENER' : 'OK')
      const enVuelo = await altaDeOrden(ORIGEN_A)
      await plc.esperarRetenido()

      const encolada = await altaDeOrden(ORIGEN_E)
      expect(await estadoDeOrden(encolada)).toBe('PENDING')

      const cancelacion = await postear(`/api/orders/${encolada}/cancel`)
      expect(cancelacion.status).toBe(200)
      expect(cancelacion.cuerpo['ok']).toBe(true)
      expect((cancelacion.cuerpo['data'] as Record<string, unknown>)['status']).toBe('CANCELED')

      // Se suelta el PLC: la primera orden termina y el robot queda libre para
      // tomar la siguiente... que ya no existe.
      plc.soltar()
      await esperarOrdenEn(enVuelo, 'DONE')
      await dormir(MARGEN_PARA_AFIRMAR_QUE_NO_PASA_MS)

      // La prueba de que no se ejecuto es el CONTEO de maniobras: una sola orden
      // movio el robot, no dos.
      expect(plc.comandos).toHaveLength(MANIOBRAS_POR_ORDEN)
      expect(await estadoDeOrden(encolada)).toBe('CANCELED')
      expect(await colaDelRobot()).toMatchObject({ queueLength: 0, activeOrderId: null })
    },
    TIMEOUT_DEL_TEST_MS,
  )

  it(
    'NO cancela un pedido que el robot ya esta ejecutando, y ese pedido termina igual',
    async () => {
      plc.politica = (numero) => (numero === 1 ? 'RETENER' : 'OK')
      const enVuelo = await altaDeOrden(ORIGEN_A)
      await plc.esperarRetenido()
      expect(await estadoDeOrden(enVuelo)).toBe('IN_PROGRESS')

      const cancelacion = await postear(`/api/orders/${enVuelo}/cancel`)
      expect(cancelacion.status).toBe(409)
      expect(cancelacion.cuerpo['ok']).toBe(false)
      // El operario lee este texto tal cual en la tablet: tiene que entender que
      // el pedido sigue vivo porque el robot lo esta haciendo, no que "fallo".
      expect(cancelacion.cuerpo['error']).toBe(
        'no se puede cancelar un pedido que el robot ya esta ejecutando',
      )

      // Y el rechazo no dejo nada a medias: la maniobra sigue su curso y termina.
      plc.soltar()
      await esperarOrdenEn(enVuelo, 'DONE')
      expect(plc.comandos).toHaveLength(MANIOBRAS_POR_ORDEN)
    },
    TIMEOUT_DEL_TEST_MS,
  )

  it('un pedido que no existe es 404 y no 409: no es un conflicto de estado', async () => {
    const respuesta = await postear('/api/orders/no-existe/cancel')

    expect(respuesta.status).toBe(404)
    expect(respuesta.cuerpo['ok']).toBe(false)
    expect(respuesta.cuerpo['error']).toBe('ORDEN_INEXISTENTE')
  })
})

describe('POST /api/orders/queue/:robotId/pause|resume (RF21)', () => {
  it(
    'con la cola en pausa el robot no toma ordenes nuevas, y al reanudar las toma',
    async () => {
      const pausa = await postear(`/api/orders/queue/${ROBOT_ID}/pause`)
      expect(pausa.status).toBe(200)
      // El header del front lee `paused` de esta misma fila: hasta ahora venia
      // false cableado y el indicador decia "En marcha" con la cola detenida.
      expect(pausa.cuerpo['data']).toMatchObject({ robotId: ROBOT_ID, paused: true })
      expect(await colaDelRobot()).toMatchObject({ paused: true })

      const ordenId = await altaDeOrden(ORIGEN_A)
      await dormir(MARGEN_PARA_AFIRMAR_QUE_NO_PASA_MS)

      expect(await estadoDeOrden(ordenId)).toBe('PENDING')
      expect(plc.comandos).toHaveLength(0)
      expect(await colaDelRobot()).toMatchObject({ queueLength: 1, activeOrderId: null })

      const reanudacion = await postear(`/api/orders/queue/${ROBOT_ID}/resume`)
      expect(reanudacion.status).toBe(200)
      expect(reanudacion.cuerpo['data']).toMatchObject({ paused: false })

      // Reanudar despierta el loop: la orden arranca sin esperar al tick.
      await esperarOrdenEn(ordenId, 'DONE')
      expect(plc.comandos).toHaveLength(MANIOBRAS_POR_ORDEN)
    },
    TIMEOUT_DEL_TEST_MS,
  )

  it(
    'pausar NO aborta la orden en curso: termina sus cinco movimientos',
    async () => {
      // El tercer comando queda retenido: la orden esta a mitad de la maniobra,
      // con el carro ya en movimiento, cuando llega la pausa.
      plc.politica = (numero) => (numero === 3 ? 'RETENER' : 'OK')
      const enVuelo = await altaDeOrden(ORIGEN_A)
      await plc.esperarRetenido()
      expect(await estadoDeOrden(enVuelo)).toBe('IN_PROGRESS')

      expect((await postear(`/api/orders/queue/${ROBOT_ID}/pause`)).status).toBe(200)
      const encolada = await altaDeOrden(ORIGEN_E)

      plc.soltar()

      // Pausar no es abortar: la que estaba en vuelo hace los cinco movimientos.
      await esperarOrdenEn(enVuelo, 'DONE')
      await dormir(MARGEN_PARA_AFIRMAR_QUE_NO_PASA_MS)
      expect(plc.comandos).toHaveLength(MANIOBRAS_POR_ORDEN)

      // Y la siguiente espera: la pausa frena la TOMA de ordenes, nada mas.
      expect(await estadoDeOrden(encolada)).toBe('PENDING')
      expect(await colaDelRobot()).toMatchObject({ paused: true, queueLength: 1 })
    },
    TIMEOUT_DEL_TEST_MS,
  )

  it('pausar la cola de un robot que no existe es 404', async () => {
    const respuesta = await postear('/api/orders/queue/9/pause')

    expect(respuesta.status).toBe(404)
    expect(respuesta.cuerpo['ok']).toBe(false)
    expect(respuesta.cuerpo['error']).toBe('ROBOT_INEXISTENTE')
  })
})
