// RF28, RF29, RF31, RF32, RF35 — El lado agente del enlace con el servidor.
//
// El contrato real esta en packages/server/src/api/httpServer.ts: los tres
// endpoints de agente y el ingreso de pedidos se autentican TODOS igual, con
// firma HMAC del body crudo (`x-aoki-key-id` + `x-aoki-timestamp` +
// `x-aoki-signature`).
//
// El secreto de la sucursal NO viaja: se usa para firmar y nunca sale de este
// proceso. Antes se mandaba en un header y el servidor lo usaba para verificar
// la firma, con lo cual la firma no probaba nada que el header no probara ya, y
// una sola request interceptada alcanzaba para hacerse pasar por la sucursal.
//
// TODO el trafico lo inicia el agente: el servidor nunca abre una conexion hacia
// la sucursal. Por eso aca hay un cliente y del otro lado no hay ninguno.
//
// TODA request lleva timeout y señal de corte. `fetch` no trae timeout propio:
// contra un servidor que acepta la conexion TCP y NO CONTESTA —proceso frozen,
// firewall en DROP, NAT que descarta el flujo, que son las caidas tipicas de un
// enlace de sucursal— una request sin timeout no vuelve NUNCA. El bucle del
// enlace queda clavado, no hay backoff porque nunca falla, `/health` sigue
// diciendo CONNECTED con el outbox creciendo, y el apagado del agente no termina.
//
// Los fallos salen por `Result` con una union discriminada, no por throw: el
// enlace caido es el caso NORMAL de este modulo, no una excepcion, y el que
// llama tiene que poder distinguir "no hay red" (reintentar con backoff) de
// "credencial rechazada" (reintentar no arregla nada, pero el agente sigue
// operando degradado igual).

import { createHmac } from 'node:crypto'

import type { EstadoOrden, Result, TipoOrden } from '@aoki-one/domain'
import { z } from 'zod'

/** Headers del contrato. Tienen que coincidir con los del servidor. */
export const HEADER_KEY_ID = 'x-aoki-key-id'
export const HEADER_FIRMA = 'x-aoki-signature'
export const HEADER_TIMESTAMP = 'x-aoki-timestamp'

export type FalloDeEnlace =
  /**
   * No hubo respuesta: servidor caido, DNS, cable, o el servidor acepto la
   * conexion y se quedo mudo hasta que vencio el timeout. Es el caso que amerita
   * backoff.
   */
  | { readonly tipo: 'SIN_RED'; readonly mensaje: string }
  /** 401/403. Reintentar no lo arregla: hay que emitir la credencial de nuevo. */
  | { readonly tipo: 'CREDENCIAL_RECHAZADA'; readonly estadoHttp: number }
  /** Contesto, pero con una forma que no es la del contrato. */
  | { readonly tipo: 'RESPUESTA_INVALIDA'; readonly mensaje: string }
  | { readonly tipo: 'ERROR_DEL_SERVIDOR'; readonly estadoHttp: number; readonly mensaje: string }
  /**
   * Una excepcion que se escapo del canal de Result.
   *
   * No la produce este modulo sino el bucle del enlace, que la usa para que un
   * throw inesperado no mate el proceso del agente. Vive en esta union porque es
   * el unico canal de error del enlace, y partirlo en dos obligaria a cada
   * consumidor a manejar las dos formas.
   */
  | { readonly tipo: 'FALLO_INESPERADO'; readonly mensaje: string }

/** Un pedido tal como lo conoce el servidor. El `id` es el del OTRO libro. */
export interface PedidoRemoto {
  readonly id: string
  readonly externalOrderId: string
  readonly tipo: TipoOrden
  readonly locationCode: string
}

export interface ReporteDeTransicion {
  readonly ordenIdRemoto: string
  readonly seq: number
  readonly estado: EstadoOrden
  readonly metadata: Readonly<Record<string, unknown>>
}

/**
 * Que hizo el servidor con la transicion.
 *
 * DESCARTADA es EXITO para el outbox: significa que esa seq ya estaba aplicada o
 * que ya llego una mas nueva. ORDEN_INEXISTENTE tambien saca la fila de la cola,
 * porque reintentar contra una orden que el servidor no tiene no converge nunca.
 */
