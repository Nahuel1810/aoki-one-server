// RF21 y RF22 — API HTTP local, solo hacia la LAN de la sucursal.
//
// El ingreso de pedidos de picking ya no entra por aca: entra por el servidor
// (RF26). Quedan las ordenes MANUALES de la tablet, la consulta, retry, cancel,
// pausa y reanudacion de cola, dispositivos, comando directo a PLC, slots,
// metricas y health.
//
// Sin login de operario: todo lo que consume la tablet va sin credencial y el
// control es de red (el listener bindea a la IP de LAN, no a 0.0.0.0).
//
// El segundo nivel de autorizacion de RF22 —el token de mantenimiento del
// comando directo a PLC, el unico endpoint que escribe registros salteandose el
// orquestador y las maquinas de estado— NO esta declarado: RF22 figura entero en
// "RF sin cobertura" y ningun test portado manda credencial. Entra con su test.

import { createServer } from 'node:http'

import {
  construirComandoCarro,
  construirComandoElevadorIrNivel,
  parsearLocationCode,
  transicionarSlot,
} from '@aoki-one/domain'
import express from 'express'
import type { Request, Response } from 'express'

import { admitirOrden } from '../orchestrator/orderIntake.js'
import type { DependenciasDelOrquestador } from '../orchestrator/ports.js'
import { reintentarOrden } from '../orchestrator/retry.js'

export type CuerpoDeRespuesta<T> =
  | { readonly ok: true; readonly data: T; readonly created?: boolean }
  | { readonly ok: false; readonly error: string }

export interface DependenciasDeApi {
  readonly orquestador: DependenciasDelOrquestador
  readonly simularPlc: boolean
  /**
   * Despierta el loop del robot. El avance es POR EVENTO: sin esto la orden
   * esperaria al tick de seguridad, que a proposito es de baja frecuencia.
   */
  readonly despertar: () => void
}

export interface DireccionDeEscucha {
  readonly host: string
  readonly puerto: number
}

export interface ServidorHttp {
  readonly escuchar: (puerto: number, bind: string) => Promise<DireccionDeEscucha>
  readonly cerrar: () => Promise<void>
}

export function crearServidorHttp(dependencias: DependenciasDeApi): ServidorHttp {
  const app = construirApp(dependencias)
  const servidor = createServer(app)

  return {
    escuchar: (puerto, bind) =>
      new Promise<DireccionDeEscucha>((resolve, reject) => {
        servidor.once('error', reject)
        // Con puerto 0 el sistema asigna uno libre y se lee de address(): cablear
        // un puerto fijo es EADDRINUSE en CI.
        servidor.listen(puerto, bind, () => {
          const direccion = servidor.address()
          if (direccion === null || typeof direccion === 'string') {
            reject(new Error('no se pudo resolver la direccion de escucha'))
            return
          }
          resolve({ host: direccion.address, puerto: direccion.port })
        })
      }),

    cerrar: () =>
      new Promise<void>((resolve) => {
        servidor.close(() => {
          resolve()
        })
      }),
  }
}

