// T23 — Importacion de la base del robot viejo a la base del agente nuevo.
//
// Se migran las tres cosas que no se pueden volver a construir solas:
//
//   - los SLOTS con su estado, porque describen que hay apoyado fisicamente en
//     la zona de pickeo en este momento. Si se arranca con la zona vacia, el
//     agente cree que puede reservar un slot que tiene un cajon encima.
//   - las ORDENES ABIERTAS, que son el trabajo que la sucursal todavia debe.
//   - el HISTORICO DE METRICAS, con `site_id` agregado, porque es el numero que
//     el negocio ya viene mirando y se corta si no se trae.
//
// El servidor arranca VACIO: las ordenes abiertas al momento del cutover las
// termina el agente desde su cola local, no se re-admiten del otro lado.
//
// Cuatro propiedades, que son las que lo hacen usable una noche de cutover:
//
//   1. IDEMPOTENTE. Correrlo dos veces no duplica ni pisa. Lo que ya esta
//      migrado se cuenta como tal y no se vuelve a escribir, y un slot que el
//      agente nuevo YA modifico no se sobrescribe: se reporta. Sin esa regla,
//      una segunda corrida "por las dudas" volveria el estado al del snapshot y
//      seria una regresion silenciosa a media noche.
//   2. SIMULACION. Con `simulacion: true` no se escribe una sola fila y el
//      reporte dice exactamente lo mismo que diria la corrida real.
//   3. La base ORIGEN no se toca (lo impone `abrirOrigenLegacy`, en solo lectura).
//   4. Todo lo que NO se pudo migrar sale en el reporte CON EL MOTIVO. Una fila
//      corrupta se salta y se informa; no corta la migracion de las demas,
//      porque la alternativa es descubrir a las 3 AM que faltan 200 metricas por
//      un `location_code` en null.

import { parsearLocationCode } from '@aoki-one/domain'
import type { EstadoOrden, EstadoSlot, Result, TipoOrden } from '@aoki-one/domain'
import { z } from 'zod'

import type { BaseDelAgente } from '../persistence/database.js'
import { crearRepositorios } from '../persistence/index.js'
import type { Orden, OrigenDeOrden } from '../persistence/orderRepository.js'
import { describirErrorDeOrigen } from './origenLegacy.js'
import type { ErrorDeOrigen, OrigenLegacy } from './origenLegacy.js'

export interface OpcionesDeMigracion {
  /**
   * La sucursal a la que pertenece todo lo que se importa.
   *
   * El modelo viejo no tiene sucursales: es un robot y nada mas. Este es el
   * "valor por defecto" con el que la spec dice que se conserva el historico.
   */
  readonly siteId: string
  /** `true` = no se escribe nada y el reporte dice que se haria. */
  readonly simulacion: boolean
}

export type MotivoDeOmision =
  | { readonly codigo: 'FILA_ILEGIBLE'; readonly detalle: string }
  | { readonly codigo: 'LOCATION_CODE_INVALIDO'; readonly valor: string }
  /** Un RESERVADO / BUSCANDO / DEVOLVIENDO sin la orden que lo reserva. */
  | { readonly codigo: 'SIN_ORDEN_QUE_RESERVA'; readonly estado: string }
  /** Un OCUPADO sin cajon: el estado nuevo exige el contenido, no lo admite nulo. */
  | { readonly codigo: 'OCUPADO_SIN_CAJON' }
  /** El destino ya no esta como lo dejo la migracion anterior: no se pisa. */
  | { readonly codigo: 'DESTINO_YA_MODIFICADO'; readonly estadoActual: string }
  | { readonly codigo: 'EXTERNAL_ORDER_ID_DUPLICADO'; readonly externalOrderId: string }

export interface Omitido {
  /** Con que identificar la fila en la base origen: locationCode, id de orden. */
  readonly referencia: string
  readonly motivo: MotivoDeOmision
}

export interface ResumenDeEntidad {
  /** Filas escritas (o que se escribirian, en simulacion). */
  readonly migrados: number
  /** Filas que ya estaban migradas y se dejaron como estaban. */
  readonly yaMigrados: number
  readonly omitidos: readonly Omitido[]
}

export interface ReporteDeMigracion {
  readonly simulacion: boolean
  readonly siteId: string
  readonly robots: ResumenDeEntidad
  readonly slots: ResumenDeEntidad
  readonly ordenes: ResumenDeEntidad
  readonly metricas: ResumenDeEntidad
}

// --- Forma de la base vieja --------------------------------------------------
//
// Los esquemas se aplican POR FILA y no al documento entero: validar el snapshot
// completo de una haria que un solo slot corrupto tirara la migracion de los
// otros once.

