// RF21 — La salida del operario cuando un PICK falla y el retry no alcanza.
//
// EL CASO DE PLANTA: un PICK falla con el cajon trabado o el PLC en falla. El
// slot queda en BUSCANDO a nombre de esa orden y la orden vuelve a PENDING
// reteniendolo (RF13). Antes de esta task el operario no tenia salida: liberar el
// slot respondia 409 (la maquina de estados solo salia de OCUPADO y DEVOLVIENDO)
// y cancelar respondia ORDEN_CON_SLOT_TOMADO. Cada fallo asi se comia uno de los
// doce slots de la zona y la unica correccion era editar SQLite a mano.
//
// El legacy SI deja: `POST /api/slots/:code/release` llama a
// `StateManager.releaseSlot`, que libera sin mirar el estado.
//
// LA GUARDA, que el legacy no tiene: no se libera el slot de una orden que el
// robot esta ejecutando AHORA. Ese ciclo esta adentro del handshake con el PLC y
// no vuelve a mirar el slot hasta terminar el paso, asi que liberarlo deja el
// cajon a mitad de camino y los libros diciendo que el slot esta vacio.

import { describe, expect, it } from 'vitest'

import { LOGGER_SILENCIOSO } from '@aoki-one/domain'

import { crearAgente, type Agente, type OpcionesDelAgente } from '../composition.js'
import type { Orden } from '../persistence/index.js'
import type { CuerpoDeRespuesta } from './httpServer.js'

const SITE_ID = 'SUC-SALIDA'
const ROBOT_ID = '1'
const SLOT = '3X02AE1'
const ZONA_DE_PICKEO = [SLOT, '3X02AC1']

const OPCIONES: OpcionesDelAgente = {
  siteId: SITE_ID,
  agentId: 'AG-SALIDA',
  rutaDeBase: ':memory:',
  montarApi: true,
  simularPlc: true,
  httpPuerto: 0,
  httpBind: '127.0.0.1',
  zonaDePickeo: ZONA_DE_PICKEO,
  tokenDeMantenimiento: null,
  enlace: null,
  logger: LOGGER_SILENCIOSO,
}

function ordenSembrada(estado: Orden['estado']): Orden {
  return {
    id: 'ORD-TRABADA',
    siteId: SITE_ID,
    robotId: ROBOT_ID,
    externalOrderId: 'EXT-1',
    tipo: 'PICK',
    origen: 'MANUAL',
    estado,
    locationCode: '3X04AA3',
    targetLocation: null,
    slotLocationCode: SLOT,
    currentStepIndex: 0,
    waitingForSlot: false,
    errorReason: null,
    creadaEn: 1,
    iniciadaEn: null,
    finalizadaEn: null,
  }
}

/**
 * Agente con el robot sembrado y la cola PAUSADA.
 *
 * La pausa es parte del caso real —el operario detiene la cola antes de tocar los
 * libros— y ademas evita que el loop tome la orden sembrada mientras el test
 * afirma sobre ella.
 */
