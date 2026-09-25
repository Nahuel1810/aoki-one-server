import type { z } from 'zod'

/**
 * Unico punto del front que emite requests HTTP.
 *
 * La spec deja auth y `siteId` fuera de alcance, pero cuando el backend los
 * exija se agregan aca y en ningun otro lado: ninguna vista llama a `fetch`
 * directamente.
 */

/** Falla de red o de transporte: el servidor no contesto. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('No se pudo contactar al servidor')
    this.name = 'NetworkError'
    this.cause = cause
  }
}

/** El servidor contesto con `{ ok: false }` o un status de error. */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * El servidor contesto algo que no coincide con el contrato esperado.
 *
 * El mensaje que se ve en pantalla no nombra rutas ni esquemas: lo lee alguien
 * que esta en el deposito. La ruta y el detalle van a la consola, que es donde
 * los busca quien puede hacer algo con ellos.
 */
export class ContractError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super('El servidor respondio algo que no se entiende')
    this.name = 'ContractError'
    this.cause = cause
    console.error('[api] respuesta invalida en %s', path, cause)
  }
}

type Envelope = { ok?: boolean; data?: unknown; error?: unknown }

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response

  // `HeadersInit` admite objeto, array o Headers: se normaliza antes de tocarlo.
  const headers = new Headers(init?.headers)
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  try {
    response = await fetch(path, { ...init, headers })
  } catch (cause) {
    throw new NetworkError(cause)
  }

  let payload: Envelope
  try {
    payload = (await response.json()) as Envelope
  } catch (cause) {
    throw new ContractError(path, cause)
  }

  // El contrato del backend es { ok, data } / { ok, error }.
  if (!response.ok || payload.ok === false) {
    const message =
      typeof payload.error === 'string' && payload.error.trim()
        ? payload.error
        : response.status >= 500
          ? 'El servidor tuvo un problema'
          : 'No se pudo completar la accion'
    throw new ApiError(message, response.status)
  }

  return payload
}

/** GET que valida `data` contra el esquema antes de devolverlo. */
export async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const payload = (await request(path)) as Envelope
  const parsed = schema.safeParse(payload.data)

  if (!parsed.success) {
    throw new ContractError(path, parsed.error)
  }

  return parsed.data
}

/**
 * Header del token de mantenimiento del agente (RF22).
 *
 * Lo exigen las dos operaciones que deciden que hace el robot: el alta de un
 * equipo —a que PLC le habla— y el comando directo al PLC. El resto de la API va
 * sin credencial, para que la operacion diaria no dependa de un secreto.
 */
export const MAINTENANCE_TOKEN_HEADER = 'x-aoki-maintenance-token'

/** POST sin validacion de respuesta: se usa por el efecto, no por el payload. */
export async function apiPost(
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<void> {
  await request(path, {
    method: 'POST',
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/**
 * `/health` no usa el envoltorio `{ ok, data }`: responde el objeto plano.
 */
export async function apiGetRaw<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let response: Response

  try {
    response = await fetch(path)
  } catch (cause) {
    throw new NetworkError(cause)
  }

  if (!response.ok) {
    throw new ApiError('El servidor tuvo un problema', response.status)
  }

  const parsed = schema.safeParse(await response.json())

  if (!parsed.success) {
    throw new ContractError(path, parsed.error)
  }

  return parsed.data
}

/** Mensaje presentable para cualquier error que salga de esta capa. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof NetworkError) {
    return error.message
  }

  if (error instanceof ContractError) {
    return error.message
  }

  return error instanceof Error ? error.message : 'Error desconocido'
}