const CAJON_LEGACY = z.object({
  id: z.string().nullish(),
  sourceLocationCode: z.string().nullish(),
})

const SLOT_LEGACY = z.object({
  locationCode: z.string(),
  robotId: z.string().nullish(),
  status: z.enum(['LIBRE', 'RESERVADO', 'BUSCANDO', 'OCUPADO', 'DEVOLVIENDO', 'ERROR']),
  reservedByOrderId: z.string().nullish(),
  currentBox: CAJON_LEGACY.nullish(),
  /** Refcount de devoluciones pendientes del legacy. Es el `pendingReturns` de RF07. */
  logicalPickStackDepth: z.number().nullish(),
  lastError: z.string().nullish(),
})

const ORDEN_LEGACY = z.object({
  id: z.string(),
  // El legacy lo guarda como entero; se normaliza a texto, que es como lo tipa
  // el modelo nuevo (y deja de estar restringido a numeros).
  externalOrderId: z.union([z.number(), z.string()]).nullish(),
  type: z.enum(['PICK', 'PUT']),
  origin: z.enum(['PICKING', 'MANUAL']).nullish(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'DONE', 'ERROR', 'CANCELED']),
  locationCode: z.string(),
  targetLocation: z.string().nullish(),
  slotLocationCode: z.string().nullish(),
  currentStepIndex: z.number().nullish(),
  robotId: z.string().nullish(),
  waitingForSlot: z.boolean().nullish(),
  errorReason: z.string().nullish(),
  createdAt: z.number(),
  startedProcessingAt: z.number().nullish(),
})

const SNAPSHOT_LEGACY = z.object({
  slots: z.array(z.unknown()).nullish(),
  orders: z.array(z.unknown()).nullish(),
})

const METRICA_LEGACY = z.object({
  order_id: z.string(),
  origin: z.enum(['PICKING', 'MANUAL']),
  type: z.enum(['PICK', 'PUT']),
  location_code: z.string(),
  waiting_ms: z.number(),
  duration_ms: z.number(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'DONE', 'ERROR', 'CANCELED']),
  created_at: z.number(),
  finished_at: z.number(),
})

type SlotLegacy = z.infer<typeof SLOT_LEGACY>
type OrdenLegacy = z.infer<typeof ORDEN_LEGACY>

/**
 * Ordenes que se traen: todo lo que no termino.
 *
 * `ERROR` entra porque en el modelo viejo es reintentable y el operario la ve en
 * la pantalla: dejarla afuera seria hacer desaparecer un pedido que la sucursal
 * todavia debe. `DONE` y `CANCELED` quedan afuera: su rastro util ya esta en las
 * metricas.
 */
const ESTADOS_ABIERTOS: readonly EstadoOrden[] = ['PENDING', 'IN_PROGRESS', 'ERROR']

// --- Acumuladores del reporte ------------------------------------------------

interface Acumulador {
  migrados: number
  yaMigrados: number
  readonly omitidos: Omitido[]
}

function nuevoAcumulador(): Acumulador {
  return { migrados: 0, yaMigrados: 0, omitidos: [] }
}

function congelar(acumulador: Acumulador): ResumenDeEntidad {
  return {
    migrados: acumulador.migrados,
    yaMigrados: acumulador.yaMigrados,
    omitidos: acumulador.omitidos,
  }
}

function detallarZod(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
    .join('; ')
}

// --- Traduccion del modelo viejo al nuevo ------------------------------------

/** Un slot ya traducido y listo para escribir. */
interface SlotPlaneado {
  readonly robotId: string
  readonly locationCode: string
  readonly estado: EstadoSlot
}

