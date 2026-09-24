// Portado de tests/integration/api.test.js :: "API /api/orders/pick deduplica
// por id numerico" (T02).
//
// TRADUCIDO: el componente cambio de lado. El endpoint /api/orders/pick
// DESAPARECE de la API local del agente — el ingreso de pedidos de picking se va
// al servidor Linux (RF26) — y el equivalente vive en POST /api/v1/orders.
//
// Que afirmaba el legacy: POST /api/orders/pick con { id: 2001 } devuelve 202 y
// created:true la primera vez; el reenvio identico devuelve 200, created:false y
// la MISMA orden (mismo data.id); y el listado sigue teniendo una sola orden. La
// dedupe era por id externo NUMERICO.
//
// Que afirma ahora y por que cambio:
//  - Se conservan literales: 202 en el alta nueva, 200 con el pedido existente
//    en el reenvio, y que un reenvio no cree un segundo pedido.
//  - La clave pasa de un id numerico a (siteId, externalOrderId) y el
//    externalOrderId deja de estar restringido a entero: el servidor no
//    interpreta su contenido, solo lo usa como clave. Por eso el fixture usa un
//    id no numerico, que bajo el contrato viejo no habria sido valido.
//  - Se agrega el caso que la clave compuesta hace posible y el legacy no podia
//    expresar: el mismo externalOrderId en otra sucursal es OTRO pedido.
//  - El alta no es "buscar y despues insertar": el doble rechaza la clave
//    duplicada como lo haria el indice unico, y el caso de uso traduce ese
//    rechazo a YA_EXISTIA. Es la ventana de carrera que el legacy tenia entre las
//    dos lecturas del indice (created se calculaba en la ruta y la dedupe real
//    vivia en submitOrder) y que su test secuencial no podia detectar.
//
// La segunda mitad del test legacy —que el agente no ejecute trabajo fisico
// duplicado— es el indice unico local de RF14 y se porta en
// packages/agent/src/orchestrator/orderIntake.
//
// DEFICIT CONOCIDO: RF26 pide ademas HMAC del body, anti-replay por timestamp y
// validacion del siteId contra la credencial. Ningun test legacy lo cubre (el
// servidor no existia) y entra con T33.

import { describe, expect, it } from 'vitest'

import { ingresarPedido, responderIngreso } from './ordersIngest.js'
import type {
  AltaDePedido,
  ClaveDePedido,
  PedidoDelServidor,
  RepositorioDePedidos,
} from '../persistence/ordersRepository.js'

interface RepositorioDoble extends RepositorioDePedidos {
  /** Cuantos pedidos hay en el libro. Es el "no nacio una segunda orden". */
  readonly cantidad: () => number
}

function claveDe(clave: ClaveDePedido): string {
  return `${clave.siteId}\u0000${clave.externalOrderId}`
}

/** Doble del indice unico (site_id, external_order_id): la clave la corta la base. */
function crearRepositorioDoble(): RepositorioDoble {
  const porClave = new Map<string, PedidoDelServidor>()
  let secuencia = 0

  return {
    buscarPorClave: (clave) => Promise.resolve(porClave.get(claveDe(clave)) ?? null),
    insertar: (alta) => {
      if (porClave.has(claveDe(alta))) {
        return Promise.resolve({ ok: false, error: { codigo: 'CLAVE_DUPLICADA' } })
      }
      secuencia += 1
      const pedido: PedidoDelServidor = {
        id: `PED-${String(secuencia)}`,
        siteId: alta.siteId,
        externalOrderId: alta.externalOrderId,
        tipo: alta.tipo,
        locationCode: alta.locationCode,
        estado: 'PENDING',
        // El instante lo pone el repositorio, no el request.
        creadaEn: 1_700_000_000_000 + secuencia,
      }
      porClave.set(claveDe(alta), pedido)
      return Promise.resolve({ ok: true, valor: pedido })
    },
    cantidad: () => porClave.size,
  }
}

// El id externo ya no es un entero: el legacy mandaba 2001.
const ALTA: AltaDePedido = {
  siteId: 'SUC-001',
  externalOrderId: 'PICK-2001',
  tipo: 'PICK',
  locationCode: '3X04AA3',
}

describe('RF26 — ingreso idempotente de pedidos de picking', () => {
  it('el reenvio del mismo (siteId, externalOrderId) devuelve el pedido existente', async () => {
    const repositorio = crearRepositorioDoble()

    const primero = await ingresarPedido(repositorio, ALTA)
    expect(primero.tipo).toBe('CREADO')

    const segundo = await ingresarPedido(repositorio, ALTA)
    expect(segundo.tipo).toBe('YA_EXISTIA')
    expect(segundo.pedido.id).toBe(primero.pedido.id)
    expect(segundo.pedido.externalOrderId).toBe('PICK-2001')

    expect(repositorio.cantidad()).toBe(1)
  })

  it('el alta nueva responde 202 con created true y el reenvio 200 con created false', async () => {
    const repositorio = crearRepositorioDoble()

    const respuestaDelAlta = responderIngreso(await ingresarPedido(repositorio, ALTA))
    expect(respuestaDelAlta.estadoHttp).toBe(202)
    expect(respuestaDelAlta.cuerpo.ok).toBe(true)
    expect(respuestaDelAlta.cuerpo.created).toBe(true)

    const respuestaDelReenvio = responderIngreso(await ingresarPedido(repositorio, ALTA))
    expect(respuestaDelReenvio.estadoHttp).toBe(200)
    expect(respuestaDelReenvio.cuerpo.ok).toBe(true)
    expect(respuestaDelReenvio.cuerpo.created).toBe(false)
    expect(respuestaDelReenvio.cuerpo.data.id).toBe(respuestaDelAlta.cuerpo.data.id)
  })

  it('el mismo externalOrderId en otra sucursal es otro pedido', async () => {
    const repositorio = crearRepositorioDoble()

    const enLaPrimera = await ingresarPedido(repositorio, ALTA)
    const enLaSegunda = await ingresarPedido(repositorio, { ...ALTA, siteId: 'SUC-002' })

    expect(enLaPrimera.tipo).toBe('CREADO')
    expect(enLaSegunda.tipo).toBe('CREADO')
    expect(enLaSegunda.pedido.id).not.toBe(enLaPrimera.pedido.id)
    expect(repositorio.cantidad()).toBe(2)
  })
})
