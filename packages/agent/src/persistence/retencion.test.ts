// RNF de Rendimiento — "El estado persistido no crece sin techo: retencion
// configurable para eventos, comandos y errores, con purga."
//
// Lo que hay que afirmar de una purga no es que borre: es que borre lo que
// sobra y NO lo que hace falta. Una purga que se lleva de mas es peor que no
// tener purga, porque se lleva justo el dato con el que despues se contesta una
// pregunta —el historico de RF24, los pasos de una orden en curso (RF15)— y no
// hay de donde recuperarlo.

import { describe, expect, it } from 'vitest'

import { abrirBase, type BaseDelAgente } from './database.js'
import { crearEventRepository } from './eventRepository.js'
import { crearMetricsRepository } from './metricsRepository.js'
import { crearOrderRepository, type Orden } from './orderRepository.js'
import { crearOrderStepRepository } from './orderStepRepository.js'
import {
  crearPurgaDelAgente,
  programarPurga,
  RETENCION_POR_DEFECTO,
  type PoliticaDeRetencion,
} from './retencion.js'

const AHORA = 1_000_000_000_000
const DIA_MS = 24 * 60 * 60 * 1000

/** Retencion corta para no tener que mover el reloj un mes en cada caso. */
const RETENCION: PoliticaDeRetencion = { eventosMs: 10 * DIA_MS, pasosMs: 5 * DIA_MS }

function orden(parcial: Partial<Orden>): Orden {
  return {
    id: 'o-1',
    siteId: 'SUC-01',
    robotId: 'R1',
    externalOrderId: null,
    tipo: 'PICK',
    origen: 'PICKING',
    estado: 'DONE',
    locationCode: '3X04AE1',
    targetLocation: null,
    slotLocationCode: null,
    currentStepIndex: 5,
    waitingForSlot: false,
    errorReason: null,
    creadaEn: AHORA - 100 * DIA_MS,
    iniciadaEn: AHORA - 100 * DIA_MS,
    finalizadaEn: AHORA - 100 * DIA_MS,
    ...parcial,
  }
}

async function sembrarPaso(base: BaseDelAgente, ordenId: string): Promise<void> {
  await crearOrderStepRepository(base).registrar({
    ordenId,
    seq: 1,
    tipo: 'HOMING',
    dispositivo: 'CARRO',
    estado: 'DONE',
    intentos: 1,
    iniciadoEn: AHORA - 100 * DIA_MS,
    finalizadoEn: AHORA - 100 * DIA_MS,
  })
}

async function sembrarEvento(base: BaseDelAgente, id: string, ts: number): Promise<void> {
  await crearEventRepository(base).registrar({
    id,
    ts,
    tipoDeEntidad: 'ORDER',
    entidadId: 'o-1',
    evento: 'STEP_FAILED',
    severidad: 'ERROR',
    metadata: {},
  })
}

function contar(base: BaseDelAgente, tabla: string): number {
  const fila = base.sql.prepare(`SELECT COUNT(*) AS total FROM ${tabla}`).get() as { total: number }
  return fila.total
}