function aEstadoSlot(slot: SlotLegacy): Result<EstadoSlot, MotivoDeOmision> {
  const cajon = slot.currentBox ?? null
  const origen = cajon?.sourceLocationCode ?? null
  const contenido =
    cajon === null || origen === null
      ? null
      : {
          cajon: {
            // El id del cajon es sintetico en los dos modelos; lo que identifica
            // al cajon es de donde salio.
            id: cajon.id ?? `ORDER:${slot.reservedByOrderId ?? slot.locationCode}`,
            ubicacionDeOrigen: origen,
          },
          // El refcount arranca en 1 (una devolucion fisica pendiente), nunca en 0.
          pendingReturns:
            slot.logicalPickStackDepth !== null &&
            slot.logicalPickStackDepth !== undefined &&
            slot.logicalPickStackDepth > 0
              ? slot.logicalPickStackDepth
              : 1,
        }

  const ordenId = slot.reservedByOrderId ?? null

  switch (slot.status) {
    case 'LIBRE':
      return { ok: true, valor: { estado: 'LIBRE' } }

    case 'RESERVADO':
      if (ordenId === null) {
        return { ok: false, error: { codigo: 'SIN_ORDEN_QUE_RESERVA', estado: slot.status } }
      }
      return { ok: true, valor: { estado: 'RESERVADO', ordenId, contenido } }

    case 'BUSCANDO':
      if (ordenId === null) {
        return { ok: false, error: { codigo: 'SIN_ORDEN_QUE_RESERVA', estado: slot.status } }
      }
      return { ok: true, valor: { estado: 'BUSCANDO', ordenId } }

    case 'OCUPADO':
      if (contenido === null) {
        // El estado nuevo exige el cajon. Un OCUPADO sin cajon es una fila
        // inconsistente del legacy y hay que mirarla a mano: inventar un cajon
        // aca seria decidir que hay apoyado algo que quiza no esta.
        return { ok: false, error: { codigo: 'OCUPADO_SIN_CAJON' } }
      }
      return { ok: true, valor: { estado: 'OCUPADO', contenido } }

    case 'DEVOLVIENDO':
      if (ordenId === null) {
        return { ok: false, error: { codigo: 'SIN_ORDEN_QUE_RESERVA', estado: slot.status } }
      }
      return { ok: true, valor: { estado: 'DEVOLVIENDO', ordenId, contenido } }

    case 'ERROR':
      return {
        ok: true,
        valor: { estado: 'ERROR', motivo: slot.lastError ?? 'migrado desde la base anterior' },
      }
  }
}

function aOrden(orden: OrdenLegacy, robotId: string, siteId: string, baseCode: string): Orden {
  const externo = orden.externalOrderId
  const origen: OrigenDeOrden = orden.origin ?? 'PICKING'

  return {
    id: orden.id,
    siteId,
    robotId,
    externalOrderId: externo === null || externo === undefined ? null : String(externo),
    tipo: orden.type satisfies TipoOrden,
    origen,
    estado: orden.status,
    locationCode: baseCode,
    targetLocation: orden.targetLocation ?? null,
    slotLocationCode: orden.slotLocationCode ?? null,
    currentStepIndex: orden.currentStepIndex ?? 0,
    waitingForSlot: orden.waitingForSlot ?? false,
    errorReason: orden.errorReason ?? null,
    creadaEn: orden.createdAt,
    iniciadaEn: orden.startedProcessingAt ?? null,
    // Una orden abierta no tiene fin. Las terminadas no se migran.
    finalizadaEn: null,
  }
}

/**
 * Compara dos estados de slot.
 *
 * Alcanza con serializar: `EstadoSlot` es una union de datos planos y los dos
 * lados de la comparacion los produce esta misma funcion de traduccion, asi que
 * el orden de las claves coincide.
 */
function mismoEstado(uno: EstadoSlot, otro: EstadoSlot): boolean {
  return JSON.stringify(uno) === JSON.stringify(otro)
}

// --- Migracion ---------------------------------------------------------------

