// RF24 — las reglas de calculo de metricas y el reporte.
//
// El legacy las tenia sin un solo test, y son los numeros con los que se mide la
// operacion: cuanto espera el que vino a buscar un cajon.

import { describe, expect, it } from 'vitest'

import { abrirBase } from './database.js'
import { calcularTiempos, crearMetricsRepository } from './metricsRepository.js'
import type { EntradaDeMetrica, MetricsRepository } from './metricsRepository.js'

function entrada(parcial: Partial<EntradaDeMetrica> = {}): EntradaDeMetrica {
  return {
    ordenId: 'o-1',
    siteId: 'SUC-TEST',
    origen: 'PICKING',
    tipo: 'PICK',
    locationCode: '3X04AE1',
    estado: 'DONE',
    creadaEn: 1_000,
    iniciadaEn: 1_500,
    finalizadaEn: 3_000,
    ...parcial,
  }
}

describe('calcularTiempos', () => {
  it('separa la espera en cola de la duracion de la maniobra', () => {
    expect(calcularTiempos(entrada())).toEqual({ waitingMs: 500, durationMs: 1_500 })
  })

  // El fallback que el legacy tiene y nadie afirmaba. Una orden que termina sin
  // haber arrancado —se resolvio sin maniobra, RF07— es espera pura.
  it('una orden que nunca arranco cuenta como espera completa y duracion cero', () => {
    expect(calcularTiempos(entrada({ iniciadaEn: null }))).toEqual({
      waitingMs: 2_000,
      durationMs: 0,
    })
  })

  it('trata un inicio en 0 o negativo como si no hubiera arrancado', () => {
    // El legacy exige `startedAt > 0`: un 0 es "sin dato", no "arranco en el epoch".
    expect(calcularTiempos(entrada({ iniciadaEn: 0 }))).toEqual({
      waitingMs: 2_000,
      durationMs: 0,
    })
    expect(calcularTiempos(entrada({ iniciadaEn: -5 }))).toEqual({
      waitingMs: 2_000,
      durationMs: 0,
    })
  })

  it('nunca devuelve tiempos negativos, aunque los timestamps vengan cruzados', () => {
    // Relojes que corrigen hacia atras, o una orden persistida a mano. El clamp
    // a 0 se porta literal: un promedio con numeros negativos miente.
    const cruzada = calcularTiempos(entrada({ creadaEn: 5_000, iniciadaEn: 1_000, finalizadaEn: 900 }))
    expect(cruzada.waitingMs).toBe(0)
    expect(cruzada.durationMs).toBe(0)
  })
})

