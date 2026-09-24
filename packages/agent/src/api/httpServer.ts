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
// El segundo nivel de RF22 es el token de mantenimiento del comando directo a
// PLC, el unico endpoint que escribe registros salteandose el orquestador y las
// maquinas de estado. Falla CERRADO: sin token configurado el endpoint responde
// 503 y no mueve nada.
//
// Toda entrada se valida por esquema (zod) antes de tocar el dominio: un body
// con la forma equivocada tiene que salir por 400 con el motivo, no reventar
// adentro del orquestador con un mensaje que no le dice nada al operario.

import { createServer } from 'node:http'

import {
  construirComandoCarro,
  construirComandoElevadorIrNivel,
  parsearLocationCode,
  transicionarSlot,
} from '@aoki-one/domain'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'

import { cancelarOrden } from '../orchestrator/cancel.js'
import type { ErrorDeCancelacionDeOrden } from '../orchestrator/cancel.js'
import { admitirOrden } from '../orchestrator/orderIntake.js'
import type { DependenciasDelOrquestador } from '../orchestrator/ports.js'
import type { SlotDeRobot } from '../persistence/slotRepository.js'
import { reintentarOrden } from '../orchestrator/retry.js'
import type { DispositivoRegistrado } from '../transport/modbusClient.js'
import { ENLACE_APAGADO, type ReporteDeEnlace } from '../sync/link.js'

export type CuerpoDeRespuesta<T> =
  | { readonly ok: true; readonly data: T; readonly created?: boolean }
  | { readonly ok: false; readonly error: string }

/** Header del token de mantenimiento (RF22). */
export const HEADER_DE_MANTENIMIENTO = 'x-aoki-maintenance-token'

export interface DependenciasDeApi {
  readonly orquestador: DependenciasDelOrquestador
  readonly simularPlc: boolean
  /** `null` = no configurado: el comando directo a PLC queda deshabilitado. */
  readonly tokenDeMantenimiento: string | null
  /**
   * Despierta el loop del robot. El avance es POR EVENTO: sin esto la orden
   * esperaria al tick de seguridad, que a proposito es de baja frecuencia.
   */
  readonly despertar: () => void
  /**
   * Estado del enlace con el servidor (RF36).
   *
   * Ausente = enlace no configurado, y entonces `/health` responde `DISABLED`.
   * Es una respuesta, no un hueco: el front tiene que poder distinguir "no hay
   * enlace porque no se configuro" de "se configuro y esta caido".
   */
  readonly enlace?: () => Promise<ReporteDeEnlace>
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
  const { orquestador, simularPlc, despertar, tokenDeMantenimiento, enlace } = dependencias
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

  /**
   * Segundo nivel de RF22. Falla cerrado: sin token configurado no hay forma de
   * habilitar el endpoint, ni siquiera acertandole al header.
   */
  function exigirMantenimiento(req: Request, res: Response, next: NextFunction): void {
    if (tokenDeMantenimiento === null) {
      error(
        res,
        503,
        'el comando directo a PLC esta deshabilitado: falta configurar el token de mantenimiento',
      )
      return
    }
    if (req.get(HEADER_DE_MANTENIMIENTO) !== tokenDeMantenimiento) {
      error(res, 401, 'token de mantenimiento invalido o ausente')
      return
    }
    next()
  }

  /**
   * Corre un handler asincrono y contiene lo que se le escape.
   *
   * Express 4 no mira la promesa que devuelve un handler, asi que un rechazo no
   * es un error de request: es un unhandled rejection, y Node baja el proceso
   * ENTERO del agente. Un SQLITE_BUSY, un disco lleno o una base bloqueada en UNA
   * consulta de la tablet dejaban al robot sin quien lo maneje, y encima la
   * request se quedaba colgada sin respuesta ni timeout. Es el mismo criterio que
   * `asincrono` del servidor; aca no hay middleware de error porque los handlers
   * se registran con su forma propia y el unico canal de salida es este.
   */
  function atender(res: Response, handler: () => Promise<void>): void {
    handler().catch((causa: unknown) => {
      // Un 500 sin rastro es indebuggeable: el detalle no sale en la respuesta a
      // proposito, asi que el unico lugar donde queda es el log del agente.
      dependencias.orquestador.logger.error('API_UNHANDLED_FAILURE', {
      mensaje: causa instanceof Error ? causa.message : String(causa),
    })

      if (res.headersSent) {
        // Ya se empezo a escribir la respuesta: cambiarle el status es imposible
        // y agregarle otro cuerpo le daria a la tablet un JSON corrupto. Se corta
        // la conexion para que lo lea como lo que es, una respuesta incompleta.
        res.destroy()
        return
      }
      error(res, 500, 'error interno del agente')
    })
  }

