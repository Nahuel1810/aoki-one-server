// RF09 y RF10 — La cola de un robot no se traba entera por una orden que espera.
//
// DIVERGENCIA CORREGIDA. El ciclo elegia siempre la orden mas antigua y, si esa
// no conseguia slot, la volvia a elegir en el ciclo siguiente y en el siguiente:
// nada mas corria en ese robot. En planta eso es una parada: un PICK del lado
// izquierdo con la zona izquierda llena bloqueaba tambien los PICK del lado
// derecho y —lo peor— TODOS los PUT, que son justamente los que liberan el slot
// que esa orden esta esperando. Deadlock permanente con el robot parado.
//
// El legacy no lo tenia: `deferOrderWaitingForSlot` sacaba la orden de la cabeza
// de la cola (`clearActive` + `enqueue`) y dejaba pasar a la siguiente, aunque al
// precio de mandarla al final. Aca se saltea sin reencolar, asi que tampoco
// pierde su lugar.
//
// Corre contra la base SQLite de verdad (en memoria) y contra el transporte
// doblado: lo que se afirma es QUE ORDEN CORRE, con los comandos que salen.

import { describe, expect, it } from 'vitest'

import { LOGGER_SILENCIOSO } from '@aoki-one/domain'
import type { Result, TipoDispositivo } from '@aoki-one/domain'

import { abrirBase, crearRepositorios } from '../persistence/index.js'
import type { Orden, RepositoriosDelAgente } from '../persistence/index.js'
import type { Reloj } from '../reloj.js'
import type { FalloDeEjecucion } from '../transport/errorClassification.js'
import type { PedidoDeComando, RespuestaUtilPlc } from '../transport/stepHandshake.js'
import { ejecutarCicloDeRobot } from './robotLoop.js'
import type { DependenciasDelOrquestador, PuertoDeTransporte } from './ports.js'

const SITE_ID = 'sucursal-test'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'

/** Modulo impar = lado LEFT; modulo par = lado RIGHT. */
const SLOT_IZQUIERDO = '3X01AE1'
const SLOT_DERECHO = '3X02AE1'
/** Ubicaciones de guardado: el origen de cada pedido, no de la zona de pickeo. */
const ORIGEN_IZQUIERDO = '3X05AA3'
const ORIGEN_DERECHO = '3X04AA3'
/** El cajon que ya ocupa el slot izquierdo, de otra ubicacion. */
const ORIGEN_DEL_CAJON_APOYADO = '3X03AA3'

const RELOJ: Reloj = { ahoraMs: () => 2_000, dormir: () => Promise.resolve() }

interface Banco {
  readonly repositorios: RepositoriosDelAgente
  readonly dependencias: DependenciasDelOrquestador
  readonly comandos: readonly number[]
  readonly cerrar: () => void
}

async function crearBanco(): Promise<Banco> {
  const base = abrirBase(':memory:')
  const repositorios = crearRepositorios(base)
  const comandos: number[] = []
  let siguienteId = 0

  const transporte: PuertoDeTransporte = {
    ejecutarComandoDePaso: (
      _robotId: string,
      _dispositivo: TipoDispositivo,
      pedido: PedidoDeComando,
    ) => {
      comandos.push(pedido.comando)
      const ok: Result<RespuestaUtilPlc, FalloDeEjecucion> = { ok: true, valor: { kind: 'OK' } }
      return Promise.resolve(ok)
    },
    resetearMessageIn: () => Promise.resolve({ ok: true, valor: undefined }),
    leerRegistros: () => {
      throw new Error('doble no configurado: leerRegistros')
    },
  }

  await repositorios.robots.guardar({
    id: ROBOT_ID,
    siteId: SITE_ID,
    estanteriaCode: ESTANTERIA,
    habilitado: true,
    estado: 'IDLE',
    ordenActivaId: null,
  })
  await repositorios.slots.sembrarZonaDePickeo(ROBOT_ID, [SLOT_IZQUIERDO, SLOT_DERECHO])
  // La zona IZQUIERDA queda llena: su unico slot tiene un cajon apoyado. La
  // derecha queda libre.
  await repositorios.slots.guardarEstado(ROBOT_ID, SLOT_IZQUIERDO, {
    estado: 'OCUPADO',
    contenido: {
      cajon: { id: 'caja-apoyada', ubicacionDeOrigen: ORIGEN_DEL_CAJON_APOYADO },
      pendingReturns: 1,
    },
  })

  return {
    repositorios,
    comandos,
    cerrar: base.cerrar,
    dependencias: {
      transporte,
      reloj: RELOJ,
      politica: { maxIntentos: 3, baseBackoffMs: 1 },
      repositorios,
      siteId: SITE_ID,
      agentId: 'AG-TEST',
      logger: LOGGER_SILENCIOSO,
      generarId: () => {
        siguienteId += 1
        return `id-${String(siguienteId)}`
      },
    },
  }
}

function orden(campos: {
  readonly id: string
  readonly tipo: Orden['tipo']
  readonly locationCode: string
  readonly creadaEn: number
}): Orden {
  return {
    id: campos.id,
    siteId: SITE_ID,
    robotId: ROBOT_ID,
    externalOrderId: campos.id,
    tipo: campos.tipo,
    origen: 'MANUAL',
    estado: 'PENDING',
    locationCode: campos.locationCode,
    targetLocation: null,
    slotLocationCode: null,
    currentStepIndex: 0,
    waitingForSlot: false,
    errorReason: null,
    creadaEn: campos.creadaEn,
    iniciadaEn: null,
    finalizadaEn: null,
  }
}