export type ResultadoDeReporte =
  | { readonly tipo: 'APLICADA' }
  | { readonly tipo: 'DESCARTADA'; readonly motivo: string }
  | { readonly tipo: 'ORDEN_INEXISTENTE' }

export interface AltaRemotaDeOrden {
  readonly externalOrderId: string
  readonly tipo: TipoOrden
  readonly locationCode: string
}

/**
 * El cliente del servidor.
 *
 * Toda operacion acepta una señal de corte para que el apagado del agente pueda
 * abortar la request EN VUELO. Sin eso `detener()` tiene que esperar a que la
 * request termine sola, y contra un servidor mudo eso es "nunca": se cuelga el
 * apagado del proceso entero, porque la composicion espera al enlace primero.
 */
export interface ClienteDelServidor {
  /** Long-poll: el servidor retiene la conexion hasta que hay trabajo (RF28). */
  readonly reclamarTrabajo: (
    limite: number,
    senal?: AbortSignal,
  ) => Promise<Result<readonly PedidoRemoto[], FalloDeEnlace>>
  readonly reportarTransicion: (
    reporte: ReporteDeTransicion,
    senal?: AbortSignal,
  ) => Promise<Result<ResultadoDeReporte, FalloDeEnlace>>
  /** Empuja al servidor una orden que nacio en el agente (RF35). */
  readonly empujarOrden: (
    alta: AltaRemotaDeOrden,
    senal?: AbortSignal,
  ) => Promise<Result<PedidoRemoto, FalloDeEnlace>>
  readonly latir: (
    estado: Readonly<Record<string, unknown>>,
    senal?: AbortSignal,
  ) => Promise<Result<void, FalloDeEnlace>>
}

export interface CredencialDeSucursal {
  readonly keyId: string
  readonly secreto: string
}

/** Cuanto se le da a cada request antes de darla por perdida. */
export interface TiemposDelCliente {
  /** Para las requests que el servidor contesta enseguida: reporte, alta, latido. */
  readonly timeoutMs: number
  /**
   * Para el long-poll, que el servidor retiene a proposito.
   *
   * Tiene que ser MAYOR que el `esperaDeLongPollMs` del servidor: si fuera menor,
   * el agente abortaria SIEMPRE su propio reclamo justo antes de que el servidor
   * conteste, y la sucursal no recibiria trabajo nunca.
   */
  readonly timeoutDeLongPollMs: number
}

/**
 * El servidor retiene el long-poll 25 s (packages/server/src/composition.ts), asi
 * que 35 s dejan margen para la ida y la vuelta sin abortar una respuesta que ya
 * venia en camino. Los 10 s del resto son holgados para un POST que del otro
 * lado se resuelve con una escritura en SQLite.
 */
export const TIEMPOS_DEL_CLIENTE_POR_DEFECTO: TiemposDelCliente = {
  timeoutMs: 10_000,
  timeoutDeLongPollMs: 35_000,
}

export interface ConfiguracionDelCliente {
  /** Base del servidor, sin barra final. Por ejemplo `https://pedidos.aoki`. */
  readonly urlBase: string
  readonly siteId: string
  readonly agentId: string
  readonly credencial: CredencialDeSucursal
  readonly tiempos: TiemposDelCliente
  /**
   * `fetch` inyectado. El de Node alcanza en produccion, pero el test necesita
   * poder contestar sin levantar un servidor.
   */
  readonly pedir: typeof fetch
  readonly ahoraMs: () => number
}

const PEDIDO_REMOTO = z.object({
  id: z.string().min(1),
  externalOrderId: z.string().min(1),
  tipo: z.enum(['PICK', 'PUT']),
  locationCode: z.string().min(1),
})

