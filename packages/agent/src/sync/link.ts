// RF33 a RF37 — El enlace del agente con el servidor de pedidos.
//
// Un ciclo del enlace hace tres cosas y en este orden, que no es casual (RF15):
//
//   1. DRENA el outbox. Lo primero al recuperar el enlace es contar lo que ya
//      paso; si se pidiera trabajo nuevo antes, el servidor seguiria creyendo en
//      vuelo ordenes que la sucursal ya termino.
//   2. RECLAMA trabajo y lo ESPEJA en SQLite antes de ejecutarlo (RF33).
//   3. LATE, para que el servidor sepa que la sucursal esta viva (RF31).
//
// Un fallo del drenado NO corta el ciclo. Cortarlo hacia que una sola fila que el
// servidor rechaza —un 400 por payload— dejara a la sucursal sin reclamar y sin
// latir: para el servidor la sucursal estaba muerta y dejaba de recibir pedidos,
// por una transicion mal formada. El orden se respeta igual; lo que cambia es que
// el ciclo sigue.
//
// La ejecucion de una orden no pasa por aca en ningun momento: el orquestador
// lee del espejo local. Esa es la razon por la que el agente existe como proceso
// aparte, y por la que una caida de enlace no para el robot.
//
// El enlace se puede APAGAR entero, y apagado es el default (composicion). En el
// cutover el agente corre primero sin servidor, solo con su cola local.

import type { EstadoOrden } from '@aoki-one/domain'

import { admitirOrden } from '../orchestrator/orderIntake.js'
import type { DependenciasDelOrquestador } from '../orchestrator/ports.js'
import { calcularEsperaDeBackoff, type Azar, type PoliticaDeBackoff } from './backoff.js'
import type { OrdenEntrante, OrderSource } from './orderSource.js'
import type { OutboxDeTransiciones, TransicionPendiente } from './outbox.js'
import type { ClienteDelServidor, FalloDeEnlace } from './serverClient.js'

/**
 * Lo que publica `/health` (RF36).
 *
 * Los nombres van en ingles porque es contrato de API que ya consume el front.
 * `DISABLED` lo responde la API cuando no hay enlace configurado; un enlace vivo
 * solo puede estar `CONNECTED` o `DEGRADED`. No hay cuarto estado: o esta
 * sincronizado o lo dice.
 */
export interface ReporteDeEnlace {
  readonly status: 'DISABLED' | 'CONNECTED' | 'DEGRADED'
  /** Ultimo contacto exitoso con el servidor, en epoch ms. */
  readonly lastContactAt: number | null
  readonly outboxSize: number
}

export const ENLACE_APAGADO: ReporteDeEnlace = {
  status: 'DISABLED',
  lastContactAt: null,
  outboxSize: 0,
}

export interface OpcionesDeEnlace {
  /** Cuantas ordenes se piden por long-poll. */
  readonly limiteDeReclamo: number
  /** Cuantas transiciones se drenan por vuelta antes de releer la cola. */
  readonly loteDeOutbox: number
  readonly intervaloDeLatidoMs: number
  /**
   * Piso de tiempo entre ciclos buenos.
   *
   * El long-poll deberia retener la conexion del lado del servidor, pero eso es
   * configuracion del OTRO proceso: si el servidor contesta al instante, el
   * ciclo vuelve a salir enseguida y la sucursal se convierte en un generador de
   * trafico. Una proteccion que depende de como este configurado el otro extremo
   * no es una proteccion.
   */
  readonly esperaMinimaEntreCiclosMs: number
  /**
   * Intentos de una misma transicion antes de mandarla a la cola muerta.
   *
   * Solo cuenta para el fallo ATRIBUIBLE A LA FILA (ver `esRechazoDeLaFila`): un
   * enlace caido o una credencial vencida los sufren todas las filas por igual, y
   * vaciar la cola por eso seria perder cada cambio de estado de la sucursal.
   */
  readonly maxIntentosDeTransicion: number
  readonly backoff: PoliticaDeBackoff
}

export const OPCIONES_DE_ENLACE_POR_DEFECTO: Omit<OpcionesDeEnlace, 'backoff'> = {
  limiteDeReclamo: 10,
  loteDeOutbox: 50,
  intervaloDeLatidoMs: 15_000,
  esperaMinimaEntreCiclosMs: 250,
  maxIntentosDeTransicion: 10,
}

