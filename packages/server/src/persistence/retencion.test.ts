// RNF de rendimiento: el estado persistido no crece sin techo.
//
// Lo que importa afirmar es el borde: se borra lo TERMINADO y vencido, y no se
// toca lo que sigue vivo por viejo que sea.

import { describe, expect, it } from 'vitest'

import { abrirBase } from './database.js'
import type { BaseDelServidor } from './database.js'
import { purgar } from './retencion.js'

const DIA_MS = 24 * 60 * 60 * 1000
const AHORA = 1_700_000_000_000

function sembrarPedido(
  base: BaseDelServidor,
  id: string,
  finalizadaEn: number | null,
): void {
  base.sql
    .prepare(
      `INSERT INTO orders (id, site_id, robot_id, external_order_id, tipo, location_code,
                           target_location, estado, creada_en, entregada_en, finalizada_en)
       VALUES (?, 'SUC-01', '3X', ?, 'PICK', '3X02AE1', NULL, ?, ?, NULL, ?)`,
    )
    .run(id, id, finalizadaEn === null ? 'PENDING' : 'DONE', AHORA - 400 * DIA_MS, finalizadaEn)
  base.sql
    .prepare(
      `INSERT INTO order_transitions (order_id, seq, estado, reportada_en, metadata_json)
       VALUES (?, 1, 'DONE', ?, '{}')`,
    )
    .run(id, finalizadaEn ?? AHORA)
  base.sql
    .prepare(
      'INSERT INTO order_leases (order_id, agent_id, otorgado_en, vence_en) VALUES (?, ?, ?, ?)',
    )
    .run(id, 'agente-1', AHORA - 400 * DIA_MS, AHORA - 399 * DIA_MS)
}

function contar(base: BaseDelServidor, tabla: string): number {
  const fila = base.sql.prepare(`SELECT COUNT(*) AS total FROM ${tabla}`).get()
  return (fila as { readonly total: number }).total
}

describe('purga por retencion', () => {
  it('borra el pedido vencido con su rastro y conserva el reciente', () => {
    const base = abrirBase(':memory:')
    try {
      sembrarPedido(base, 'viejo', AHORA - 100 * DIA_MS)
      sembrarPedido(base, 'reciente', AHORA - 10 * DIA_MS)

      const resultado = purgar(base, AHORA, { diasDePedidosTerminados: 90 })

      expect(resultado.pedidos).toBe(1)
      expect(resultado.transiciones).toBe(1)
      expect(resultado.leases).toBe(1)
      expect(contar(base, 'orders')).toBe(1)
      expect(contar(base, 'order_transitions')).toBe(1)
      expect(contar(base, 'order_leases')).toBe(1)
    } finally {
      base.cerrar()
    }
  })

  it('no borra un pedido sin terminar por mas viejo que sea', () => {
    const base = abrirBase(':memory:')
    try {
      // Trabajo pendiente del ano pasado: borrarlo seria perder el pedido, no
      // limpiar historia.
      sembrarPedido(base, 'abandonado', null)

      const resultado = purgar(base, AHORA, { diasDePedidosTerminados: 1 })

      expect(resultado.pedidos).toBe(0)
      expect(contar(base, 'orders')).toBe(1)
    } finally {
      base.cerrar()
    }
  })

  it('es idempotente: la segunda corrida no borra nada', () => {
    const base = abrirBase(':memory:')
    try {
      sembrarPedido(base, 'viejo', AHORA - 100 * DIA_MS)
      purgar(base, AHORA, { diasDePedidosTerminados: 90 })

      const segunda = purgar(base, AHORA, { diasDePedidosTerminados: 90 })

      expect(segunda.pedidos).toBe(0)
    } finally {
      base.cerrar()
    }
  })
})