export async function migrar(
  origen: OrigenLegacy,
  destino: BaseDelAgente,
  opciones: OpcionesDeMigracion,
): Promise<Result<ReporteDeMigracion, ErrorDeOrigen>> {
  const { siteId, simulacion } = opciones
  const repositorios = crearRepositorios(destino)

  const robots = nuevoAcumulador()
  const slots = nuevoAcumulador()
  const ordenes = nuevoAcumulador()
  const metricas = nuevoAcumulador()

  // 1. Snapshot: slots y ordenes viven adentro del mismo JSON.
  const crudo = origen.leerSnapshot()
  if (!crudo.ok) {
    return crudo
  }

  const planSlots: SlotPlaneado[] = []
  const planOrdenes: Orden[] = []
  /** robotId -> estanteria, derivada de las ubicaciones que se vieron. */
  const estanterias = new Map<string, string>()

  if (crudo.valor !== null) {
    let documento: unknown = null
    try {
      documento = JSON.parse(crudo.valor)
    } catch (error) {
      // El snapshot entero ilegible no es una fila corrupta: no hay nada que
      // migrar de ahi y hay que decirlo, no seguir en silencio.
      slots.omitidos.push({
        referencia: 'snapshots.payload_json',
        motivo: {
          codigo: 'FILA_ILEGIBLE',
          detalle: error instanceof Error ? error.message : String(error),
        },
      })
    }

    const snapshot = SNAPSHOT_LEGACY.safeParse(documento)
    if (snapshot.success) {
      for (const fila of snapshot.data.slots ?? []) {
        const slot = SLOT_LEGACY.safeParse(fila)
        if (!slot.success) {
          slots.omitidos.push({
            referencia: 'slot sin locationCode legible',
            motivo: { codigo: 'FILA_ILEGIBLE', detalle: detallarZod(slot.error) },
          })
          continue
        }

        const ubicacion = parsearLocationCode(slot.data.locationCode)
        if (!ubicacion.ok) {
          slots.omitidos.push({
            referencia: slot.data.locationCode,
            motivo: { codigo: 'LOCATION_CODE_INVALIDO', valor: slot.data.locationCode },
          })
          continue
        }

        const estado = aEstadoSlot(slot.data)
        if (!estado.ok) {
          slots.omitidos.push({ referencia: ubicacion.valor.baseCode, motivo: estado.error })
          continue
        }

        // El legacy usa la estanteria como robotId mientras no haya mapeo
        // explicito, y el snapshot ya trae el valor resuelto: se respeta si esta.
        const robotId = slot.data.robotId ?? ubicacion.valor.estanteria
        estanterias.set(robotId, ubicacion.valor.estanteria)
        planSlots.push({ robotId, locationCode: ubicacion.valor.baseCode, estado: estado.valor })
      }

      for (const fila of snapshot.data.orders ?? []) {
        const orden = ORDEN_LEGACY.safeParse(fila)
        if (!orden.success) {
          ordenes.omitidos.push({
            referencia: 'orden sin id legible',
            motivo: { codigo: 'FILA_ILEGIBLE', detalle: detallarZod(orden.error) },
          })
          continue
        }

        if (!ESTADOS_ABIERTOS.includes(orden.data.status)) {
          continue
        }

        const ubicacion = parsearLocationCode(orden.data.locationCode)
        if (!ubicacion.ok) {
          ordenes.omitidos.push({
            referencia: orden.data.id,
            motivo: { codigo: 'LOCATION_CODE_INVALIDO', valor: orden.data.locationCode },
          })
          continue
        }

        const robotId = orden.data.robotId ?? ubicacion.valor.estanteria
        estanterias.set(robotId, estanterias.get(robotId) ?? ubicacion.valor.estanteria)
        planOrdenes.push(aOrden(orden.data, robotId, siteId, ubicacion.valor.baseCode))
      }
    } else if (documento !== null) {
      slots.omitidos.push({
        referencia: 'snapshots.payload_json',
        motivo: { codigo: 'FILA_ILEGIBLE', detalle: detallarZod(snapshot.error) },
      })
    }
  }

  // 2. Robots. Van primero porque slots y ordenes cuelgan de ellos, y sin la
  // fila del robot el agente no tiene de donde sacar la cola de esa estanteria.
  for (const [robotId, estanteriaCode] of estanterias) {
    const existente = await repositorios.robots.buscarPorId(robotId)
    if (existente !== undefined) {
      robots.yaMigrados += 1
      continue
    }
    if (!simulacion) {
      await repositorios.robots.guardar({
        id: robotId,
        siteId,
        estanteriaCode,
        habilitado: true,
        // Nace IDLE y sin orden activa: lo que estaba en vuelo lo vuelve a
        // encolar la rehidratacion del agente al arrancar (RF15).
        estado: 'IDLE',
        ordenActivaId: null,
      })
    }
    robots.migrados += 1
  }

  // 3. Slots.
  for (const plan of planSlots) {
    const existente = await repositorios.slots.buscar(plan.robotId, plan.locationCode)

    if (existente !== undefined && mismoEstado(existente.estado, plan.estado)) {
      slots.yaMigrados += 1
      continue
    }

    if (existente !== undefined && existente.estado.estado !== 'LIBRE') {
      // El agente nuevo ya movio este slot. Pisarlo con el snapshot viejo seria
      // borrar trabajo real; se reporta para mirarlo a mano.
      slots.omitidos.push({
        referencia: `${plan.robotId}/${plan.locationCode}`,
        motivo: { codigo: 'DESTINO_YA_MODIFICADO', estadoActual: existente.estado.estado },
      })
      continue
    }

    if (!simulacion) {
      // Sembrar primero: `guardarEstado` no crea el slot al vuelo, porque un slot
      // que no esta en la zona de pickeo no existe.
      await repositorios.slots.sembrarZonaDePickeo(plan.robotId, [plan.locationCode])
      await repositorios.slots.guardarEstado(plan.robotId, plan.locationCode, plan.estado)
    }
    slots.migrados += 1
  }

  // 4. Ordenes abiertas.
  for (const orden of planOrdenes) {
    const existente = await repositorios.ordenes.buscarPorId(orden.id)
    if (existente !== undefined) {
      ordenes.yaMigrados += 1
      continue
    }

    if (simulacion) {
      ordenes.migrados += 1
      continue
    }

    const creada = await repositorios.ordenes.crear(orden)
    if (!creada.ok) {
      ordenes.omitidos.push({
        referencia: orden.id,
        motivo: {
          codigo: 'EXTERNAL_ORDER_ID_DUPLICADO',
          externalOrderId: orden.externalOrderId ?? '',
        },
      })
      continue
    }
    ordenes.migrados += 1
  }

  // 5. Metricas. Se escriben con SQL propio y no con `metricsRepository`: el
  // repositorio RECALCULA espera y duracion, y aca no hay de donde sacar el
  // `startedAt` que esa cuenta necesita. Los milisegundos del legacy son los
  // numeros que el negocio ya vio; recalcularlos seria reescribir el historico.
  const crudas = origen.leerMetricas()
  if (!crudas.ok) {
    return crudas
  }

  const yaEsta = destino.sql.prepare('SELECT 1 FROM order_metrics WHERE orden_id = ?')
  const insertar = destino.sql.prepare(
    `INSERT INTO order_metrics (
       orden_id, site_id, origen, tipo, location_code,
       waiting_ms, duration_ms, estado, creada_en, finalizada_en
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(orden_id) DO NOTHING`,
  )

  for (const fila of crudas.valor) {
    const metrica = METRICA_LEGACY.safeParse(fila)
    if (!metrica.success) {
      const id = (fila as { readonly order_id?: unknown }).order_id
      metricas.omitidos.push({
        referencia: typeof id === 'string' ? id : 'metrica sin order_id legible',
        motivo: { codigo: 'FILA_ILEGIBLE', detalle: detallarZod(metrica.error) },
      })
      continue
    }

    if (yaEsta.get(metrica.data.order_id) !== undefined) {
      metricas.yaMigrados += 1
      continue
    }

    if (!simulacion) {
      insertar.run(
        metrica.data.order_id,
        siteId,
        metrica.data.origin,
        metrica.data.type,
        metrica.data.location_code,
        metrica.data.waiting_ms,
        metrica.data.duration_ms,
        metrica.data.status,
        metrica.data.created_at,
        metrica.data.finished_at,
      )
    }
    metricas.migrados += 1
  }

  return {
    ok: true,
    valor: {
      simulacion,
      siteId,
      robots: congelar(robots),
      slots: congelar(slots),
      ordenes: congelar(ordenes),
      metricas: congelar(metricas),
    },
  }
}