  /**
   * Valida el cuerpo contra su esquema y responde 400 con el motivo si no pasa.
   * Devuelve `null` cuando ya respondio, para que el handler corte.
   */
  function validar<T>(esquema: z.ZodType<T>, valor: unknown, res: Response): T | null {
    const resultado = esquema.safeParse(valor)
    if (resultado.success) {
      return resultado.data
    }
    const primero = resultado.error.issues[0]
    const donde = primero === undefined ? '' : primero.path.join('.')
    const motivo = primero?.message ?? 'entrada invalida'
    error(res, 400, donde === '' ? motivo : `${donde}: ${motivo}`)
    return null
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
    atender(res, async () => {
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
        // y cuando esta configurado se informa de verdad: si el servidor no
        // contesta, el operario ve DEGRADED y el tamaño de lo que quedo sin
        // reportar, no una pantalla que finge estar al dia.
        link: enlace === undefined ? ENLACE_APAGADO : await enlace(),
      }

      res.status(200).json({ ok: true, data: datos, ...datos })
    })
  })

  // ---------------------------------------------------------------- ordenes
  app.post('/api/orders', (req: Request, res: Response) => {
    atender(res, async () => {
      const pedido = validar(ALTA_DE_ORDEN, req.body, res)
      if (pedido === null) {
        return
      }

      const admision = await admitirOrden(orquestador, {
        robotId: null,
        externalOrderId: pedido.externalOrderId ?? null,
        tipo: pedido.type,
        // El alta local es siempre MANUAL: el ingreso de picking se fue al servidor.
        origen: 'MANUAL',
        locationCode: pedido.locationCode,
        targetLocation: pedido.targetLocation ?? null,
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
    })
  })

  app.get('/api/orders', (_req: Request, res: Response) => {
    atender(res, async () => {
      const ordenes = await repositorios.ordenes.listar({ siteId })
      ok(res, 200, ordenes.map(aOrdenDeApi))
    })
  })

  // Va ANTES de /api/orders/:id para que no lo capture el parametro.
  app.get('/api/orders/queue/status', (_req: Request, res: Response) => {
    atender(res, async () => {
      const robots = await repositorios.robots.listar(siteId)
      ok(res, 200, await Promise.all(robots.map((robot) => snapshotDeCola(robot.id))))
    })
  })

  // RF21 — El boton de pausar/reanudar la cola de la tablet.
  //
  // Van ANTES de /api/orders/:id/retry por claridad, aunque no compitan: son
  // cuatro segmentos contra tres y el router no los puede confundir.
  //
  // Pausar NO aborta: lo unico que cambia es que el loop deja de tomar ordenes
  // nuevas de ese robot. La que ya esta en curso la termina el ciclo que la
  // arranco. Reanudar despierta el loop para que no espere al tick de seguridad.
  app.post('/api/orders/queue/:robotId/pause', (req: Request, res: Response) => {
    atender(res, async () => {
      await fijarPausa(texto(req.params['robotId']), true, res)
    })
  })

  app.post('/api/orders/queue/:robotId/resume', (req: Request, res: Response) => {
    atender(res, async () => {
      await fijarPausa(texto(req.params['robotId']), false, res)
    })
  })

  app.post('/api/orders/simulate', (req: Request, res: Response) => {
    atender(res, async () => {
      const pedido = validar(SIMULACION, req.body, res)
      if (pedido === null) {
        return
      }

      const ubicacion = parsearLocationCode(pedido.locationCode)
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
    })
  })

  // RF24. Va antes de /api/orders/:id: son dos segmentos y el parametro captura uno.
  app.get('/api/orders/metrics/report', (req: Request, res: Response) => {
    atender(res, async () => {
      const rango = validar(RANGO_DE_REPORTE, req.query, res)
      if (rango === null) {
        return
      }
      if (
        rango.startDate !== undefined &&
        rango.endDate !== undefined &&
        rango.endDate < rango.startDate
      ) {
        error(res, 400, 'endDate debe ser mayor o igual a startDate')
        return
      }

      const reporte = await repositorios.metricas.reporte({
        ...(rango.startDate === undefined ? {} : { desdeMs: rango.startDate }),
        ...(rango.endDate === undefined ? {} : { hastaMs: rango.endDate }),
      })
      ok(res, 200, reporte)
    })
  })

  app.post('/api/orders/:id/retry', (req: Request, res: Response) => {
    atender(res, async () => {
      const resultado = await reintentarOrden(orquestador, texto(req.params['id']))
      if (!resultado.ok) {
        error(res, 400, resultado.error.codigo)
        return
      }
      ok(res, 200, aOrdenDeApi(resultado.valor))
    })
  })

  // RF21 — El boton de cancelar de la tablet.
  app.post('/api/orders/:id/cancel', (req: Request, res: Response) => {
    atender(res, async () => {
      const resultado = await cancelarOrden(orquestador, texto(req.params['id']))
      if (!resultado.ok) {
        // El 409 no es decorativo: el front muestra el texto tal cual, y lo que
        // el operario necesita saber es que el pedido sigue vivo porque el robot
        // ya lo esta haciendo, no que "fallo".
        error(
          res,
          resultado.error.codigo === 'ORDEN_INEXISTENTE' ? 404 : 409,
          mensajeDeCancelacion(resultado.error),
        )
        return
      }
      ok(res, 200, aOrdenDeApi(resultado.valor))
    })
  })

  app.get('/api/orders/:id', (req: Request, res: Response) => {
    atender(res, async () => {
      const orden = await repositorios.ordenes.buscarPorId(texto(req.params['id']))
      if (orden === undefined) {
        error(res, 404, 'ORDEN_INEXISTENTE')
        return
      }
      ok(res, 200, aOrdenDeApi(orden))
    })
  })

  // ---------------------------------------------------------------- slots
  app.get('/api/slots', (_req: Request, res: Response) => {
    atender(res, async () => {
      const robots = await repositorios.robots.listar(siteId)
      const zonas = await Promise.all(
        robots.map(async (robot) => repositorios.slots.listarPorRobot(robot.id)),
      )
      ok(res, 200, zonas.flat().map(aSlotDeApi))
    })
  })

  app.post('/api/slots/:locationCode/release', (req: Request, res: Response) => {
    atender(res, async () => {
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
    })
  })

  // ---------------------------------------------------------------- dispositivos
  app.post('/api/devices/register', (req: Request, res: Response) => {
    atender(res, async () => {
      const alta = validar(ALTA_DE_DISPOSITIVO, req.body, res)
      if (alta === null) {
        return
      }

      const dispositivo = await repositorios.dispositivos.registrar({
        robotId: alta.robotId,
        tipo: alta.type,
        host: alta.host,
        puerto: alta.port,
        unitId: alta.unitId,
        timeoutMsDeSocket: alta.timeoutMs,
      })

      ok(res, 201, dispositivo)
    })
  })

  // RF21: listado de dispositivos. El front lo consume plano, sin agrupar por
  // robot, porque su pantalla de diagnostico es una fila por dispositivo.
  app.get('/api/devices', (_req: Request, res: Response) => {
    atender(res, async () => {
      const robots = await repositorios.robots.listar(siteId)
      const porRobot = await Promise.all(
        robots.map((robot) => repositorios.dispositivos.listarPorRobot(robot.id)),
      )
      ok(
        res,
        200,
        porRobot.flat().map((dispositivo) => aDispositivoDeApi(dispositivo, simularPlc)),
      )
    })
  })

  app.get('/api/devices/robots', (_req: Request, res: Response) => {
    atender(res, async () => {
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
            // Los dispositivos salen con la MISMA forma que en GET /api/devices:
            // el front los valida con un solo esquema y los muestra en las dos
            // pantallas, asi que dos formas distintas rompen una de las dos.
            devices: (await repositorios.dispositivos.listarPorRobot(robot.id)).map(
              (dispositivo) => aDispositivoDeApi(dispositivo, simularPlc),
            ),
            // El legacy devolvia {} aca: armaba la promesa y no la esperaba.
            queue: await snapshotDeCola(robot.id),
          })),
        ),
      )
    })
  })

  app.post(
    '/api/devices/:robotId/:dispositivo/command',
    exigirMantenimiento,
    (req: Request, res: Response) => {
      atender(res, async () => {
        const tipo = validar(TIPO_DE_DISPOSITIVO, texto(req.params['dispositivo']).toUpperCase(), res)
        if (tipo === null) {
          return
        }

        const pedido = validar(COMANDO_DIRECTO, req.body, res)
        if (pedido === null) {
          return
        }
        const valor = pedido.value

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
      })
    },
  )

  app.get('/api/devices/:robotId/:dispositivo/state', (req: Request, res: Response) => {
    atender(res, async () => {
      const tipo = validar(TIPO_DE_DISPOSITIVO, texto(req.params['dispositivo']).toUpperCase(), res)
      if (tipo === null) {
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
    })
  })

  app.use((_req: Request, res: Response) => {
    error(res, 404, 'ruta no encontrada')
  })

  /**
   * Pausa o reanuda la cola de un robot y contesta con la cola ya actualizada.
   *
   * El robot tiene que existir: pausar la cola de un id inventado aceptaria en
   * silencio una pausa que despues nadie puede reanudar desde el front, porque
   * ese robot no aparece en ninguna pantalla.
   */
  async function fijarPausa(robotId: string, pausada: boolean, res: Response): Promise<void> {
    const cambio = await repositorios.robots.fijarPausaDeCola(
      robotId,
      pausada,
      orquestador.reloj.ahoraMs(),
    )
    if (!cambio.ok) {
      error(res, 404, cambio.error.codigo)
      return
    }

    await repositorios.eventos.registrar({
      id: orquestador.generarId(),
      ts: orquestador.reloj.ahoraMs(),
      tipoDeEntidad: 'ROBOT',
      entidadId: robotId,
      evento: pausada ? 'QUEUE_PAUSED' : 'QUEUE_RESUMED',
      severidad: 'INFO',
      metadata: {},
    })

    if (!pausada) {
      // Sin esto la cola reanudada espera al tick de seguridad, que a proposito
      // es de baja frecuencia: el operario apreta "Reanudar" y no pasa nada.
      despertar()
    }
    ok(res, 200, await snapshotDeCola(robotId))
  }

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
      paused: await repositorios.robots.colaPausada(robotId),
      queuedOrderIds: pendientes.map((orden) => orden.id),
    }
  }

  return app
}

