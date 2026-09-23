// RF34 — La cola de salida de transiciones.
//
// Lo que se afirma aca es lo que el servidor necesita para no descartar
// transiciones buenas: seq monotona POR ORDEN, y monotona TAMBIEN despues de que
// la cola se vacio. Ver `aplicarTransicion` en
// packages/server/src/persistence/sqliteOrdersRepository.ts: descarta la seq
// repetida y la menor que la maxima ya aplicada.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { abrirBase, type BaseDelAgente } from '../persistence/database.js'
import { crearOutboxSqlite, type OutboxDeTransiciones } from './outbox.js'

const AHORA_MS = 1_700_000_000_000

let base: BaseDelAgente
let outbox: OutboxDeTransiciones

beforeEach(() => {
  base = abrirBase(':memory:')
  outbox = crearOutboxSqlite(base)
})

afterEach(() => {
  base.cerrar()
})

function alta(ordenId: string, estado: 'IN_PROGRESS' | 'DONE' | 'ERROR' | 'PENDING') {
  return { ordenId, estado, metadata: {}, creadaEn: AHORA_MS } as const
}

describe('outbox de transiciones (RF34)', () => {
  it('numera la seq de forma monotona y por orden', async () => {
    const primera = await outbox.encolar(alta('o-1', 'IN_PROGRESS'))
    const segunda = await outbox.encolar(alta('o-1', 'DONE'))
    const deOtraOrden = await outbox.encolar(alta('o-2', 'IN_PROGRESS'))

    expect(primera.seq).toBe(1)
    expect(segunda.seq).toBe(2)
    // La seq es por orden: la de o-2 no continua la de o-1.
    expect(deOtraOrden.seq).toBe(1)
  })

  it('sigue numerando hacia arriba despues de que la cola se vacio', async () => {
    const primera = await outbox.encolar(alta('o-1', 'IN_PROGRESS'))
    await outbox.confirmar(primera.id)
    expect(await outbox.pendientes()).toBe(0)

    // Si la seq saliera de MAX(seq) sobre lo pendiente, aca volveria a 1 y el
    // servidor descartaria esta transicion como repetida.
    const siguiente = await outbox.encolar(alta('o-1', 'DONE'))
    expect(siguiente.seq).toBe(2)
  })

  it('entrega las pendientes en orden de encolado', async () => {
    await outbox.encolar(alta('o-1', 'IN_PROGRESS'))
    await outbox.encolar(alta('o-2', 'IN_PROGRESS'))
    await outbox.encolar(alta('o-1', 'DONE'))

    const pendientes = await outbox.proximas(10)
    expect(pendientes.map((t) => [t.ordenId, t.seq])).toEqual([
      ['o-1', 1],
      ['o-2', 1],
      ['o-1', 2],
    ])
  })

  it('conserva estado y metadata al ida y vuelta por la base', async () => {
    await outbox.encolar({
      ordenId: 'o-1',
      estado: 'ERROR',
      metadata: { motivo: 'TIMEOUT_ACK', seq: 3 },
      creadaEn: AHORA_MS,
    })

    const [pendiente] = await outbox.proximas(1)
    expect(pendiente?.estado).toBe('ERROR')
    expect(pendiente?.metadata).toEqual({ motivo: 'TIMEOUT_ACK', seq: 3 })
  })

  it('un intento fallido deja la transicion en la cola con su motivo', async () => {
    const encolada = await outbox.encolar(alta('o-1', 'DONE'))
    await outbox.registrarIntentoFallido(encolada.id, 'SIN_RED')

    const [pendiente] = await outbox.proximas(10)
    expect(await outbox.pendientes()).toBe(1)
    expect(pendiente?.intentos).toBe(1)
  })

  it('el vinculo con el id remoto es null hasta que la orden existe del otro lado', async () => {
    expect(await outbox.buscarVinculo('o-1')).toBeNull()

    await outbox.vincular('o-1', 'remota-1')
    expect(await outbox.buscarVinculo('o-1')).toBe('remota-1')

    // Vincular no puede pisar la numeracion: la orden ya venia reportando.
    const siguiente = await outbox.encolar(alta('o-1', 'DONE'))
    expect(siguiente.seq).toBe(1)
    await outbox.vincular('o-1', 'remota-1')
    expect((await outbox.encolar(alta('o-1', 'ERROR'))).seq).toBe(2)
  })
})
