// Portado de tests/architecture/modularity.test.js :: "Se puede levantar app sin
// API (componente desconectable)" (T02).
//
// TRADUCIDO.
//
// Que afirmaba el legacy: con enableApi:false el proceso arranca igual, GET
// /health sigue respondiendo 200 y GET /api/orders devuelve 404.
//
// Que afirma ahora y por que cambio:
//  - El 404 de /api/orders era trivial (el router nunca se monto) y lo daria
//    cualquier Express vacio; ademas dependia de un detalle fragil de src/app.js
//    (el fallback SPA solo se monta si existe public-dist/index.html y excluye
//    por regex). En el agente nuevo, sin montar la API no hay listener: la
//    afirmacion pasa a ser que `api` y `direccion()` quedan en null.
//  - El /health que seguia respondiendo se porta como forma de /health en
//    api/health.aceptacion.test.ts, no aca.
//  - Se agrega lo que el legacy NO probaba y es la parte interesante de
//    "componente desconectable": que el orquestador SIGUE funcionando sin API.
//    Con enableApi:false la unica superficie que quedaba eran start/stop, o sea
//    que nada afirmaba que el agente siguiera ejecutando ordenes.
//
// RF: son RF21 y RF22 (la API local es una capa montable sobre el agente, y su
// control es de red). El mapeo citaba RF36, que es degradacion del enlace con el
// servidor y no tiene nada que ver con montar o desmontar el router HTTP;
// citarlo ahi inflaba artificialmente la cobertura de RF36, que esta en cero.

import { describe, expect, it } from 'vitest'

import { crearAgente, type Agente, type OpcionesDelAgente } from './composition.js'
import { admitirOrden } from './orchestrator/orderIntake.js'

const SITE_ID = 'SUC-TEST'
const ROBOT_ID = '1'

const OPCIONES: OpcionesDelAgente = {
  siteId: SITE_ID,
  rutaDeBase: ':memory:',
  montarApi: true,
  // RF20: el default es false, asi que la simulacion se pide explicita.
  simularPlc: true,
  httpPuerto: 0,
  httpBind: '127.0.0.1',
  zonaDePickeo: ['3X02AE1', '3X02AE2'],
}

async function sembrarRobot(agente: Agente): Promise<void> {
  const guardado = await agente.orquestador.repositorios.robots.guardar({
    id: ROBOT_ID,
    siteId: SITE_ID,
    estanteriaCode: '3X',
    habilitado: true,
    estado: 'IDLE',
    ordenActivaId: null,
  })
  if (!guardado.ok) {
    throw new Error(`no se pudo sembrar el robot: ${guardado.error.codigo}`)
  }
}

describe('la API local es un componente montable', () => {
  it('sin montar la API el agente arranca y el orquestador sigue admitiendo ordenes', async () => {
    const agente = crearAgente({ ...OPCIONES, montarApi: false })
    await agente.iniciar()

    try {
      expect(agente.api).toBeNull()
      expect(agente.direccion()).toBeNull()

      await sembrarRobot(agente)

      const admision = await admitirOrden(agente.orquestador, {
        robotId: null,
        externalOrderId: null,
        tipo: 'PICK',
        origen: 'MANUAL',
        locationCode: '3X04AA3',
        targetLocation: null,
      })

      expect(admision.ok).toBe(true)
      if (admision.ok) {
        expect(admision.valor.tipo).toBe('CREADA')
        expect(admision.valor.orden.robotId).toBe(ROBOT_ID)
      }
      expect(await agente.orquestador.repositorios.ordenes.listar({})).toHaveLength(1)
    } finally {
      await agente.detener()
    }
  })

  it('montando la API el agente expone la direccion donde quedo escuchando', async () => {
    const agente = crearAgente(OPCIONES)
    await agente.iniciar()

    try {
      expect(agente.api).not.toBeNull()

      const direccion = agente.direccion()
      expect(direccion).not.toBeNull()
      expect(direccion?.host).toBe('127.0.0.1')
      // Se pidio el puerto 0 y el sistema asigno uno libre. Que se pueda leer es
      // lo que permite no cablear un puerto y no rifar un EADDRINUSE en CI.
      expect(direccion?.puerto).toBeGreaterThan(0)
    } finally {
      await agente.detener()
    }
  })
})
