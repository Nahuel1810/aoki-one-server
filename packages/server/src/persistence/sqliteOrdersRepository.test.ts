// RF27–RF29 — La cola durable: entrega con lease, re-entrega y reporte idempotente.
//
// Es la parte del servidor que decide si el robot hace una maniobra dos veces o
// ninguna, asi que los casos que importan son los feos: el agente que se muere
// con la orden en la mano, el reporte que llega repetido y el que llega tarde.

import { describe, expect, it } from 'vitest'

import { abrirBase } from './database.js'
import { crearColaDelServidor } from './sqliteOrdersRepository.js'
import type { ColaDelServidor } from './sqliteOrdersRepository.js'

const LEASE_MS = 60_000

function conCola(): { cola: ColaDelServidor; avanzar: (ms: number) => void; ahora: () => number; cerrar: () => void } {
  const base = abrirBase(':memory:')
  let reloj = 1_000_000
  let contador = 0
  const cola = crearColaDelServidor(
    base,
    () => {
      contador += 1
      return `id-${String(contador)}`
    },
    () => reloj,
  )
  return {
    cola,
    ahora: () => reloj,
    avanzar: (ms) => {
      reloj += ms
    },
    cerrar: () => {
      base.cerrar()
    },
  }
}

async function alta(cola: ColaDelServidor, externalOrderId: string): Promise<string> {
  const resultado = await cola.insertar({
    siteId: 'SUC-1',
    externalOrderId,
    tipo: 'PICK',
    locationCode: '3X04AE1',
  })
  if (!resultado.ok) {
    throw new Error(`no se pudo dar de alta ${externalOrderId}`)
  }
  return resultado.valor.id
}

describe('dedupe del ingreso (RF26)', () => {
  it('la segunda alta con la misma clave la rechaza el indice, no un SELECT previo', async () => {
    const { cola, cerrar } = conCola()

    try {
      const primera = await cola.insertar({
        siteId: 'SUC-1',
        externalOrderId: 'pedido-1',
        tipo: 'PICK',
        locationCode: '3X04AE1',
      })
      expect(primera.ok).toBe(true)

      const segunda = await cola.insertar({
        siteId: 'SUC-1',
        externalOrderId: 'pedido-1',
        tipo: 'PICK',
        locationCode: '3X04AE1',
      })
      expect(segunda).toEqual({ ok: false, error: { codigo: 'CLAVE_DUPLICADA' } })
    } finally {
      cerrar()
    }
  })

  it('la misma clave en otra sucursal es otro pedido', async () => {
    const { cola, cerrar } = conCola()

    try {
      await alta(cola, 'pedido-1')
      const otraSucursal = await cola.insertar({
        siteId: 'SUC-2',
        externalOrderId: 'pedido-1',
        tipo: 'PICK',
        locationCode: '3X04AE1',
      })
      expect(otraSucursal.ok).toBe(true)
    } finally {
      cerrar()
    }
  })
})

describe('entrega con lease (RF28)', () => {
  it('entrega en orden de llegada y respeta el limite', async () => {
    const { cola, ahora, cerrar } = conCola()

    try {
      await alta(cola, 'p-1')
      await alta(cola, 'p-2')
      await alta(cola, 'p-3')

      const reclamados = await cola.reclamar('SUC-1', 'agente-1', 2, ahora(), LEASE_MS)
      expect(reclamados.map((p) => p.externalOrderId)).toEqual(['p-1', 'p-2'])
    } finally {
      cerrar()
    }
  })

  it('no entrega dos veces lo mismo mientras el lease este vigente', async () => {
    const { cola, ahora, avanzar, cerrar } = conCola()

    try {
      await alta(cola, 'p-1')

      expect(await cola.reclamar('SUC-1', 'agente-1', 10, ahora(), LEASE_MS)).toHaveLength(1)

      // Otro agente pidiendo al mismo tiempo no se lo lleva.
      expect(await cola.reclamar('SUC-1', 'agente-2', 10, ahora(), LEASE_MS)).toHaveLength(0)

      // Y el mismo agente tampoco lo recibe duplicado.
      avanzar(LEASE_MS - 1)
      expect(await cola.reclamar('SUC-1', 'agente-1', 10, ahora(), LEASE_MS)).toHaveLength(0)
    } finally {
      cerrar()
    }
  })

  it('el lease vencido devuelve la orden a la cola con el mismo externalOrderId', async () => {
    const { cola, ahora, avanzar, cerrar } = conCola()

    try {
      await alta(cola, 'p-1')
      const primera = await cola.reclamar('SUC-1', 'agente-1', 10, ahora(), LEASE_MS)
      expect(primera).toHaveLength(1)

      // El agente se murio con la orden en la mano.
      avanzar(LEASE_MS + 1)

      const reentrega = await cola.reclamar('SUC-1', 'agente-2', 10, ahora(), LEASE_MS)
      expect(reentrega).toHaveLength(1)
      // La clave se conserva: es lo que permite que el dedupe del agente (RF14)
      // absorba la re-entrega sin que el robot haga la maniobra dos veces.
      expect(reentrega[0]?.externalOrderId).toBe('p-1')
      expect(reentrega[0]?.id).toBe(primera[0]?.id)
    } finally {
      cerrar()
    }
  })

  it('una sucursal no recibe el trabajo de otra', async () => {
    const { cola, ahora, cerrar } = conCola()

    try {
      await alta(cola, 'p-1')
      expect(await cola.reclamar('SUC-2', 'agente-de-otra', 10, ahora(), LEASE_MS)).toHaveLength(0)
    } finally {
      cerrar()
    }
  })
})

