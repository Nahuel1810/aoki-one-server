// RF15 — El agente rehidrata al arrancar, ANTES de pedir trabajo nuevo.
//
// `rehidratar()` tenia su test de unidad pero no estaba cableado a la
// composicion: su unico consumidor era ese test. Como el ciclo del robot solo
// lista PENDING y no toma un robot con `ordenActivaId`, una orden que quedo
// IN_PROGRESS por un reinicio a mitad de maniobra quedaba huerfana —nadie la
// volvia a tomar y el robot quedaba ocupado para siempre—. Este test afirma el
// cableado de punta a punta, que es lo que el de unidad no podia ver.
//
// El "reinicio" se representa sembrando en la base el estado que un corte deja
// escrito (orden IN_PROGRESS a mitad de pasos, robot BUSY con esa orden activa)
// y arrancando el agente sobre el. Es exactamente lo que `crearAgente` encuentra
// al abrir una base que ya existia.
//
// Lo unico simulado es el PLC: RF20 pone el default en false, asi que va
// explicito.

import { setTimeout as dormir } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import { crearAgente } from '../composition.js'
import type { Orden } from '../persistence/index.js'

const SITE_ID = 'sucursal-test'
const AGENT_ID = 'AG-TEST'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'

/** Ubicacion de guardado del cajon que la orden interrumpida iba a buscar. */
const ORIGEN = '3X04AA3'

/** Modulo 04 (par) -> lado RIGHT: solo compiten los slots del modulo 02. */
const ZONA_DE_PICKEO: readonly string[] = ['3X02AE1', '3X02AC1', '3X02AA1']

const ORDEN_HUERFANA = 'o-interrumpida'

const ESPERA_MAXIMA_MS = 10_000
const INTERVALO_DE_SONDEO_MS = 25
const TIMEOUT_DEL_TEST_MS = 30_000

const ESTADOS_FINALES = ['DONE', 'ERROR', 'CANCELED']

describe('rehidratacion al arrancar el agente (RF15)', () => {
  it(
    'una orden que quedo IN_PROGRESS por un reinicio vuelve a PENDING y se ejecuta',
    async () => {
      const agente = crearAgente({
        siteId: SITE_ID,
        agentId: AGENT_ID,
        rutaDeBase: ':memory:',
        // Sin API: lo que se afirma es el orquestador, no la capa HTTP.
        montarApi: false,
        simularPlc: true,
        httpPuerto: 0,
        httpBind: '127.0.0.1',
        zonaDePickeo: ZONA_DE_PICKEO,
        tokenDeMantenimiento: null,
        // Enlace APAGADO: la rehidratacion no depende del servidor, y es lo que
        // RF15 pide que pase ANTES de reclamar trabajo nuevo.
        enlace: null,
      })

      const repositorios = agente.orquestador.repositorios

      // --- Estado que deja un corte a mitad de maniobra ---
      const robot = await repositorios.robots.guardar({
        id: ROBOT_ID,
        siteId: SITE_ID,
        estanteriaCode: ESTANTERIA,
        habilitado: true,
        // El robot quedo tomado por la orden que se estaba ejecutando.
        estado: 'BUSY',
        ordenActivaId: ORDEN_HUERFANA,
      })
      expect(robot.ok).toBe(true)

      const interrumpida: Orden = {
        id: ORDEN_HUERFANA,
        siteId: SITE_ID,
        robotId: ROBOT_ID,
        externalOrderId: 'PICK-INTERRUMPIDA',
        tipo: 'PICK',
        origen: 'PICKING',
        estado: 'IN_PROGRESS',
        locationCode: ORIGEN,
        targetLocation: null,
        slotLocationCode: null,
        // Murio en el tercero de los cinco pasos: nadie sabe donde quedo el carro.
        currentStepIndex: 3,
        waitingForSlot: false,
        errorReason: null,
        creadaEn: 1_000,
        iniciadaEn: 1_500,
        finalizadaEn: null,
      }
      const sembrada = await repositorios.ordenes.crear(interrumpida)
      expect(sembrada.ok).toBe(true)

      await agente.iniciar()

      try {
        // --- Se rehidrato y volvio a ejecutarse sola, sin intervencion ---
        const limite = Date.now() + ESPERA_MAXIMA_MS
        let final = await repositorios.ordenes.buscarPorId(ORDEN_HUERFANA)
        while (!ESTADOS_FINALES.includes(final?.estado ?? '') && Date.now() < limite) {
          await dormir(INTERVALO_DE_SONDEO_MS)
          final = await repositorios.ordenes.buscarPorId(ORDEN_HUERFANA)
        }

        expect(final?.estado).toBe('DONE')
        // Se replayo desde HOMING: el indice volvio a 0 y recorrio los cinco pasos.
        // Sin rehidratacion habria quedado clavado en 3 y en IN_PROGRESS.
        expect(final?.currentStepIndex).toBe(5)
        expect(final?.errorReason).toBeNull()
        // Llego hasta el final: el cajon quedo apoyado en un slot de la zona.
        expect(ZONA_DE_PICKEO).toContain(final?.slotLocationCode)

        const pasos = await repositorios.pasos.listarPorOrden(ORDEN_HUERFANA)
        expect(pasos.map((paso) => paso.seq)).toEqual([1, 2, 3, 4, 5])

        // El robot se libero al rehidratar y volvio a IDLE al terminar: si la
        // orden activa hubiera quedado colgada, el ciclo lo habria salteado
        // siempre por ROBOT_OCUPADO.
        const robotFinal = await repositorios.robots.buscarPorId(ROBOT_ID)
        expect(robotFinal?.estado).toBe('IDLE')
        expect(robotFinal?.ordenActivaId).toBeNull()
      } finally {
        await agente.detener()
      }
    },
    TIMEOUT_DEL_TEST_MS,
  )
})