// ------------------------------------------------------------------ esquemas
//
// La validacion vive en el borde: lo que pasa de aca ya tiene la forma correcta,
// asi que el orquestador no repite chequeos ni recibe strings vacios.

const TIPO_DE_DISPOSITIVO = z.enum(['CARRO', 'ELEVADOR'], {
  message: 'dispositivo debe ser carro o elevador',
})

const ALTA_DE_ORDEN = z.object({
  type: z.enum(['PICK', 'PUT'], { message: 'type debe ser PICK o PUT' }).default('PICK'),
  locationCode: z.string().trim().min(1, 'locationCode es requerido'),
  targetLocation: z.string().trim().min(1).nullish(),
  externalOrderId: z.string().trim().min(1).nullish(),
  // El siteId del body se ignora a proposito: sale de la configuracion del
  // agente, nunca del request de la tablet.
  siteId: z.unknown().optional(),
})

const SIMULACION = z.object({
  locationCode: z.string().trim().min(1, 'locationCode es requerido'),
})

const ALTA_DE_DISPOSITIVO = z.object({
  robotId: z.string().trim().min(1, 'robotId es requerido'),
  type: TIPO_DE_DISPOSITIVO,
  host: z.string().trim().min(1, 'host es requerido'),
  port: z.coerce.number().int().min(1).max(65535).default(502),
  // Los Festo de planta no usan el unitId 1.
  unitId: z.coerce.number().int().min(0).max(255).default(255),
  timeoutMs: z.coerce.number().int().min(1).default(2000),
})