describe('purga por retencion del agente', () => {
  it('borra los eventos viejos y deja los que estan dentro de la ventana', async () => {
    const base = abrirBase(':memory:')
    await sembrarEvento(base, 'viejo', AHORA - 11 * DIA_MS)
    await sembrarEvento(base, 'nuevo', AHORA - 9 * DIA_MS)

    const resultado = await crearPurgaDelAgente(base, RETENCION).purgar(AHORA)

    expect(resultado.eventosBorrados).toBe(1)
    const quedan = await crearEventRepository(base).listar({})
    expect(quedan.map((evento) => evento.id)).toEqual(['nuevo'])
    base.cerrar()
  })

  it('borra los pasos de una orden terminada hace rato', async () => {
    const base = abrirBase(':memory:')
    await crearOrderRepository(base).crear(orden({ id: 'vieja' }))
    await sembrarPaso(base, 'vieja')

    const resultado = await crearPurgaDelAgente(base, RETENCION).purgar(AHORA)

    expect(resultado.pasosBorrados).toBe(1)
    expect(await crearOrderStepRepository(base).listarPorOrden('vieja')).toEqual([])
    base.cerrar()
  })

  it('NO toca los pasos de una orden todavia en curso, por vieja que sea', async () => {
    // Es el caso que rompe el sistema: los pasos de una orden viva son lo que lee
    // la rehidratacion al arrancar (RF15). Sin ellos, un reinicio a mitad de
    // maniobra deja la orden imposible de reconstruir.
    const base = abrirBase(':memory:')
    await crearOrderRepository(base).crear(
      orden({ id: 'en-curso', estado: 'IN_PROGRESS', finalizadaEn: null }),
    )
    await sembrarPaso(base, 'en-curso')

    const resultado = await crearPurgaDelAgente(base, RETENCION).purgar(AHORA)

    expect(resultado.pasosBorrados).toBe(0)
    expect(await crearOrderStepRepository(base).listarPorOrden('en-curso')).toHaveLength(1)
    base.cerrar()
  })

  it('NO toca los pasos de una orden que termino dentro de la ventana', async () => {
    const base = abrirBase(':memory:')
    await crearOrderRepository(base).crear(
      orden({ id: 'reciente', finalizadaEn: AHORA - 4 * DIA_MS }),
    )
    await sembrarPaso(base, 'reciente')

    await crearPurgaDelAgente(base, RETENCION).purgar(AHORA)

    expect(await crearOrderStepRepository(base).listarPorOrden('reciente')).toHaveLength(1)
    base.cerrar()
  })

  it('NO borra las metricas ni la orden: es el historico con el que se mide (RF24)', async () => {
    // La decision de la task. `order_metrics` crece igual que todo lo demas,
    // pero su reporte filtra JUSTO por rango de fechas: purgarla por antiguedad
    // borra el unico dato que el negocio mira. Y sin la fila de `orders` el
    // dedupe de RF14 deja de rechazar una re-entrega vieja.
    const base = abrirBase(':memory:')
    await crearOrderRepository(base).crear(orden({ id: 'antiquisima' }))
    await sembrarPaso(base, 'antiquisima')
    await crearMetricsRepository(base).registrar({
      ordenId: 'antiquisima',
      siteId: 'SUC-01',
      origen: 'PICKING',
      tipo: 'PICK',
      locationCode: '3X04AE1',
      estado: 'DONE',
      creadaEn: AHORA - 100 * DIA_MS,
      iniciadaEn: AHORA - 100 * DIA_MS,
      finalizadaEn: AHORA - 100 * DIA_MS,
    })

    await crearPurgaDelAgente(base, RETENCION).purgar(AHORA)

    expect(contar(base, 'order_metrics')).toBe(1)
    expect(contar(base, 'orders')).toBe(1)
    const reporte = await crearMetricsRepository(base).reporte({})
    expect(reporte.total).toBe(1)
    base.cerrar()
  })

  it('con la retencion por defecto no se lleva nada de los ultimos dias', async () => {
    const base = abrirBase(':memory:')
    await sembrarEvento(base, 'de-ayer', AHORA - DIA_MS)
    await crearOrderRepository(base).crear(orden({ id: 'de-ayer', finalizadaEn: AHORA - DIA_MS }))
    await sembrarPaso(base, 'de-ayer')

    const resultado = await crearPurgaDelAgente(base, RETENCION_POR_DEFECTO).purgar(AHORA)

    expect(resultado).toEqual({ eventosBorrados: 0, pasosBorrados: 0 })
    base.cerrar()
  })
})

describe('programarPurga', () => {
  it('corre una pasada al arrancar, sin esperar al intervalo', async () => {
    // Es la mitad que hace que la purga corra SOLA: la notebook de sucursal se
    // apaga a la noche, asi que un agente que solo purgara por intervalo de
    // uptime no purgaria nunca.
    const base = abrirBase(':memory:')
    await sembrarEvento(base, 'viejo', AHORA - 11 * DIA_MS)

    const pasadas: number[] = []
    const programada = programarPurga({
      purga: crearPurgaDelAgente(base, RETENCION),
      intervaloMs: 60_000,
      ahoraMs: () => AHORA,
      alTerminar: (resultado) => pasadas.push(resultado.eventosBorrados),
      alFallar: () => pasadas.push(-1),
    })
    await Promise.resolve()

    expect(pasadas).toEqual([1])
    programada.detener()
    base.cerrar()
  })

  it('un fallo de la purga se avisa y no propaga: el robot sigue andando', async () => {
    const pasadas: unknown[] = []
    const programada = programarPurga({
      purga: {
        purgar: () => Promise.reject(new Error('disco lleno')),
      },
      intervaloMs: 60_000,
      ahoraMs: () => AHORA,
      alTerminar: () => pasadas.push('ok'),
      alFallar: (error) => pasadas.push(error instanceof Error ? error.message : error),
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(pasadas).toEqual(['disco lleno'])
    programada.detener()
  })
})
