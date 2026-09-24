// T23 — Lo que hay que poder afirmar antes de correr esto sobre la base de un
// robot en produccion: que se puede correr dos veces, que se puede ensayar sin
// escribir, que una fila podrida no se lleva puesta a la migracion entera, y que
// la base origen queda exactamente como estaba.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { abrirBase } from '../persistence/database.js'
import type { BaseDelAgente } from '../persistence/database.js'
import { crearRepositorios } from '../persistence/index.js'
import { migrar } from './migrar.js'
import { abrirOrigenLegacy } from './origenLegacy.js'
import type { OrigenLegacy } from './origenLegacy.js'

const SITE_ID = 'SUC-CENTRO'

/** El snapshot que guarda el `StateManager` viejo, con casos buenos y podridos. */
const SNAPSHOT = {
  slots: [
    { locationCode: '3X02AE1', robotId: '3X', status: 'LIBRE', reservedByOrderId: null },
    {
      locationCode: '3X04AB2',
      robotId: '3X',
      status: 'OCUPADO',
      reservedByOrderId: 'orden-vieja',
      currentBox: { id: 'CAJON-9', sourceLocationCode: '3X06AC3' },
      logicalPickStackDepth: 2,
    },
    // Podrido: la ubicacion no cumple la gramatica.
    { locationCode: 'ESTANTE-DEL-FONDO', robotId: '3X', status: 'LIBRE' },
    // Podrido: estado que no existe.
    { locationCode: '3X08AD1', robotId: '3X', status: 'VOLANDO' },
  ],
  orders: [
    {
      id: 'orden-abierta',
      externalOrderId: 47,
      type: 'PICK',
      origin: 'PICKING',
      status: 'PENDING',
      locationCode: '3X06AC3',
      robotId: '3X',
      currentStepIndex: 0,
      waitingForSlot: false,
      createdAt: 1000,
      startedProcessingAt: null,
    },
    {
      id: 'orden-terminada',
      externalOrderId: 46,
      type: 'PUT',
      status: 'DONE',
      locationCode: '3X06AC3',
      robotId: '3X',
      createdAt: 900,
    },
    // Podrida: sin estado ni fecha de alta.
    { id: 'orden-rota', type: 'PICK' },
  ],
}

interface Escenario {
  readonly directorio: string
  readonly rutaOrigen: string
  readonly destino: BaseDelAgente
}