describe('reporte de metricas', () => {
  function conBase(): { repositorio: MetricsRepository; cerrar: () => void } {
    const base = abrirBase(':memory:')
    return { repositorio: crearMetricsRepository(base), cerrar: () => { base.cerrar() } }
  }

  it('cuenta pedidos por su PICK y maniobras por cada movimiento', async () => {
    const { repositorio, cerrar } = conBase()

    try {
      // Un pedido completo: traer y guardar. Son 2 maniobras y 1 pedido.
      await repositorio.registrar(entrada({ ordenId: 'o-1', tipo: 'PICK' }))
      await repositorio.registrar(entrada({ ordenId: 'o-2', tipo: 'PUT' }))

      const reporte = await repositorio.reporte({})

      expect(reporte.summary.totalOrders).toBe(1)
      expect(reporte.summary.totalManoeuvres).toBe(2)
      // Idealmente 2: traer y guardar.
      expect(reporte.summary.manoeuvresPerOrder).toBe(2)
    } finally {
      cerrar()
    }
  })

  it('separa los pedidos de picking de los manuales', async () => {
    const { repositorio, cerrar } = conBase()

    try {
      await repositorio.registrar(entrada({ ordenId: 'o-1', origen: 'PICKING' }))
      await repositorio.registrar(entrada({ ordenId: 'o-2', origen: 'MANUAL' }))
      await repositorio.registrar(entrada({ ordenId: 'o-3', origen: 'MANUAL' }))

      const reporte = await repositorio.reporte({})

      expect(reporte.summary.pickingOrders).toBe(1)
      expect(reporte.summary.manualOrders).toBe(2)
    } finally {
      cerrar()
    }
  })

  it('cuenta las que fallaron: medir solo los exitos esconde el numero que importa', async () => {
    const { repositorio, cerrar } = conBase()

    try {
      await repositorio.registrar(entrada({ ordenId: 'o-1', estado: 'DONE' }))
      await repositorio.registrar(entrada({ ordenId: 'o-2', estado: 'ERROR' }))

      const reporte = await repositorio.reporte({})
      expect(reporte.summary.failedOrders).toBe(1)
    } finally {
      cerrar()
    }
  })

  it('el tiempo hasta el slot promedia espera mas maniobra, solo sobre las DONE', async () => {
    const { repositorio, cerrar } = conBase()

    try {
      // 500 + 1500 = 2000
      await repositorio.registrar(entrada({ ordenId: 'o-1' }))
      // 1000 + 2000 = 3000
      await repositorio.registrar(
        entrada({ ordenId: 'o-2', creadaEn: 0, iniciadaEn: 1_000, finalizadaEn: 3_000 }),
      )
      // Fallida: no entra en el promedio.
      await repositorio.registrar(
        entrada({ ordenId: 'o-3', estado: 'ERROR', creadaEn: 0, finalizadaEn: 100_000 }),
      )

      const reporte = await repositorio.reporte({})

      expect(reporte.summary.avgTimeToSlotMs).toBe(2_500)
      expect(reporte.summary.maxTimeToSlotMs).toBe(3_000)
      // Cuanto de esa espera fue cola: (500 + 1000) / 2.
      expect(reporte.summary.avgQueueMs).toBe(750)
    } finally {
      cerrar()
    }
  })

  it('filtra por rango de fechas de finalizacion', async () => {
    const { repositorio, cerrar } = conBase()

    try {
      await repositorio.registrar(entrada({ ordenId: 'vieja', finalizadaEn: 1_000 }))
      await repositorio.registrar(entrada({ ordenId: 'media', finalizadaEn: 5_000 }))
      await repositorio.registrar(entrada({ ordenId: 'nueva', finalizadaEn: 9_000 }))

      expect((await repositorio.reporte({ desdeMs: 4_000 })).items.map((m) => m.ordenId)).toEqual([
        'nueva',
        'media',
      ])
      expect((await repositorio.reporte({ hastaMs: 4_000 })).items.map((m) => m.ordenId)).toEqual([
        'vieja',
      ])
      expect(
        (await repositorio.reporte({ desdeMs: 2_000, hastaMs: 8_000 })).items.map((m) => m.ordenId),
      ).toEqual(['media'])
    } finally {
      cerrar()
    }
  })

  it('rankea las ubicaciones mas pedidas, de mayor a menor', async () => {
    const { repositorio, cerrar } = conBase()

    try {
      await repositorio.registrar(entrada({ ordenId: 'o-1', locationCode: '3X04AE1' }))
      await repositorio.registrar(entrada({ ordenId: 'o-2', locationCode: '3X04AE1' }))
      await repositorio.registrar(entrada({ ordenId: 'o-3', locationCode: '3X06AA1' }))
      // Un PUT no cuenta como pedido: es la otra mitad del mismo.
      await repositorio.registrar(entrada({ ordenId: 'o-4', tipo: 'PUT', locationCode: '3X08AA1' }))

      const reporte = await repositorio.reporte({})

      expect(reporte.byLocation).toEqual([
        { locationCode: '3X04AE1', total: 2 },
        { locationCode: '3X06AA1', total: 1 },
      ])
    } finally {
      cerrar()
    }
  })

  it('un reporte sin datos no divide por cero', async () => {
    const { repositorio, cerrar } = conBase()

    try {
      const reporte = await repositorio.reporte({})

      expect(reporte.total).toBe(0)
      expect(reporte.summary.manoeuvresPerOrder).toBe(0)
      expect(reporte.summary.avgTimeToSlotMs).toBe(0)
      expect(reporte.items).toEqual([])
    } finally {
      cerrar()
    }
  })

  it('registrar dos veces la misma orden actualiza en vez de duplicar', async () => {
    const { repositorio, cerrar } = conBase()

    try {
      await repositorio.registrar(entrada({ ordenId: 'o-1', estado: 'DONE' }))
      await repositorio.registrar(entrada({ ordenId: 'o-1', estado: 'ERROR' }))

      const reporte = await repositorio.reporte({})
      expect(reporte.total).toBe(1)
      expect(reporte.items[0]?.estado).toBe('ERROR')
    } finally {
      cerrar()
    }
  })
})
