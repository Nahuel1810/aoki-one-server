// Portado de tests/unit/orchestrator.test.js (T02).
//
// Dos tests del OrchestratorService legacy sobre el PUT, los dos ADAPTADOS.
//
// "acepta PUT manual sobre slot LIBRE (devolucion fuera-de-libros)": el caso feliz
// sobrevive, pero el legacy NO mandaba targetLocation y pasaba igual. Bajo RF11 un
// PUT sobre un slot vacio en libros EXIGE targetLocation y sin el se rechaza (400).
// Portarlo literal habria quedado en verde tapando justo el cambio. Se agregan el
// rechazo y el caso complementario (slot con cajon en libros: el destino sale de
// `cajon.ubicacionDeOrigen` y el targetLocation recibido se IGNORA).
//
// "deja PUT en espera si el slot esta BLOQUEADO": el nombre mentia (el estado se
// llama y se persiste ERROR; BLOCKED era un alias interno). Ademas cambia el SETUP:
// el legacy llegaba a ERROR por `blockSlot` en el camino de fallo de un paso, y bajo
// RF13 un paso fallido CONSERVA el estado del slot, asi que ese camino desaparece.
// ERROR queda solo para un slot realmente inutilizable y por eso ahora es un estado
// que el fixture escribe directo. El assert de fondo no cambia: la orden ESPERA, no
// se rechaza.

import { describe, it, expect } from 'vitest'

import type { EstadoSlot } from '@aoki-one/domain'

import { resolverDestinoDePut } from './putTargetResolution.js'

const SLOT = '3X02AE1'

/**
 * La zona de pickeo del robot. Entra al pedido porque el destino de una
 * devolucion NUNCA puede caer en ella (invariante de seguridad de RF11): sin la
 * zona en la mano, "el destino es un slot" es indecidible.
 */
const ZONA_DE_PICKEO: readonly string[] = [SLOT, '3X02AC1']

const LIBRE: EstadoSlot = { estado: 'LIBRE' }

const CON_CAJON_EN_LIBROS: EstadoSlot = {
  estado: 'OCUPADO',
  contenido: {
    cajon: { id: 'existing', ubicacionDeOrigen: '3X04AE1' },
    pendingReturns: 1,
  },
}

const INUTILIZABLE: EstadoSlot = { estado: 'ERROR', motivo: 'falla previa' }

const TOMADO_POR_OTRA_ORDEN: EstadoSlot = {
  estado: 'RESERVADO',
  ordenId: 'o-otra',
  contenido: null,
}

describe('destino de una devolucion (portado de orchestrator.test.js)', () => {
  it('acepta el PUT sobre un slot LIBRE con destino y lo exige cuando falta', () => {
    const conDestino = resolverDestinoDePut({
      slotLocationCode: SLOT,
      zonaDePickeo: ZONA_DE_PICKEO,
      estadoDelSlot: LIBRE,
      targetLocationPedido: '3X04AE1',
    })

    expect(conDestino).toEqual({
      ok: true,
      valor: {
        tipo: 'DESTINO_RESUELTO',
        destino: { locationCode: '3X04AE1', resueltoDesde: 'PEDIDO' },
      },
    })

    // RF11: slot vacio en libros y sin destino -> se rechaza (400). El legacy no
    // mandaba targetLocation y devolvia el cajon al mismo slot.
    const sinDestino = resolverDestinoDePut({
      slotLocationCode: SLOT,
      zonaDePickeo: ZONA_DE_PICKEO,
      estadoDelSlot: LIBRE,
      targetLocationPedido: null,
    })

    expect(sinDestino).toEqual({
      ok: false,
      error: { codigo: 'TARGET_LOCATION_REQUERIDO', slotLocationCode: SLOT },
    })

    // Caso complementario: con cajon en libros el destino sale del cajon y el
    // targetLocation recibido se IGNORA.
    const conCajon = resolverDestinoDePut({
      slotLocationCode: SLOT,
      zonaDePickeo: ZONA_DE_PICKEO,
      estadoDelSlot: CON_CAJON_EN_LIBROS,
      targetLocationPedido: '9X09AL9',
    })

    expect(conCajon).toEqual({
      ok: true,
      valor: {
        tipo: 'DESTINO_RESUELTO',
        destino: { locationCode: '3X04AE1', resueltoDesde: 'CAJON_EN_LIBROS' },
      },
    })
  })

  it('deja el PUT esperando si el slot esta en ERROR o tomado por otra maniobra', () => {
    const sobreSlotEnError = resolverDestinoDePut({
      slotLocationCode: SLOT,
      zonaDePickeo: ZONA_DE_PICKEO,
      estadoDelSlot: INUTILIZABLE,
      targetLocationPedido: '3X04AE1',
    })

    // Esperar es un resultado, no un error del pedido: el slot puede volver.
    expect(sobreSlotEnError).toEqual({
      ok: true,
      valor: { tipo: 'ESPERAR_SLOT', estado: 'ERROR' },
    })

    const sobreSlotReservado = resolverDestinoDePut({
      slotLocationCode: SLOT,
      zonaDePickeo: ZONA_DE_PICKEO,
      estadoDelSlot: TOMADO_POR_OTRA_ORDEN,
      targetLocationPedido: '3X04AE1',
    })

    expect(sobreSlotReservado).toEqual({
      ok: true,
      valor: { tipo: 'ESPERAR_SLOT', estado: 'RESERVADO' },
    })
  })
})
