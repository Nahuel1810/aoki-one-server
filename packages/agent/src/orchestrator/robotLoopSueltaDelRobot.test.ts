// RF23 — `robots.orden_activa_id` se suelta pase lo que pase.
//
// El puntero no es un dato de pantalla: `ejecutarCicloDeRobot` lo mira primero y,
// si no es null, da al robot por OCUPADO y no toma nada mas. O sea que un puntero
// colgado no deja una pantalla desactualizada, deja al ROBOT PARADO.
//
// Antes se tomaba antes de la maniobra y se soltaba despues, sin `finally`. En
// este modulo no hay un solo `catch`, y better-sqlite3 lanza SINCRONO —un
// SQLITE_BUSY, un disco lleno—, asi que cualquier excepcion entre las dos
// escrituras dejaba al robot tomado por una orden que ya no corria. La
// rehidratacion limpia el puntero en cada arranque, asi que reiniciar arreglaba;
// esto es para no necesitar el reinicio.

import { describe, expect, it } from 'vitest'

import { LOGGER_SILENCIOSO } from '@aoki-one/domain'

import { ejecutarCicloDeRobot } from './robotLoop.js'
import type { DependenciasDelOrquestador, PuertoDeTransporte } from './ports.js'
import { abrirBase, crearRepositorios } from '../persistence/index.js'
import type { RepositoriosDelAgente } from '../persistence/index.js'
import type { Orden } from '../persistence/orderRepository.js'
import type { Reloj } from '../reloj.js'

const SITE_ID = 'sucursal-test'
const ROBOT_ID = '1'
const ESTANTERIA = '3X'
const SLOT = '3X02AE1'
const ORIGEN = '3X04AE1'

const RELOJ: Reloj = { ahoraMs: () => 2_000, dormir: () => Promise.resolve() }

const FALLA_DE_PLANTA = 'SQLITE_BUSY: database is locked'

async function crearBanco(): Promise<{
  dependencias: DependenciasDelOrquestador
  repositorios: RepositoriosDelAgente
  cerrar: () => void
}> {
  const base = abrirBase(':memory:')
  const repositorios = crearRepositorios(base)

  const transporte: PuertoDeTransporte = {
    // Tira en vez de devolver un Result de error: es la diferencia entre un paso
    // que FALLA —que el orquestador ya sabe manejar— y una excepcion que se
    // escapa, que es lo que este test cubre.
    ejecutarComandoDePaso: () => {
      throw new Error(FALLA_DE_PLANTA)
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
  await repositorios.slots.sembrarZonaDePickeo(ROBOT_ID, [SLOT])
  await repositorios.slots.guardarEstado(ROBOT_ID, SLOT, {
    estado: 'OCUPADO',
    contenido: { cajon: { id: 'caja-1', ubicacionDeOrigen: ORIGEN }, pendingReturns: 1 },
  })

  let siguienteId = 0
  return {
    repositorios,
    cerrar: base.cerrar,
    dependencias: {
      transporte,
      reloj: RELOJ,
      politica: { maxIntentos: 1, baseBackoffMs: 1 },
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

function ordenDePut(id: string): Orden {
  return {
    id,
    siteId: SITE_ID,
    robotId: ROBOT_ID,
    externalOrderId: id,
    tipo: 'PUT',
    origen: 'MANUAL',
    estado: 'PENDING',
    locationCode: SLOT,
    targetLocation: null,
    slotLocationCode: null,
    currentStepIndex: 0,
    waitingForSlot: false,
    errorReason: null,
    creadaEn: 1_000,
    iniciadaEn: null,
    finalizadaEn: null,
  }
}

describe('el robot se suelta aunque la maniobra reviente', () => {
  it('una excepcion en el transporte NO deja el robot tomado', async () => {
    const banco = await crearBanco()

    try {
      await banco.repositorios.ordenes.crear(ordenDePut('o-1'))

      // La excepcion se propaga: no se la traga nadie, y eso esta bien — quien
      // decide que hacer con ella es el bucle de arriba, no este ciclo.
      await expect(ejecutarCicloDeRobot(banco.dependencias, ROBOT_ID)).rejects.toThrow(
        FALLA_DE_PLANTA,
      )

      // Lo que importa: el robot quedo libre. Sin el finally, `ordenActivaId`
      // seguiria en 'o-1' y el robot no tomaria ni una orden mas hasta que
      // alguien reiniciara el proceso.
      const robot = await banco.repositorios.robots.buscarPorId(ROBOT_ID)
      expect(robot?.ordenActivaId).toBeNull()
    } finally {
      banco.cerrar()
    }
  })

  it('el ciclo siguiente NO ve al robot ocupado', async () => {
    // Es la consecuencia que importa en planta. Sin el finally este segundo ciclo
    // —y todos los que vengan— cortaria en ROBOT_OCUPADO apuntando a una orden
    // que ya no corre, y el robot no volveria a trabajar hasta que alguien
    // reiniciara el proceso.
    const banco = await crearBanco()

    try {
      await banco.repositorios.ordenes.crear(ordenDePut('o-1'))
      await expect(ejecutarCicloDeRobot(banco.dependencias, ROBOT_ID)).rejects.toThrow()

      const siguiente = await ejecutarCicloDeRobot(banco.dependencias, ROBOT_ID)
      expect(siguiente.tipo).not.toBe('ROBOT_OCUPADO')
    } finally {
      banco.cerrar()
    }
  })
})