function construirApp(dependencias: DependenciasDeApi): express.Express {
  const { orquestador, simularPlc, despertar } = dependencias
  const { repositorios, siteId } = orquestador
  const arrancadoEn = orquestador.reloj.ahoraMs()

  const app = express()
  app.use(express.json())

  function ok(res: Response, estado: number, data: unknown): void {
    const cuerpo: CuerpoDeRespuesta<unknown> = { ok: true, data }
    res.status(estado).json(cuerpo)
  }

  function error(res: Response, estado: number, mensaje: string): void {
    const cuerpo: CuerpoDeRespuesta<never> = { ok: false, error: mensaje }
    res.status(estado).json(cuerpo)
  }

  // ---------------------------------------------------------------- health
  //
  // RF25: health profundo. Conectividad por dispositivo, profundidad de cola por
  // robot, ultima orden completada, timestamp de arranque y estado del enlace con
  // el servidor.
  //
  // Los campos van en la raiz Y bajo `data`: el front nuevo consume el envelope
  // { ok, data } de toda la API, y el chequeo de infraestructura lee la raiz sin
  // saber del envelope. Duplicarlos es mas barato que romper a uno de los dos.
  app.get('/health', (_req: Request, res: Response) => {
    void (async () => {
      const robots = await repositorios.robots.listar(siteId)

      const dispositivos = (
        await Promise.all(
          robots.map((robot) => repositorios.dispositivos.listarPorRobot(robot.id)),
        )
      )
        .flat()
        .map((dispositivo) => ({
          robotId: dispositivo.robotId,
          type: dispositivo.tipo,
          host: dispositivo.host,
          port: dispositivo.puerto,
          // En simulacion se reporta conectado a proposito: es el modo en el que
          // el agente se prueba sin PLC, y decir lo contrario seria ruido.
          connected: simularPlc,
        }))

      const estadoDeRobots = await Promise.all(
        robots.map(async (robot) => {
          const cola = await snapshotDeCola(robot.id)
          return {
            id: robot.id,
            robotId: robot.id,
            status: robot.estado,
            queueDepth: cola.queueLength,
            activeOrderId: robot.ordenActivaId,
          }
        }),
      )

      const terminadas = await repositorios.ordenes.listar({ siteId, estados: ['DONE'] })
      const ultima = [...terminadas].sort(
        (a, b) => (b.finalizadaEn ?? 0) - (a.finalizadaEn ?? 0),
      )[0]

      const datos = {
        // RF20: el default de simulacion es false. Arrancar sin configuracion NO
        // puede reportar modo simulacion mientras el robot no se mueve.
        mode: simularPlc ? 'simulation' : 'live',
        startedAt: arrancadoEn,
        devices: dispositivos,
        robots: estadoDeRobots,
        lastCompletedOrder:
          ultima === undefined ? null : { id: ultima.id, finishedAt: ultima.finalizadaEn },
        // RF36: sin modo silencioso. El enlace con el servidor se informa siempre,
        // aunque en fase 1 todavia no exista: 'DISABLED' es una respuesta, no un hueco.
        link: { status: 'DISABLED', lastContactAt: null, outboxSize: 0 },
      }

      res.status(200).json({ ok: true, data: datos, ...datos })
    })()
  })

  // ---------------------------------------------------------------- ordenes
  app.post('/api/orders', (req: Request, res: Response) => {
    void (async () => {
      const cuerpo = req.body as Record<string, unknown>
      const tipo = texto(cuerpo['type'], 'PICK').toUpperCase()
      if (tipo !== 'PICK' && tipo !== 'PUT') {
        error(res, 400, 'type debe ser PICK o PUT')
        return
      }

      const admision = await admitirOrden(orquestador, {
        robotId: null,
        externalOrderId: textoOpcional(cuerpo['externalOrderId']),
        tipo,
        // El alta local es siempre MANUAL: el ingreso de picking se fue al servidor.
        origen: 'MANUAL',
        locationCode: texto(cuerpo['locationCode']),
        targetLocation: textoOpcional(cuerpo['targetLocation']),
      })

      if (!admision.ok) {
        error(res, 400, mensajeDeAdmision(admision.error.codigo))
        return
      }

      // created distingue el alta nueva del reenvio idempotente, igual que en el
      // ingreso del servidor (RF26).
      const creada = admision.valor.tipo === 'CREADA'
      const cuerpoDeAlta: CuerpoDeRespuesta<Record<string, unknown>> = {
        ok: true,
        data: aOrdenDeApi(admision.valor.orden),
        created: creada,
      }
      res.status(creada ? 202 : 200).json(cuerpoDeAlta)
      if (creada) {
        despertar()
      }
    })()
  })

  app.get('/api/orders', (_req: Request, res: Response) => {
    void (async () => {
      const ordenes = await repositorios.ordenes.listar({ siteId })
      ok(res, 200, ordenes.map(aOrdenDeApi))
    })()
  })

  // Va ANTES de /api/orders/:id para que no lo capture el parametro.
  app.get('/api/orders/queue/status', (_req: Request, res: Response) => {
    void (async () => {
      const robots = await repositorios.robots.listar(siteId)
      ok(res, 200, await Promise.all(robots.map((robot) => snapshotDeCola(robot.id))))
    })()
  })

  app.post('/api/orders/simulate', (req: Request, res: Response) => {
    void (async () => {
      const cuerpo = req.body as Record<string, unknown>
      const ubicacion = parsearLocationCode(texto(cuerpo['locationCode']))
      if (!ubicacion.ok) {
        error(res, 400, ubicacion.error.codigo)
        return
      }

      const robot = await repositorios.robots.buscarPorEstanteria(siteId, ubicacion.valor.estanteria)
      if (robot === undefined) {
        error(res, 400, 'ROBOT_NO_REGISTRADO')
        return
      }

      const traer = construirComandoCarro(ubicacion.valor, 'T')
      const devolver = construirComandoCarro(ubicacion.valor, 'D')
      if (!traer.ok || !devolver.ok) {
        error(res, 400, 'ACCION_INDETERMINADA')
        return
      }
      const nivel = construirComandoElevadorIrNivel(ubicacion.valor.nivel)

      // Los campos address, responseAddress, verifyAddress y expectedValue del
      // legacy no se exponen: nunca se calculaban y siempre salian en null.
      ok(res, 200, {
        order: { robotId: robot.id, locationCode: ubicacion.valor.baseCode },
        location: {
          baseCode: ubicacion.valor.baseCode,
          estanteria: ubicacion.valor.estanteria,
          modulo: ubicacion.valor.modulo,
          lado: ubicacion.valor.lado,
          nivel: ubicacion.valor.nivel,
          posicion: ubicacion.valor.posicion,
        },
        commandPreview: {
          carroBring: { commandCode: traer.valor.codigo, command: traer.valor.texto },
          carroReturn: { commandCode: devolver.valor.codigo, command: devolver.valor.texto },
          elevadorGoLevel: { commandCode: nivel },
        },
        stepCommands: [
          { seq: 1, deviceType: 'CARRO', commandCode: 41000 },
          { seq: 2, deviceType: 'ELEVADOR', commandCode: nivel },
          { seq: 3, deviceType: 'CARRO', commandCode: traer.valor.codigo },
          { seq: 4, deviceType: 'ELEVADOR', commandCode: nivel },
          { seq: 5, deviceType: 'CARRO', commandCode: devolver.valor.codigo },
        ],
      })
    })()
  })

  app.post('/api/orders/:id/retry', (req: Request, res: Response) => {
    void (async () => {
      const resultado = await reintentarOrden(orquestador, texto(req.params['id']))
      if (!resultado.ok) {
        error(res, 400, resultado.error.codigo)
        return
      }
      ok(res, 200, aOrdenDeApi(resultado.valor))
    })()
  })

  app.get('/api/orders/:id', (req: Request, res: Response) => {
    void (async () => {
      const orden = await repositorios.ordenes.buscarPorId(texto(req.params['id']))
      if (orden === undefined) {
        error(res, 404, 'ORDEN_INEXISTENTE')
        return
      }
      ok(res, 200, aOrdenDeApi(orden))
    })()
  })

  // ---------------------------------------------------------------- slots
  app.get('/api/slots', (_req: Request, res: Response) => {
    void (async () => {
      const robots = await repositorios.robots.listar(siteId)
      const zonas = await Promise.all(
        robots.map(async (robot) => repositorios.slots.listarPorRobot(robot.id)),
      )
      ok(
        res,
        200,
        zonas.flat().map((slot) => ({
          locationCode: slot.locationCode,
          robotId: slot.robotId,
          // `side` y `robotId` los agrega esta version: sin ellos el front tendria
          // que reimplementar la regla de paridad del modulo.
          side: slot.lado,
          status: slot.estado.estado,
          currentBox:
            'contenido' in slot.estado && slot.estado.contenido !== null
              ? {
                  id: slot.estado.contenido.cajon.id,
                  sourceLocationCode: slot.estado.contenido.cajon.ubicacionDeOrigen,
                  pendingReturns: slot.estado.contenido.pendingReturns,
                }
              : null,
        })),
      )
    })()
  })

  app.post('/api/slots/:locationCode/release', (req: Request, res: Response) => {
    void (async () => {
      const locationCode = texto(req.params['locationCode'])
      const robots = await repositorios.robots.listar(siteId)

      for (const robot of robots) {
        const slot = await repositorios.slots.buscar(robot.id, locationCode)
        if (slot === undefined) {
          continue
        }

        const siguiente = transicionarSlot(slot.estado, { tipo: 'LIBERAR' })
        if (!siguiente.ok) {
          error(res, 409, siguiente.error.codigo)
          return
        }

        await repositorios.slots.guardarEstado(robot.id, locationCode, siguiente.valor)
        // La liberacion manual corrige los libros y NO mueve el robot: queda
        // registrada para que se pueda auditar quien la uso.
        await repositorios.eventos.registrar({
          id: orquestador.generarId(),
          ts: orquestador.reloj.ahoraMs(),
          tipoDeEntidad: 'SLOT',
          entidadId: locationCode,
          evento: 'SLOT_RELEASED_MANUAL',
          severidad: 'INFO',
          metadata: { robotId: robot.id },
        })

        ok(res, 200, { locationCode, status: 'LIBRE' })
        return
      }

      error(res, 404, 'SLOT_INEXISTENTE')
    })()
  })

  // ---------------------------------------------------------------- dispositivos
  app.post('/api/devices/register', (req: Request, res: Response) => {
    void (async () => {
      const cuerpo = req.body as Record<string, unknown>
      const tipo = texto(cuerpo['type']).toUpperCase()
      if (tipo !== 'CARRO' && tipo !== 'ELEVADOR') {
        error(res, 400, 'type debe ser CARRO o ELEVADOR')
        return
      }

      const dispositivo = await repositorios.dispositivos.registrar({
        robotId: texto(cuerpo['robotId']),
        tipo,
        host: texto(cuerpo['host']),
        puerto: Number(cuerpo['port'] ?? 502),
        unitId: Number(cuerpo['unitId'] ?? 255),
        timeoutMsDeSocket: Number(cuerpo['timeoutMs'] ?? 2000),
      })

      ok(res, 201, dispositivo)
    })()
  })

  app.get('/api/devices/robots', (_req: Request, res: Response) => {
    void (async () => {
      const robots = await repositorios.robots.listar(siteId)
      ok(
        res,
        200,
        await Promise.all(
          robots.map(async (robot) => ({
            id: robot.id,
            robotId: robot.id,
            status: robot.estado,
            currentOrderId: robot.ordenActivaId,
            devices: await repositorios.dispositivos.listarPorRobot(robot.id),
            // El legacy devolvia {} aca: armaba la promesa y no la esperaba.
            queue: await snapshotDeCola(robot.id),
          })),
        ),
      )
    })()
  })

  app.post('/api/devices/:robotId/:dispositivo/command', (req: Request, res: Response) => {
    void (async () => {
      const tipo = texto(req.params['dispositivo']).toUpperCase()
      if (tipo !== 'CARRO' && tipo !== 'ELEVADOR') {
        error(res, 400, 'dispositivo debe ser carro o elevador')
        return
      }

      const cuerpo = req.body as Record<string, unknown>
      const valor = Number(cuerpo['value'])
      if (!Number.isFinite(valor)) {
        error(res, 400, 'value debe ser un numero')
        return
      }

      const resultado = await orquestador.transporte.ejecutarComandoDePaso(
        texto(req.params['robotId']),
        tipo,
        { comando: valor, respuestasEsperadas: [100, '1##'] },
      )
      if (!resultado.ok) {
        error(res, 502, resultado.error.tipo)
        return
      }

      ok(res, 200, { response: { ack: 'DONE', kind: resultado.valor.kind } })
    })()
  })

  app.get('/api/devices/:robotId/:dispositivo/state', (req: Request, res: Response) => {
    void (async () => {
      const tipo = texto(req.params['dispositivo']).toUpperCase()
      if (tipo !== 'CARRO' && tipo !== 'ELEVADOR') {
        error(res, 400, 'dispositivo debe ser carro o elevador')
        return
      }

      const registros = await orquestador.transporte.leerRegistros(
        texto(req.params['robotId']),
        tipo,
      )
      if (!registros.ok) {
        error(res, 502, registros.error.tipo)
        return
      }

      ok(res, 200, { type: tipo, values: registros.valor, simulated: simularPlc })
    })()
  })

  app.use((_req: Request, res: Response) => {
    error(res, 404, 'ruta no encontrada')
  })

  async function snapshotDeCola(robotId: string): Promise<{
    robotId: string
    activeOrderId: string | null
    queueLength: number
    paused: boolean
    queuedOrderIds: readonly string[]
  }> {
    const robot = await repositorios.robots.buscarPorId(robotId)
    const pendientes = await repositorios.ordenes.listar({
      siteId,
      robotId,
      estados: ['PENDING'],
    })
    return {
      robotId,
      activeOrderId: robot?.ordenActivaId ?? null,
      queueLength: pendientes.length,
      // La pausa de cola entra con su test: hoy ninguna orden se pausa.
      paused: false,
      queuedOrderIds: pendientes.map((orden) => orden.id),
    }
  }

  return app
}

