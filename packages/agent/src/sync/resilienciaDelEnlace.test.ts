// RF33 a RF37 — Lo que el enlace tiene que aguantar para no colgar la sucursal.
//
// El test que manda es el primero: un servidor que ACEPTA la conexion y no
// contesta nunca. Es la caida tipica de un enlace de sucursal —proceso frozen,
// firewall en DROP, NAT que descarta el flujo— y la peor, porque no falla: sin
// timeout la request no vuelve, el bucle queda clavado, `/health` sigue diciendo
// CONNECTED con el outbox creciendo y `detener()` no termina, lo que cuelga el
// apagado del agente entero. Un puerto donde no escucha nadie NO sirve para
// afirmarlo: eso da un ECONNREFUSED inmediato, que es el caso facil.
//
// El resto son las otras formas de quedarse clavado: un throw que se escapa del
// canal de Result, una fila que bloquea la cola para siempre, un estado local que
// nunca se reconcilia con el servidor y un ciclo sin piso de frecuencia.

import { createServer, type Server, type Socket } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LOGGER_SILENCIOSO, type Result } from '@aoki-one/domain'

import { admitirOrden } from '../orchestrator/orderIntake.js'
import type { DependenciasDelOrquestador, PuertoDeTransporte } from '../orchestrator/ports.js'
import { abrirBase, type BaseDelAgente } from '../persistence/database.js'
import { crearRepositorios, type RepositoriosDelAgente } from '../persistence/index.js'
import type { Reloj } from '../reloj.js'
import type { Azar } from './backoff.js'
import { crearEnlace, type Enlace, type OpcionesDeEnlace } from './link.js'
import { crearOrigenPorLongPoll, type OrderSource } from './orderSource.js'
import { crearOutboxSqlite, type OutboxDeTransiciones } from './outbox.js'
import {
  crearClienteHttp,
  type ClienteDelServidor,
  type FalloDeEnlace,
  type PedidoRemoto,
  type ReporteDeTransicion,
  type ResultadoDeReporte,
} from './serverClient.js'
import { aplicarTransicionDeOrden } from './transitions.js'

const SITE_ID = 'SUC-TEST'
const AGENT_ID = 'AG-TEST'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'
const ORIGEN_DEL_CAJON = '3X04AE1'
const AHORA_MS = 1_700_000_000_000

const TRANSPORTE_SIN_USO: PuertoDeTransporte = {
  ejecutarComandoDePaso: () => {
    throw new Error('el enlace no ejecuta pasos')
  },
  resetearMessageIn: () => {
    throw new Error('el enlace no toca el PLC')
  },
  leerRegistros: () => {
    throw new Error('el enlace no lee registros')
  },
}

const AZAR: Azar = { siguiente: () => 0.5 }

const OPCIONES: OpcionesDeEnlace = {
  limiteDeReclamo: 10,
  loteDeOutbox: 50,
  intervaloDeLatidoMs: 15_000,
  esperaMinimaEntreCiclosMs: 250,
  maxIntentosDeTransicion: 3,
  backoff: { baseMs: 1, techoMs: 5, fraccionDeJitter: 0.5 },
}

interface ServidorMudo {
  readonly puerto: number
  readonly cerrar: () => Promise<void>
}

/**
 * Un servidor que acepta el TCP y no contesta jamas.
 *
 * No cierra el socket ni manda un byte: la request queda abierta hasta que el
 * cliente se cansa. Es lo unico que ejercita el timeout de verdad.
 */
function crearServidorMudo(): Promise<ServidorMudo> {
  return new Promise<ServidorMudo>((resolve, reject) => {
    const abiertos: Socket[] = []
    const servidor: Server = createServer((socket) => {
      // La referencia se guarda para poder matar el socket al final: uno vivo
      // mantiene en pie el proceso de la suite.
      abiertos.push(socket)
      socket.on('error', () => undefined)
    })
    servidor.once('error', reject)
    servidor.listen(0, '127.0.0.1', () => {
      const direccion = servidor.address()
      if (direccion === null || typeof direccion === 'string') {
        reject(new Error('no se pudo levantar el servidor mudo'))
        return
      }
      resolve({
        puerto: direccion.port,
        cerrar: () =>
          new Promise<void>((listo) => {
            for (const socket of abiertos) {
              socket.destroy()
            }
            servidor.close(() => {
              listo()
            })
          }),
      })
    })
  })
}

