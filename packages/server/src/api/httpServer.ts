// RF26, RF28–RF32 — La API del servidor de pedidos.
//
// Es el UNICO componente expuesto a internet. Dos clientes con contratos
// distintos:
//
//   - la app de picking, que da de alta pedidos firmados con HMAC y consulta su
//     estado;
//   - el agente de cada sucursal, que reclama trabajo por long-poll, reporta
//     transiciones y manda heartbeat.
//
// Todo el trafico del enlace lo INICIA el agente: el servidor nunca abre una
// conexion hacia la sucursal. Es lo que permite que el agente no exponga ningun
// puerto y que agregar una sucursal sea instalar un agente y emitir una
// credencial.

import { createServer } from 'node:http'

import express from 'express'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { z } from 'zod'

import type { CorrelacionDeOrden, Logger } from '@aoki-one/domain'

import type { CredencialDeAgente, CredentialsRepository } from '../persistence/credentialsRepository.js'
import type { PedidoDelServidor } from '../persistence/ordersRepository.js'
import type { ColaDelServidor } from '../persistence/sqliteOrdersRepository.js'
import { verificarFirma } from './hmac.js'
import { ingresarPedido, responderIngreso } from './ordersIngest.js'

export type CuerpoDeRespuesta<T> =
  | { readonly ok: true; readonly data: T; readonly created?: boolean }
  | { readonly ok: false; readonly error: string }

export interface DependenciasDelServidorHttp {
  readonly cola: ColaDelServidor
  readonly credenciales: CredentialsRepository
  readonly ahora: () => number
  readonly dormir: (ms: number) => Promise<void>
  readonly configuracion: ConfiguracionDelServidor
  /**
   * Logs estructurados de esta mitad del enlace (RNF de Observabilidad).
   *
   * No es opcional: el RNF pide "el mismo id de orden a los dos lados", y con un
   * `logger?` el dia que alguien lo omita al componer desaparece una de las dos
   * mitades en silencio y el cruce deja de existir sin que nada falle.
   */
  readonly logger: Logger
}

export interface ConfiguracionDelServidor {
  /** Ventana anti-replay del HMAC (RF26). */
  readonly ventanaDeFirmaMs: number
  /** Cuanto retiene el servidor el long-poll antes de contestar vacio (RF28). */
  readonly esperaDeLongPollMs: number
  /** Intervalo con el que el long-poll mira si hay trabajo nuevo. */
  readonly sondeoDeLongPollMs: number
  /** Vigencia del lease. Vencido, la orden vuelve a estar disponible (RF28). */
  readonly duracionDelLeaseMs: number
  /** Sin latido por mas de esto, la sucursal se reporta caida (RF31). */
  readonly toleranciaDeLatidoMs: number
}

export interface DireccionDeEscucha {
  readonly host: string
  readonly puerto: number
}

export interface ServidorHttp {
  readonly escuchar: (puerto: number, bind: string) => Promise<DireccionDeEscucha>
  readonly cerrar: () => Promise<void>
}

/**
 * Headers del contrato con la app de picking y con el agente.
 *
 * NO hay header de secreto. El cliente dice QUIEN es (`keyId`) y lo PRUEBA con
 * la firma; el servidor resuelve el secreto por keyId desde su propio almacen.
 * Mandar el secreto, como se hacia antes, volvia decorativa a la firma: el que
 * podia firmar ya se habia autenticado al mandarlo, y bastaba con interceptar
 * una sola request para poder emitir cualquier otra.
 */
export const HEADER_KEY_ID = 'x-aoki-key-id'
export const HEADER_FIRMA = 'x-aoki-signature'
export const HEADER_TIMESTAMP = 'x-aoki-timestamp'

/** El pedido que manda la app de picking. */
const ALTA_DE_PEDIDO = z.object({
  siteId: z.string().trim().min(1, 'siteId es requerido'),
  externalOrderId: z.string().trim().min(1, 'externalOrderId es requerido'),
  tipo: z.enum(['PICK', 'PUT'], { message: 'tipo debe ser PICK o PUT' }),
  locationCode: z.string().trim().min(1, 'locationCode es requerido'),
})

