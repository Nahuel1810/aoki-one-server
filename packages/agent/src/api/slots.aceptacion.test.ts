// Portado de tests/integration/api.test.js :: "API expone estado de slots de
// pickeo" (T02).
//
// ADAPTADO.
//
// Que afirmaba el legacy: GET /api/slots devuelve los 2 slots del fixture,
// data[0].status === 'LIBRE', y POST /api/slots/:code/release responde 200.
//
// Que afirma ahora y por que cambio:
//  - El item suma side (LEFT/RIGHT) y robotId, que el front nuevo ya consume
//    (T22). 3X02AE1 y 3X02AE2 son modulo 02, par, o sea lado RIGHT (RF01).
//  - Los slots dejan de vivir en el Map de StateManager y pasan a la tabla
//    slots de SQLite, que es la fuente de verdad (RF23).
//  - Se busca el slot por locationCode y no por data[0]: el legacy dependia del
//    orden de insercion del array, que ningun contrato garantiza.
//  - El release deja de mirar solo el status HTTP: se afirma el efecto (el slot
//    queda LIBRE y se registra SLOT_RELEASED_MANUAL), que es lo que importa. Y
//    se libera un slot OCUPADO, no uno ya LIBRE: con la maquina de estados
//    explicita de RF06, LIBRE no tiene transicion de salida por LIBERAR, y si
//    eso es no-op idempotente o error de dominio es una decision que ningun test
//    portado fija. Entra con T19.
//
// El listado y la liberacion van SIN credencial (RF22, nivel operario: el
// control es de red, el listener bindea a la IP de LAN).

import { describe, expect, it } from 'vitest'

import { crearAgente, type Agente, type OpcionesDelAgente } from '../composition.js'
import type { CuerpoDeRespuesta } from './httpServer.js'

const SITE_ID = 'SUC-TEST'
const ROBOT_ID = '1'
const ZONA_DE_PICKEO = ['3X02AE1', '3X02AE2']

const OPCIONES: OpcionesDelAgente = {
  siteId: SITE_ID,
  rutaDeBase: ':memory:',
  montarApi: true,
  // RF20: el default es false, asi que la simulacion se pide explicita.
  simularPlc: true,
  httpPuerto: 0,
  httpBind: '127.0.0.1',
  zonaDePickeo: ZONA_DE_PICKEO,
  // RF22: sin token configurado el comando directo a PLC queda deshabilitado.
  // Este fixture no lo usa, asi que va en null a proposito.
  tokenDeMantenimiento: null,
}

interface SlotDeApi {
  readonly locationCode: string
  readonly status: string
  readonly side: string
  readonly robotId: string
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

  // Sembrar la zona es idempotente: un slot que ya estaba conserva su estado.
  const zona = await agente.orquestador.repositorios.slots.sembrarZonaDePickeo(
    ROBOT_ID,
    ZONA_DE_PICKEO,
  )
  if (!zona.ok) {
    throw new Error(`no se pudo sembrar la zona de pickeo: ${zona.error.codigo}`)
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

describe('API local de slots de pickeo', () => {
  it('GET /api/slots lista la zona en LIBRE, con side y robotId por slot', async () => {
    const agente = await levantarAgente()

    try {
      const respuesta = await fetch(urlDe(agente, '/api/slots'))
      const cuerpo = await leerCuerpo<readonly SlotDeApi[]>(respuesta)

      expect(respuesta.status).toBe(200)
      expect(cuerpo.ok).toBe(true)

      const slots = datosDe(cuerpo)
      expect(slots).toHaveLength(2)

      for (const locationCode of ZONA_DE_PICKEO) {
        const slot = slots.find((candidato) => candidato.locationCode === locationCode)
        expect(slot).toBeDefined()
        expect(slot?.status).toBe('LIBRE')
        // Modulo 02: par, o sea lado derecho. El carro no cruza de lado.
        expect(slot?.side).toBe('RIGHT')
        expect(slot?.robotId).toBe(ROBOT_ID)
      }
    } finally {
      await agente.detener()
    }
  })

  it('POST /api/slots/:locationCode/release libera el slot y deja el evento', async () => {
    const agente = await levantarAgente()

    try {
      const ocupado = await agente.orquestador.repositorios.slots.guardarEstado(
        ROBOT_ID,
        '3X02AE1',
        {
          estado: 'OCUPADO',
          contenido: {
            cajon: { id: 'CAJON-1', ubicacionDeOrigen: '3X04AA3' },
            // Arranca en 1: una unica devolucion fisica pendiente (RF07).
            pendingReturns: 1,
          },
        },
      )
      expect(ocupado.ok).toBe(true)

      const respuesta = await fetch(urlDe(agente, '/api/slots/3X02AE1/release'), { method: 'POST' })
      expect(respuesta.status).toBe(200)

      const slot = await agente.orquestador.repositorios.slots.buscar(ROBOT_ID, '3X02AE1')
      expect(slot?.estado.estado).toBe('LIBRE')

      const eventos = await agente.orquestador.repositorios.eventos.listar({
        tipoDeEntidad: 'SLOT',
        entidadId: '3X02AE1',
      })
      expect(eventos.map((evento) => evento.evento)).toContain('SLOT_RELEASED_MANUAL')
    } finally {
      await agente.detener()
    }
  })
})