/** Doble del servidor. Cada test dice que contesta y despues mira que le pidieron. */
interface ClienteDoble {
  readonly cliente: ClienteDelServidor
  readonly reportes: ReporteDeTransicion[]
  latidos: number
  reclamos: number
  trabajo: readonly PedidoRemoto[]
  respuestaDeReporte: Result<ResultadoDeReporte, FalloDeEnlace>
}

function crearClienteDoble(): ClienteDoble {
  const doble: ClienteDoble = {
    reportes: [],
    latidos: 0,
    reclamos: 0,
    trabajo: [],
    respuestaDeReporte: { ok: true, valor: { tipo: 'APLICADA' } },
    cliente: {
      reclamarTrabajo: () => {
        doble.reclamos += 1
        return Promise.resolve({ ok: true, valor: doble.trabajo })
      },
      reportarTransicion: (reporte) => {
        doble.reportes.push(reporte)
        return Promise.resolve(doble.respuestaDeReporte)
      },
      empujarOrden: (alta) =>
        Promise.resolve({
          ok: true,
          valor: {
            id: `remota-de-${alta.externalOrderId}`,
            externalOrderId: alta.externalOrderId,
            tipo: alta.tipo,
            locationCode: alta.locationCode,
          },
        }),
      latir: () => {
        doble.latidos += 1
        return Promise.resolve({ ok: true, valor: undefined })
      },
    },
  }
  return doble
}

let base: BaseDelAgente
let repositorios: RepositoriosDelAgente
let outbox: OutboxDeTransiciones
let orquestador: DependenciasDelOrquestador
let esperas: number[]

/**
 * Reloj que anota las esperas y no duerme: el backoff no puede alargar la suite.
 *
 * Cede el turno con un `setTimeout(0)` y no con una promesa ya resuelta. Sin eso
 * el bucle del enlace no sale nunca de la cola de microtareas, los timers del
 * test se quedan sin correr y el que se cuelga es el test.
 */
function crearRelojQueAnota(): Reloj {
  return {
    ahoraMs: () => AHORA_MS,
    dormir: (ms) => {
      esperas.push(ms)
      return new Promise<void>((listo) => {
        setTimeout(listo, 0)
      })
    },
  }
}

