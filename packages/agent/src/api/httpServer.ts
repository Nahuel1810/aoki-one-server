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

import { timingSafeEqual } from 'node:crypto'
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
import type { EstadoDeConexion } from '../transport/connectionMonitor.js'
import { claveDeDispositivo } from '../transport/modbusClient.js'
import type { ClaveDeDispositivo, DispositivoRegistrado } from '../transport/modbusClient.js'
import { MAPA_DE_REGISTROS_POR_DEFECTO } from '../transport/stepHandshake.js'
import type { RespuestaEsperada } from '../transport/stepHandshake.js'
import { ENLACE_APAGADO, type ReporteDeEnlace } from '../sync/link.js'
import { clasificarBind } from '../exposicionDeRed.js'

export type CuerpoDeRespuesta<T> =
  | { readonly ok: true; readonly data: T; readonly created?: boolean }
  | { readonly ok: false; readonly error: string }

/** Header del token de mantenimiento (RF22). */
export const HEADER_DE_MANTENIMIENTO = 'x-aoki-maintenance-token'

export interface DependenciasDeApi {
  readonly orquestador: DependenciasDelOrquestador
  readonly simularPlc: boolean
  /**
   * La direccion en la que escucha la API, para poder decirlo en `/health`.
   *
   * Se informa porque el primer nivel de RF22 ES el bind: si esta abierto, todos
   * los endpoints que mueven el robot quedan al alcance de cualquier interfaz de
   * la notebook. Que eso se sepa mirando el health y no leyendo el archivo de
   * entorno de una maquina a la que hay que entrar es la diferencia entre
   * enterarse y no enterarse.
   */
  readonly httpBind: string
  /** `null` = no configurado: el comando directo a PLC queda deshabilitado. */
  readonly tokenDeMantenimiento: string | null
  /**
   * Despierta el loop del robot. El avance es POR EVENTO: sin esto la orden
   * esperaria al tick de seguridad, que a proposito es de baja frecuencia.
   */
  readonly despertar: () => void
  /**
   * Estado de conexion por dispositivo, tal como lo dejo el ultimo ciclo del
   * monitor (RF18).
   *
   * Ausente = no hay monitor (transporte inyectado). Es el UNICO indicador que
   * tiene el operario para distinguir "cable desenchufado" de "PLC trabado" de
   * "todo bien pero la orden fallo", asi que no puede seguir siendo una
   * constante derivada de si hay simulacion.
   */
  readonly estadoDeConexion?: (clave: ClaveDeDispositivo) => EstadoDeConexion | undefined
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
  const {
    orquestador,
    simularPlc,
    httpBind,
    despertar,
    tokenDeMantenimiento,
    enlace,
    estadoDeConexion,
  } = dependencias
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
  /**
   * Compara el token sin filtrar por cuanto tarda.
   *
   * Un `===` corta en el primer byte distinto, asi que el tiempo de respuesta
   * dice cuantos caracteres se acerto y el token se puede adivinar de a uno. En
   * una LAN es un riesgo chico, pero el servidor ya firma con `timingSafeEqual`
   * y no hay motivo para que el agente sea el eslabon flojo.
   *
   * El largo se compara aparte porque `timingSafeEqual` tira si los buffers
   * miden distinto; esa fuga —saber el largo del token— no sirve para adivinarlo.
   */
  function igualEnTiempoConstante(recibido: string | undefined, esperado: string): boolean {
    if (recibido === undefined) {
      return false
    }
    const a = Buffer.from(recibido)
    const b = Buffer.from(esperado)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  function exigirMantenimiento(req: Request, res: Response, next: NextFunction): void {
    if (tokenDeMantenimiento === null) {
      error(
        res,
        503,
        'sin AOKI_AGENT_TOKEN_DE_MANTENIMIENTO configurado no se puede ni mandar un comando directo ' +
          'al PLC ni dar de alta un dispositivo: las dos cosas deciden que hace el robot',
      )
      return
    }
    if (!igualEnTiempoConstante(req.get(HEADER_DE_MANTENIMIENTO), tokenDeMantenimiento)) {
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
  /**
   * Conectividad de un dispositivo, en la forma que consume el front.
   *
   * Sale del monitor (RF18). Sin estado todavia —el monitor no completo su
   * primer ciclo, o no hay monitor— se contesta lo mismo que el legacy dejaba en
   * el alta del dispositivo: DISCONNECTED. Decir CONNECTED sin haber hablado con
   * el PLC seria peor que decir que no se sabe. En simulacion se reporta
   * conectado porque es lo que el monitor mismo contesta en ese modo (RF20): el
   * agente se prueba sin PLC y decir lo contrario seria ruido.
   */
  function conexionDe(dispositivo: DispositivoRegistrado): ConexionDeApi {
    const estado = estadoDeConexion?.(claveDeDispositivo(dispositivo.robotId, dispositivo.tipo))
    if (estado === undefined) {
      return { status: simularPlc ? 'CONNECTED' : 'DISCONNECTED', lastSeen: null }
    }
    return estado.tipo === 'CONECTADO'
      ? { status: 'CONNECTED', lastSeen: estado.ultimoContactoMs }
      : { status: 'DISCONNECTED', lastSeen: null }
  }

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
          // Sale del monitor, igual que el `status` de GET /api/devices: dos
          // pantallas que leen lo mismo no pueden contestar distinto.
          connected: conexionDe(dispositivo).status === 'CONNECTED',
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
            // RF21 — La pausa de cola sobrevive al reinicio del proceso (el
            // legacy la perdia). Sale por /health porque la alternativa es el
            // modo que no puede pasar: la notebook arranca sola un lunes, el
            // health dice "ok" y el robot no se mueve porque alguien apreto
            // pausar el viernes. Aca se ve, y se grita ademas al arrancar.
            paused: cola.paused,
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
        // RF22, primer nivel. `LOOPBACK` = solo la notebook; `LAN_PRIVADA` = la
        // red de la sucursal, que es lo que necesita la tablet; `EXPUESTO` =
        // cualquier interfaz, y entonces la autorizacion del operario no se
        // apoya en nada.
        network: { bind: httpBind, scope: clasificarBind(httpBind) },
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
        // El `id` del body es la clave de dedupe del front actual (la tablet
        // manda {id: 1234}). Sin el, cada toque del boton creaba una orden nueva
        // con un externalOrderId propio y un doble tap eran DOS maniobras, la
        // segunda a buscar un cajon que ya no estaba.
        externalOrderId: pedido.externalOrderId ?? pedido.id ?? null,
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

  // RF21 — La SALIDA del operario, y es la unica que hay.
  //
  // Libera el slot desde CUALQUIER estado, como `StateManager.releaseSlot` del
  // legacy. Es lo que sostiene la planta cuando un PICK falla de una forma que el
  // retry no arregla —cajon trabado, PLC en falla—: el slot queda en RESERVADO o
  // BUSCANDO y, sin esta salida, cada fallo asi se come uno de los doce slots de
  // la zona y la unica correccion es editar SQLite a mano. Liberar corrige los
  // libros y NO mueve el robot; para eso existe.
  //
  // LA GUARDA: no se libera el slot de una orden EN CURSO. Mientras el ciclo
  // maniobra, el handshake con el PLC no mira el estado del slot, asi que
  // liberarlo ahi deja el cajon a mitad de camino con los libros diciendo que el
  // slot esta vacio, y el proximo PICK lo elige y manda el carro encima. El
  // operario espera a que termine —o cancela— y despues libera.
  //
  // LA OTRA GUARDA vive en el dominio: si el slot tiene un cajon en libros,
  // liberarlo exige declarar que se lo saco. Ver `LIBERAR_MANUAL`.
  app.post('/api/slots/:locationCode/release', (req: Request, res: Response) => {
    atender(res, async () => {
      const locationCode = texto(req.params['locationCode'])
      const confirmacion = validar(LIBERACION_DE_SLOT, req.body ?? {}, res)
      if (confirmacion === null) {
        return
      }
      const robots = await repositorios.robots.listar(siteId)

      for (const robot of robots) {
        const slot = await repositorios.slots.buscar(robot.id, locationCode)
        if (slot === undefined) {
          continue
        }

        const ordenId = 'ordenId' in slot.estado ? slot.estado.ordenId : null
        if (ordenId !== null && (await estaEnCurso(ordenId))) {
          error(
            res,
            409,
            `el slot ${locationCode} lo esta usando el pedido ${ordenId} ahora mismo: espera a que el robot termine antes de liberarlo`,
          )
          return
        }

        const estadoPrevio = slot.estado.estado
        const siguiente = transicionarSlot(slot.estado, {
          tipo: 'LIBERAR_MANUAL',
          slotVacioConfirmado: confirmacion.slotVacioConfirmado,
        })
        if (!siguiente.ok) {
          // El rechazo por cajon en libros se explica: decir "SLOT_CON_CAJON_EN_
          // LIBROS" a secas manda a la persona a reintentar con el flag sin haber
          // ido a mirar, que es exactamente lo que el rechazo quiere evitar.
          error(
            res,
            409,
            siguiente.error.codigo === 'SLOT_CON_CAJON_EN_LIBROS'
              ? `el slot ${locationCode} figura con un cajon de ${siguiente.error.ubicacionDeOrigen} apoyado: ` +
                  'anda a mirarlo. Si el cajon ya no esta, reintenta con {"slotVacioConfirmado": true}; si ' +
                  'sigue ahi, sacalo primero — liberarlo asi lo borra del inventario y el proximo PICK manda ' +
                  'el carro a ese mismo slot'
              : siguiente.error.codigo,
          )
          return
        }

        await repositorios.slots.guardarEstado(robot.id, locationCode, siguiente.valor)
        // La liberacion manual corrige los libros y NO mueve el robot: queda
        // registrada —con el estado del que se salio y el pedido que lo retenia—
        // para que se pueda auditar quien la uso y sobre que.
        await repositorios.eventos.registrar({
          id: orquestador.generarId(),
          ts: orquestador.reloj.ahoraMs(),
          tipoDeEntidad: 'SLOT',
          entidadId: locationCode,
          evento: 'SLOT_RELEASED_MANUAL',
          severidad: 'INFO',
          metadata: { robotId: robot.id, estadoPrevio, ordenId },
        })

        ok(res, 200, { locationCode, status: 'LIBRE', previousStatus: estadoPrevio })
        return
      }

      error(res, 404, 'SLOT_INEXISTENTE')
    })
  })

  // ---------------------------------------------------------------- dispositivos
  //
  // El alta de dispositivo EXIGE el token de mantenimiento (RF22, segundo nivel).
  // No es una accion de la jornada: es la que dice por que host, puerto y unitId
  // se le habla al PLC. Sin token, cualquiera que llegue al puerto del agente
  // reapunta el Modbus del robot a una maquina suya, y a partir de ahi el robot
  // obedece a otro. El resto de la API sigue sin credencial a proposito: el
  // operario tiene que poder trabajar sin un secreto en la tablet.
  app.post('/api/devices/register', exigirMantenimiento, (req: Request, res: Response) => {
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
        // El mapa de registros es configuracion de planta y entra por el alta,
        // como en el legacy: un dispositivo que no usa el registro 0 no falla, le
        // escribe el comando a otra direccion del PLC. Lo que no se declara lo
        // completa el default, que es lo que hace `mergeRegisterMaps`.
        mapaDeRegistros: {
          messageIn: alta.registerMap?.messageIn ?? MAPA_DE_REGISTROS_POR_DEFECTO.messageIn,
          messageOut: alta.registerMap?.messageOut ?? MAPA_DE_REGISTROS_POR_DEFECTO.messageOut,
        },
      })

      ok(res, 201, aDispositivoRegistradoDeApi(dispositivo))
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
        porRobot.flat().map((dispositivo) => aDispositivoDeApi(dispositivo, conexionDe(dispositivo))),
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
              (dispositivo) => aDispositivoDeApi(dispositivo, conexionDe(dispositivo)),
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
        const robotId = texto(req.params['robotId'])
        const respuestasEsperadas = respuestasEsperadasDe(pedido)

        const resultado = await orquestador.transporte.ejecutarComandoDePaso(robotId, tipo, {
          comando: valor,
          respuestasEsperadas,
        })
        if (!resultado.ok) {
          // El comando YA se escribio: sin este reset `messageIn` queda con el
          // valor puesto a mano y el proximo paso real arranca con el registro
          // sucio, o sea con un comando colgado que el PLC puede tomar. Es el
          // mismo reset que hace el retry de orden (RF13), acotado al unico
          // dispositivo que este endpoint toco.
          const limpieza = await orquestador.transporte.resetearMessageIn(robotId, tipo)
          if (!limpieza.ok) {
            // Que falle el reset es peor que el comando fallido: queda un
            // registro escrito que nadie limpio. Se dice cual fue; taparlo seria
            // dejar el proximo paso real arrancando sucio y sin rastro de por que.
            orquestador.logger.error('DIRECT_COMMAND_RESET_FAILED', {
              robotId,
              dispositivo: tipo,
              fallo: limpieza.error.tipo,
            })
          }
          error(res, 502, resultado.error.tipo)
          return
        }

        ok(res, 200, {
          response: { ack: 'DONE', kind: resultado.valor.kind },
          expectedResponses: respuestasEsperadas,
        })
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

  /**
   * True si esa orden es una maniobra en curso.
   *
   * Es la guarda de la liberacion manual de slot: IN_PROGRESS significa que el
   * ciclo del robot esta adentro del handshake con el PLC, y ese ciclo no vuelve
   * a mirar el slot hasta terminar el paso.
   */
  async function estaEnCurso(ordenId: string): Promise<boolean> {
    const orden = await repositorios.ordenes.buscarPorId(ordenId)
    return orden?.estado === 'IN_PROGRESS'
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

/**
 * El `id` con el que el front dedupea, portado del legacy (`parseNumericOrderId`).
 *
 * La tablet manda `{id: 1234}` y espera que el segundo toque del boton devuelva
 * la MISMA orden. Se exige entero, como el legacy, y se normaliza a texto
 * —`'1234'` y `1234` son el mismo pedido— porque `external_order_id` es TEXT.
 * No colisiona con el id local de RF35, que va prefijado (`local-<agente>-<uuid>`)
 * y nunca es solo digitos.
 */
const ID_DE_DEDUPE = z
  .union([z.number(), z.string().trim().min(1)])
  .refine((valor) => Number.isInteger(Number(valor)), {
    message: 'id debe ser numerico entero',
  })
  .transform((valor) => String(Number(valor)))

const ALTA_DE_ORDEN = z.object({
  id: ID_DE_DEDUPE.nullish(),
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

const LIBERACION_DE_SLOT = z.object({
  /**
   * Declaracion de que el slot ya no tiene el cajon encima.
   *
   * Default false: liberar un slot con cajon en libros tiene que ser un acto
   * deliberado. Omitir el campo es no haber mirado.
   */
  slotVacioConfirmado: z.boolean().default(false),
})

const ALTA_DE_DISPOSITIVO = z.object({
  robotId: z.string().trim().min(1, 'robotId es requerido'),
  type: TIPO_DE_DISPOSITIVO,
  host: z.string().trim().min(1, 'host es requerido'),
  port: z.coerce.number().int().min(1).max(65535).default(502),
  // Los Festo de planta no usan el unitId 1.
  unitId: z.coerce.number().int().min(0).max(255).default(255),
  timeoutMs: z.coerce.number().int().min(1).default(2000),
  /**
   * En que direcciones Modbus vive este dispositivo. Ausente = el default (0 y 0).
   *
   * Se validan las dos como enteros no negativos, que es la validacion de alta
   * que el legacy tenia en `src/config/deviceRegisterMaps.js` mas
   * `parseRegisterMap`. Una direccion fraccionaria o negativa no existe en
   * Modbus: aceptarla no falla, manda el comando a cualquier lado.
   */
  registerMap: z
    .object({
      messageIn: z.coerce.number().int().min(0).optional(),
      messageOut: z.coerce.number().int().min(0).optional(),
    })
    .optional(),
})

/**
 * Un codigo que cierra el comando: un numero exacto o un comodin de rango del
 * legacy (`1##` = 100..199, `2##` = 200..299).
 */
const RESPUESTA_ESPERADA = z.union([
  z.coerce.number().int(),
  z.literal('1##'),
  z.literal('2##'),
])

const COMANDO_DIRECTO = z.object({
  value: z.coerce.number({ message: 'value debe ser un numero' }),
  /**
   * Con que respuestas del PLC se da por cerrado el comando (RF17).
   *
   * Vuelve a entrar por el body, como en el legacy: sin esto, mover el elevador a
   * mano —que contesta `2##`, el nivel, y nunca 100— se quedaba esperando los 90
   * s enteros del presupuesto de ack y terminaba en 502.
   */
  expectedResponses: z.array(RESPUESTA_ESPERADA).min(1).optional(),
  /** La forma singular del legacy. Se acepta igual: es la que manda la herramienta vieja. */
  expectedResponse: RESPUESTA_ESPERADA.optional(),
})

/**
 * Las respuestas que cierran el comando directo.
 *
 * Precedencia del legacy: `expectedResponses` gana, si no `expectedResponse`, y
 * si no el default. El default agrega `'1##'` al `[100]` del legacy —DESVIO
 * DECLARADO— para que un error del PLC se informe apenas llega, en vez de
 * agotar los 90 s de polling esperando un 100 que ya no va a venir.
 */
function respuestasEsperadasDe(pedido: {
  readonly expectedResponses?: readonly RespuestaEsperada[] | undefined
  readonly expectedResponse?: RespuestaEsperada | undefined
}): readonly RespuestaEsperada[] {
  if (pedido.expectedResponses !== undefined) {
    return pedido.expectedResponses
  }
  if (pedido.expectedResponse !== undefined) {
    return [pedido.expectedResponse]
  }
  return [100, '1##']
}

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

/** `status` y `lastSeen` de un dispositivo, ya resueltos contra el monitor. */
interface ConexionDeApi {
  readonly status: 'CONNECTED' | 'DISCONNECTED'
  /** Ultimo contacto real con el PLC; `null` si nunca se logro. */
  readonly lastSeen: number | null
}

/**
 * Forma de un dispositivo tal como la consume el front.
 *
 * `status` y `lastSeen` son diagnostico y salen del monitor de conectividad
 * (RF18), que es quien de verdad toca el socket. Antes eran una constante
 * derivada de `simularPlc`, asi que en planta la pantalla decia DISCONNECTED
 * para siempre y el operario no podia distinguir un cable desenchufado de un PLC
 * trabado ni de una orden que fallo por otra cosa.
 */
function aDispositivoDeApi(
  dispositivo: DispositivoRegistrado,
  conexion: ConexionDeApi,
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
    status: conexion.status,
    lastCommand: null,
    lastSeen: conexion.lastSeen,
    updatedAt: null,
    // En que direcciones esta cableado. Es lo primero que se mira cuando un
    // dispositivo "no responde" y el cable esta bien.
    registerMap: dispositivo.mapaDeRegistros ?? MAPA_DE_REGISTROS_POR_DEFECTO,
  }
}

/**
 * Forma del alta (201). Lleva el mapa de registros ya resuelto, para que quien
 * dio de alta sin declararlo vea cual le quedo.
 */
function aDispositivoRegistradoDeApi(
  dispositivo: DispositivoRegistrado,
): Record<string, unknown> {
  return {
    ...dispositivo,
    // El front lee la API en ingles; `mapaDeRegistros` se queda del lado de adentro.
    registerMap: dispositivo.mapaDeRegistros ?? MAPA_DE_REGISTROS_POR_DEFECTO,
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
    case 'PUT_FUERA_DE_ZONA_DE_PICKEO':
      return 'PUT requiere un locationCode de la zona de pickeo configurada'
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
      // Las dos salidas, en el mismo texto: el retry es la normal, la liberacion
      // manual es la que queda cuando el retry no va a funcionar (cajon trabado,
      // PLC en falla). Antes esta respuesta era un callejon sin salida.
      return `el pedido todavia tiene tomado el slot ${error.slotLocationCode}: reintentalo para que el robot lo libere, o —si el slot ya no tiene el cajon encima— liberalo a mano con POST /api/slots/${error.slotLocationCode}/release y cancela despues`
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

