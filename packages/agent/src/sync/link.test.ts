// RF33 a RF36 — El enlace, de punta a punta contra SQLite real.
//
// La base es de verdad (`:memory:`) porque lo que hay que afirmar es el espejo y
// el dedupe, que viven en indices, no en un Map. Lo unico doblado es el cliente
// HTTP: el servidor tiene sus propios tests y aca importa como reacciona el
// agente a cada respuesta suya, incluida la que no llega.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Result } from '@aoki-one/domain'

import { admitirOrden } from '../orchestrator/orderIntake.js'
import type { DependenciasDelOrquestador, PuertoDeTransporte } from '../orchestrator/ports.js'
import { abrirBase, type BaseDelAgente } from '../persistence/database.js'
import { crearRepositorios, type RepositoriosDelAgente } from '../persistence/index.js'
import type { Reloj } from '../reloj.js'
import type { Azar } from './backoff.js'
import { crearEnlace, type Enlace } from './link.js'
import { crearOrigenPorLongPoll } from './orderSource.js'
import { crearOutboxSqlite, type OutboxDeTransiciones } from './outbox.js'
import type {
  ClienteDelServidor,
  FalloDeEnlace,
  PedidoRemoto,
  ReporteDeTransicion,
  ResultadoDeReporte,
} from './serverClient.js'

const SITE_ID = 'SUC-TEST'
const AGENT_ID = 'AG-TEST'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'
const ORIGEN_DEL_CAJON = '3X04AE1'
const AHORA_MS = 1_700_000_000_000

const SIN_RED: FalloDeEnlace = { tipo: 'SIN_RED', mensaje: 'ECONNREFUSED' }

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

const RELOJ: Reloj = { ahoraMs: () => AHORA_MS, dormir: () => Promise.resolve() }
const AZAR: Azar = { siguiente: () => 0.5 }

/** Doble del servidor. Cada test dice que contesta y despues mira que le pidieron. */
interface ClienteDoble {
  readonly cliente: ClienteDelServidor
  readonly reportes: ReporteDeTransicion[]
  readonly empujes: string[]
  trabajo: readonly PedidoRemoto[]
  respuestaDeReporte: Result<ResultadoDeReporte, FalloDeEnlace>
  respuestaDeTrabajo: FalloDeEnlace | null
  respuestaDeEmpuje: FalloDeEnlace | null
}

function crearClienteDoble(): ClienteDoble {
  const doble: ClienteDoble = {
    reportes: [],
    empujes: [],
    trabajo: [],
    respuestaDeReporte: { ok: true, valor: { tipo: 'APLICADA' } },
    respuestaDeTrabajo: null,
    respuestaDeEmpuje: null,
    cliente: {
      reclamarTrabajo: () =>
        Promise.resolve(
          doble.respuestaDeTrabajo === null
            ? { ok: true, valor: doble.trabajo }
            : { ok: false, error: doble.respuestaDeTrabajo },
        ),
      reportarTransicion: (reporte) => {
        doble.reportes.push(reporte)
        return Promise.resolve(doble.respuestaDeReporte)
      },
      empujarOrden: (alta) => {
        doble.empujes.push(alta.externalOrderId)
        if (doble.respuestaDeEmpuje !== null) {
          return Promise.resolve({ ok: false, error: doble.respuestaDeEmpuje })
        }
        return Promise.resolve({
          ok: true,
          valor: {
            id: `remota-de-${alta.externalOrderId}`,
            externalOrderId: alta.externalOrderId,
            tipo: alta.tipo,
            locationCode: alta.locationCode,
          },
        })
      },
      latir: () => Promise.resolve({ ok: true, valor: undefined }),
    },
  }
  return doble
}

let base: BaseDelAgente
let repositorios: RepositoriosDelAgente
let outbox: OutboxDeTransiciones
let orquestador: DependenciasDelOrquestador
let doble: ClienteDoble
let enlace: Enlace
let despertares: number