beforeEach(async () => {
  base = abrirBase(':memory:')
  repositorios = crearRepositorios(base)
  outbox = crearOutboxSqlite(base)
  esperas = []

  let contador = 0
  orquestador = {
    repositorios,
    siteId: SITE_ID,
    agentId: AGENT_ID,
    logger: LOGGER_SILENCIOSO,
    generarId: () => {
      contador += 1
      return `id-${String(contador)}`
    },
    transporte: TRANSPORTE_SIN_USO,
    reloj: crearRelojQueAnota(),
    politica: { maxIntentos: 3, baseBackoffMs: 1 },
    outbox,
  }

  const robot = await repositorios.robots.guardar({
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
})

afterEach(() => {
  base.cerrar()
})

function armarEnlace(origen: OrderSource, cliente: ClienteDelServidor, opciones = OPCIONES): Enlace {
  return crearEnlace({
    origen,
    cliente,
    outbox,
    orquestador,
    azar: AZAR,
    opciones,
    despertar: () => undefined,
  })
}

describe('un servidor que acepta la conexion y no contesta (RF36, RF37)', () => {
  it(
    'se degrada por timeout en vez de quedarse clavado para siempre',
    async () => {
      const mudo = await crearServidorMudo()
      try {
        const cliente = crearClienteHttp({
          urlBase: `http://127.0.0.1:${String(mudo.puerto)}`,
          siteId: SITE_ID,
          agentId: AGENT_ID,
          credencial: { keyId: 'key', secreto: 'secreto' },
          // Timeouts cortos: lo que se afirma es que EXISTEN, no cuanto valen.
          tiempos: { timeoutMs: 300, timeoutDeLongPollMs: 400 },
          pedir: fetch,
          ahoraMs: () => AHORA_MS,
        })
        const enlace = armarEnlace(crearOrigenPorLongPoll(cliente), cliente)

        const ciclo = await enlace.sincronizar()

        // Sin timeout esto no vuelve nunca y el test muere por su propio limite.
        expect(ciclo.tipo).toBe('DEGRADADO')
        if (ciclo.tipo === 'DEGRADADO') {
          expect(ciclo.fallo.tipo).toBe('SIN_RED')
        }
        const estado = await enlace.estado()
        // Lo que el operario ve en la tablet: degradado y sin ningun contacto
        // bueno. El modo silencioso es el peor final posible (RF36).
        expect(estado.status).toBe('DEGRADED')
        expect(estado.lastContactAt).toBeNull()
      } finally {
        await mudo.cerrar()
      }
    },
    10_000,
  )

  it(
    'detener() vuelve porque aborta la request en vuelo, no porque la espera',
    async () => {
      const mudo = await crearServidorMudo()
      try {
        const cliente = crearClienteHttp({
          urlBase: `http://127.0.0.1:${String(mudo.puerto)}`,
          siteId: SITE_ID,
          agentId: AGENT_ID,
          credencial: { keyId: 'key', secreto: 'secreto' },
          // Timeout mas largo que el limite del test: si `detener()` esperara al
          // timeout en vez de abortar, esto no terminaria a tiempo.
          tiempos: { timeoutMs: 60_000, timeoutDeLongPollMs: 60_000 },
          pedir: fetch,
          ahoraMs: () => AHORA_MS,
        })
        const enlace = armarEnlace(crearOrigenPorLongPoll(cliente), cliente)

        enlace.iniciar()
        // Se le da tiempo a que la request salga y quede colgada del servidor mudo.
        await new Promise((listo) => setTimeout(listo, 100))
        await enlace.detener()

        // Que `detener()` haya vuelto ya es el invariante: la composicion del
        // agente lo espera ANTES de apagar todo lo demas, asi que un enlace que
        // no se detiene cuelga el apagado del proceso entero.
        expect((await enlace.estado()).status).toBe('DEGRADED')
      } finally {
        await mudo.cerrar()
      }
    },
    10_000,
  )
})

describe('ningun throw se escapa del canal de Result (RF34)', () => {
  it('una excepcion dentro del ciclo sale como DEGRADADO y no mata el bucle', async () => {
    const doble = crearClienteDoble()
    const origen: OrderSource = {
      nombre: 'EXPLOSIVO',
      reclamar: () => {
        throw new Error('el origen reviento')
      },
    }
    const enlace = armarEnlace(origen, doble.cliente)

    const ciclo = await enlace.sincronizar()

    // Sin esta contencion la excepcion viaja hasta el bucle, que la deja como
    // promesa rechazada sin manejar: se muere el proceso del agente entero
    // mientras `/health` sigue informando CONNECTED.
    expect(ciclo).toEqual({
      tipo: 'DEGRADADO',
      fallo: { tipo: 'FALLO_INESPERADO', mensaje: 'el origen reviento' },
    })
    expect((await enlace.estado()).status).toBe('DEGRADED')

    // Y el bucle sobrevive: arranca, gira y se detiene.
    enlace.iniciar()
    await enlace.detener()
  })
})

describe('el estado local y su reporte se escriben juntos (RF34)', () => {
  it('quedan las dos escrituras o no queda ninguna', async () => {
    const admision = await admitirOrden(orquestador, {
      robotId: null,
      externalOrderId: null,
      tipo: 'PICK',
      origen: 'MANUAL',
      locationCode: ORIGEN_DEL_CAJON,
      targetLocation: null,
    })
    if (!admision.ok) {
      throw new Error('la orden tenia que admitirse')
    }
    const ordenId = admision.valor.orden.id

    const aplicada = await aplicarTransicionDeOrden(
      orquestador,
      ordenId,
      { estado: 'DONE', finalizadaEn: AHORA_MS },
      'DONE',
      { huboManiobra: true },
    )

    expect(aplicada.ok).toBe(true)
    expect((await repositorios.ordenes.buscarPorId(ordenId))?.estado).toBe('DONE')
    expect((await outbox.proximas(10)).map((t) => t.estado)).toEqual(['DONE'])
  })

  it('si el encolado revienta, el estado tampoco queda escrito a medias', async () => {
    const admision = await admitirOrden(orquestador, {
      robotId: null,
      externalOrderId: null,
      tipo: 'PICK',
      origen: 'MANUAL',
      locationCode: ORIGEN_DEL_CAJON,
      targetLocation: null,
    })
    if (!admision.ok) {
      throw new Error('la orden tenia que admitirse')
    }
    const ordenId = admision.valor.orden.id

    // Se siembra a mano la seq que el proximo encolado va a reservar, con la fila
    // del outbox ya ocupada: el INSERT rompe el UNIQUE (orden_id, seq). Es la
    // forma de forzar que la segunda escritura de la transaccion falle.
    base.sql
      .prepare('INSERT INTO sync_ordenes (orden_id, ultima_seq) VALUES (?, 0)')
      .run(ordenId)
    base.sql
      .prepare(
        `INSERT INTO outbox (orden_id, seq, payload_json, creada_en, intentos, en_vuelo)
         VALUES (?, 1, '{"estado":"DONE","metadata":{}}', ?, 0, 0)`,
      )
      .run(ordenId, AHORA_MS)

    await expect(
      outbox.encolarConEstadoDeOrden(
        { ordenId, estado: 'DONE', metadata: {}, creadaEn: AHORA_MS },
        { estado: 'DONE', finalizadaEn: AHORA_MS },
      ),
    ).rejects.toThrow()

    // La transaccion se deshizo: la orden NO quedo en DONE. Con dos transacciones
    // separadas este estado quedaba escrito y su reporte no existia nunca.
    expect((await repositorios.ordenes.buscarPorId(ordenId))?.estado).toBe('PENDING')
  })
})

describe('reconciliacion de una orden que la sucursal ya termino (RF33, RF34)', () => {
  it('re-encola la transicion terminal cuando el servidor vuelve a entregarla', async () => {
    const doble = crearClienteDoble()
    doble.trabajo = [
      { id: 'remota-1', externalOrderId: 'PICK-1', tipo: 'PICK', locationCode: ORIGEN_DEL_CAJON },
    ]
    const enlace = armarEnlace(crearOrigenPorLongPoll(doble.cliente), doble.cliente)

    await enlace.sincronizar()
    const [orden] = await repositorios.ordenes.listar({ siteId: SITE_ID })
    if (orden === undefined) {
      throw new Error('la orden tenia que espejarse')
    }

    // La sucursal la termina y el reporte se pierde: es lo que pasa si el proceso
    // se muere entre las dos escrituras, o si la transaccion no llego a entrar.
    await repositorios.ordenes.actualizar(orden.id, { estado: 'DONE', finalizadaEn: AHORA_MS })
    expect(await outbox.pendientes()).toBe(0)

    // El lease vence y el servidor la re-entrega: misma clave, mismo id remoto.
    const reentrega = await enlace.sincronizar()

    expect(reentrega).toMatchObject({ tipo: 'SINCRONIZADO', admitidas: 0, rechazadas: 0 })
    // Sin reconciliar, esta orden se re-entrega para siempre, ocupa cupo del
    // reclamo y queda PENDING eternamente en la app de picking.
    expect(await outbox.pendientes()).toBe(1)

    // El servidor recibe el DONE y deja de entregarla.
    doble.trabajo = []
    await enlace.sincronizar()

    expect(doble.reportes.map((reporte) => reporte.estado)).toEqual(['DONE'])
    expect(await outbox.pendientes()).toBe(0)
  })

  it('no duplica el reporte que ya estaba encolado y sin salir', async () => {
    const doble = crearClienteDoble()
    doble.trabajo = [
      { id: 'remota-1', externalOrderId: 'PICK-1', tipo: 'PICK', locationCode: ORIGEN_DEL_CAJON },
    ]
    const enlace = armarEnlace(crearOrigenPorLongPoll(doble.cliente), doble.cliente)

    await enlace.sincronizar()
    const [orden] = await repositorios.ordenes.listar({ siteId: SITE_ID })
    if (orden === undefined) {
      throw new Error('la orden tenia que espejarse')
    }
    await aplicarTransicionDeOrden(
      orquestador,
      orden.id,
      { estado: 'DONE', finalizadaEn: AHORA_MS },
      'DONE',
      { huboManiobra: true },
    )
    // El reporte esta encolado pero el servidor no lo recibio: el enlace se cayo
    // justo ahi, y en el medio vencio el lease y la orden volvio a entregarse.
    doble.respuestaDeReporte = { ok: false, error: { tipo: 'SIN_RED', mensaje: 'caido' } }
    await enlace.sincronizar()

    // Una sola transicion: reconciliar no puede significar encolar de nuevo algo
    // que ya estaba en la cola esperando salir.
    expect(await outbox.pendientes()).toBe(1)
  })
})

describe('una fila mala no puede dejar a la sucursal sin trabajo (RF31, RF34)', () => {
  it('el drenado que falla no impide reclamar ni latir', async () => {
    const doble = crearClienteDoble()
    doble.trabajo = [
      { id: 'remota-1', externalOrderId: 'PICK-1', tipo: 'PICK', locationCode: ORIGEN_DEL_CAJON },
    ]
    doble.respuestaDeReporte = {
      ok: false,
      error: { tipo: 'ERROR_DEL_SERVIDOR', estadoHttp: 400, mensaje: 'payload invalido' },
    }
    await outbox.vincular('o-vieja', 'remota-vieja')
    await outbox.encolar({ ordenId: 'o-vieja', estado: 'DONE', metadata: {}, creadaEn: AHORA_MS })

    const enlace = armarEnlace(crearOrigenPorLongPoll(doble.cliente), doble.cliente)
    const ciclo = await enlace.sincronizar()

    // El ciclo es DEGRADADO —la cola no se vacio— pero la sucursal SIGUE
    // recibiendo trabajo y sigue latiendo. Si el ciclo cortara en el drenado, una
    // sola fila mal formada dejaria a la sucursal sin pedidos y, para el
    // servidor, muerta.
    expect(ciclo).toMatchObject({ tipo: 'DEGRADADO' })
    expect(doble.reclamos).toBe(1)
    expect(doble.latidos).toBe(1)
    expect(await repositorios.ordenes.listar({ siteId: SITE_ID })).toHaveLength(1)
  })

  it('la fila que el servidor rechaza por su contenido termina en la cola muerta', async () => {
    const doble = crearClienteDoble()
    doble.respuestaDeReporte = {
      ok: false,
      error: { tipo: 'ERROR_DEL_SERVIDOR', estadoHttp: 400, mensaje: 'payload invalido' },
    }
    await outbox.vincular('o-1', 'remota-1')
    await outbox.encolar({ ordenId: 'o-1', estado: 'DONE', metadata: {}, creadaEn: AHORA_MS })
    await outbox.vincular('o-2', 'remota-2')
    await outbox.encolar({ ordenId: 'o-2', estado: 'DONE', metadata: {}, creadaEn: AHORA_MS })

    const enlace = armarEnlace(crearOrigenPorLongPoll(doble.cliente), doble.cliente)
    // Tope de 3 intentos: tres vueltas y la fila se archiva.
    for (let vuelta = 0; vuelta < OPCIONES.maxIntentosDeTransicion; vuelta += 1) {
      await enlace.sincronizar()
    }

    // La primera se archivo y la cola volvio a moverse: sin tope, esa fila
    // bloqueaba a todas las de atras de por vida.
    const muertas = base.sql.prepare('SELECT orden_id FROM outbox_muertas').all() as {
      orden_id: string
    }[]
    expect(muertas.map((fila) => fila.orden_id)).toEqual(['o-1'])
    expect((await outbox.proximas(10)).map((t) => t.ordenId)).toEqual(['o-2'])
    // Y no se archiva en silencio: queda el evento con el que alguien reconstruye
    // que cambio de estado no vio nunca la app de picking.
    const eventos = await repositorios.eventos.listar({ tipoDeEntidad: 'ORDER', entidadId: 'o-1' })
    expect(eventos.map((evento) => evento.evento)).toEqual(['OUTBOX_DEAD_LETTER'])
  })

  it('un enlace caido NO archiva nada: lo sufren todas las filas por igual', async () => {
    const doble = crearClienteDoble()
    doble.respuestaDeReporte = { ok: false, error: { tipo: 'SIN_RED', mensaje: 'ECONNREFUSED' } }
    await outbox.vincular('o-1', 'remota-1')
    await outbox.encolar({ ordenId: 'o-1', estado: 'DONE', metadata: {}, creadaEn: AHORA_MS })

    const enlace = armarEnlace(crearOrigenPorLongPoll(doble.cliente), doble.cliente)
    for (let vuelta = 0; vuelta < OPCIONES.maxIntentosDeTransicion * 2; vuelta += 1) {
      await enlace.sincronizar()
    }

    // Tirar la cola porque el servidor esta caido seria perder todos los cambios
    // de estado de la sucursal justo cuando mas importan.
    expect(base.sql.prepare('SELECT COUNT(*) AS total FROM outbox_muertas').get()).toEqual({
      total: 0,
    })
    expect(await outbox.pendientes()).toBe(1)
  })
})

describe('el indicador de /health y el piso de frecuencia (RF36, RNF)', () => {
  it('no dice DEGRADED mientras el primer long-poll esta en vuelo contra un servidor sano', async () => {
    const doble = crearClienteDoble()
    let soltarElReclamo: () => void = () => undefined
    let avisarQueArranco: () => void = () => undefined
    const reclamoColgado = new Promise<void>((listo) => {
      soltarElReclamo = listo
    })
    // El long-poll retiene la conexion: el estado se mira EXACTAMENTE mientras el
    // reclamo esta en vuelo, que es la ventana en la que el indicador mentia.
    const reclamoEnVuelo = new Promise<void>((listo) => {
      avisarQueArranco = listo
    })
    const origen: OrderSource = {
      nombre: 'LENTO',
      reclamar: async () => {
        avisarQueArranco()
        await reclamoColgado
        return { ok: true, valor: [] }
      },
    }
    const enlace = armarEnlace(origen, doble.cliente)

    const ciclo = enlace.sincronizar()
    await reclamoEnVuelo
    const durante = await enlace.estado()

    soltarElReclamo()
    await ciclo

    // Arrancar en DEGRADED contra un servidor sano significa 25 s de mentira en
    // cada arranque, y un indicador que miente al arrancar es un indicador al que
    // despues nadie le cree.
    expect(doble.latidos).toBe(1)
    expect(durante.status).toBe('CONNECTED')
    expect(durante.lastContactAt).toBe(AHORA_MS)
  })

  it('el ciclo bueno respeta un piso de frecuencia en vez de volver a pedir enseguida', async () => {
    const doble = crearClienteDoble()
    const enlace = armarEnlace(crearOrigenPorLongPoll(doble.cliente), doble.cliente)

    enlace.iniciar()
    // El reloj no avanza, asi que cada vuelta buena pide la espera completa.
    await new Promise((listo) => setTimeout(listo, 20))
    await enlace.detener()

    // Sin piso, un servidor que contesta al instante convierte a la sucursal en
    // un generador de trafico, y la unica proteccion seria la configuracion del
    // OTRO proceso.
    expect(esperas.length).toBeGreaterThan(0)
    expect(new Set(esperas)).toEqual(new Set([OPCIONES.esperaMinimaEntreCiclosMs]))
  })
})

describe('dos drenados solapados no se pisan (RF34)', () => {
  it('la fila reservada por un drenado no la ve el otro', async () => {
    await outbox.encolar({ ordenId: 'o-1', estado: 'DONE', metadata: {}, creadaEn: AHORA_MS })
    await outbox.encolar({ ordenId: 'o-2', estado: 'DONE', metadata: {}, creadaEn: AHORA_MS })

    const primero = await outbox.reservarProximas(10)
    const segundo = await outbox.reservarProximas(10)

    // Sin marca de en-vuelo los dos leen lo mismo, lo reportan los dos y el
    // servidor puede recibir las seqs fuera de orden.
    expect(primero.map((t) => t.ordenId)).toEqual(['o-1', 'o-2'])
    expect(segundo).toEqual([])
    // Reservar no saca de la cola: siguen siendo lo que el servidor no sabe.
    expect(await outbox.pendientes()).toBe(2)
    // Y lo que se suelta vuelve a estar disponible para el proximo drenado.
    await outbox.soltar(primero.map((t) => t.id))
    expect((await outbox.reservarProximas(10)).map((t) => t.ordenId)).toEqual(['o-1', 'o-2'])
  })

  it('mirar la cola no la reserva: el diagnostico no le saca trabajo al drenado', async () => {
    await outbox.encolar({ ordenId: 'o-1', estado: 'DONE', metadata: {}, creadaEn: AHORA_MS })

    expect((await outbox.proximas(10)).map((t) => t.ordenId)).toEqual(['o-1'])

    // Si `proximas` reservara, cualquier lectura de diagnostico le robaria la
    // fila al drenado y el reporte no saldria hasta la proxima corrida.
    expect((await outbox.reservarProximas(10)).map((t) => t.ordenId)).toEqual(['o-1'])
  })

  it('al abrir la base se libera lo que quedo reservado por una corrida anterior', async () => {
    await outbox.encolar({ ordenId: 'o-1', estado: 'DONE', metadata: {}, creadaEn: AHORA_MS })
    expect(await outbox.reservarProximas(10)).toHaveLength(1)

    // El proceso se muere con el drenado a medias. Al volver, este proceso es el
    // unico dueño de la base: lo que quedo marcado es de la corrida anterior y
    // nadie lo va a soltar.
    const reabierto = crearOutboxSqlite(base)

    expect((await reabierto.reservarProximas(10)).map((t) => t.ordenId)).toEqual(['o-1'])
  })
})
