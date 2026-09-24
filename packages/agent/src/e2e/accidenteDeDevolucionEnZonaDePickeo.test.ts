// EL ACCIDENTE DEL CAJON EMPUJADO — regresion de punta a punta.
//
// Esto no es un test de un codigo de error. Es la reconstruccion de un choque
// que paso en planta, con el agente entero levantado y el PLC simulado. Si
// alguien dentro de seis meses se pregunta por que existe la barrera de
// `putTargetResolution.ts`, este archivo es la respuesta, y "DESTINO_EN_ZONA_DE
// _PICKEO" no se la iba a dar.
//
// QUE PASO
//
// El servidor legacy resuelve el destino de un paso asi:
//
//     dropTarget = target || source            (OrchestratorService.js)
//
// Para una devolucion (PUT), `source` ES EL PROPIO SLOT DE PICKEO del que sale
// el cajon. O sea que un PUT sin `targetLocation` —que es exactamente como lo
// mandaba la tablet— se resolvia como "devolver el cajon al slot donde el cajon
// ya esta". El robot no tenia nada que mover. La orden terminaba DONE igual.
//
// A partir de ahi el sistema mintio dos veces:
//
//   MENTIRA 1 — dijo que habia guardado el cajon en su ubicacion de origen.
//               Falso: el cajon no se movio un centimetro. Seguia apoyado en la
//               zona de pickeo.
//   MENTIRA 2 — al terminar la devolucion libero el slot. Falso: el slot estaba
//               fisicamente ocupado por ese mismo cajon.
//
// La segunda mentira es la que lastima. Como en los libros el slot figuraba
// LIBRE, el PICK siguiente lo eligio —era un slot valido y disponible— y mando
// al robot a traer OTRO cajon ahi. El cajon viejo seguia en el lugar. El robot
// EMPUJO EL CAJON VIEJO CON EL NUEVO.
//
// POR QUE LA BARRERA ES MAS ANCHA QUE EL BUG
//
// El invariante que quedo escrito no es "el destino no puede ser el propio
// slot": es "el destino de una devolucion NUNCA cae en la zona de pickeo",
// cualquier slot de la zona. El daño no depende de a que slot apunte el
// destino, sino de que quede un cajon apoyado en pickeo y fuera de los libros.
// Un PUT con `targetLocation` a OTRO slot de la zona deja exactamente el mismo
// cajon huerfano sobre exactamente la misma zona —y encima, si ese slot ya
// tenia cajon, repite el choque de una—. El legacy ni siquiera cubria ese caso.
//
// SOBRE LA PARIDAD CON EL LEGACY
//
// Aca el legacy NO es la referencia: su comportamiento ES el bug. Esta
// divergencia no se revierte, se conserva.
//
// COMO ROMPE LA CADENA EL SISTEMA NUEVO — y donde lo afirma cada test
//
//   1. `el destino de un PUT sale de los libros, no del slot de origen`
//      Primer corte, y el que mata el accidente real: el destino de un PUT
//      sobre un slot con cajon en libros se lee de `cajon.ubicacionDeOrigen`,
//      NO de `source`. El `target || source` del legacy ya no existe, asi que
//      el destino nunca puede ser el propio slot por omision. El robot mueve el
//      cajon de verdad y el slot queda libre porque el cajon SE FUE.
//   2. `el destino que apunta al propio slot de pickeo se rechaza`
//      Segundo corte, la barrera: si aun asi el destino terminara siendo el
//      propio slot —libros sembrados con ese origen, una rehidratacion vieja—,
//      la orden se rechaza ANTES de reservar el slot. Ese test sigue el
//      escenario hasta el final: el slot sigue OCUPADO con su cajon y el PICK
//      posterior no lo elige. El rechazo por si solo no probaria nada; esto si.
//   3. `el destino que apunta a OTRO slot de la zona se rechaza igual`
//      La variante que el legacy no cubria, con el choque servido: el slot
//      destino ya tenia un cajon y conserva EL SUYO.

