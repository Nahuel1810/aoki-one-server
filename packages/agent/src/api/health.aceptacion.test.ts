// Portado de tests/integration/api.test.js :: "API health responde en modo simulacion" (T02).
//
// ADAPTADO.
//
// Que afirmaba el legacy: GET /health -> 200 con `{ ok: true, mode: 'simulation' }`
// PLANO, con `simulatePlc: true` sobre un default que tambien era true.
//
// Que afirma ahora y por que cambio:
//  - Envelope unificado `{ ok, data }` / `{ ok, error }` en toda la API (es el
//    contrato que consume el front y la spec lo mantiene), asi que `mode` pasa a
//    viajar dentro de `data`. El campo `mode` se PRESERVA a proposito.
//  - RF20 pone el default de SIMULATE_PLC en `false`, asi que el fixture pasa
//    `simularPlc` EXPLICITO. Sin eso el valor de `mode` cambiaria sin que nadie
//    lo haya decidido. Va ademas el caso hermano que pinea el default: arrancar
//    sin simulacion NO puede responder 'simulation'.
//
// DEFICIT CONOCIDO: RF25 (health profundo — conectividad por dispositivo,
// profundidad de cola por robot, ultima orden completada, timestamp de arranque
// y estado del enlace con el servidor, RF36) NO TIENE COBERTURA TODAVIA. El
// /health legacy es una constante con `ok: true` cableado: no consulta ningun
// dispositivo ni la cola, asi que pasa por construccion. Este test es el punto
// de partida y el resto entra con T20.

import { describe, expect, it } from 'vitest'

import { crearAgente, type Agente, type OpcionesDelAgente } from '../composition.js'
import type { CuerpoDeRespuesta } from './httpServer.js'

/** Lo unico que este test mira del cuerpo de /health. */
interface DatosDeHealth {
  readonly mode: string
}

const OPCIONES_SIMULADAS: OpcionesDelAgente = {
  siteId: 'SUC-TEST',
  agentId: 'AG-TEST',
  rutaDeBase: ':memory:',
  montarApi: true,
  // RF20: explicito. El default es false y arrancar sin configuracion no simula.
  simularPlc: true,
  // Puerto 0: lo asigna el sistema y se lee de `direccion()`. Cablear uno fijo es
  // EADDRINUSE en CI.
  httpPuerto: 0,
  httpBind: '127.0.0.1',
  zonaDePickeo: [],
  // RF22: sin token configurado el comando directo a PLC queda deshabilitado.
  // Este fixture no lo usa, asi que va en null a proposito.
  tokenDeMantenimiento: null,
  // RF36/T26: el enlace con el servidor va APAGADO. Estos fixtures ejercitan el
  // agente solo con su cola local, que es como arranca en el cutover.
  enlace: null,
}

async function levantarAgente(opciones: OpcionesDelAgente): Promise<Agente> {
  const agente = crearAgente(opciones)
  await agente.iniciar()
  return agente
}

function urlDe(agente: Agente, ruta: string): string {
  const direccion = agente.direccion()
  if (direccion === null) {
    throw new Error('el agente no monto la API')
  }
  return `http://${direccion.host}:${String(direccion.puerto)}${ruta}`
}

async function leerCuerpo<T>(respuesta: Response): Promise<CuerpoDeRespuesta<T>> {
  const cuerpo: unknown = await respuesta.json()
  return cuerpo as CuerpoDeRespuesta<T>
}

function datosDe<T>(cuerpo: CuerpoDeRespuesta<T>): T {
  if (!cuerpo.ok) {
    throw new Error(`la API respondio error: ${cuerpo.error}`)
  }
  return cuerpo.data
}

describe('GET /health', () => {
  it('responde 200 y modo simulacion cuando la simulacion se pide explicita', async () => {
    const agente = await levantarAgente(OPCIONES_SIMULADAS)

    try {
      const respuesta = await fetch(urlDe(agente, '/health'))
      const cuerpo = await leerCuerpo<DatosDeHealth>(respuesta)

      expect(respuesta.status).toBe(200)
      expect(cuerpo.ok).toBe(true)
      expect(datosDe(cuerpo).mode).toBe('simulation')
    } finally {
      await agente.detener()
    }
  })

  // RF20: el default de SIMULATE_PLC pasa a false. Este caso no existe en el
  // legacy —donde el default era true— y es lo que impide que el agente arranque
  // simulando en silencio mientras la API responde ok y el robot no se mueve.
  it('sin simulacion el modo no es simulacion (RF20: el default es false)', async () => {
    const agente = await levantarAgente({ ...OPCIONES_SIMULADAS, simularPlc: false })

    try {
      const respuesta = await fetch(urlDe(agente, '/health'))
      const cuerpo = await leerCuerpo<DatosDeHealth>(respuesta)

      expect(respuesta.status).toBe(200)
      expect(cuerpo.ok).toBe(true)
      expect(datosDe(cuerpo).mode).not.toBe('simulation')
    } finally {
      await agente.detener()
    }
  })
})