const COMANDO_DIRECTO = z.object({
  value: z.coerce.number({ message: 'value debe ser un numero' }),
})

const RANGO_DE_REPORTE = z.object({
  startDate: z.coerce.number().int().optional(),
  endDate: z.coerce.number().int().optional(),
})

/**
 * Forma de un slot de pickeo tal como la consume el front.
 *
 * `side`, `robotId`, `level` y `position` son derivados del `locationCode` que
 * agrega esta version: el tablero los usa para armar la grilla (una fila por
 * nivel, ordenada por posicion) y sin ellos tendria que reimplementar la
 * gramatica de ubicaciones, que es dominio y vive de un solo lado.
 *
 * `reservedByOrderId` es lo que le permite al tablero decir QUE pedido esta en
 * camino sobre un slot en maniobra, y no solo que hay uno.
 */
function aSlotDeApi(slot: SlotDeRobot): Record<string, unknown> {
  const ubicacion = parsearLocationCode(slot.locationCode)
  const contenido = 'contenido' in slot.estado ? slot.estado.contenido : null

  return {
    // Identidad estable de un slot: es de UN robot y de una ubicacion. Sirve de
    // clave del lado del front, que no puede asumir que dos robots no compartan
    // un locationCode.
    id: `${slot.robotId}:${slot.locationCode}`,
    locationCode: slot.locationCode,
    robotId: slot.robotId,
    side: slot.lado,
    level: ubicacion.ok ? ubicacion.valor.nivel : null,
    position: ubicacion.ok ? ubicacion.valor.posicion : null,
    status: slot.estado.estado,
    // Quien lo tiene tomado AHORA. Un slot OCUPADO no lo retiene nadie: el cajon
    // esta apoyado y la orden que lo trajo ya termino.
    reservedByOrderId: 'ordenId' in slot.estado ? slot.estado.ordenId : null,
    lastError: slot.estado.estado === 'ERROR' ? slot.estado.motivo : null,
    updatedAt: slot.actualizadoEn,
    currentBox:
      contenido === null
        ? null
        : {
            id: contenido.cajon.id,
            sourceLocationCode: contenido.cajon.ubicacionDeOrigen,
            pendingReturns: contenido.pendingReturns,
          },
  }
}