import { setTimeout as dormir } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import type { EstadoSlot } from '@aoki-one/domain'

import { crearAgente } from '../composition.js'
import type { Agente } from '../composition.js'

const SITE_ID = 'sucursal-test'
const AGENT_ID = 'AG-ACCIDENTE'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'

/** Ubicacion de GUARDADO del cajon: modulo 04, fuera de la zona de pickeo. */
const ORIGEN_DEL_CAJON = '3X04AA3'
/** Otra ubicacion de guardado, para el segundo cajon del escenario del choque. */
const ORIGEN_DE_OTRO_CAJON = '3X06AA2'

/** Los 12 slots reales de la zona de pickeo de planta. */
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
 * El slot donde cae el cajon: origen modulo 04 (par) -> lado RIGHT, y de los
 * tres slots del lado derecho gana el del mismo nivel que el origen.
 */
const SLOT_DEL_ACCIDENTE = '3X02AA1'
/** Otro slot de la MISMA zona de pickeo, lado derecho. */
const OTRO_SLOT_DE_PICKEO = '3X02AC1'

const ESPERA_MAXIMA_MS = 10_000
const INTERVALO_DE_SONDEO_MS = 25
const TIMEOUT_DEL_TEST_MS = 60_000

const ESTADOS_FINALES_DE_ORDEN = ['DONE', 'ERROR', 'CANCELED']

interface RespuestaHttp {
  readonly status: number
  readonly cuerpo: unknown
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null
}

/** Lee una ruta con puntos sobre un cuerpo JSON sin tipar. */
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

async function esperarOrdenFinalizada(base: string, ordenId: string): Promise<RespuestaHttp> {
  const limite = Date.now() + ESPERA_MAXIMA_MS
  let ultima = await obtener(`${base}/api/orders/${ordenId}`)
  while (!ESTADOS_FINALES_DE_ORDEN.includes(estadoDeOrden(ultima.cuerpo)) && Date.now() < limite) {
    await dormir(INTERVALO_DE_SONDEO_MS)
    ultima = await obtener(`${base}/api/orders/${ordenId}`)
  }
  return ultima
}

interface Planta {
  readonly agente: Agente
  readonly base: string
}

/**
 * Levanta el agente completo con el PLC simulado, el robot dado de alta, los
 * dos dispositivos registrados y la zona de pickeo sembrada, y lo apaga al
 * final pase lo que pase.
 */