describe('la cola de un robot no se traba por una orden en espera (RF10)', () => {
  it('con la zona izquierda llena, el PICK derecho CORRE aunque el izquierdo sea mas antiguo', async () => {
    const banco = await crearBanco()
    try {
      // La mas antigua es la que no puede avanzar: es la que trababa todo.
      await banco.repositorios.ordenes.crear(
        orden({ id: 'o-izq', tipo: 'PICK', locationCode: ORIGEN_IZQUIERDO, creadaEn: 1_000 }),
      )
      await banco.repositorios.ordenes.crear(
        orden({ id: 'o-der', tipo: 'PICK', locationCode: ORIGEN_DERECHO, creadaEn: 2_000 }),
      )

      const resultado = await ejecutarCicloDeRobot(banco.dependencias, ROBOT_ID)

      // LO QUE IMPORTA: corrio la segunda.
      expect(resultado).toEqual({
        tipo: 'ORDEN_TERMINADA',
        ordenId: 'o-der',
        estadoFinal: 'DONE',
        huboManiobra: true,
      })
      expect(banco.comandos).toHaveLength(5)

      const derecha = await banco.repositorios.ordenes.buscarPorId('o-der')
      expect(derecha?.estado).toBe('DONE')
      expect(derecha?.slotLocationCode).toBe(SLOT_DERECHO)

      // Y la que espera no perdio su lugar: sigue PENDING, con su creadaEn
      // intacto y marcada como en espera para que el operario la vea.
      const izquierda = await banco.repositorios.ordenes.buscarPorId('o-izq')
      expect(izquierda?.estado).toBe('PENDING')
      expect(izquierda?.creadaEn).toBe(1_000)
      expect(izquierda?.waitingForSlot).toBe(true)

      // El robot quedo libre: no se lo llevo puesto la orden que espera.
      const robot = await banco.repositorios.robots.buscarPorId(ROBOT_ID)
      expect(robot?.ordenActivaId).toBeNull()
    } finally {
      banco.cerrar()
    }
  })

  // El deadlock completo: el PUT es el unico que libera el slot que el PICK
  // espera, y antes quedaba detras de el para siempre.
  it('con la zona llena el PUT de ese lado pasa al frente y destraba al PICK que esperaba', async () => {
    const banco = await crearBanco()
    try {
      await banco.repositorios.ordenes.crear(
        orden({ id: 'o-izq', tipo: 'PICK', locationCode: ORIGEN_IZQUIERDO, creadaEn: 1_000 }),
      )
      // Para un PUT el locationCode ES el slot del que sale el cajon.
      await banco.repositorios.ordenes.crear(
        orden({ id: 'o-put', tipo: 'PUT', locationCode: SLOT_IZQUIERDO, creadaEn: 2_000 }),
      )

      // RF09: zona de ese lado llena -> el PUT encabeza, aunque sea mas nuevo.
      const primero = await ejecutarCicloDeRobot(banco.dependencias, ROBOT_ID)
      expect(primero).toMatchObject({ ordenId: 'o-put', estadoFinal: 'DONE', huboManiobra: true })
      const slotLiberado = await banco.repositorios.slots.buscar(ROBOT_ID, SLOT_IZQUIERDO)
      expect(slotLiberado?.estado).toEqual({ estado: 'LIBRE' })

      // Y con el slot libre, el PICK que esperaba corre en el ciclo siguiente.
      const segundo = await ejecutarCicloDeRobot(banco.dependencias, ROBOT_ID)
      expect(segundo).toMatchObject({ ordenId: 'o-izq', estadoFinal: 'DONE', huboManiobra: true })

      const izquierda = await banco.repositorios.ordenes.buscarPorId('o-izq')
      expect(izquierda?.slotLocationCode).toBe(SLOT_IZQUIERDO)
      expect(izquierda?.waitingForSlot).toBe(false)
    } finally {
      banco.cerrar()
    }
  })

  it('si NINGUNA puede avanzar lo dice, no toma ninguna y deja el robot libre', async () => {
    const banco = await crearBanco()
    try {
      // Las dos son PICK del lado izquierdo, que es el que tiene la zona llena.
      await banco.repositorios.ordenes.crear(
        orden({ id: 'o-izq-1', tipo: 'PICK', locationCode: ORIGEN_IZQUIERDO, creadaEn: 1_000 }),
      )
      await banco.repositorios.ordenes.crear(
        orden({ id: 'o-izq-2', tipo: 'PICK', locationCode: ORIGEN_IZQUIERDO, creadaEn: 2_000 }),
      )
      // El unico slot derecho se llena tambien: no queda ningun slot libre.
      await banco.repositorios.slots.guardarEstado(ROBOT_ID, SLOT_DERECHO, {
        estado: 'OCUPADO',
        contenido: {
          cajon: { id: 'caja-derecha', ubicacionDeOrigen: ORIGEN_DERECHO },
          pendingReturns: 1,
        },
      })

      const resultado = await ejecutarCicloDeRobot(banco.dependencias, ROBOT_ID)

      expect(resultado).toEqual({
        tipo: 'COLA_EN_ESPERA_DE_SLOT',
        robotId: ROBOT_ID,
        ordenes: ['o-izq-1', 'o-izq-2'],
      })
      // Ni un comando: el robot no se movio.
      expect(banco.comandos).toEqual([])
      const robot = await banco.repositorios.robots.buscarPorId(ROBOT_ID)
      expect(robot?.ordenActivaId).toBeNull()
      const primera = await banco.repositorios.ordenes.buscarPorId('o-izq-1')
      expect(primera?.estado).toBe('PENDING')
      expect(primera?.waitingForSlot).toBe(true)
    } finally {
      banco.cerrar()
    }
  })
})