const SOBRE_DE_TRABAJO = z.object({ ok: z.literal(true), data: z.array(PEDIDO_REMOTO) })
const SOBRE_DE_PEDIDO = z.object({ ok: z.literal(true), data: PEDIDO_REMOTO })
const SOBRE_DE_REPORTE = z.object({
  ok: z.literal(true),
  data: z.union([
    z.object({ tipo: z.literal('APLICADA') }),
    z.object({ tipo: z.literal('DESCARTADA'), motivo: z.string() }),
    z.object({ tipo: z.literal('ORDEN_INEXISTENTE') }),
  ]),
})

export function crearClienteHttp(configuracion: ConfiguracionDelCliente): ClienteDelServidor {
  const { urlBase, siteId, agentId, credencial, tiempos, pedir, ahoraMs } = configuracion

  /**
   * Firma los bytes EXACTOS que se van a mandar.
   *
   * El servidor verifica sobre el body crudo, asi que serializar dos veces —una
   * para firmar y otra para enviar— es la forma de que la firma no cierre: dos
   * JSON equivalentes tienen bytes distintos.
   */
  function cabecerasFirmadas(cuerpoCrudo: string): Readonly<Record<string, string>> {
    const timestamp = ahoraMs()
    return {
      'content-type': 'application/json',
      [HEADER_KEY_ID]: credencial.keyId,
      [HEADER_TIMESTAMP]: String(timestamp),
      [HEADER_FIRMA]: firmarCuerpo(credencial.secreto, timestamp, cuerpoCrudo),
    }
  }

  async function postear(
    ruta: string,
    cuerpo: unknown,
    timeoutMs: number,
    senal: AbortSignal | undefined,
  ): Promise<Result<unknown, FalloDeEnlace>> {
    const cuerpoCrudo = JSON.stringify(cuerpo)
    const porTiempo = AbortSignal.timeout(timeoutMs)
    const corte = senal === undefined ? porTiempo : AbortSignal.any([porTiempo, senal])

    let estadoHttp: number
    let texto: string
    try {
      const respuesta = await pedir(`${urlBase}${ruta}`, {
        method: 'POST',
        headers: cabecerasFirmadas(cuerpoCrudo),
        body: cuerpoCrudo,
        signal: corte,
      })
      estadoHttp = respuesta.status
      // Leer el cuerpo va DENTRO del try: la conexion se puede cortar mientras
      // baja el body, y entonces el error saldria por throw y no por Result, que
      // es el unico canal de error de este modulo.
      texto = await respuesta.text()
    } catch (error) {
      return { ok: false, error: falloDeTransporte(error, porTiempo, senal, timeoutMs) }
    }

    if (estadoHttp === 401 || estadoHttp === 403) {
      return { ok: false, error: { tipo: 'CREDENCIAL_RECHAZADA', estadoHttp } }
    }
    if (estadoHttp < 200 || estadoHttp >= 300) {
      return { ok: false, error: { tipo: 'ERROR_DEL_SERVIDOR', estadoHttp, mensaje: texto } }
    }

    try {
      return { ok: true, valor: JSON.parse(texto) as unknown }
    } catch (error) {
      return { ok: false, error: { tipo: 'RESPUESTA_INVALIDA', mensaje: mensajeDeError(error) } }
    }
  }

  function validar<T>(esquema: z.ZodType<T>, cuerpo: unknown): Result<T, FalloDeEnlace> {
    const analizado = esquema.safeParse(cuerpo)
    if (!analizado.success) {
      return {
        ok: false,
        error: {
          tipo: 'RESPUESTA_INVALIDA',
          mensaje: analizado.error.issues[0]?.message ?? 'forma inesperada',
        },
      }
    }
    return { ok: true, valor: analizado.data }
  }

  return {
    reclamarTrabajo: async (limite, senal) => {
      const respuesta = await postear(
        '/api/v1/agent/work',
        { siteId, agentId, limite },
        tiempos.timeoutDeLongPollMs,
        senal,
      )
      if (!respuesta.ok) {
        return respuesta
      }
      const sobre = validar(SOBRE_DE_TRABAJO, respuesta.valor)
      return sobre.ok ? { ok: true, valor: sobre.valor.data } : sobre
    },

    reportarTransicion: async (reporte, senal) => {
      const respuesta = await postear(
        '/api/v1/agent/report',
        {
          ordenId: reporte.ordenIdRemoto,
          seq: reporte.seq,
          estado: reporte.estado,
          metadata: reporte.metadata,
        },
        tiempos.timeoutMs,
        senal,
      )
      if (!respuesta.ok) {
        // Ningun error HTTP se traduce a un resultado terminal, y en particular
        // NO el 404. El servidor manda ORDEN_INEXISTENTE por el cuerpo, con 200,
        // justamente porque desde aca no hay forma de distinguir "esa orden no
        // esta" de "esta ruta no existe" (una base de URL con un prefijo de mas,
        // un proxy que contesta por su cuenta). Tratar cualquier 404 como terminal
        // vaciaria el outbox contra un servidor que nunca recibio nada, que es la
        // unica forma de perder un cambio de estado en silencio (RF34).
        return respuesta
      }
      const sobre = validar(SOBRE_DE_REPORTE, respuesta.valor)
      if (!sobre.ok) {
        return sobre
      }
      const dato = sobre.valor.data
      if (dato.tipo === 'DESCARTADA') {
        return { ok: true, valor: { tipo: 'DESCARTADA', motivo: dato.motivo } }
      }
      return { ok: true, valor: { tipo: dato.tipo } }
    },

    empujarOrden: async (alta, senal) => {
      // Misma ruta y mismo mecanismo que usa la app de picking (RF26): el agente
      // firma con su secreto de sucursal y el servidor valida que el siteId del
      // body sea el de esa credencial.
      const respuesta = await postear(
        '/api/v1/orders',
        {
          siteId,
          externalOrderId: alta.externalOrderId,
          tipo: alta.tipo,
          locationCode: alta.locationCode,
        },
        tiempos.timeoutMs,
        senal,
      )
      if (!respuesta.ok) {
        return respuesta
      }
      const sobre = validar(SOBRE_DE_PEDIDO, respuesta.valor)
      return sobre.ok ? { ok: true, valor: sobre.valor.data } : sobre
    },

    latir: async (estado, senal) => {
      const respuesta = await postear(
        '/api/v1/agent/heartbeat',
        { siteId, agentId, estado },
        tiempos.timeoutMs,
        senal,
      )
      return respuesta.ok ? { ok: true, valor: undefined } : respuesta
    },
  }
}

