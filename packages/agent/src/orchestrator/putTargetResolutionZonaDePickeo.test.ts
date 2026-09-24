// RF11 — Invariante de seguridad: una devolucion nunca termina en la zona de pickeo.
//
// DIVERGENCIA CORREGIDA contra la logica VIVA del servidor de produccion. El
// working tree de `src/core/orchestrator/OrchestratorService.js` tiene
// `assertReturnTargetIsStorage`, que rechaza un PUT cuyo destino sea el propio
// slot del que sale el cajon o CUALQUIER otro slot de pickeo, y lo verifica dos
// veces: al crear la orden y otra vez al construir el comando, que es lo ultimo
// antes de mandarlo al PLC.
//
// El sistema nuevo lo declaraba explicitamente fuera de alcance ("NO esta
// DESTINO_ES_EL_PROPIO_SLOT", en el docblock de `ErrorDeDestinoDePut`). Sin el,
// el robot deja el cajon sobre un slot de pickeo, la orden pasa a DONE y el slot
// se libera: el cajon queda fisicamente en la zona y, en los libros, en ningun
// lado. El inventario se rompe y el proximo PICK sobre ese slot choca con un
// cajon que no deberia estar ahi.
//
// RF11 ya nombraba el caso del propio slot ("Nunca se acepta una devolucion cuyo
// destino sea el propio slot"); la extension a toda la zona se anoto en la spec
// como diferencia declarada.

import { describe, expect, it } from 'vitest'

import type { EstadoSlot } from '@aoki-one/domain'

import { resolverDestinoDePut } from './putTargetResolution.js'
import type { PedidoDeDestinoDePut } from './putTargetResolution.js'

/** Zona de pickeo de planta del modulo 02 (lado derecho). */
const ZONA: readonly string[] = ['3X02AA1', '3X02AC1', '3X02AE1']

/** Ubicacion de GUARDADO: modulo 04, fuera de la zona de pickeo. */
const UBICACION_DE_GUARDADO = '3X04AA3'

const SLOT_LIBRE: EstadoSlot = { estado: 'LIBRE' }

function slotOcupadoCon(ubicacionDeOrigen: string): EstadoSlot {
  return {
    estado: 'OCUPADO',
    contenido: { cajon: { id: 'caja-1', ubicacionDeOrigen }, pendingReturns: 1 },
  }
}

function pedido(parcial: Partial<PedidoDeDestinoDePut>): PedidoDeDestinoDePut {
  return {
    slotLocationCode: '3X02AE1',
    estadoDelSlot: SLOT_LIBRE,
    targetLocationPedido: null,
    zonaDePickeo: ZONA,
    ...parcial,
  }
}

describe('resolverDestinoDePut: el destino nunca cae en la zona de pickeo', () => {
  it('rechaza la devolucion cuyo destino es el MISMO slot del que sale el cajon', () => {
    // Es el caso que producia el `target || source` del legacy: el robot iba a
    // "devolver" el cajon al lugar donde ya estaba, el paso respondia OK y
    // despues el slot se marcaba libre con el cajon todavia apoyado.
    expect(
      resolverDestinoDePut(
        pedido({ slotLocationCode: '3X02AE1', targetLocationPedido: '3X02AE1' }),
      ),
    ).toEqual({
      ok: false,
      error: {
        codigo: 'DESTINO_EN_ZONA_DE_PICKEO',
        slotLocationCode: '3X02AE1',
        destino: '3X02AE1',
      },
    })
  })

  it('rechaza la devolucion cuyo destino es OTRO slot de pickeo', () => {
    expect(
      resolverDestinoDePut(
        pedido({ slotLocationCode: '3X02AE1', targetLocationPedido: '3X02AC1' }),
      ),
    ).toEqual({
      ok: false,
      error: {
        codigo: 'DESTINO_EN_ZONA_DE_PICKEO',
        slotLocationCode: '3X02AE1',
        destino: '3X02AC1',
      },
    })
  })

  it('el invariante se afirma por baseCode: el sufijo de accion no lo esquiva', () => {
    // `3X02AC1D` y `3X02AC1` son el mismo slot. Comparar los codigos crudos
    // dejaria pasar el destino prohibido con una letra de mas.
    expect(resolverDestinoDePut(pedido({ targetLocationPedido: '3X02AC1D' }))).toEqual({
      ok: false,
      error: {
        codigo: 'DESTINO_EN_ZONA_DE_PICKEO',
        slotLocationCode: '3X02AE1',
        destino: '3X02AC1',
      },
    })
  })

  it('tambien vale para el destino que sale del cajon en libros, no solo para el pedido', () => {
    // Ultima barrera: un slot sembrado con un cajon cuyo origen es otro slot de
    // pickeo no puede colarse solo porque el destino no lo mando la tablet.
    expect(
      resolverDestinoDePut(
        pedido({
          slotLocationCode: '3X02AE1',
          estadoDelSlot: slotOcupadoCon('3X02AA1'),
          targetLocationPedido: null,
        }),
      ),
    ).toEqual({
      ok: false,
      error: {
        codigo: 'DESTINO_EN_ZONA_DE_PICKEO',
        slotLocationCode: '3X02AE1',
        destino: '3X02AA1',
      },
    })
  })

  it('rechaza un destino que no parsea en vez de dejarlo pasar sin verificar', () => {
    expect(resolverDestinoDePut(pedido({ targetLocationPedido: 'no-es-una-ubicacion' }))).toEqual({
      ok: false,
      error: { codigo: 'TARGET_LOCATION_INVALIDO', recibido: 'no-es-una-ubicacion' },
    })
  })

  it('acepta la devolucion a una ubicacion de guardado y la normaliza a baseCode', () => {
    expect(resolverDestinoDePut(pedido({ targetLocationPedido: '3X04AA3D' }))).toEqual({
      ok: true,
      valor: {
        tipo: 'DESTINO_RESUELTO',
        destino: { locationCode: UBICACION_DE_GUARDADO, resueltoDesde: 'PEDIDO' },
      },
    })
  })

  it('con cajon en libros devuelve a su ubicacion de origen e ignora lo que mando la tablet', () => {
    expect(
      resolverDestinoDePut(
        pedido({
          estadoDelSlot: slotOcupadoCon(UBICACION_DE_GUARDADO),
          targetLocationPedido: '3X06AB2',
        }),
      ),
    ).toEqual({
      ok: true,
      valor: {
        tipo: 'DESTINO_RESUELTO',
        destino: { locationCode: UBICACION_DE_GUARDADO, resueltoDesde: 'CAJON_EN_LIBROS' },
      },
    })
  })
})