function sembrarOrigen(ruta: string): void {
  const sql = new Database(ruta)
  sql.exec(`
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- Sin NOT NULL a proposito: asi se puede sembrar la fila corrupta que el
    -- test necesita, que es justo la que una base vieja termina teniendo.
    CREATE TABLE order_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL UNIQUE,
      origin TEXT,
      type TEXT,
      location_code TEXT,
      waiting_ms INTEGER,
      duration_ms INTEGER,
      status TEXT,
      created_at INTEGER,
      finished_at INTEGER
    );
  `)
  sql
    .prepare('INSERT INTO snapshots (id, payload_json, updated_at) VALUES (1, ?, 1)')
    .run(JSON.stringify(SNAPSHOT))
  sql
    .prepare(
      `INSERT INTO order_metrics (order_id, origin, type, location_code, waiting_ms,
                                  duration_ms, status, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('m-buena', 'PICKING', 'PICK', '3X06AC3', 1500, 4200, 'DONE', 10, 20)
  // Podrida: sin ubicacion.
  sql
    .prepare(
      `INSERT INTO order_metrics (order_id, origin, type, location_code, waiting_ms,
                                  duration_ms, status, created_at, finished_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run('m-rota', 'PICKING', 'PICK', 0, 0, 'DONE', 30, 40)
  sql.close()
}

let escenario: Escenario

function abrirOrigen(): OrigenLegacy {
  const origen = abrirOrigenLegacy(escenario.rutaOrigen)
  if (!origen.ok) {
    throw new Error(`no se pudo abrir el origen sintetico: ${origen.error.codigo}`)
  }
  return origen.valor
}

async function correr(simulacion: boolean): ReturnType<typeof migrar> {
  const origen = abrirOrigen()
  try {
    return await migrar(origen, escenario.destino, { siteId: SITE_ID, simulacion })
  } finally {
    origen.cerrar()
  }
}

function contar(tabla: string): number {
  const fila = escenario.destino.sql.prepare(`SELECT COUNT(*) AS total FROM ${tabla}`).get()
  return (fila as { readonly total: number }).total
}

beforeEach(() => {
  const directorio = mkdtempSync(join(tmpdir(), 'aoki-migracion-'))
  const rutaOrigen = join(directorio, 'persistence.db')
  sembrarOrigen(rutaOrigen)
  // El destino en memoria: la migracion no necesita un archivo para probarse y
  // asi no queda basura si el test se cae.
  escenario = { directorio, rutaOrigen, destino: abrirBase(':memory:') }
})

afterEach(() => {
  escenario.destino.cerrar()
  rmSync(escenario.directorio, { recursive: true, force: true })
})

describe('migracion desde la base actual', () => {
  it('trae slots, ordenes abiertas y metricas, con el site_id de la sucursal', async () => {
    const reporte = await correr(false)

    expect(reporte.ok).toBe(true)
    if (!reporte.ok) {
      return
    }
    expect(reporte.valor.slots.migrados).toBe(2)
    expect(reporte.valor.ordenes.migrados).toBe(1)
    expect(reporte.valor.metricas.migrados).toBe(1)
    expect(reporte.valor.robots.migrados).toBe(1)

    const repositorios = crearRepositorios(escenario.destino)
    const slot = await repositorios.slots.buscar('3X', '3X04AB2')
    expect(slot?.estado).toEqual({
      estado: 'OCUPADO',
      contenido: {
        cajon: { id: 'CAJON-9', ubicacionDeOrigen: '3X06AC3' },
        // El refcount de devoluciones del legacy se conserva: si se perdiera, el
        // cajon volveria a su lugar una vez de menos.
        pendingReturns: 2,
      },
    })

    const orden = await repositorios.ordenes.buscarPorId('orden-abierta')
    expect(orden?.estado).toBe('PENDING')
    expect(orden?.siteId).toBe(SITE_ID)
    // El entero del legacy pasa a texto, que es como lo tipa el modelo nuevo.
    expect(orden?.externalOrderId).toBe('47')

    const metrica = escenario.destino.sql
      .prepare('SELECT site_id, waiting_ms, duration_ms FROM order_metrics WHERE orden_id = ?')
      .get('m-buena')
    // Los milisegundos se conservan tal cual: son los numeros que el negocio ya
    // vio, no se recalculan.
    expect(metrica).toEqual({ site_id: SITE_ID, waiting_ms: 1500, duration_ms: 4200 })
  })

  it('no trae las ordenes que ya habian terminado', async () => {
    await correr(false)

    const repositorios = crearRepositorios(escenario.destino)
    expect(await repositorios.ordenes.buscarPorId('orden-terminada')).toBeUndefined()
  })

  it('es idempotente: la segunda corrida no duplica ni reescribe nada', async () => {
    const primera = await correr(false)
    const estadoTrasLaPrimera = escenario.destino.sql.prepare('SELECT * FROM slots').all()

    const segunda = await correr(false)

    expect(primera.ok && segunda.ok).toBe(true)
    if (!segunda.ok) {
      return
    }
    expect(segunda.valor.slots.migrados).toBe(0)
    expect(segunda.valor.slots.yaMigrados).toBe(2)
    expect(segunda.valor.ordenes.migrados).toBe(0)
    expect(segunda.valor.ordenes.yaMigrados).toBe(1)
    expect(segunda.valor.metricas.yaMigrados).toBe(1)
    expect(segunda.valor.robots.yaMigrados).toBe(1)

    expect(contar('slots')).toBe(2)
    expect(contar('orders')).toBe(1)
    expect(contar('order_metrics')).toBe(1)
    // Ni siquiera el contador de version de la fila se movio: no hubo escritura.
    expect(escenario.destino.sql.prepare('SELECT * FROM slots').all()).toEqual(
      estadoTrasLaPrimera,
    )
  })

  it('no pisa un slot que el agente nuevo ya movio: lo reporta', async () => {
    await correr(false)
    const repositorios = crearRepositorios(escenario.destino)
    // El agente ya devolvio el cajon y dejo el slot en otro estado.
    await repositorios.slots.guardarEstado('3X', '3X04AB2', {
      estado: 'BUSCANDO',
      ordenId: 'orden-de-hoy',
    })

    const reporte = await correr(false)

    expect(reporte.ok).toBe(true)
    if (!reporte.ok) {
      return
    }
    expect(reporte.valor.slots.omitidos).toContainEqual({
      referencia: '3X/3X04AB2',
      motivo: { codigo: 'DESTINO_YA_MODIFICADO', estadoActual: 'BUSCANDO' },
    })
    const slot = await repositorios.slots.buscar('3X', '3X04AB2')
    expect(slot?.estado.estado).toBe('BUSCANDO')
  })

  it('la simulacion dice lo mismo que la corrida real y no escribe una fila', async () => {
    const simulada = await correr(true)

    expect(simulada.ok).toBe(true)
    if (!simulada.ok) {
      return
    }
    expect(simulada.valor.simulacion).toBe(true)
    expect(simulada.valor.slots.migrados).toBe(2)
    expect(simulada.valor.ordenes.migrados).toBe(1)
    expect(simulada.valor.metricas.migrados).toBe(1)

    expect(contar('slots')).toBe(0)
    expect(contar('orders')).toBe(0)
    expect(contar('order_metrics')).toBe(0)
    expect(contar('robots')).toBe(0)

    // Y despues de simular, la corrida real hace exactamente lo que anuncio.
    const real = await correr(false)
    expect(real.ok).toBe(true)
    if (!real.ok) {
      return
    }
    expect(real.valor.slots.migrados).toBe(simulada.valor.slots.migrados)
    expect(real.valor.ordenes.migrados).toBe(simulada.valor.ordenes.migrados)
    expect(real.valor.metricas.migrados).toBe(simulada.valor.metricas.migrados)
  })

  it('reporta cada fila corrupta con su motivo en vez de cortar la migracion', async () => {
    const reporte = await correr(false)

    expect(reporte.ok).toBe(true)
    if (!reporte.ok) {
      return
    }

    expect(reporte.valor.slots.omitidos).toContainEqual({
      referencia: 'ESTANTE-DEL-FONDO',
      motivo: { codigo: 'LOCATION_CODE_INVALIDO', valor: 'ESTANTE-DEL-FONDO' },
    })
    const motivosDeSlot = reporte.valor.slots.omitidos.map((omitido) => omitido.motivo.codigo)
    expect(motivosDeSlot).toContain('FILA_ILEGIBLE')

    expect(reporte.valor.ordenes.omitidos).toHaveLength(1)
    expect(reporte.valor.ordenes.omitidos[0]?.motivo.codigo).toBe('FILA_ILEGIBLE')

    expect(reporte.valor.metricas.omitidos).toContainEqual({
      referencia: 'm-rota',
      motivo: expect.objectContaining({ codigo: 'FILA_ILEGIBLE' }) as unknown,
    })

    // Y lo sano entro igual: una fila podrida no puede costar la migracion.
    expect(contar('slots')).toBe(2)
    expect(contar('order_metrics')).toBe(1)
  })

  it('no toca la base origen: ni una tabla nueva ni una fila cambiada', async () => {
    const antes = new Database(escenario.rutaOrigen, { readonly: true })
    const tablasAntes = antes.prepare('SELECT name FROM sqlite_master ORDER BY name').all()
    const snapshotAntes = antes.prepare('SELECT payload_json FROM snapshots').get()
    antes.close()

    await correr(false)

    const despues = new Database(escenario.rutaOrigen, { readonly: true })
    try {
      expect(despues.prepare('SELECT name FROM sqlite_master ORDER BY name').all()).toEqual(
        tablasAntes,
      )
      expect(despues.prepare('SELECT payload_json FROM snapshots').get()).toEqual(snapshotAntes)
      expect(
        despues.prepare('SELECT COUNT(*) AS total FROM order_metrics').get(),
      ).toEqual({ total: 2 })
    } finally {
      despues.close()
    }
  })
})