export interface DependenciasDelEnlace {
  readonly origen: OrderSource
  readonly cliente: ClienteDelServidor
  readonly outbox: OutboxDeTransiciones
  readonly orquestador: DependenciasDelOrquestador
  readonly azar: Azar
  readonly opciones: OpcionesDeEnlace
  /**
   * Despierta el loop del robot. Sin esto una orden espejada esperaria al tick
   * de seguridad, que a proposito es de baja frecuencia (RNF, sin busy-loops).
   */
  readonly despertar: () => void
}

export type ResultadoDeCiclo =
  | {
      readonly tipo: 'SINCRONIZADO'
      readonly reportadas: number
      readonly admitidas: number
      readonly rechazadas: number
    }
  | { readonly tipo: 'DEGRADADO'; readonly fallo: FalloDeEnlace }

export interface Enlace {
  /** Arranca el bucle de sincronizacion. Idempotente. */
  readonly iniciar: () => void
  readonly detener: () => Promise<void>
  readonly estado: () => Promise<ReporteDeEnlace>
  /**
   * Un ciclo completo, sin bucle ni timers.
   *
   * Se expone para poder ejercitar el enlace entero de forma deterministica: el
   * bucle solo agrega backoff sobre esto. NUNCA tira: todo fallo sale por el
   * `Result` del ciclo.
   */
  readonly sincronizar: () => Promise<ResultadoDeCiclo>
}

/** Una orden en estado terminal ya no vuelve a cambiar: su reporte es el ultimo. */
const ESTADOS_TERMINALES: readonly EstadoOrden[] = ['DONE', 'ERROR', 'CANCELED']

/**
 * Codigos HTTP que NO matan la fila aunque se repitan.
 *
 * El 404 puede ser la ruta y no el pedido: una base de URL con un prefijo de mas
 * o un proxy que contesta por su cuenta 404ean TODO, y ahi tirar filas seria
 * vaciar el outbox contra un servidor que nunca recibio nada (RF34). 408 y 429
 * son, literalmente, "volve a intentar".
 */
const HTTP_QUE_NO_MATA_LA_FILA: readonly number[] = [404, 408, 429]