/**
 * Traduce lo que tiro `fetch` al unico canal de error del modulo.
 *
 * La causa se decide mirando QUE señal disparo y no el nombre del error: un
 * aborto llega como `DOMException` o como `TypeError` segun la version de Node y
 * segun quien lo haya disparado, y atarse a ese nombre es atarse a un detalle del
 * runtime. Las señales, en cambio, las controla este modulo.
 */
function falloDeTransporte(
  error: unknown,
  porTiempo: AbortSignal,
  senal: AbortSignal | undefined,
  timeoutMs: number,
): FalloDeEnlace {
  if (senal?.aborted === true) {
    return { tipo: 'SIN_RED', mensaje: 'el enlace se detuvo con la request en vuelo' }
  }
  if (porTiempo.aborted) {
    // El servidor acepto la conexion y no contesto. Para el enlace es
    // indistinguible de no tener red, y amerita el mismo backoff.
    return { tipo: 'SIN_RED', mensaje: `sin respuesta en ${String(timeoutMs)} ms` }
  }
  return { tipo: 'SIN_RED', mensaje: mensajeDeError(error) }
}

/**
 * Firma que espera el servidor: HMAC-SHA256 de `<timestamp>.<body crudo>`.
 *
 * Se reimplementa aca a proposito. El contrato lo fija
 * packages/server/src/api/hmac.ts, pero el agente NO depende del paquete del
 * servidor: el enlace es HTTP, no una importacion, y esa es la condicion para
 * que el agente corra solo en la sucursal. Si el contrato cambia, los dos lados
 * cambian juntos.
 */
function firmarCuerpo(secreto: string, timestampMs: number, cuerpoCrudo: string): string {
  return createHmac('sha256', secreto)
    .update(`${String(timestampMs)}.${cuerpoCrudo}`)
    .digest('hex')
}

function mensajeDeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
