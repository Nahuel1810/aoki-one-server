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
import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'

import type { CredencialDeAgente, CredentialsRepository } from '../persistence/credentialsRepository.js'
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

/** Headers del contrato con la app de picking y con el agente. */
export const HEADER_KEY_ID = 'x-aoki-key-id'
export const HEADER_FIRMA = 'x-aoki-signature'
export const HEADER_TIMESTAMP = 'x-aoki-timestamp'
export const HEADER_SECRETO_DE_AGENTE = 'x-aoki-agent-secret'

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
  const { cola, credenciales, ahora, dormir, configuracion } = dependencias
  const arrancadoEn = ahora()

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
   * Autentica al agente por su credencial de sucursal (RF32).
   *
   * Deja la credencial en el request para que el handler pueda validar que el
   * `siteId` del body coincide: una sucursal no puede reclamar trabajo de otra.
   */
  function autenticarAgente(req: Request, res: Response, next: NextFunction): void {
    void (async () => {
      const keyId = req.get(HEADER_KEY_ID)
      const secreto = req.get(HEADER_SECRETO_DE_AGENTE)
      if (keyId === undefined || secreto === undefined) {
        error(res, 401, 'falta la credencial de sucursal')
        return
      }

      const credencial = await credenciales.verificar(keyId, secreto)
      if (credencial === undefined) {
        error(res, 401, 'credencial invalida o revocada')
        return
      }

      ;(req as RequestConCredencial).credencial = credencial
      next()
    })()
  }

  // ------------------------------------------------- app de picking (RF26)
  app.post('/api/v1/orders', (req: Request, res: Response) => {
    void (async () => {
      const keyId = req.get(HEADER_KEY_ID)
      if (keyId === undefined) {
        error(res, 401, 'falta el identificador de credencial')
        return
      }

      const alta = validar(ALTA_DE_PEDIDO, req.body, res)
      if (alta === null) {
        return
      }

      // El secreto se resuelve por keyId y despues se verifica la firma sobre el
      // body crudo. El siteId del body se valida contra la credencial: una
      // sucursal no puede crear ordenes de otra.
      const credencial = await credenciales.buscar(keyId)
      if (credencial === undefined || credencial.revocadaEn !== null) {
        error(res, 401, 'credencial invalida o revocada')
        return
      }
      if (credencial.siteId !== alta.siteId) {
        error(res, 403, 'el siteId del pedido no corresponde a la credencial')
        return
      }

      const secreto = req.get(HEADER_SECRETO_DE_AGENTE)
      if (secreto === undefined) {
        error(res, 401, 'falta el secreto para verificar la firma')
        return
      }
      const verificada = await credenciales.verificar(keyId, secreto)
      if (verificada === undefined) {
        error(res, 401, 'credencial invalida o revocada')
        return
      }

      const firma = verificarFirma({
        cuerpoCrudo: (req as RequestConCrudo).cuerpoCrudo ?? '',
        firma: req.get(HEADER_FIRMA),
        timestamp: req.get(HEADER_TIMESTAMP),
        secreto,
        ahoraMs: ahora(),
        ventanaMs: configuracion.ventanaDeFirmaMs,
      })
      if (!firma.ok) {
        error(res, 401, `firma rechazada: ${firma.error.codigo}`)
        return
      }

      const resultado = await ingresarPedido(cola, {
        siteId: alta.siteId,
        externalOrderId: alta.externalOrderId,
        tipo: alta.tipo,
        locationCode: alta.locationCode,
      })
      const respuesta = responderIngreso(resultado)
      ok(res, respuesta.estadoHttp, respuesta.cuerpo.data, respuesta.cuerpo.created)
    })()
  })

  app.get('/api/v1/orders/:externalOrderId', (req: Request, res: Response) => {
    void (async () => {
      const keyId = req.get(HEADER_KEY_ID)
      if (keyId === undefined) {
        error(res, 401, 'falta el identificador de credencial')
        return
      }
      const credencial = await credenciales.buscar(keyId)
      if (credencial === undefined || credencial.revocadaEn !== null) {
        error(res, 401, 'credencial invalida o revocada')
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
    })()
  })

  // ------------------------------------------------------- agente (RF28–RF31)
  app.post('/api/v1/agent/work', autenticarAgente, (req: Request, res: Response) => {
    void (async () => {
      const pedido = validar(RECLAMO_DE_TRABAJO, req.body, res)
      if (pedido === null) {
        return
      }
      const credencial = (req as RequestConCredencial).credencial
      if (credencial === undefined || credencial.siteId !== pedido.siteId) {
        error(res, 403, 'el siteId no corresponde a la credencial')
        return
      }

      // Long-poll: se retiene la conexion hasta que hay trabajo o vence el
      // timeout. No es polling: no hay ciclo de reintento en caliente del lado
      // del agente.
      const limite = ahora() + configuracion.esperaDeLongPollMs
      for (;;) {
        const reclamados = await cola.reclamar(
          pedido.siteId,
          pedido.agentId,
          pedido.limite,
          ahora(),
          configuracion.duracionDelLeaseMs,
        )
        if (reclamados.length > 0) {
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
    })()
  })

  app.post('/api/v1/agent/report', autenticarAgente, (req: Request, res: Response) => {
    void (async () => {
      const reporte = validar(REPORTE_DE_TRANSICION, req.body, res)
      if (reporte === null) {
        return
      }

      const resultado = await cola.aplicarTransicion({
        ordenId: reporte.ordenId,
        seq: reporte.seq,
        estado: reporte.estado,
        reportadaEn: ahora(),
        metadata: reporte.metadata,
      })

      if (resultado.tipo === 'ORDEN_INEXISTENTE') {
        error(res, 404, 'orden inexistente')
        return
      }
      // Una transicion descartada NO es un error para el agente: su outbox
      // reintenta hasta tener confirmacion, y un 4xx lo haria reintentar para
      // siempre algo que ya se aplico.
      ok(res, 200, resultado)
    })()
  })

  app.post('/api/v1/agent/heartbeat', autenticarAgente, (req: Request, res: Response) => {
    void (async () => {
      const latido = validar(LATIDO, req.body, res)
      if (latido === null) {
        return
      }
      const credencial = (req as RequestConCredencial).credencial
      if (credencial === undefined || credencial.siteId !== latido.siteId) {
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
    })()
  })

  // ---------------------------------------------------------------- health
  app.get('/health', (_req: Request, res: Response) => {
    void (async () => {
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
    })()
  })

  app.use((_req: Request, res: Response) => {
    error(res, 404, 'ruta no encontrada')
  })

  return app
}

interface RequestConCrudo extends Request {
  cuerpoCrudo?: string
}

interface RequestConCredencial extends Request {
  credencial?: CredencialDeAgente
}