async function conPlanta(escenario: (planta: Planta) => Promise<void>): Promise<void> {
  const agente = crearAgente({
    siteId: SITE_ID,
    agentId: AGENT_ID,
    rutaDeBase: ':memory:',
    montarApi: true,
    simularPlc: true,
    httpPuerto: 0,
    httpBind: '127.0.0.1',
    zonaDePickeo: ZONA_DE_PICKEO,
    tokenDeMantenimiento: null,
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
    const altaDelRobot = await repositorios.robots.guardar({
      id: ROBOT_ID,
      siteId: SITE_ID,
      estanteriaCode: ESTANTERIA,
      habilitado: true,
      estado: 'IDLE',
      ordenActivaId: null,
    })
    expect(altaDelRobot.ok).toBe(true)

    const zonaSembrada = await repositorios.slots.sembrarZonaDePickeo(ROBOT_ID, ZONA_DE_PICKEO)
    expect(zonaSembrada.ok).toBe(true)

    for (const tipo of ['CARRO', 'ELEVADOR'] as const) {
      const alta = await postear(`${base}/api/devices/register`, {
        robotId: ROBOT_ID,
        type: tipo,
        host: '127.0.0.1',
        port: 502,
      })
      expect(alta.status).toBe(201)
    }

    await escenario({ agente, base })
  } finally {
    await agente.detener()
  }
}

/** El estado de un slot leido de la fuente de verdad, no de un snapshot. */
async function estadoDelSlot(agente: Agente, locationCode: string): Promise<EstadoSlot> {
  const slot = await agente.orquestador.repositorios.slots.buscar(ROBOT_ID, locationCode)
  if (slot === undefined) {
    throw new Error(`El slot ${locationCode} tendria que existir en la zona sembrada`)
  }
  return slot.estado
}

/** Deja un slot OCUPADO con un cajon cuyo origen en libros es el que se pide. */
async function apoyarCajonEnSlot(
  agente: Agente,
  locationCode: string,
  cajon: { readonly id: string; readonly ubicacionDeOrigen: string },
): Promise<void> {
  await agente.orquestador.repositorios.slots.guardarEstado(ROBOT_ID, locationCode, {
    estado: 'OCUPADO',
    contenido: { cajon, pendingReturns: 1 },
  })
}

describe('el accidente del cajon empujado: una devolucion nunca termina en la zona de pickeo', () => {
  it(
    'el destino de un PUT sale de los libros, no del slot de origen',
    async () => {
      await conPlanta(async ({ agente, base }) => {
        const repositorios = agente.orquestador.repositorios

        // --- Paso 1 del accidente: el PICK trae el cajon al slot de pickeo ---
        const pick = await postear(`${base}/api/orders`, {
          type: 'PICK',
          locationCode: ORIGEN_DEL_CAJON,
        })
        expect(pick.status).toBe(202)
        const pickFinal = await esperarOrdenFinalizada(base, texto(pick.cuerpo, 'data.id'))
        expect(leer(pickFinal.cuerpo, 'data.status')).toBe('DONE')
        expect(leer(pickFinal.cuerpo, 'data.slotLocationCode')).toBe(SLOT_DEL_ACCIDENTE)

        // El slot queda OCUPADO y los libros se acuerdan de DONDE vino el cajon.
        // Ese dato es el que el legacy nunca leia.
        const trasElPick = await estadoDelSlot(agente, SLOT_DEL_ACCIDENTE)
        if (trasElPick.estado !== 'OCUPADO') {
          throw new Error(`El slot ${SLOT_DEL_ACCIDENTE} tendria que haber quedado OCUPADO`)
        }
        expect(trasElPick.contenido.cajon.ubicacionDeOrigen).toBe(ORIGEN_DEL_CAJON)

        // --- Paso 2: el PUT que mandaba la tablet, SIN targetLocation ---
        const put = await postear(`${base}/api/orders`, {
          type: 'PUT',
          locationCode: SLOT_DEL_ACCIDENTE,
        })
        expect(put.status).toBe(202)
        expect(leer(put.cuerpo, 'data.targetLocation')).toBeNull()
        const ordenDePut = texto(put.cuerpo, 'data.id')

        // --- AQUI SE ROMPE LA CADENA ---
        // El legacy resolvia `target || source` y el destino caia en
        // SLOT_DEL_ACCIDENTE. El sistema nuevo lee la ubicacion de origen del
        // cajon en libros: el destino es la ubicacion de GUARDADO, y por
        // construccion no puede ser el slot del que sale el cajon.
        const putFinal = await esperarOrdenFinalizada(base, ordenDePut)
        expect(leer(putFinal.cuerpo, 'data.status')).toBe('DONE')
        expect(leer(putFinal.cuerpo, 'data.targetLocation')).toBe(ORIGEN_DEL_CAJON)
        expect(leer(putFinal.cuerpo, 'data.targetLocation')).not.toBe(SLOT_DEL_ACCIDENTE)

        // Y hubo maniobra de verdad: los cinco pasos fisicos, con el ultimo
        // devolviendo el cajon. En el accidente el robot no se movia.
        const pasos = await repositorios.pasos.listarPorOrden(ordenDePut)
        expect(pasos.map((paso) => paso.tipo)).toEqual([
          'HOMING',
          'ELEVADOR_NIVEL_ORIGEN',
          'CARRO_BUSCA',
          'ELEVADOR_NIVEL_DESTINO',
          'CARRO_DEVUELVE',
        ])
        expect(pasos.every((paso) => paso.estado === 'DONE')).toBe(true)
        expect(leer(putFinal.cuerpo, 'data.currentStepIndex')).toBe(5)

        // El slot queda LIBRE, pero esta vez no es mentira: el cajon se fue.
        expect((await estadoDelSlot(agente, SLOT_DEL_ACCIDENTE)).estado).toBe('LIBRE')

        // --- Paso 4 del accidente, ahora sin choque ---
        // El PICK siguiente vuelve a elegir el slot, y puede: esta vacio de
        // verdad. Lo que el accidente hizo imposible, aca es lo correcto.
        const pickPosterior = await postear(`${base}/api/orders`, {
          type: 'PICK',
          locationCode: ORIGEN_DE_OTRO_CAJON,
        })
        expect(pickPosterior.status).toBe(202)
        const posteriorFinal = await esperarOrdenFinalizada(
          base,
          texto(pickPosterior.cuerpo, 'data.id'),
        )
        expect(leer(posteriorFinal.cuerpo, 'data.status')).toBe('DONE')
        expect(leer(posteriorFinal.cuerpo, 'data.slotLocationCode')).toBe(SLOT_DEL_ACCIDENTE)

        const trasElChoqueQueNoFue = await estadoDelSlot(agente, SLOT_DEL_ACCIDENTE)
        if (trasElChoqueQueNoFue.estado !== 'OCUPADO') {
          throw new Error(`El slot ${SLOT_DEL_ACCIDENTE} tendria que estar OCUPADO`)
        }
        // Un solo cajon en el slot, y es el nuevo: el viejo se habia ido.
        expect(trasElChoqueQueNoFue.contenido.cajon.ubicacionDeOrigen).toBe(ORIGEN_DE_OTRO_CAJON)
      })
    },
    TIMEOUT_DEL_TEST_MS,
  )

  it(
    'el destino que apunta al propio slot de pickeo se rechaza y el cajon se queda donde esta',
    async () => {
      await conPlanta(async ({ agente, base }) => {
        // El slot tiene un cajon cuyo origen en libros es EL PROPIO SLOT: ese es
        // literalmente el destino que calculaba el legacy con `target || source`.
        // En el sistema nuevo solo puede llegar por libros sembrados o una
        // rehidratacion vieja, y aun asi tiene que cortarse.
        await apoyarCajonEnSlot(agente, SLOT_DEL_ACCIDENTE, {
          id: 'cajon-del-accidente',
          ubicacionDeOrigen: SLOT_DEL_ACCIDENTE,
        })

        const put = await postear(`${base}/api/orders`, {
          type: 'PUT',
          locationCode: SLOT_DEL_ACCIDENTE,
        })
        expect(put.status).toBe(202)

        // La orden muere antes de tocar el robot, y dice por que.
        const final = await esperarOrdenFinalizada(base, texto(put.cuerpo, 'data.id'))
        expect(leer(final.cuerpo, 'data.status')).toBe('ERROR')
        const motivo = texto(final.cuerpo, 'data.errorReason')
        expect(motivo).toContain('DESTINO_EN_ZONA_DE_PICKEO')
        expect(motivo).toContain(SLOT_DEL_ACCIDENTE)

        // Ni un paso: el rechazo es previo a la maniobra.
        const pasos = await agente.orquestador.repositorios.pasos.listarPorOrden(
          texto(final.cuerpo, 'data.id'),
        )
        expect(pasos).toHaveLength(0)

        // CONTRA LA MENTIRA 2: el slot NO se libero. Sigue OCUPADO, con su cajon.
        const trasElRechazo = await estadoDelSlot(agente, SLOT_DEL_ACCIDENTE)
        if (trasElRechazo.estado !== 'OCUPADO') {
          throw new Error(
            `El slot ${SLOT_DEL_ACCIDENTE} tendria que seguir OCUPADO tras el rechazo`,
          )
        }
        expect(trasElRechazo.contenido.cajon.id).toBe('cajon-del-accidente')

        // Y ESTE es el assert que prueba que el accidente no puede repetirse: el
        // PICK siguiente NO elige ese slot, porque los libros dicen la verdad
        // sobre el. Sin esto, el rechazo solo seria un codigo de error.
        const pickPosterior = await postear(`${base}/api/orders`, {
          type: 'PICK',
          locationCode: ORIGEN_DE_OTRO_CAJON,
        })
        expect(pickPosterior.status).toBe(202)
        const posteriorFinal = await esperarOrdenFinalizada(
          base,
          texto(pickPosterior.cuerpo, 'data.id'),
        )
        expect(leer(posteriorFinal.cuerpo, 'data.status')).toBe('DONE')
        expect(leer(posteriorFinal.cuerpo, 'data.slotLocationCode')).not.toBe(SLOT_DEL_ACCIDENTE)

        // El cajon viejo sigue solo en su slot: nadie le apoyo otro encima.
        const alFinal = await estadoDelSlot(agente, SLOT_DEL_ACCIDENTE)
        if (alFinal.estado !== 'OCUPADO') {
          throw new Error(`El slot ${SLOT_DEL_ACCIDENTE} tendria que seguir OCUPADO`)
        }
        expect(alFinal.contenido.cajon.id).toBe('cajon-del-accidente')
        expect(alFinal.contenido.cajon.ubicacionDeOrigen).toBe(SLOT_DEL_ACCIDENTE)
      })
    },
    TIMEOUT_DEL_TEST_MS,
  )

  it(
    'el destino que apunta a OTRO slot de la zona se rechaza igual: el daño es el mismo',
    async () => {
      await conPlanta(async ({ agente, base }) => {
        // La variante que el legacy NI SIQUIERA cubria. El slot del que sale el
        // cajon esta LIBRE en libros —devolucion manual: alguien lo saco a mano,
        // lo restockeo y lo apoya—, asi que el destino lo manda la tablet. Y
        // apunta a OTRO slot de la zona de pickeo, que ademas YA TIENE un cajon.
        await apoyarCajonEnSlot(agente, OTRO_SLOT_DE_PICKEO, {
          id: 'cajon-que-ya-estaba',
          ubicacionDeOrigen: ORIGEN_DEL_CAJON,
        })
        expect((await estadoDelSlot(agente, SLOT_DEL_ACCIDENTE)).estado).toBe('LIBRE')

        const put = await postear(`${base}/api/orders`, {
          type: 'PUT',
          locationCode: SLOT_DEL_ACCIDENTE,
          targetLocation: OTRO_SLOT_DE_PICKEO,
        })
        expect(put.status).toBe(202)

        const final = await esperarOrdenFinalizada(base, texto(put.cuerpo, 'data.id'))
        expect(leer(final.cuerpo, 'data.status')).toBe('ERROR')
        const motivo = texto(final.cuerpo, 'data.errorReason')
        expect(motivo).toContain('DESTINO_EN_ZONA_DE_PICKEO')
        expect(motivo).toContain(OTRO_SLOT_DE_PICKEO)

        const pasos = await agente.orquestador.repositorios.pasos.listarPorOrden(
          texto(final.cuerpo, 'data.id'),
        )
        expect(pasos).toHaveLength(0)

        // El slot destino conserva EL SUYO: no le empujaron nada encima.
        const destino = await estadoDelSlot(agente, OTRO_SLOT_DE_PICKEO)
        if (destino.estado !== 'OCUPADO') {
          throw new Error(`El slot ${OTRO_SLOT_DE_PICKEO} tendria que seguir OCUPADO`)
        }
        expect(destino.contenido.cajon.id).toBe('cajon-que-ya-estaba')

        // Y el slot de salida queda como estaba: el rechazo no lo reserva.
        expect((await estadoDelSlot(agente, SLOT_DEL_ACCIDENTE)).estado).toBe('LIBRE')
      })
    },
    TIMEOUT_DEL_TEST_MS,
  )
})