/** Forma que consume el front. Se mantiene la del legacy para no romperlo. */
function aOrdenDeApi(orden: {
  id: string
  siteId: string
  externalOrderId: string | null
  tipo: string
  origen: string
  estado: string
  locationCode: string
  targetLocation: string | null
  slotLocationCode: string | null
  currentStepIndex: number
  waitingForSlot: boolean
  errorReason: string | null
  robotId: string
  creadaEn: number
}): Record<string, unknown> {
  return {
    id: orden.id,
    siteId: orden.siteId,
    externalOrderId: orden.externalOrderId,
    type: orden.tipo,
    origin: orden.origen,
    status: orden.estado,
    locationCode: orden.locationCode,
    targetLocation: orden.targetLocation,
    slotLocationCode: orden.slotLocationCode,
    currentStepIndex: orden.currentStepIndex,
    waitingForSlot: orden.waitingForSlot,
    errorReason: orden.errorReason,
    robotId: orden.robotId,
    createdAt: orden.creadaEn,
  }
}

/**
 * Mensaje para el operario. La accion (traer/devolver) la impone el tipo de
 * orden, nunca viaja en la ubicacion.
 */
function mensajeDeAdmision(codigo: string): string {
  switch (codigo) {
    case 'LOCATION_CODE_CON_ACCION':
      return 'locationCode no debe incluir accion final (T/D/L): la define el tipo de orden'
    case 'LOCATION_CODE_INVALIDO':
      return 'locationCode invalido'
    case 'ROBOT_NO_REGISTRADO':
      return 'no hay robot registrado para esa estanteria'
    default:
      return codigo
  }
}

/**
 * Texto de un campo que llega del request. `unknown` no se puede pasar por
 * String() sin riesgo de imprimir [object Object] en vez de fallar.
 */
function texto(valor: unknown, porDefecto = ''): string {
  if (typeof valor === 'string') {
    return valor
  }
  if (typeof valor === 'number' || typeof valor === 'boolean') {
    return String(valor)
  }
  return porDefecto
}

function textoOpcional(valor: unknown): string | null {
  if (typeof valor !== 'string') {
    return null
  }
  const limpio = valor.trim()
  return limpio === '' ? null : limpio
}