export function crearEnlace(dependencias: DependenciasDelEnlace): Enlace {
  const { origen, cliente, outbox, orquestador, azar, opciones, despertar } = dependencias
  const { reloj, repositorios, siteId } = orquestador

  let ultimoContactoMs: number | null = null
  let ultimoLatidoMs: number | null = null
  /** `null` = todavia no cerro ningun ciclo. Ver `estado()`. */
  let ultimoCicloFallo: boolean | null = null
  let corriendo = false
  let fallosConsecutivos = 0
  let cortarEspera: (() => void) | null = null
  let bucleTerminado: Promise<void> = Promise.resolve()
  /**
   * Corta las requests en vuelo cuando el enlace se detiene.
   *
   * Sin esto `detener()` espera a que la request termine sola, y contra un
   * servidor que acepta la conexion y no contesta eso es "nunca": se cuelga el
   * apagado del agente entero, porque la composicion espera al enlace primero.
   */
  let apagado = new AbortController()

  function registrarContacto(): void {
    ultimoContactoMs = reloj.ahoraMs()
  }

  /**
   * Resuelve el id con el que el SERVIDOR conoce la orden.
   *
   * Para una orden de picking el vinculo se guardo al espejarla. Para una orden
   * local (RF35) no hay vinculo hasta que se la empuja, y este es el momento en
   * que se la empuja: al reconectar, empujada por su propia transicion. Asi no
   * hace falta escanear el historico de ordenes buscando cuales faltan subir.
   */
  async function resolverOrdenRemota(
    ordenId: string,
  ): Promise<
    | { readonly tipo: 'RESUELTA'; readonly ordenIdRemoto: string }
    /** No existe en el libro del servidor y no puede existir: la transicion se tira. */
    | { readonly tipo: 'SIN_CONTRAPARTE'; readonly motivo: string }
    | { readonly tipo: 'FALLO'; readonly fallo: FalloDeEnlace }
  > {
    const vinculo = await outbox.buscarVinculo(ordenId)
    if (vinculo !== null) {
      return { tipo: 'RESUELTA', ordenIdRemoto: vinculo }
    }

    const orden = await repositorios.ordenes.buscarPorId(ordenId)
    if (orden === undefined) {
      return { tipo: 'SIN_CONTRAPARTE', motivo: 'la orden local ya no existe' }
    }
    if (orden.externalOrderId === null) {
      // Sin id externo no hay clave de dedupe: el servidor no puede recibirla.
      return { tipo: 'SIN_CONTRAPARTE', motivo: 'la orden no tiene externalOrderId' }
    }

    const empujada = await cliente.empujarOrden(
      {
        externalOrderId: orden.externalOrderId,
        tipo: orden.tipo,
        locationCode: orden.locationCode,
      },
      apagado.signal,
    )
    if (!empujada.ok) {
      return { tipo: 'FALLO', fallo: empujada.error }
    }

    registrarContacto()
    await outbox.vincular(ordenId, empujada.valor.id)
    return { tipo: 'RESUELTA', ordenIdRemoto: empujada.valor.id }
  }

  /**
   * Anota el intento fallido y decide si esa fila ya no tiene arreglo.
   *
   * El tope de intentos solo se aplica al rechazo que apunta a ESTA fila. Un
   * enlace caido o una credencial vencida los sufren todas las filas por igual:
   * ahi la cola se bloquea, pero bloquearse es preferible a tirar cada cambio de
   * estado de la sucursal, y `/health` ya lo dice con DEGRADED y el outboxSize.
   */
  async function anotarFalloDeReporte(
    transicion: TransicionPendiente,
    fallo: FalloDeEnlace,
  ): Promise<{ readonly ok: false; readonly fallo: FalloDeEnlace }> {
    await outbox.registrarIntentoFallido(transicion.id, fallo.tipo)
    const intentos = transicion.intentos + 1
    if (intentos >= opciones.maxIntentosDeTransicion && esRechazoDeLaFila(fallo)) {
      await outbox.darPorMuerta(transicion.id, fallo.tipo, reloj.ahoraMs())
      await avisarDeTransicionMuerta(transicion, fallo, intentos)
    }
    return { ok: false, fallo }
  }

  /** Sin esta traza, una transicion archivada se pierde en silencio. */
  async function avisarDeTransicionMuerta(
    transicion: TransicionPendiente,
    fallo: FalloDeEnlace,
    intentos: number,
  ): Promise<void> {
    await repositorios.eventos.registrar({
      id: orquestador.generarId(),
      ts: reloj.ahoraMs(),
      tipoDeEntidad: 'ORDER',
      entidadId: transicion.ordenId,
      evento: 'OUTBOX_DEAD_LETTER',
      severidad: 'ERROR',
      metadata: {
        seq: transicion.seq,
        estado: transicion.estado,
        motivo: fallo.tipo,
        intentos,
      },
    })
  }

  /**
   * Deja la traza del unico descarte que decide el agente por su cuenta.
   *
   * Todo lo demas que sale de la cola sale porque el servidor lo acepto o lo
   * descarto: esto no. Es un cambio de estado de la sucursal que el libro del
   * servidor no va a ver nunca, y sin registro nadie puede reconstruir cual fue
   * ni por que se tiro.
   */
  async function avisarDeTransicionSinContraparte(
    transicion: TransicionPendiente,
    motivo: string,
  ): Promise<void> {
    await repositorios.eventos.registrar({
      id: orquestador.generarId(),
      ts: reloj.ahoraMs(),
      tipoDeEntidad: 'ORDER',
      entidadId: transicion.ordenId,
      evento: 'OUTBOX_DROPPED_NO_COUNTERPART',
      severidad: 'ERROR',
      metadata: {
        seq: transicion.seq,
        estado: transicion.estado,
        motivo,
      },
    })
  }

  /** Reporta una transicion. `true` = sale de la cola. */
  async function reportar(
    transicion: TransicionPendiente,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly fallo: FalloDeEnlace }> {
    const remota = await resolverOrdenRemota(transicion.ordenId)
    if (remota.tipo === 'FALLO') {
      return anotarFalloDeReporte(transicion, remota.fallo)
    }
    if (remota.tipo === 'SIN_CONTRAPARTE') {
      // Reintentar no converge nunca: la fila se saca para no bloquear a las que
      // vienen atras, que es el riesgo real de una cola que se drena en orden.
      // La traza se deja ANTES de sacarla: si el proceso muere en el medio, el
      // proximo drenado vuelve a resolver SIN_CONTRAPARTE y repite el evento, y
      // un evento repetido es preferible a una transicion que desaparece sin
      // rastro.
      await avisarDeTransicionSinContraparte(transicion, remota.motivo)
      await outbox.confirmar(transicion.id)
      return { ok: true }
    }

    const reporte = await cliente.reportarTransicion(
      {
        ordenIdRemoto: remota.ordenIdRemoto,
        seq: transicion.seq,
        estado: transicion.estado,
        metadata: transicion.metadata,
      },
      apagado.signal,
    )
    if (!reporte.ok) {
      return anotarFalloDeReporte(transicion, reporte.error)
    }

    registrarContacto()
    // APLICADA, DESCARTADA y ORDEN_INEXISTENTE terminan igual: la transicion sale
    // de la cola. Una DESCARTADA ya esta aplicada del otro lado; tratarla como
    // error dejaria al outbox reintentandola para siempre.
    await outbox.confirmar(transicion.id)
    return { ok: true }
  }

  /**
   * Vacia la cola en ORDEN estricto de encolado.
   *
   * Se corta en el primer fallo de transporte a proposito: saltearse una
   * transicion para seguir con la siguiente le haria llegar al servidor una seq
   * mayor, y despues descartaria la que quedo atras por SEQ_VIEJA. Ahi si se
   * perderia un cambio de estado, que es exactamente lo que RF34 prohibe.
   */
  async function drenarOutbox(): Promise<
    | { readonly ok: true; readonly reportadas: number }
    | { readonly ok: false; readonly fallo: FalloDeEnlace }
  > {
    let reportadas = 0
    for (;;) {
      const lote = await outbox.reservarProximas(opciones.loteDeOutbox)
      if (lote.length === 0) {
        return { ok: true, reportadas }
      }
      for (const [indice, transicion] of lote.entries()) {
        const resultado = await reportar(transicion)
        if (!resultado.ok) {
          // Lo que quedo reservado y no se intento vuelve a la cola: si no, el
          // proximo drenado lo saltearia y el servidor recibiria seqs invertidas.
          await outbox.soltar(lote.slice(indice + 1).map((pendiente) => pendiente.id))
          return { ok: false, fallo: resultado.fallo }
        }
        reportadas += 1
      }
    }
  }

  /**
   * Deja en la sucursal el rastro de un pedido que no pudo admitir.
   *
   * No hay orden local a la que colgarlo, asi que el evento se asocia al id
   * REMOTO: es el unico identificador que existe de los dos lados y con el que
   * despues se puede cruzar el pedido muerto del servidor con lo que paso aca.
   */
  async function avisarDeOrdenRechazada(entrante: OrdenEntrante, motivo: string): Promise<void> {
    await repositorios.eventos.registrar({
      id: orquestador.generarId(),
      ts: reloj.ahoraMs(),
      tipoDeEntidad: 'ORDER',
      entidadId: entrante.ordenIdRemoto,
      evento: 'ORDER_REJECTED_BY_SITE',
      severidad: 'ERROR',
      metadata: {
        motivo,
        externalOrderId: entrante.externalOrderId,
        locationCode: entrante.locationCode,
        siteId,
      },
    })
  }

  /**
   * Espeja en SQLite lo que entrego el servidor, ANTES de ejecutar nada (RF33).
   *
   * Una re-entrega por lease vencido llega con el MISMO `externalOrderId`, asi
   * que el dedupe local de `admitirOrden` (RF14) la devuelve como YA_EXISTIA. Pero
   * "ya existia" no alcanza para ignorarla: si la orden ya TERMINO en la sucursal
   * y su reporte se perdio —el proceso se murio entre las dos escrituras, o el
   * encolado fallo— el servidor la re-entrega para siempre, ocupa cupo del reclamo
   * y queda PENDING eternamente en la app de picking. Por eso se RECONCILIA: se
   * vuelve a encolar la transicion terminal que el servidor nunca vio.
   */
  async function espejar(
    entrante: OrdenEntrante,
  ): Promise<'CREADA' | 'YA_EXISTIA' | 'RECONCILIADA' | 'RECHAZADA'> {
    const admision = await admitirOrden(orquestador, {
      robotId: null,
      externalOrderId: entrante.externalOrderId,
      tipo: entrante.tipo,
      origen: 'PICKING',
      locationCode: entrante.locationCode,
      targetLocation: null,
    })

    if (!admision.ok) {
      // La sucursal no puede ejecutarla (ubicacion de otra estanteria, robot sin
      // dar de alta). Se reporta ERROR usando el id REMOTO como clave del outbox:
      // no hay orden local a la que colgar la transicion, y sin reporte el
      // servidor la re-entregaria en cada vencimiento de lease, para siempre.
      await outbox.vincular(entrante.ordenIdRemoto, entrante.ordenIdRemoto)
      if (!(await outbox.tienePendientes(entrante.ordenIdRemoto))) {
        await outbox.encolar({
          ordenId: entrante.ordenIdRemoto,
          estado: 'ERROR',
          metadata: { motivo: admision.error.codigo, siteId },
          creadaEn: reloj.ahoraMs(),
        })
        // La traza local va junto con el reporte y bajo la misma guarda: del lado
        // del servidor ese ERROR es terminal, asi que sin este evento el pedido
        // queda muerto y en la sucursal no existe ningun rastro de que llego. El
        // operario de la tablet no tiene otra forma de enterarse.
        await avisarDeOrdenRechazada(entrante, admision.error.codigo)
      }
      return 'RECHAZADA'
    }

    // El vinculo se guarda tambien cuando YA_EXISTIA: si el agente se reinicio
    // entre el reclamo y el reporte, el espejo esta pero el vinculo no, y sin el
    // las transiciones de esa orden no sabrian a que id remoto ir.
    const orden = admision.valor.orden
    await outbox.vincular(orden.id, entrante.ordenIdRemoto)
    if (admision.valor.tipo === 'CREADA') {
      return 'CREADA'
    }

    if (!ESTADOS_TERMINALES.includes(orden.estado)) {
      // Sigue en curso: el reporte va a salir solo cuando termine.
      return 'YA_EXISTIA'
    }
    if (await outbox.tienePendientes(orden.id)) {
      // El reporte existe y todavia no salio: encolar otro seria duplicarlo.
      return 'YA_EXISTIA'
    }

    await outbox.encolar({
      ordenId: orden.id,
      estado: orden.estado,
      metadata: { motivo: 'RECONCILIACION', errorReason: orden.errorReason },
      creadaEn: reloj.ahoraMs(),
    })
    return 'RECONCILIADA'
  }

  async function latir(): Promise<
    { readonly ok: true } | { readonly ok: false; readonly fallo: FalloDeEnlace }
  > {
    const ahora = reloj.ahoraMs()
    const latido = await cliente.latir({ outboxSize: await outbox.pendientes() }, apagado.signal)
    if (!latido.ok) {
      return { ok: false, fallo: latido.error }
    }
    ultimoLatidoMs = ahora
    registrarContacto()
    return { ok: true }
  }

  async function latirSiCorresponde(): Promise<
    { readonly ok: true } | { readonly ok: false; readonly fallo: FalloDeEnlace }
  > {
    const ahora = reloj.ahoraMs()
    if (ultimoLatidoMs !== null && ahora - ultimoLatidoMs < opciones.intervaloDeLatidoMs) {
      return { ok: true }
    }
    return latir()
  }

  async function cicloDeSincronizacion(): Promise<ResultadoDeCiclo> {
    /** El primer fallo del ciclo es el que se reporta: es la causa raiz. */
    let fallo: FalloDeEnlace | null = null

    const drenado = await drenarOutbox()
    if (!drenado.ok) {
      fallo = drenado.fallo
    }

    if (ultimoContactoMs === null) {
      // Primer contacto: se late ANTES del long-poll. Si se dejara para el final,
      // `/health` diria DEGRADED durante todo el primer reclamo —25 s en
      // produccion contra un servidor sano— y un indicador que miente al arrancar
      // es un indicador al que despues nadie le cree.
      const primero = await latir()
      if (!primero.ok && fallo === null) {
        fallo = primero.fallo
      }
    }

    const reclamadas = await origen.reclamar(opciones.limiteDeReclamo, apagado.signal)
    let admitidas = 0
    let rechazadas = 0
    if (!reclamadas.ok) {
      fallo ??= reclamadas.error
    } else {
      registrarContacto()
      for (const entrante of reclamadas.valor) {
        const espejada = await espejar(entrante)
        if (espejada === 'CREADA') {
          admitidas += 1
        }
        if (espejada === 'RECHAZADA') {
          rechazadas += 1
        }
      }
      if (admitidas > 0) {
        despertar()
      }
    }

    const latido = await latirSiCorresponde()
    if (!latido.ok) {
      fallo ??= latido.fallo
    }

    ultimoCicloFallo = fallo !== null
    if (fallo !== null) {
      return { tipo: 'DEGRADADO', fallo }
    }
    return {
      tipo: 'SINCRONIZADO',
      reportadas: drenado.ok ? drenado.reportadas : 0,
      admitidas,
      rechazadas,
    }
  }

  async function sincronizar(): Promise<ResultadoDeCiclo> {
    try {
      return await cicloDeSincronizacion()
    } catch (error) {
      // Un throw que se escapa mata el bucle y, por rechazo sin manejar, el
      // proceso entero del agente, mientras `/health` sigue diciendo CONNECTED.
      // El canal de error de este modulo es Result: aca se cierra.
      ultimoCicloFallo = true
      return {
        tipo: 'DEGRADADO',
        fallo: {
          tipo: 'FALLO_INESPERADO',
          mensaje: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  /** Espera cortable: detener no puede quedarse colgado un backoff entero. */
  function esperar(ms: number): Promise<void> {
    if (!corriendo || ms <= 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      let resuelta = false
      const terminar = (): void => {
        if (resuelta) {
          return
        }
        resuelta = true
        cortarEspera = null
        resolve()
      }
      cortarEspera = terminar
      void reloj.dormir(ms).then(terminar)
    })
  }

  async function bucle(): Promise<void> {
    while (corriendo) {
      const comienzo = reloj.ahoraMs()
      const ciclo = await sincronizar()
      if (ciclo.tipo === 'DEGRADADO') {
        fallosConsecutivos += 1
        await esperar(calcularEsperaDeBackoff(opciones.backoff, fallosConsecutivos, azar))
        continue
      }
      fallosConsecutivos = 0
      // El enlace anda. El long-poll deberia retener la conexion del otro lado,
      // pero eso es configuracion del OTRO proceso: el piso de frecuencia es lo
      // que evita que un servidor que contesta al instante convierta a la
      // sucursal en un generador de trafico.
      await esperar(opciones.esperaMinimaEntreCiclosMs - (reloj.ahoraMs() - comienzo))
    }
  }

  return {
    sincronizar,

    iniciar: () => {
      if (corriendo) {
        return
      }
      corriendo = true
      if (apagado.signal.aborted) {
        // Un `detener()` previo dejo la señal disparada: reiniciar con esa señal
        // abortaria en el aire la primera request del enlace nuevo.
        apagado = new AbortController()
      }
      bucleTerminado = bucle().catch(() => {
        // El bucle no puede rechazar: un rechazo sin manejar se lleva puesto el
        // proceso del agente. Si igual pasa, el enlace queda detenido y `/health`
        // lo dice en vez de seguir informando CONNECTED.
        ultimoCicloFallo = true
        corriendo = false
      })
    },

    detener: async () => {
      corriendo = false
      apagado.abort()
      cortarEspera?.()
      await bucleTerminado
    },

    estado: async () => ({
      // Antes de que cierre el primer ciclo lo unico honesto es mirar si ya hubo
      // un contacto bueno: el primer latido lo resuelve en milisegundos.
      status: (ultimoCicloFallo ?? ultimoContactoMs === null) ? 'DEGRADED' : 'CONNECTED',
      lastContactAt: ultimoContactoMs,
      outboxSize: await outbox.pendientes(),
    }),
  }
}

/**
 * Si el rechazo apunta a ESTA fila y no al enlace entero.
 *
 * Es la unica condicion que justifica tirar una transicion: un 400 por payload
 * no se arregla reintentando y bloquea a todas las que vienen atras. Lo que
 * sufren todas las filas por igual —sin red, credencial rechazada, respuesta que
 * no es del contrato— no entra, porque ahi el tope de intentos vaciaria la cola
 * entera por un problema que se arregla de una sola vez.
 */
function esRechazoDeLaFila(fallo: FalloDeEnlace): boolean {
  return (
    fallo.tipo === 'ERROR_DEL_SERVIDOR' &&
    fallo.estadoHttp >= 400 &&
    fallo.estadoHttp < 500 &&
    !HTTP_QUE_NO_MATA_LA_FILA.includes(fallo.estadoHttp)
  )
}