beforeEach(async () => {
  base = abrirBase(':memory:')
  repositorios = crearRepositorios(base)
  outbox = crearOutboxSqlite(base)
  doble = crearClienteDoble()
  despertares = 0

  let contador = 0
  orquestador = {
    repositorios,
    siteId: SITE_ID,
    agentId: AGENT_ID,
    generarId: () => {
      contador += 1
      return `id-${String(contador)}`
    },
    transporte: TRANSPORTE_SIN_USO,
    reloj: RELOJ,
    politica: { maxIntentos: 3, baseBackoffMs: 10 },
    outbox,
  }

  enlace = crearEnlace({
    origen: crearOrigenPorLongPoll(doble.cliente),
    cliente: doble.cliente,
    outbox,
    orquestador,
    azar: AZAR,
    opciones: {
      limiteDeReclamo: 10,
      loteDeOutbox: 50,
      intervaloDeLatidoMs: 15_000,
      esperaMinimaEntreCiclosMs: 250,
      maxIntentosDeTransicion: 10,
      backoff: { baseMs: 1, techoMs: 10, fraccionDeJitter: 0.5 },
    },
    despertar: () => {
      despertares += 1
    },
  })

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

describe('espejo local de lo que entrega el servidor (RF28, RF33)', () => {
  it('persiste la orden reclamada en SQLite y despierta al orquestador', async () => {
    doble.trabajo = [
      { id: 'remota-1', externalOrderId: 'PICK-1001', tipo: 'PICK', locationCode: ORIGEN_DEL_CAJON },
    ]

    const ciclo = await enlace.sincronizar()

    expect(ciclo).toEqual({ tipo: 'SINCRONIZADO', reportadas: 0, admitidas: 1, rechazadas: 0 })
    const persistidas = await repositorios.ordenes.listar({ siteId: SITE_ID })
    expect(persistidas).toHaveLength(1)
    expect(persistidas[0]?.origen).toBe('PICKING')
    expect(persistidas[0]?.robotId).toBe(ROBOT_ID)
    // El vinculo con el libro del servidor queda guardado: es con ese id con el
    // que despues se reportan las transiciones.
    expect(await outbox.buscarVinculo(persistidas[0]?.id ?? '')).toBe('remota-1')
    expect(despertares).toBe(1)
  })

  it('una re-entrega por lease vencido no crea una segunda orden ni repite la maniobra', async () => {
    doble.trabajo = [
      { id: 'remota-1', externalOrderId: 'PICK-1001', tipo: 'PICK', locationCode: ORIGEN_DEL_CAJON },
    ]

    await enlace.sincronizar()
    // Mismo externalOrderId: es lo que manda el servidor al re-entregar (RF28).
    const reentrega = await enlace.sincronizar()

    expect(reentrega).toEqual({ tipo: 'SINCRONIZADO', reportadas: 0, admitidas: 0, rechazadas: 0 })
    expect(await repositorios.ordenes.listar({ siteId: SITE_ID })).toHaveLength(1)
    // Solo el primer ciclo despierta el loop: la segunda vez no hay trabajo nuevo.
    expect(despertares).toBe(1)
  })

  it('una orden que la sucursal no puede ejecutar se reporta en ERROR y no vuelve para siempre', async () => {
    // Estanteria sin robot dado de alta: admitirOrden la rechaza.
    doble.trabajo = [
      { id: 'remota-9', externalOrderId: 'PICK-9', tipo: 'PICK', locationCode: '9Z04AE1' },
    ]

    const ciclo = await enlace.sincronizar()

    expect(ciclo).toEqual({ tipo: 'SINCRONIZADO', reportadas: 0, admitidas: 0, rechazadas: 1 })
    expect(await repositorios.ordenes.listar({ siteId: SITE_ID })).toHaveLength(0)
    // Queda encolado el ERROR: sin reporte el servidor la re-entregaria en cada
    // vencimiento de lease.
    const pendientes = await outbox.proximas(10)
    expect(pendientes[0]?.estado).toBe('ERROR')

    // Y queda la traza LOCAL. El ERROR es terminal del lado del servidor: sin
    // este evento el pedido queda muerto alla y en la sucursal no existe ningun
    // rastro de que llego, asi que el operario de la tablet no puede enterarse.
    const eventos = await repositorios.eventos.listar({
      tipoDeEntidad: 'ORDER',
      entidadId: 'remota-9',
    })
    expect(eventos).toHaveLength(1)
    expect(eventos[0]?.evento).toBe('ORDER_REJECTED_BY_SITE')
    expect(eventos[0]?.severidad).toBe('ERROR')
    expect(eventos[0]?.metadata).toMatchObject({
      motivo: 'ROBOT_NO_REGISTRADO',
      externalOrderId: 'PICK-9',
      locationCode: '9Z04AE1',
      siteId: SITE_ID,
    })
  })

  it('con el ERROR todavia sin reportar, una re-entrega no duplica ni el reporte ni la traza', async () => {
    doble.trabajo = [
      { id: 'remota-9', externalOrderId: 'PICK-9', tipo: 'PICK', locationCode: '9Z04AE1' },
    ]
    // El servidor no recibe el reporte, asi que el ERROR se queda en la cola y
    // el lease vencido vuelve a entregar el mismo pedido. La traza sigue la
    // misma guarda que el reporte: mientras ese ERROR no salga, la re-entrega no
    // encola otro ni repite el evento.
    doble.respuestaDeReporte = { ok: false, error: SIN_RED }

    await enlace.sincronizar()
    await enlace.sincronizar()

    expect(await outbox.pendientes()).toBe(1)
    expect(
      await repositorios.eventos.listar({ tipoDeEntidad: 'ORDER', entidadId: 'remota-9' }),
    ).toHaveLength(1)
  })
})

describe('outbox de transiciones (RF34)', () => {
  it('acumula con el enlace caido y drena en orden al reconectar', async () => {
    await outbox.vincular('o-1', 'remota-1')
    await outbox.encolar({
      ordenId: 'o-1',
      estado: 'IN_PROGRESS',
      metadata: {},
      creadaEn: AHORA_MS,
    })
    await outbox.encolar({ ordenId: 'o-1', estado: 'DONE', metadata: {}, creadaEn: AHORA_MS })

    doble.respuestaDeReporte = { ok: false, error: SIN_RED }
    const caido = await enlace.sincronizar()

    expect(caido).toEqual({ tipo: 'DEGRADADO', fallo: SIN_RED })
    // Nada se pierde: siguen las dos en la cola.
    expect(await outbox.pendientes()).toBe(2)

    doble.respuestaDeReporte = { ok: true, valor: { tipo: 'APLICADA' } }
    const reconectado = await enlace.sincronizar()

    expect(reconectado).toEqual({
      tipo: 'SINCRONIZADO',
      reportadas: 2,
      admitidas: 0,
      rechazadas: 0,
    })
    expect(await outbox.pendientes()).toBe(0)
    // Drenado EN ORDEN y con reintento IDEMPOTENTE: el intento que no llego se
    // repite con la MISMA seq, asi el servidor lo descarta si en realidad si
    // habia llegado, en vez de aplicarlo dos veces.
    expect(doble.reportes.map((r) => [r.estado, r.seq])).toEqual([
      ['IN_PROGRESS', 1],
      ['IN_PROGRESS', 1],
      ['DONE', 2],
    ])
  })

  it('se corta en la primera que falla en vez de saltearla', async () => {
    await outbox.vincular('o-1', 'remota-1')
    await outbox.encolar({
      ordenId: 'o-1',
      estado: 'IN_PROGRESS',
      metadata: {},
      creadaEn: AHORA_MS,
    })
    await outbox.encolar({ ordenId: 'o-1', estado: 'DONE', metadata: {}, creadaEn: AHORA_MS })

    doble.respuestaDeReporte = { ok: false, error: SIN_RED }
    await enlace.sincronizar()

    // Un solo intento: saltear la primera le haria llegar al servidor la seq 2
    // antes que la 1, y despues descartaria la 1 por vieja.
    expect(doble.reportes).toHaveLength(1)
    expect(doble.reportes[0]?.seq).toBe(1)
  })

  it('una transicion que el servidor descarta sale de la cola: ya esta aplicada', async () => {
    await outbox.vincular('o-1', 'remota-1')
    await outbox.encolar({ ordenId: 'o-1', estado: 'DONE', metadata: {}, creadaEn: AHORA_MS })

    doble.respuestaDeReporte = { ok: true, valor: { tipo: 'DESCARTADA', motivo: 'SEQ_REPETIDA' } }
    const ciclo = await enlace.sincronizar()

    expect(ciclo.tipo).toBe('SINCRONIZADO')
    // Si se tratara como error, el outbox la reintentaria para siempre y
    // bloquearia a todas las que vienen atras.
    expect(await outbox.pendientes()).toBe(0)
  })

  it('una transicion de una orden que el servidor no tiene tampoco bloquea la cola', async () => {
    await outbox.vincular('o-1', 'remota-1')
    await outbox.encolar({ ordenId: 'o-1', estado: 'DONE', metadata: {}, creadaEn: AHORA_MS })

    doble.respuestaDeReporte = { ok: true, valor: { tipo: 'ORDEN_INEXISTENTE' } }
    await enlace.sincronizar()

    expect(await outbox.pendientes()).toBe(0)
  })

  it('la transicion sin contraparte se tira, pero deja su traza en los eventos', async () => {
    // Sin vinculo y sin orden local: `resolverOrdenRemota` no tiene con que
    // construir el reporte y reintentar no converge nunca.
    await outbox.encolar({
      ordenId: 'o-fantasma',
      estado: 'DONE',
      metadata: {},
      creadaEn: AHORA_MS,
    })

    const ciclo = await enlace.sincronizar()

    expect(ciclo.tipo).toBe('SINCRONIZADO')
    expect(await outbox.pendientes()).toBe(0)
    expect(doble.reportes).toHaveLength(0)
    // Es el UNICO punto donde una transicion desaparece por decision del agente:
    // sin evento, un cambio de estado se pierde y nadie puede reconstruir cual.
    const eventos = await repositorios.eventos.listar({
      tipoDeEntidad: 'ORDER',
      entidadId: 'o-fantasma',
    })
    expect(eventos).toHaveLength(1)
    expect(eventos[0]?.evento).toBe('OUTBOX_DROPPED_NO_COUNTERPART')
    expect(eventos[0]?.severidad).toBe('ERROR')
    expect(eventos[0]?.metadata).toMatchObject({
      seq: 1,
      estado: 'DONE',
      motivo: 'la orden local ya no existe',
    })
  })
})

describe('ordenes locales sin enlace (RF35)', () => {
  it('nacen con externalOrderId prefijado por agente', async () => {
    const admision = await admitirOrden(orquestador, {
      robotId: null,
      externalOrderId: null,
      tipo: 'PICK',
      origen: 'MANUAL',
      locationCode: ORIGEN_DEL_CAJON,
      targetLocation: null,
    })

    expect(admision.ok).toBe(true)
    if (admision.ok) {
      // Sin prefijo, una colision con un id de picking no falla ruidosamente:
      // dedupea dos ordenes distintas en una y deja un pedido sin atender.
      expect(admision.valor.orden.externalOrderId).toMatch(/^local-AG-TEST-/)
    }
  })

  it('se empujan al servidor al reconectar y recien ahi se reporta su transicion', async () => {
    const admision = await admitirOrden(orquestador, {
      robotId: null,
      externalOrderId: null,
      tipo: 'PICK',
      origen: 'MANUAL',
      locationCode: ORIGEN_DEL_CAJON,
      targetLocation: null,
    })
    if (!admision.ok) {
      throw new Error('la orden local tenia que admitirse sin enlace')
    }
    const ordenLocal = admision.valor.orden
    await outbox.encolar({
      ordenId: ordenLocal.id,
      estado: 'DONE',
      metadata: {},
      creadaEn: AHORA_MS,
    })

    await enlace.sincronizar()

    expect(doble.empujes).toEqual([ordenLocal.externalOrderId])
    expect(doble.reportes[0]?.ordenIdRemoto).toBe(`remota-de-${ordenLocal.externalOrderId ?? ''}`)
    // El vinculo queda guardado: la proxima transicion no vuelve a empujarla.
    expect(await outbox.buscarVinculo(ordenLocal.id)).not.toBeNull()
  })

  it('si el empuje falla la transicion queda en la cola, no se pierde', async () => {
    const admision = await admitirOrden(orquestador, {
      robotId: null,
      externalOrderId: null,
      tipo: 'PICK',
      origen: 'MANUAL',
      locationCode: ORIGEN_DEL_CAJON,
      targetLocation: null,
    })
    if (!admision.ok) {
      throw new Error('la orden local tenia que admitirse sin enlace')
    }
    await outbox.encolar({
      ordenId: admision.valor.orden.id,
      estado: 'DONE',
      metadata: {},
      creadaEn: AHORA_MS,
    })

    doble.respuestaDeEmpuje = SIN_RED
    const ciclo = await enlace.sincronizar()

    expect(ciclo).toEqual({ tipo: 'DEGRADADO', fallo: SIN_RED })
    expect(await outbox.pendientes()).toBe(1)
    expect(doble.reportes).toHaveLength(0)
  })
})

describe('degradacion explicita (RF36)', () => {
  it('arranca degradado: hasta que no hubo un contacto bueno no se puede decir otra cosa', async () => {
    expect(await enlace.estado()).toEqual({
      status: 'DEGRADED',
      lastContactAt: null,
      outboxSize: 0,
    })
  })

  it('informa CONNECTED y el ultimo contacto despues de un ciclo bueno', async () => {
    await enlace.sincronizar()

    expect(await enlace.estado()).toEqual({
      status: 'CONNECTED',
      lastContactAt: AHORA_MS,
      outboxSize: 0,
    })
  })

  it('informa DEGRADED y cuanto quedo sin reportar cuando el servidor no contesta', async () => {
    await enlace.sincronizar()
    await outbox.vincular('o-1', 'remota-1')
    await outbox.encolar({ ordenId: 'o-1', estado: 'DONE', metadata: {}, creadaEn: AHORA_MS })
    doble.respuestaDeReporte = { ok: false, error: SIN_RED }

    await enlace.sincronizar()

    expect(await enlace.estado()).toEqual({
      // Nada de modo silencioso: el agente sigue operando con su cola local y lo dice.
      status: 'DEGRADED',
      lastContactAt: AHORA_MS,
      outboxSize: 1,
    })
  })
})