/** Reporte en texto, que es lo que mira quien corre el cutover. */
export function describirReporte(reporte: ReporteDeMigracion): string {
  const lineas: string[] = [
    reporte.simulacion
      ? `SIMULACION (no se escribio nada) - sucursal ${reporte.siteId}`
      : `MIGRACION - sucursal ${reporte.siteId}`,
  ]

  const entidades: readonly (readonly [string, ResumenDeEntidad])[] = [
    ['robots', reporte.robots],
    ['slots', reporte.slots],
    ['ordenes abiertas', reporte.ordenes],
    ['metricas', reporte.metricas],
  ]

  for (const [nombre, resumen] of entidades) {
    lineas.push(
      `  ${nombre}: ${String(resumen.migrados)} migrados, ` +
        `${String(resumen.yaMigrados)} ya estaban, ${String(resumen.omitidos.length)} sin migrar`,
    )
    for (const omitido of resumen.omitidos) {
      lineas.push(`    - ${omitido.referencia}: ${describirMotivo(omitido.motivo)}`)
    }
  }

  return lineas.join('\n')
}

export function describirMotivo(motivo: MotivoDeOmision): string {
  switch (motivo.codigo) {
    case 'FILA_ILEGIBLE':
      return `la fila no tiene la forma esperada (${motivo.detalle})`
    case 'LOCATION_CODE_INVALIDO':
      return `"${motivo.valor}" no cumple la gramatica de ubicacion`
    case 'SIN_ORDEN_QUE_RESERVA':
      return `esta en ${motivo.estado} pero no dice que orden lo reserva`
    case 'OCUPADO_SIN_CAJON':
      return 'esta OCUPADO pero no dice que cajon tiene apoyado'
    case 'DESTINO_YA_MODIFICADO':
      return `el agente nuevo ya lo dejo en ${motivo.estadoActual}: no se pisa`
    case 'EXTERNAL_ORDER_ID_DUPLICADO':
      return `ya hay otra orden con externalOrderId ${motivo.externalOrderId}`
  }
}

export { describirErrorDeOrigen }