async function levantarAgente(estadoDeLaOrden: Orden['estado']): Promise<Agente> {
  const agente = crearAgente(OPCIONES)
  const { repositorios } = agente.orquestador

  const robot = await repositorios.robots.guardar({
    id: ROBOT_ID,
    siteId: SITE_ID,
    estanteriaCode: '3X',
    habilitado: true,
    estado: estadoDeLaOrden === 'IN_PROGRESS' ? 'BUSY' : 'IDLE',
    ordenActivaId: estadoDeLaOrden === 'IN_PROGRESS' ? 'ORD-TRABADA' : null,
  })
  if (!robot.ok) {
    throw new Error(`no se pudo sembrar el robot: ${robot.error.codigo}`)
  }

  await agente.iniciar()
  await repositorios.robots.fijarPausaDeCola(ROBOT_ID, true, 0)

  const creada = await repositorios.ordenes.crear(ordenSembrada(estadoDeLaOrden))
  if (!creada.ok) {
    throw new Error('no se pudo sembrar la orden')
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

async function cuerpoDe<T>(respuesta: Response): Promise<CuerpoDeRespuesta<T>> {
  return (await respuesta.json()) as CuerpoDeRespuesta<T>
}

interface SlotLiberado {
  readonly locationCode: string
  readonly status: string
  readonly previousStatus: string
}

describe('salida del operario: liberar el slot de un PICK trabado', () => {
  it('libera un slot en BUSCANDO y deja el evento con el estado del que salio', async () => {
    const agente = await levantarAgente('PENDING')
    const { repositorios } = agente.orquestador

    try {
      await repositorios.slots.guardarEstado(ROBOT_ID, SLOT, {
        estado: 'BUSCANDO',
        ordenId: 'ORD-TRABADA',
      })

      const respuesta = await fetch(urlDe(agente, `/api/slots/${SLOT}/release`), { method: 'POST' })
      const cuerpo = await cuerpoDe<SlotLiberado>(respuesta)

      expect(respuesta.status).toBe(200)
      expect(cuerpo.ok).toBe(true)
      if (cuerpo.ok) {
        expect(cuerpo.data.status).toBe('LIBRE')
        expect(cuerpo.data.previousStatus).toBe('BUSCANDO')
      }

      const slot = await repositorios.slots.buscar(ROBOT_ID, SLOT)
      expect(slot?.estado.estado).toBe('LIBRE')

      const eventos = await repositorios.eventos.listar({
        tipoDeEntidad: 'SLOT',
        entidadId: SLOT,
      })
      const liberacion = eventos.find((evento) => evento.evento === 'SLOT_RELEASED_MANUAL')
      expect(liberacion).toBeDefined()
      expect(liberacion?.metadata).toMatchObject({
        robotId: ROBOT_ID,
        estadoPrevio: 'BUSCANDO',
        ordenId: 'ORD-TRABADA',
      })
    } finally {
      await agente.detener()
    }
  })

  it('libera un slot en RESERVADO, y recien ahi la orden se puede cancelar', async () => {
    const agente = await levantarAgente('PENDING')
    const { repositorios } = agente.orquestador

    try {
      await repositorios.slots.guardarEstado(ROBOT_ID, SLOT, {
        estado: 'RESERVADO',
        ordenId: 'ORD-TRABADA',
        contenido: null,
      })

      // Antes de liberar, cancelar es un callejon sin salida: 409 y el codigo
      // ORDEN_CON_SLOT_TOMADO. Se afirma para que la secuencia quede pineada.
      const cancelacionTemprana = await fetch(
        urlDe(agente, '/api/orders/ORD-TRABADA/cancel'),
        { method: 'POST' },
      )
      expect(cancelacionTemprana.status).toBe(409)
      const rechazo = await cuerpoDe<never>(cancelacionTemprana)
      expect(rechazo.ok).toBe(false)
      if (!rechazo.ok) {
        // El mensaje tiene que decir las DOS salidas: el retry y la liberacion.
        expect(rechazo.error).toContain(`/api/slots/${SLOT}/release`)
      }

      const liberacion = await fetch(urlDe(agente, `/api/slots/${SLOT}/release`), {
        method: 'POST',
      })
      expect(liberacion.status).toBe(200)

      const cancelacion = await fetch(urlDe(agente, '/api/orders/ORD-TRABADA/cancel'), {
        method: 'POST',
      })
      expect(cancelacion.status).toBe(200)

      const orden = await repositorios.ordenes.buscarPorId('ORD-TRABADA')
      expect(orden?.estado).toBe('CANCELED')

      // El slot vuelve a la zona util: es el punto entero de la salida.
      const slot = await repositorios.slots.buscar(ROBOT_ID, SLOT)
      expect(slot?.estado.estado).toBe('LIBRE')
    } finally {
      await agente.detener()
    }
  })

  it('NO libera el slot de una orden que el robot esta ejecutando ahora', async () => {
    const agente = await levantarAgente('IN_PROGRESS')
    const { repositorios } = agente.orquestador

    try {
      await repositorios.slots.guardarEstado(ROBOT_ID, SLOT, {
        estado: 'RESERVADO',
        ordenId: 'ORD-TRABADA',
        contenido: null,
      })

      const respuesta = await fetch(urlDe(agente, `/api/slots/${SLOT}/release`), { method: 'POST' })
      const cuerpo = await cuerpoDe<never>(respuesta)

      expect(respuesta.status).toBe(409)
      expect(cuerpo.ok).toBe(false)
      if (!cuerpo.ok) {
        expect(cuerpo.error).toContain('ORD-TRABADA')
      }

      // Lo que importa no es el 409 sino que el slot NO se toco: el cajon esta en
      // camino y los libros tienen que seguir diciendolo.
      const slot = await repositorios.slots.buscar(ROBOT_ID, SLOT)
      expect(slot?.estado.estado).toBe('RESERVADO')

      const eventos = await repositorios.eventos.listar({
        tipoDeEntidad: 'SLOT',
        entidadId: SLOT,
      })
      expect(eventos.map((evento) => evento.evento)).not.toContain('SLOT_RELEASED_MANUAL')
    } finally {
      await agente.detener()
    }
  })
})