describe('reporte de transiciones (RF29)', () => {
  it('aplica la transicion y actualiza el estado del pedido', async () => {
    const { cola, ahora, cerrar } = conCola()

    try {
      const id = await alta(cola, 'p-1')
      const resultado = await cola.aplicarTransicion({
        ordenId: id,
        seq: 1,
        estado: 'IN_PROGRESS',
        reportadaEn: ahora(),
        metadata: { robotId: '1' },
      })

      expect(resultado.tipo).toBe('APLICADA')
      expect((await cola.buscarPorId(id))?.estado).toBe('IN_PROGRESS')
    } finally {
      cerrar()
    }
  })

  it('descarta el reporte repetido: el outbox reintenta hasta tener confirmacion', async () => {
    const { cola, ahora, cerrar } = conCola()

    try {
      const id = await alta(cola, 'p-1')
      const transicion = {
        ordenId: id,
        seq: 1,
        estado: 'IN_PROGRESS' as const,
        reportadaEn: ahora(),
        metadata: {},
      }

      expect((await cola.aplicarTransicion(transicion)).tipo).toBe('APLICADA')
      expect(await cola.aplicarTransicion(transicion)).toEqual({
        tipo: 'DESCARTADA',
        motivo: 'SEQ_REPETIDA',
      })
    } finally {
      cerrar()
    }
  })

  it('descarta el reporte viejo: sin esto la orden RETROCEDE de estado', async () => {
    const { cola, ahora, cerrar } = conCola()

    try {
      const id = await alta(cola, 'p-1')

      await cola.aplicarTransicion({
        ordenId: id,
        seq: 1,
        estado: 'IN_PROGRESS',
        reportadaEn: ahora(),
        metadata: {},
      })
      await cola.aplicarTransicion({
        ordenId: id,
        seq: 2,
        estado: 'DONE',
        reportadaEn: ahora(),
        metadata: {},
      })

      // Llega tarde un reporte anterior, que con outbox y reintentos es normal.
      const tardio = await cola.aplicarTransicion({
        ordenId: id,
        seq: 1,
        estado: 'IN_PROGRESS',
        reportadaEn: ahora(),
        metadata: {},
      })

      expect(tardio.tipo).toBe('DESCARTADA')
      // Lo que importa: la app de picking no ve la orden volver a IN_PROGRESS.
      expect((await cola.buscarPorId(id))?.estado).toBe('DONE')
    } finally {
      cerrar()
    }
  })

  it('una orden terminada suelta su lease y no se re-entrega nunca mas', async () => {
    const { cola, ahora, avanzar, cerrar } = conCola()

    try {
      const id = await alta(cola, 'p-1')
      await cola.reclamar('SUC-1', 'agente-1', 10, ahora(), LEASE_MS)
      await cola.aplicarTransicion({
        ordenId: id,
        seq: 1,
        estado: 'DONE',
        reportadaEn: ahora(),
        metadata: {},
      })

      avanzar(LEASE_MS * 10)
      expect(await cola.reclamar('SUC-1', 'agente-1', 10, ahora(), LEASE_MS)).toHaveLength(0)
    } finally {
      cerrar()
    }
  })

  it('un reporte sobre una orden que no existe se distingue de una descartada', async () => {
    const { cola, ahora, cerrar } = conCola()

    try {
      const resultado = await cola.aplicarTransicion({
        ordenId: 'no-existe',
        seq: 1,
        estado: 'DONE',
        reportadaEn: ahora(),
        metadata: {},
      })
      expect(resultado).toEqual({ tipo: 'ORDEN_INEXISTENTE' })
    } finally {
      cerrar()
    }
  })
})

describe('pendientes', () => {
  it('cuenta lo que esta disponible, no lo que ya tiene lease vigente', async () => {
    const { cola, ahora, avanzar, cerrar } = conCola()

    try {
      await alta(cola, 'p-1')
      await alta(cola, 'p-2')
      expect(await cola.pendientes('SUC-1', ahora())).toBe(2)

      await cola.reclamar('SUC-1', 'agente-1', 1, ahora(), LEASE_MS)
      expect(await cola.pendientes('SUC-1', ahora())).toBe(1)

      // Al vencer el lease vuelve a contarse: esta disponible de nuevo.
      avanzar(LEASE_MS + 1)
      expect(await cola.pendientes('SUC-1', ahora())).toBe(2)
    } finally {
      cerrar()
    }
  })
})
