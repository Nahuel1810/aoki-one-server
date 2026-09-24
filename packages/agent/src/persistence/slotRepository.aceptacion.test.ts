// Portado de tests/unit/stateManager.test.js — caso 5 de "reserveSlotForPut
// acepta slots LIBRE y OCUPADO, rechaza otros" (RF06 + RF23).
//
// El test legacy metia los cinco casos en un solo it(). Los cuatro primeros son
// rechazos o aceptaciones POR ESTADO y viven en la maquina de estados pura
// (packages/domain/src/slotStateMachine.aceptacion.test.ts). Este quinto no se
// puede afirmar en el dominio: `transicionarSlot` ya recibe el estado del slot
// resuelto, asi que nunca puede emitir SLOT_INEXISTENTE. El unico productor de
// ese rechazo es el repositorio, que es quien resuelve el slot por su baseCode
// antes de transicionarlo. Por eso el test se parte y esta mitad vive aca.
//
// CAMBIO DE CONTRATO (RF06): el legacy afirmaba `assert.equal(missing, null)`.
// Ahora es un Result de error tipado, y con un codigo DISTINGUIBLE del rechazo
// por estado (SLOT_INEXISTENTE contra TRANSICION_INVALIDA): con el null los tres
// rechazos de `reserveSlotForPut` eran indistinguibles para el llamador.

import { describe, expect, it } from 'vitest'

import { abrirBase } from './database.js'
import { crearSlotRepository } from './slotRepository.js'

describe('slotRepository', () => {
  it('rechaza guardar el estado de un slot que no existe en la zona de pickeo', async () => {
    const base = abrirBase(':memory:')

    try {
      const repositorio = crearSlotRepository(base)
      await repositorio.sembrarZonaDePickeo('1', ['3X02AE1', '3X02AE2', '3X02AE3'])

      const resultado = await repositorio.guardarEstado('1', '9X99AE9', {
        estado: 'RESERVADO',
        ordenId: 'order-put-missing',
        contenido: null,
      })

      expect(resultado).toEqual({
        ok: false,
        error: { codigo: 'SLOT_INEXISTENTE', locationCode: '9X99AE9' },
      })
    } finally {
      base.cerrar()
    }
  })

  it('sembrar la zona NO pisa el slot que quedo con un cajon apoyado', async () => {
    // El arranque siembra la zona de pickeo SIEMPRE, no solo la primera vez. Si
    // el sembrado reescribiera los slots, cada reinicio del agente dejaria los
    // doce en LIBRE —incluido el que tiene un cajon encima— y el proximo PICK
    // mandaria el carro contra ese cajon. Un reinicio no puede ser un evento que
    // mueva cajones. Lo sostiene el INSERT OR IGNORE del sembrado.
    const base = abrirBase(':memory:')

    try {
      const repositorio = crearSlotRepository(base)
      const zona = ['3X02AE1', '3X02AE2', '3X02AE3']
      await repositorio.sembrarZonaDePickeo('1', zona)

      const ocupado = await repositorio.guardarEstado('1', '3X02AE2', {
        estado: 'OCUPADO',
        contenido: {
          cajon: { id: 'CAJON-1', ubicacionDeOrigen: '3X04AA3' },
          pendingReturns: 1,
        },
      })
      expect(ocupado.ok).toBe(true)

      // El reinicio.
      const resembrado = await repositorio.sembrarZonaDePickeo('1', zona)

      const despues = await repositorio.buscar('1', '3X02AE2')
      expect(despues?.estado).toEqual({
        estado: 'OCUPADO',
        contenido: {
          cajon: { id: 'CAJON-1', ubicacionDeOrigen: '3X04AA3' },
          pendingReturns: 1,
        },
      })

      // Y la zona sigue siendo de tres: el sembrado no duplico filas.
      expect(resembrado.ok).toBe(true)
      if (resembrado.ok) {
        expect(resembrado.valor).toHaveLength(3)
      }
    } finally {
      base.cerrar()
    }
  })
})