const RECLAMO_DE_TRABAJO = z.object({
  siteId: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  limite: z.coerce.number().int().min(1).max(50).default(10),
})

const REPORTE_DE_TRANSICION = z.object({
  ordenId: z.string().trim().min(1),
  seq: z.coerce.number().int().min(1),
  estado: z.enum(['PENDING', 'IN_PROGRESS', 'DONE', 'ERROR', 'CANCELED']),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

const LATIDO = z.object({
  siteId: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  estado: z.record(z.string(), z.unknown()).default({}),
})

export function crearServidorHttp(dependencias: DependenciasDelServidorHttp): ServidorHttp {
  const app = construirApp(dependencias)
  const servidor = createServer(app)

  return {
    escuchar: (puerto, bind) =>
      new Promise<DireccionDeEscucha>((resolve, reject) => {
        servidor.once('error', reject)
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

function construirApp(dependencias: DependenciasDelServidorHttp): express.Express {
  const { cola, credenciales, ahora, dormir, configuracion, logger } = dependencias
  const arrancadoEn = ahora()

  /**
   * La correlacion de un pedido del libro de ESTE servidor.
   *
   * `ordenIdLocal` va en `null` y no ausente: el id del libro del agente existe,
   * pero de este lado no se conoce. Decirlo explicitamente es lo que distingue
   * "no lo se" de "me lo olvide" cuando alguien cruza las dos mitades.
   */
  function correlacionDe(pedido: PedidoDelServidor): CorrelacionDeOrden {
    return {
      siteId: pedido.siteId,
      ordenId: pedido.id,
      ordenIdLocal: null,
      externalOrderId: pedido.externalOrderId,
    }
  }

  const app = express()
  // El body crudo se guarda para verificar la firma: dos JSON equivalentes tienen
  // bytes distintos, asi que firmar el reparseado no sirve.
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        ;(req as RequestConCrudo).cuerpoCrudo = buffer.toString('utf8')
      },
    }),
  )

  function ok(res: Response, estado: number, data: unknown, created?: boolean): void {
    const cuerpo: CuerpoDeRespuesta<unknown> =
      created === undefined ? { ok: true, data } : { ok: true, data, created }
    res.status(estado).json(cuerpo)
  }

  function error(res: Response, estado: number, mensaje: string): void {
    const cuerpo: CuerpoDeRespuesta<never> = { ok: false, error: mensaje }
    res.status(estado).json(cuerpo)
  }

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

  /**
   * Autentica por firma HMAC (RF26, RF32). Es la UNICA autenticacion de escritura.
   *
   * El cliente manda keyId, timestamp y firma; el secreto no viaja nunca. El
   * servidor lo resuelve por keyId desde su propio almacen y recomputa la firma
   * sobre el body crudo. La app de picking y el agente usan el mismo mecanismo:
   * no hay motivo para que el agente tenga uno mas debil.
   *
   * Deja la credencial en el request para que el handler valide a que sucursal
   * pertenece el recurso: autenticar no es autorizar.
   */
  const autenticarPorFirma = asincrono(async (req, res, next) => {
    // Un rechazo de autenticacion es lo PRIMERO que se mira cuando una sucursal
    // deja de reportar, y sin log no se distingue de una sucursal apagada: en
    // los dos casos el sintoma es el mismo silencio. Va con el keyId y la ruta
    // —nunca con la firma ni el secreto— porque el keyId es un identificador y
    // es con lo que se busca la credencial en la base.
    const rechazar = (estado: number, mensaje: string, datos: Record<string, unknown>): void => {
      const nivel = estado >= 500 ? 'error' : 'warn'
      logger[nivel]('AUTH_REJECTED', { ...datos, ruta: req.path, metodo: req.method })
      error(res, estado, mensaje)
    }

    const keyId = req.get(HEADER_KEY_ID)
    if (keyId === undefined) {
      rechazar(401, 'falta el identificador de credencial', { motivo: 'SIN_KEY_ID' })
      return
    }

    const resuelto = await credenciales.resolverSecreto(keyId)
    if (!resuelto.ok) {
      if (resuelto.error.codigo === 'SECRETO_ILEGIBLE') {
        // El servidor no puede recomputar la firma de esta credencial: es su
        // problema de configuracion, no del cliente. Un 401 mandaria al agente
        // a reemitir una credencial que esta bien.
        rechazar(500, 'no se pudo leer el material de la credencial', {
          motivo: resuelto.error.codigo,
          keyId,
        })
        return
      }
      rechazar(401, 'credencial invalida o revocada', { motivo: resuelto.error.codigo, keyId })
      return
    }

    // En un GET no hay body que firmar, asi que se firma la RUTA COMPLETA. Sin
    // eso la firma no quedaria atada al recurso: una firma valida para consultar
    // un pedido serviria para leer cualquier otro de la misma sucursal, que es
    // justo lo que la firma tiene que impedir.
    const crudo = (req as RequestConCrudo).cuerpoCrudo
    const contenidoFirmado = req.method === 'GET' ? req.originalUrl : (crudo ?? '')

    const firma = verificarFirma({
      cuerpoCrudo: contenidoFirmado,
      firma: req.get(HEADER_FIRMA),
      timestamp: req.get(HEADER_TIMESTAMP),
      secreto: resuelto.valor.secreto,
      ahoraMs: ahora(),
      ventanaMs: configuracion.ventanaDeFirmaMs,
    })
    if (!firma.ok) {
      rechazar(401, `firma rechazada: ${firma.error.codigo}`, {
        motivo: firma.error.codigo,
        keyId,
        // La credencial existe: el que no cierra es el material con el que
        // firmo. Un secreto desactualizado despues de una rotacion y un reloj
        // corrido se ven distinto aca, y es lo que decide a quien llamar.
        siteId: resuelto.valor.credencial.siteId,
      })
      return
    }

    ;(req as RequestConCredencial).credencial = resuelto.valor.credencial
    next()
  })

  /** La credencial que dejo `autenticarPorFirma`. Nunca falta: el middleware corrio antes. */
  function credencialDe(req: Request, res: Response): CredencialDeAgente | null {
    const credencial = (req as RequestConCredencial).credencial
    if (credencial === undefined) {
      error(res, 401, 'credencial invalida o revocada')
      return null
    }
    return credencial
  }

  // ------------------------------------------------- app de picking (RF26)
  app.post(
    '/api/v1/orders',
    autenticarPorFirma,
    asincrono(async (req, res) => {
      const alta = validar(ALTA_DE_PEDIDO, req.body, res)
      if (alta === null) {
        return
      }

      const credencial = credencialDe(req, res)
      if (credencial === null) {
        return
      }
      if (credencial.siteId !== alta.siteId) {
        error(res, 403, 'el siteId del pedido no corresponde a la credencial')
        return
      }

      const resultado = await ingresarPedido(cola, {
        siteId: alta.siteId,
        externalOrderId: alta.externalOrderId,
        tipo: alta.tipo,
        locationCode: alta.locationCode,
      })
      // Primer punto del hilo: aca nace el `ordenId` con el que despues se
      // cruzan el log del agente y el de este servidor.
      logger.paraOrden(correlacionDe(resultado.pedido)).info('ORDER_INGESTED', {
        tipo: resultado.pedido.tipo,
        locationCode: resultado.pedido.locationCode,
        // Un reenvio no crea una segunda orden (RF26). Se dice cual de los dos
        // fue para que dos lineas de la misma orden no se lean como dos altas.
        creado: resultado.tipo === 'CREADO',
      })

      const respuesta = responderIngreso(resultado)
      ok(res, respuesta.estadoHttp, respuesta.cuerpo.data, respuesta.cuerpo.created)
    }),
  )

  app.get(
    '/api/v1/orders/:externalOrderId',
    // Tambien va firmada: un keyId es un IDENTIFICADOR, no un secreto. Sin firma,
    // cualquiera que lo conozca lee el estado de todos los pedidos de la sucursal.
    autenticarPorFirma,
    asincrono(async (req, res) => {
      const credencial = credencialDe(req, res)
      if (credencial === null) {
        return
      }

      const pedido = await cola.buscarPorClave({
        siteId: credencial.siteId,
        externalOrderId: String(req.params['externalOrderId']),
      })
      if (pedido === null) {
        error(res, 404, 'pedido inexistente')
        return
      }
      ok(res, 200, pedido)
    }),
  )

  // ------------------------------------------------------- agente (RF28–RF31)
  app.post(
    '/api/v1/agent/work',
    autenticarPorFirma,
    asincrono(async (req, res) => {
      const pedido = validar(RECLAMO_DE_TRABAJO, req.body, res)
      if (pedido === null) {
        return
      }
      const credencial = credencialDe(req, res)
      if (credencial === null) {
        return
      }
      if (credencial.siteId !== pedido.siteId) {
        error(res, 403, 'el siteId no corresponde a la credencial')
        return
      }

      // Reclamar para un cliente que ya no esta es perder ordenes: el lote sale
      // de la cola con lease vigente, la respuesta se escribe en un socket
      // muerto y nadie ejecuta ese trabajo hasta que el lease vence. El agente
      // no lo recibio y el servidor cree que si. Por eso el bucle mira si la
      // conexion sigue viva ANTES de cada reclamo, no despues.
      //
      // La señal es el 'close' de la RESPUESTA sin haberla terminado de
      // escribir. El 'close' del request no sirve: Node lo emite apenas
      // termina de leer el body, o sea en toda request, y con el bucle cortaria
      // siempre en la primera vuelta.
      let clienteCortado = false
      res.on('close', () => {
        clienteCortado = !res.writableFinished
      })
      const clienteSeFue = (): boolean => clienteCortado || res.writableEnded

      // Long-poll: se retiene la conexion hasta que hay trabajo o vence el
      // timeout. No es polling: no hay ciclo de reintento en caliente del lado
      // del agente.
      const limite = ahora() + configuracion.esperaDeLongPollMs
      for (;;) {
        if (clienteSeFue()) {
          return
        }
        const reclamados = await cola.reclamar(
          pedido.siteId,
          pedido.agentId,
          pedido.limite,
          ahora(),
          configuracion.duracionDelLeaseMs,
        )
        if (reclamados.length > 0) {
          // Una linea por orden y no una por lote: el lote es un detalle del
          // transporte, y lo que hay que poder seguir es la ORDEN. Con el lease
          // adentro se ve, sin abrir la base, si una re-entrega fue por lease
          // vencido y cuando vence la actual.
          for (const reclamado of reclamados) {
            logger.paraOrden(correlacionDe(reclamado)).info('WORK_LEASED', {
              agentId: reclamado.agentId,
              leaseVenceEn: reclamado.leaseVenceEn,
            })
          }
          ok(res, 200, reclamados)
          return
        }
        if (ahora() >= limite) {
          // Vacio, no error: el agente vuelve a pedir enseguida.
          ok(res, 200, [])
          return
        }
        await dormir(configuracion.sondeoDeLongPollMs)
      }
    }),
  )

  app.post(
    '/api/v1/agent/report',
    autenticarPorFirma,
    asincrono(async (req, res) => {
      const reporte = validar(REPORTE_DE_TRANSICION, req.body, res)
      if (reporte === null) {
        return
      }
      const credencial = credencialDe(req, res)
      if (credencial === null) {
        return
      }

      // El ordenId viene del cliente y es el unico endpoint de agente donde el
      // recurso no esta identificado por el siteId del body: hay que ir a buscar
      // de que sucursal es la orden. Sin esto, cualquier credencial valida podia
      // mover el estado de ordenes de otra sucursal.
      //
      // Que la orden NO exista no es un 403: sigue el camino de aplicarTransicion,
      // que contesta ORDEN_INEXISTENTE con 200 para que el outbox del agente la
      // saque de la cola. Un 4xx ahi lo haria reintentar para siempre (RF34).
      const orden = await cola.buscarPorId(reporte.ordenId)
      if (orden !== undefined && orden.siteId !== credencial.siteId) {
        error(res, 403, 'la orden no corresponde a la credencial')
        return
      }

      const resultado = await cola.aplicarTransicion({
        ordenId: reporte.ordenId,
        seq: reporte.seq,
        estado: reporte.estado,
        reportadaEn: ahora(),
        metadata: reporte.metadata,
      })

      // Los tres resultados viajan por la rama ok, con 200, incluido
      // ORDEN_INEXISTENTE. Una transicion descartada NO es un error para el
      // agente: su outbox reintenta hasta tener confirmacion, y un 4xx lo haria
      // reintentar para siempre algo que ya se aplico.
      //
      // El cierre del hilo: la misma orden que se logueo al entrar y al
      // entregarse, ahora con lo que la sucursal reporto de ella.
      const deLaOrden = logger.paraOrden({
        siteId: credencial.siteId,
        ordenId: reporte.ordenId,
        ordenIdLocal: null,
        // `null` cuando la orden no esta en el libro: el agente reporta por
        // ordenId y el externo es lo unico que aca no se puede inventar.
        externalOrderId: orden?.externalOrderId ?? null,
      })
      const datosDeLaTransicion = { seq: reporte.seq, estado: reporte.estado }
      switch (resultado.tipo) {
        case 'APLICADA':
          deLaOrden.info('TRANSITION_APPLIED', datosDeLaTransicion)
          break
        case 'DESCARTADA':
          // WARN y no INFO: descartar es lo normal cuando el outbox reintenta
          // (RF34), pero un descarte que se repite es un agente que no esta
          // recibiendo la confirmacion, y eso no se ve en ningun otro lado.
          deLaOrden.warn('TRANSITION_DISCARDED', {
            ...datosDeLaTransicion,
            motivo: resultado.motivo,
          })
          break
        case 'ORDEN_INEXISTENTE':
          deLaOrden.warn('TRANSITION_DISCARDED', {
            ...datosDeLaTransicion,
            motivo: resultado.tipo,
          })
          break
      }

      // ORDEN_INEXISTENTE tampoco puede ser un 404. El agente no tiene como
      // distinguir ese 404 del que devuelve esta misma API cuando la ruta no
      // existe —un proxy mal configurado, una base de URL con un prefijo de mas—,
      // y leerlo como "la orden no esta" le haria descartar del outbox cambios de
      // estado que el servidor nunca recibio. Perder una transicion en silencio es
      // exactamente lo que RF34 prohibe, asi que el caso terminal se dice por el
      // cuerpo y el 404 queda reservado para "esta ruta no existe".
      ok(res, 200, resultado)
    }),
  )

  app.post(
    '/api/v1/agent/heartbeat',
    autenticarPorFirma,
    asincrono(async (req, res) => {
      const latido = validar(LATIDO, req.body, res)
      if (latido === null) {
        return
      }
      const credencial = credencialDe(req, res)
      if (credencial === null) {
        return
      }
      if (credencial.siteId !== latido.siteId) {
        error(res, 403, 'el siteId no corresponde a la credencial')
        return
      }

      const ahoraMs = ahora()
      await credenciales.registrarLatido({
        siteId: latido.siteId,
        agentId: latido.agentId,
        ultimoLatido: ahoraMs,
        estado: latido.estado,
      })
      ok(res, 200, { siteId: latido.siteId, recibidoEn: ahoraMs })
    }),
  )

  // ---------------------------------------------------------------- health
  app.get(
    '/health',
    asincrono(async (_req, res) => {
      const ahoraMs = ahora()
      const presencias = await credenciales.presencias()

      const sucursales = await Promise.all(
        presencias.map(async (presencia) => ({
          siteId: presencia.siteId,
          agentId: presencia.agentId,
          ultimoLatido: presencia.ultimoLatido,
          // RF31: sin latido dentro de la tolerancia, la sucursal esta caida.
          // Se dice siempre, no solo cuando hay problema.
          caida: ahoraMs - presencia.ultimoLatido > configuracion.toleranciaDeLatidoMs,
          pendientes: await cola.pendientes(presencia.siteId, ahoraMs),
        })),
      )

      ok(res, 200, { startedAt: arrancadoEn, sites: sucursales })
    }),
  )

  app.use((_req: Request, res: Response) => {
    error(res, 404, 'ruta no encontrada')
  })

  /**
   * Red de contencion: todo fallo de un handler termina aca (RF26).
   *
   * Va ULTIMO y con cuatro argumentos: Express reconoce un middleware de error
   * solo por su aridad, y solo atiende lo que se registro despues del handler
   * que fallo. `_siguiente` existe por eso, aunque no se use.
   */
  app.use((causa: unknown, req: Request, res: Response, _siguiente: NextFunction): void => {
    // Un 500 sin rastro es indebuggeable: el cliente no ve el detalle a
    // proposito, asi que el unico lugar donde queda es el log del servidor. Va
    // por el logger y no por `console.error` para que salga con la misma forma
    // que el resto: un segundo formato es una linea que el recolector no parsea
    // y que nadie encuentra cuando la busca.
    logger.error('REQUEST_FAILED', {
      ruta: req.path,
      metodo: req.method,
      detalle: causa instanceof Error ? causa.message : String(causa),
      // El stack no viaja al cliente (ver abajo) y aca si hace falta: sin el,
      // "error interno" no dice en que capa se rompio.
      stack: causa instanceof Error ? causa.stack : undefined,
    })

    if (res.headersSent) {
      // Ya se empezo a escribir la respuesta: cambiarle el status es imposible y
      // agregarle otro cuerpo le daria al cliente un JSON corrupto. Se corta la
      // conexion para que lo lea como lo que es, una respuesta incompleta.
      res.destroy()
      return
    }

    // El detalle del fallo no sale: un stack trace en la respuesta le dibuja al
    // atacante el mapa del servidor.
    const estado = estadoDeCliente(causa)
    error(res, estado ?? 500, estado === null ? 'error interno del servidor' : 'entrada invalida')
  })

  return app
}

/**
 * Envuelve un handler async para que su fallo llegue a Express en vez de matar
 * al proceso.
 *
 * Express 4 no mira la promesa que devuelve un handler, asi que un
 * `void (async () => {...})()` que rechaza no es un error de request: es un
 * unhandled rejection, y Node baja el proceso entero. Un SQLITE_BUSY, un disco
 * lleno o una base corrupta en UNA request dejaban sin servidor a TODAS las
 * sucursales. Aca el rechazo se deriva a `next`, que lo lleva al middleware de
 * error.
 */
function asincrono(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch((causa: unknown) => {
      next(causa)
    })
  }
}

/**
 * El status que el propio error declara, cuando culpa al cliente.
 *
 * `express.json()` rechaza un body mal formado con un error que trae
 * `status: 400`. Contestarle 500 a eso seria mentir sobre de quien es el
 * problema e invitar al agente a reintentar algo que nunca va a andar. Todo lo
 * demas —repositorio, disco, base bloqueada— es del servidor.
 */
function estadoDeCliente(causa: unknown): number | null {
  if (typeof causa !== 'object' || causa === null || !('status' in causa)) {
    return null
  }
  const { status } = causa
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 499) {
    return null
  }
  return status
}

interface RequestConCrudo extends Request {
  cuerpoCrudo?: string
}

interface RequestConCredencial extends Request {
  credencial?: CredencialDeAgente
}