/**
 * Forma de un dispositivo tal como la consume el front.
 *
 * `status` y `lastSeen` son diagnostico, y hoy salen de lo mismo que `/health`:
 * en simulacion se reporta conectado a proposito —es el modo en el que el agente
 * se prueba sin PLC— y en vivo se reporta DISCONNECTED porque el agente todavia
 * no persiste la conectividad por dispositivo. Decir CONNECTED sin haber hablado
 * con el PLC seria peor que decir que no se sabe.
 */
function aDispositivoDeApi(
  dispositivo: DispositivoRegistrado,
  simularPlc: boolean,
): Record<string, unknown> {
  return {
    // La identidad de un dispositivo es `<robotId>:<TIPO>`: un robot tiene un
    // carro y un elevador, no dos de ninguno.
    id: `${dispositivo.robotId}:${dispositivo.tipo}`,
    robotId: dispositivo.robotId,
    type: dispositivo.tipo,
    host: dispositivo.host,
    port: dispositivo.puerto,
    unitId: dispositivo.unitId,
    timeoutMs: dispositivo.timeoutMsDeSocket,
    status: simularPlc ? 'CONNECTED' : 'DISCONNECTED',
    lastCommand: null,
    lastSeen: null,
    updatedAt: null,
  }
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
 * Mensaje para el operario cuando la cancelacion no procede.
 *
 * Los dos rechazos dicen cosas distintas y el operario hace cosas distintas con
 * cada uno: uno espera a que el robot termine, el otro reintenta.
 */
function mensajeDeCancelacion(error: ErrorDeCancelacionDeOrden): string {
  switch (error.codigo) {
    case 'ORDEN_INEXISTENTE':
      return 'ORDEN_INEXISTENTE'
    case 'ORDEN_NO_CANCELABLE':
      return error.estado === 'IN_PROGRESS'
        ? 'no se puede cancelar un pedido que el robot ya esta ejecutando'
        : `no se puede cancelar un pedido en ${error.estado}`
    case 'ORDEN_CON_SLOT_TOMADO':
      return `el pedido todavia tiene tomado el slot ${error.slotLocationCode}: reintentalo para que el robot lo libere`
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

