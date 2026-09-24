// RF08, RF09 y RF12 — Un ciclo del loop de un robot.
//
// La invariante de "una sola orden fisica por robot" vive aca y no en la cola: la
// cola entrega la siguiente igual, es el loop el que no la arranca si el robot
// ya tiene una activa.
//
// El ciclo se expone como funcion y no como timer para poder ejercitarlo sin
// relojes: el avance real es por evento y el tick queda solo como red de
// seguridad de baja frecuencia (RNF, sin busy-loops de 300 ms).

import {
  construirComandoCarro,
  construirComandoElevadorIrNivel,
  elegirProximaOrden,
  parsearLocationCode,
  resolverPick,
  resolverPut,
  transicionarOrden,
  transicionarSlot,
} from '@aoki-one/domain'
import type { ColaDeRobot, EstadoSlot, EventoSlot, Logger, PasoDeOrden } from '@aoki-one/domain'
import type { Orden } from '../persistence/index.js'
import type { FalloDeEjecucion } from '../transport/errorClassification.js'
import { loggerDeOrden } from '../sync/correlacion.js'
import { aplicarTransicionDeOrden } from '../sync/transitions.js'
import { armarColaDelRobot } from './colaDelRobot.js'
import { resolverSlotDeOrden } from './slotWait.js'
import { ejecutarPasoConReintentos } from './stepExecutor.js'
import type { EstadoOrden, Lado } from '@aoki-one/domain'

import type { DependenciasDelOrquestador } from './ports.js'

export type ResultadoDeCicloDeRobot =
  | { readonly tipo: 'ROBOT_NO_REGISTRADO'; readonly robotId: string }
  | { readonly tipo: 'SIN_TRABAJO' }
  /** Ya hay una orden en curso: no se arranca la siguiente. */
  | { readonly tipo: 'ROBOT_OCUPADO'; readonly ordenActivaId: string }
  /** Cola pausada desde la tablet (RF21): no se toman ordenes nuevas de este robot. */
  | { readonly tipo: 'COLA_PAUSADA'; readonly robotId: string }
  /** Sin slot disponible de ese lado: la orden espera sin perder su lugar y el robot se libera. */
  | { readonly tipo: 'ORDEN_EN_ESPERA_DE_SLOT'; readonly ordenId: string; readonly lado: Lado }
  /**
   * Hay ordenes pero ninguna puede avanzar: todas esperan slot (RF10).
   *
   * Se distingue de `SIN_TRABAJO` a proposito: la cola NO esta vacia y el robot
   * esta parado por la zona de pickeo, no por falta de pedidos. Es la diferencia
   * entre "no hay nada que hacer" y "hay trabajo trabado", que es justo lo que
   * hay que poder ver desde afuera cuando la planta se frena.
   */
  | { readonly tipo: 'COLA_EN_ESPERA_DE_SLOT'; readonly robotId: string; readonly ordenes: readonly string[] }
  | {
      readonly tipo: 'ORDEN_TERMINADA'
      readonly ordenId: string
      readonly estadoFinal: EstadoOrden
      /** False cuando termino por refcount de devoluciones, sin mover el robot (RF07). */
      readonly huboManiobra: boolean
    }

export async function ejecutarCicloDeRobot(
  dependencias: DependenciasDelOrquestador,
  robotId: string,
): Promise<ResultadoDeCicloDeRobot> {
  const { repositorios, siteId, reloj } = dependencias

  const robot = await repositorios.robots.buscarPorId(robotId)
  if (robot === undefined) {
    return { tipo: 'ROBOT_NO_REGISTRADO', robotId }
  }

  // Una sola orden fisica por robot. La cola entrega la siguiente igual: es el
  // loop el que no la arranca.
  if (robot.ordenActivaId !== null) {
    return { tipo: 'ROBOT_OCUPADO', ordenActivaId: robot.ordenActivaId }
  }

  // RF21: con la cola pausada el robot deja de TOMAR ordenes nuevas, y nada mas.
  // La que ya estaba en curso no pasa por aca —la ejecuta entera el ciclo que la
  // arranco, adentro de `ejecutarManiobra`— asi que pausar no la puede abortar ni
  // dejar el cajon a mitad de camino. Va despues del guard de orden activa para
  // que una pausa no disimule un robot ocupado.
  if (await repositorios.robots.colaPausada(robotId)) {
    return { tipo: 'COLA_PAUSADA', robotId }
  }

  const pendientes = await repositorios.ordenes.listar({
    siteId,
    robotId,
    estados: ['PENDING'],
  })
  // La eleccion mira el estado VIVO de la zona: es lo que hace que una orden que
  // no consigue slot se saltee (RF10) en vez de volver a salir elegida ciclo tras
  // ciclo y congelar el robot entero, y lo que dispara la inversion PICK/PUT de
  // RF09 cuando la zona de ese lado esta llena.
  const zona = await repositorios.slots.listarPorRobot(robotId)
  const { cola, conUbicacionInvalida } = armarColaDelRobot(pendientes, zona)
  await sincronizarEsperaDeSlot(dependencias, pendientes, cola)

  // Las que ni se pueden ubicar van primero: no mueven el robot, terminan en
  // ERROR en este mismo ciclo y asi no quedan escondidas detras de una cola que
  // tal vez nunca se vacia.
  const invalidaMasAntigua = [...conUbicacionInvalida].sort((a, b) => a.creadaEn - b.creadaEn)[0]
  const elegida = elegirProximaOrden(cola)
  const orden =
    invalidaMasAntigua ??
    (elegida === undefined
      ? undefined
      : pendientes.find((candidata) => candidata.id === elegida.ordenId))
  if (orden === undefined) {
    if (cola.ordenes.length === 0) {
      return { tipo: 'SIN_TRABAJO' }
    }
    // Hay cola y ninguna puede avanzar. El robot queda libre igual: no se toma
    // ninguna orden, asi que cualquier PUT que llegue —o un slot que se libere—
    // arranca en el ciclo siguiente.
    return {
      tipo: 'COLA_EN_ESPERA_DE_SLOT',
      robotId,
      ordenes: cola.ordenes.map((enCola) => enCola.ordenId),
    }
  }

  // La correlacion se fija UNA vez, al tomar la orden, y de ahi en mas viaja
  // sola: es lo que permite seguir este pedido hasta el comando que sale al PLC
  // y cruzarlo con el log del servidor por `ordenId` o por `externalOrderId`.
  const log = await loggerDeOrden(dependencias, orden)

  // RF07: un PICK sobre un cajon que YA esta apoyado no genera maniobra.
  if (orden.tipo === 'PICK') {
    const yaApoyado = await repositorios.slots.buscarPorCajonDeOrigen(robotId, orden.locationCode)
    if (yaApoyado !== undefined && yaApoyado.estado.estado === 'OCUPADO') {
      const resolucion = resolverPick(yaApoyado.estado.contenido)
      if (resolucion.ok && resolucion.valor.tipo === 'TERMINAR_SIN_MANIOBRA') {
        log.info('ORDER_DONE_WITHOUT_MOVE', { slotLocationCode: yaApoyado.locationCode })
        await repositorios.slots.guardarEstado(robotId, yaApoyado.locationCode, {
          estado: 'OCUPADO',
          contenido: {
            cajon: yaApoyado.estado.contenido.cajon,
            pendingReturns: resolucion.valor.pendingReturns,
          },
        })
        // RF34: el servidor tiene que ver DONE igual. Que no haya habido maniobra
        // es un detalle de la sucursal, no del pedido. Estado y reporte van en la
        // misma transaccion: separados, un corte en el medio deja la orden
        // terminada aca y PENDING para siempre en la app de picking.
        await aplicarTransicionDeOrden(
          dependencias,
          orden.id,
          {
            estado: 'DONE',
            slotLocationCode: yaApoyado.locationCode,
            waitingForSlot: false,
            finalizadaEn: reloj.ahoraMs(),
          },
          'DONE',
          { huboManiobra: false },
        )
        // Tambien cuenta: es un pedido atendido, aunque el robot no se haya movido.
        await registrarMetrica(dependencias, orden, 'DONE')
        return {
          tipo: 'ORDEN_TERMINADA',
          ordenId: orden.id,
          estadoFinal: 'DONE',
          huboManiobra: false,
        }
      }
    }
  }

  // RF07, segunda mitad: un PUT con mas de una devolucion pendiente decrementa
  // el contador y termina DONE SIN maniobra. Solo el ultimo PUT devuelve
  // fisicamente el cajon.
  //
  // Sin esto el primer PUT devuelve el cajon a su ubicacion de guardado y libera
  // el slot mientras un segundo pedido todavia lo esta esperando: ese pedido
  // queda sin atender y el operario va al slot a buscar un cajon que el robot ya
  // se llevo. Es lo que hace hoy el servidor de produccion
  // (`OrchestratorService.js:248-253`, `logicalReturnOnly`).
  //
  // Para un PUT el `locationCode` de la orden ES el slot del que sale el cajon.
  if (orden.tipo === 'PUT') {
    const slotDeDevolucion = await repositorios.slots.buscar(robotId, orden.locationCode)
    if (slotDeDevolucion !== undefined && slotDeDevolucion.estado.estado === 'OCUPADO') {
      const contenido = slotDeDevolucion.estado.contenido
      const resolucion = resolverPut(contenido)
      if (resolucion.ok && resolucion.valor.tipo === 'TERMINAR_SIN_MANIOBRA') {
        log.info('ORDER_DONE_WITHOUT_MOVE', {
          slotLocationCode: slotDeDevolucion.locationCode,
          pendingReturns: resolucion.valor.pendingReturns,
        })
        // El cajon NO se mueve y el slot sigue OCUPADO: lo unico que baja es el
        // contador de devoluciones que todavia se le deben.
        await repositorios.slots.guardarEstado(robotId, slotDeDevolucion.locationCode, {
          estado: 'OCUPADO',
          contenido: { cajon: contenido.cajon, pendingReturns: resolucion.valor.pendingReturns },
        })
        await aplicarTransicionDeOrden(
          dependencias,
          orden.id,
          {
            estado: 'DONE',
            slotLocationCode: slotDeDevolucion.locationCode,
            waitingForSlot: false,
            finalizadaEn: reloj.ahoraMs(),
          },
          'DONE',
          { huboManiobra: false },
        )
        await registrarMetrica(dependencias, orden, 'DONE')
        return {
          tipo: 'ORDEN_TERMINADA',
          ordenId: orden.id,
          estadoFinal: 'DONE',
          huboManiobra: false,
        }
      }
    }
  }

  const slot = await resolverSlotDeOrden(dependencias, orden)
  if (!slot.ok) {
    log.error('ORDER_FAILED', { etapa: 'RESOLUCION_DE_SLOT', motivo: slot.error })
    await marcarEnError(dependencias, orden, JSON.stringify(slot.error))
    return {
      tipo: 'ORDEN_TERMINADA',
      ordenId: orden.id,
      estadoFinal: 'ERROR',
      huboManiobra: false,
    }
  }

  if (slot.valor.tipo === 'EN_ESPERA') {
    // No se reencola: conserva su creadaEn y con eso su lugar. El robot queda
    // libre para atender otra orden, posiblemente del otro lado.
    await repositorios.ordenes.actualizar(orden.id, { waitingForSlot: true })
    log.info('ORDER_WAITING_FOR_SLOT', { lado: slot.valor.lado })
    return { tipo: 'ORDEN_EN_ESPERA_DE_SLOT', ordenId: orden.id, lado: slot.valor.lado }
  }

  const slotLocationCode = slot.valor.slotLocationCode
  // El destino de un PUT lo resuelve `resolverSlotDeOrden` contra el cajon en
  // libros (RF11), asi que la orden que se ejecuta es la de la resolucion, no la
  // que se leyo de la cola.
  const targetLocation = slot.valor.targetLocation

  // Toma del robot y del slot, y arranque de la orden.
  //
  // La toma y la suelta van en try/finally: `ordenActivaId` no es un dato de
  // pantalla, es el que hace que `ejecutarCicloDeRobot` vea al robot OCUPADO y no
  // tome nada mas. Si algo entre las dos tira —y en este modulo no hay un solo
  // catch: better-sqlite3 lanza SINCRONO ante un SQLITE_BUSY o un disco lleno— el
  // puntero queda apuntando a una orden que ya no corre y el robot deja de
  // trabajar. La rehidratacion lo limpia en cada arranque, asi que reiniciar
  // arregla; el finally es para no necesitar el reinicio.
  await repositorios.robots.fijarOrdenActiva(robotId, orden.id)
  try {
    await aplicarTransicionDeOrden(
      dependencias,
      orden.id,
      {
        estado: 'IN_PROGRESS',
        slotLocationCode,
        waitingForSlot: false,
        iniciadaEn: reloj.ahoraMs(),
      },
      'IN_PROGRESS',
      { robotId, slotLocationCode },
    )

    await registrarEvento(dependencias, orden.id, 'ORDER_STARTED', 'INFO', {
      robotId,
      slotLocationCode,
    })
    log.info('ORDER_STARTED', { robotId, slotLocationCode, tipo: orden.tipo })

    const ejecucion = await ejecutarManiobra(
      dependencias,
      { ...orden, slotLocationCode, targetLocation },
      log,
    )

    await registrarEvento(
      dependencias,
      orden.id,
      ejecucion.estadoFinal === 'DONE' ? 'ORDER_DONE' : 'ORDER_FAILED',
      ejecucion.estadoFinal === 'DONE' ? 'INFO' : 'ERROR',
      { robotId },
    )

    if (ejecucion.estadoFinal === 'DONE') {
      log.info('ORDER_DONE', { robotId })
    } else {
      log.error('ORDER_FAILED', { robotId, etapa: 'MANIOBRA' })
    }

    return {
      tipo: 'ORDEN_TERMINADA',
      ordenId: orden.id,
      estadoFinal: ejecucion.estadoFinal,
      huboManiobra: true,
    }
  } finally {
    // SIEMPRE, incluso si la maniobra tiro: ver el comentario de la toma.
    await repositorios.robots.fijarOrdenActiva(robotId, null)
  }

}

/**
 * Deja `waitingForSlot` diciendo la verdad de cada orden PENDING.
 *
 * El flag NO es el que decide la eleccion —eso lo decide el estado vivo de la
 * zona— pero es lo que ve el operario en la tablet, asi que tiene que coincidir.
 * Se escribe solo cuando cambia: sincronizar en cada ciclo una cola entera que no
 * se movio serian escrituras por tick sin ningun cambio detras.
 */
async function sincronizarEsperaDeSlot(
  dependencias: DependenciasDelOrquestador,
  pendientes: readonly Orden[],
  cola: ColaDeRobot,
): Promise<void> {
  for (const enCola of cola.ordenes) {
    const orden = pendientes.find((candidata) => candidata.id === enCola.ordenId)
    if (orden === undefined || orden.waitingForSlot === enCola.esperandoSlot) {
      continue
    }
    await dependencias.repositorios.ordenes.actualizar(orden.id, {
      waitingForSlot: enCola.esperandoSlot,
    })
  }
}

/**
 * Ejecuta los pasos de la orden y deja el estado final persistido.
 *
 * RF13: si un paso falla, el slot CONSERVA su estado. El legacy llama a
 * `blockSlot` y lo deja en ERROR para siempre, porque el retry no lo desbloquea.
 */
async function ejecutarManiobra(
  dependencias: DependenciasDelOrquestador,
  orden: Orden,
  log: Logger,
): Promise<{ readonly estadoFinal: EstadoOrden }> {
  const { repositorios, reloj } = dependencias

  const pasos = construirPasosDeOrden(orden)
  if (!pasos.ok) {
    await marcarEnError(dependencias, orden, pasos.motivo)
    return { estadoFinal: 'ERROR' }
  }

  // El slot entra en maniobra: BUSCANDO para un PICK, DEVOLVIENDO para un PUT.
  //
  // Que el PUT llegue a DEVOLVIENDO no es cosmetico: mientras el robot se lleva
  // el cajon, un slot que sigue figurando OCUPADO hace que un PICK nuevo del
  // mismo cajon entre por el camino de refcount (RF07) y le diga al pickeador
  // que su cajon esta en el slot cuando ya no esta.
  const inicioDeManiobra = await transicionarSlotDeOrden(
    dependencias,
    orden,
    orden.tipo === 'PICK'
      ? { tipo: 'INICIAR_BUSQUEDA', ordenId: orden.id }
      : { tipo: 'INICIAR_DEVOLUCION', ordenId: orden.id },
  )
  if (!inicioDeManiobra.ok) {
    log.error('SLOT_TRANSITION_REJECTED', {
      etapa: 'INICIO_DE_MANIOBRA',
      motivo: inicioDeManiobra.motivo,
    })
    await marcarEnError(dependencias, orden, inicioDeManiobra.motivo)
    return { estadoFinal: 'ERROR' }
  }

  for (const paso of pasos.valor) {
    await repositorios.pasos.registrar({
      ordenId: orden.id,
      seq: paso.seq,
      tipo: paso.tipo,
      dispositivo: paso.dispositivo,
      estado: 'SENT',
      intentos: 0,
      iniciadoEn: reloj.ahoraMs(),
      finalizadoEn: null,
    })

    // La punta del hilo: este es el comando concreto que sale al PLC, y lleva
    // pegada la misma correlacion con la que el pedido entro por el servidor.
    log.debug('STEP_SENT', {
      seq: paso.seq,
      tipo: paso.tipo,
      dispositivo: paso.dispositivo,
      comando: typeof paso.comando === 'number' ? paso.comando : paso.comando.codigo,
    })

    const resultado = await ejecutarPasoConReintentos(dependencias, {
      ordenId: orden.id,
      robotId: orden.robotId,
      paso,
    })

    if (!resultado.ok) {
      await repositorios.pasos.actualizar(orden.id, paso.seq, {
        estado: 'ERROR',
        finalizadoEn: reloj.ahoraMs(),
      })
      const fallo =
        resultado.error.codigo === 'FALLO_FATAL'
          ? resultado.error.fallo
          : resultado.error.ultimoFallo
      await registrarEvento(dependencias, orden.id, 'STEP_FAILED', 'ERROR', {
        seq: paso.seq,
        tipo: paso.tipo,
        mensaje: mensajeDeFallo(fallo),
      })
      log.error('STEP_FAILED', {
        seq: paso.seq,
        tipo: paso.tipo,
        dispositivo: paso.dispositivo,
        intentos: resultado.error.intentos,
        motivo: resultado.error.codigo,
        mensaje: mensajeDeFallo(fallo),
      })
      await marcarEnError(dependencias, orden, mensajeDeFallo(fallo))
      return { estadoFinal: 'ERROR' }
    }

    await repositorios.pasos.actualizar(orden.id, paso.seq, {
      estado: 'DONE',
      intentos: resultado.valor.intentos,
      finalizadoEn: reloj.ahoraMs(),
    })
    await repositorios.ordenes.actualizar(orden.id, { currentStepIndex: paso.seq })
    log.debug('STEP_DONE', { seq: paso.seq, intentos: resultado.valor.intentos })
  }

  const cierre =
    orden.tipo === 'PICK'
      ? // El cajon queda apoyado con una devolucion pendiente (RF07).
        await transicionarSlotDeOrden(dependencias, orden, {
          tipo: 'OCUPAR',
          cajon: { id: dependencias.generarId(), ubicacionDeOrigen: orden.locationCode },
        })
      : await transicionarSlotDeOrden(dependencias, orden, { tipo: 'LIBERAR' })
  if (!cierre.ok) {
    // El cajon YA se movio: el rechazo significa que los libros quedaron
    // diciendo otra cosa que la planta. Terminar DONE aca seria firmar un
    // inventario que se sabe falso, asi que la orden queda en ERROR con el
    // motivo a la vista.
    log.error('SLOT_TRANSITION_REJECTED', { etapa: 'CIERRE_DE_MANIOBRA', motivo: cierre.motivo })
    await marcarEnError(dependencias, orden, cierre.motivo)
    return { estadoFinal: 'ERROR' }
  }

  // La metrica se registra recien aca: una orden que cierra mal la registra
  // `marcarEnError` como ERROR, y contarla DONE antes del cierre la contaria dos
  // veces y con los dos estados.
  await registrarMetrica(dependencias, orden, 'DONE')

  await aplicarTransicionDeOrden(
    dependencias,
    orden.id,
    { estado: 'DONE', finalizadaEn: reloj.ahoraMs() },
    'DONE',
    { huboManiobra: true },
  )
  return { estadoFinal: 'DONE' }
}

/**
 * Deja constancia de lo que le paso a la orden.
 *
 * Es la traza con la que el operario reconstruye por que una orden quedo donde
 * quedo. El legacy la escribia dentro del snapshot completo; aca es una fila
 * propia por evento (RF23).
 */
async function registrarEvento(
  dependencias: DependenciasDelOrquestador,
  ordenId: string,
  evento: string,
  severidad: 'INFO' | 'ERROR',
  metadata: Readonly<Record<string, unknown>>,
): Promise<void> {
  await dependencias.repositorios.eventos.registrar({
    id: dependencias.generarId(),
    ts: dependencias.reloj.ahoraMs(),
    tipoDeEntidad: 'ORDER',
    entidadId: ordenId,
    evento,
    severidad,
    metadata,
  })
}

/** Una transicion de slot que no se aplico, con el motivo que ve el operario. */
type ResultadoDeTransicionDeSlot = { readonly ok: true } | { readonly ok: false; readonly motivo: string }

/**
 * Mueve el slot de la orden por su maquina de estados.
 *
 * Solo se llama en el camino feliz: si un paso falla el slot NO se toca y
 * conserva su estado a la espera del retry (RF13).
 *
 * NINGUN rechazo se traga en silencio. Un rechazo significa que el slot no esta
 * donde la maniobra cree que esta, y seguir adelante deja los libros diciendo
 * una cosa y la planta otra: el operario va al slot a buscar un cajon que no
 * esta, o el proximo PICK choca con uno que sobra. El llamador lo convierte en
 * ORDEN_FAILED con el motivo.
 */
async function transicionarSlotDeOrden(
  dependencias: DependenciasDelOrquestador,
  orden: Orden,
  evento: EventoSlot,
): Promise<ResultadoDeTransicionDeSlot> {
  const { repositorios } = dependencias
  if (orden.slotLocationCode === null) {
    return { ok: false, motivo: `la orden no tiene slot asignado para ${evento.tipo}` }
  }

  const slot = await repositorios.slots.buscar(orden.robotId, orden.slotLocationCode)
  if (slot === undefined) {
    return { ok: false, motivo: `slot inexistente: ${orden.slotLocationCode}` }
  }

  if (yaAplicada(slot.estado, evento)) {
    return { ok: true }
  }

  const siguiente = transicionarSlot(slot.estado, evento)
  if (!siguiente.ok) {
    return {
      ok: false,
      motivo: `transicion de slot invalida: ${evento.tipo} desde ${siguiente.error.desde}`,
    }
  }

  const guardado = await repositorios.slots.guardarEstado(
    orden.robotId,
    orden.slotLocationCode,
    siguiente.valor,
  )
  if (!guardado.ok) {
    return { ok: false, motivo: `no se pudo guardar el slot: ${guardado.error.codigo}` }
  }
  return { ok: true }
}

/**
 * El slot YA esta donde el evento lo queria llevar, y lo retiene esta orden.
 *
 * Pasa en el retry de RF13: el paso que fallo dejo el slot en BUSCANDO o
 * DEVOLVIENDO —que es justo lo que RF13 pide, conservar el estado— y el replay
 * desde HOMING vuelve a emitir el evento de arranque. Ahi no hay nada que
 * corregir ni nada que avisar: la maniobra ya esta declarada sobre ese slot.
 */
function yaAplicada(estado: EstadoSlot, evento: EventoSlot): boolean {
  if (evento.tipo === 'INICIAR_BUSQUEDA') {
    return estado.estado === 'BUSCANDO' && estado.ordenId === evento.ordenId
  }
  if (evento.tipo === 'INICIAR_DEVOLUCION') {
    return estado.estado === 'DEVOLVIENDO' && estado.ordenId === evento.ordenId
  }
  return false
}

/** El mensaje del PLC se propaga tal cual al errorReason que ve el operario. */
function mensajeDeFallo(fallo: FalloDeEjecucion): string {
  return 'mensaje' in fallo ? fallo.mensaje : fallo.tipo
}

async function marcarEnError(
  dependencias: DependenciasDelOrquestador,
  orden: Orden,
  motivo: string,
): Promise<void> {
  const { reloj } = dependencias
  const siguiente = transicionarOrden(orden.estado, { tipo: 'FALLAR', motivo })
  const estadoFinal = siguiente.ok ? siguiente.valor : 'ERROR'
  // RF34: el motivo viaja al servidor. Sin el, la app de picking ve una orden en
  // ERROR y no tiene con que decirle al operario que paso.
  await aplicarTransicionDeOrden(
    dependencias,
    orden.id,
    { estado: estadoFinal, errorReason: motivo, finalizadaEn: reloj.ahoraMs() },
    estadoFinal,
    { motivo },
  )
  await registrarMetrica(dependencias, orden, 'ERROR')
}

/**
 * Deja la metrica de la orden terminada (RF24).
 *
 * Se registran tambien las que fallan: medir solo los exitos esconde justamente
 * el numero que hay que mirar.
 */
async function registrarMetrica(
  dependencias: DependenciasDelOrquestador,
  orden: Orden,
  estado: EstadoOrden,
): Promise<void> {
  const { repositorios, reloj, siteId } = dependencias
  await repositorios.metricas.registrar({
    ordenId: orden.id,
    siteId,
    origen: orden.origen,
    tipo: orden.tipo,
    locationCode: orden.locationCode,
    estado,
    creadaEn: orden.creadaEn,
    iniciadaEn: orden.iniciadaEn,
    finalizadaEn: reloj.ahoraMs(),
  })
}

/**
 * La secuencia fisica de 5 pasos (RF04).
 *
 * HOMING -> ELEVADOR(nivel origen) -> CARRO_BUSCA -> ELEVADOR(nivel destino) ->
 * CARRO_DEJA | CARRO_DEVUELVE.
 */
function construirPasosDeOrden(
  orden: Orden,
): { readonly ok: true; readonly valor: readonly PasoDeOrden[] } | { readonly ok: false; readonly motivo: string } {
  const origen = parsearLocationCode(orden.locationCode)
  if (!origen.ok) {
    return { ok: false, motivo: 'locationCode invalido' }
  }

  // Para un PICK el cajon se trae de la ubicacion de guardado y se deja en el
  // slot; para un PUT sale del slot y vuelve a la ubicacion de guardado.
  const destinoCodigo =
    orden.tipo === 'PICK' ? (orden.slotLocationCode ?? '') : (orden.targetLocation ?? '')
  const destino = parsearLocationCode(destinoCodigo)
  if (!destino.ok) {
    return { ok: false, motivo: 'destino invalido' }
  }

  const buscar = construirComandoCarro(origen.valor, 'T')
  if (!buscar.ok) {
    return { ok: false, motivo: 'no se pudo armar el comando de busqueda' }
  }
  const dejar = construirComandoCarro(destino.valor, 'D')
  if (!dejar.ok) {
    return { ok: false, motivo: 'no se pudo armar el comando de destino' }
  }

  return {
    ok: true,
    valor: [
      { seq: 1, tipo: 'HOMING', dispositivo: 'CARRO', comando: COMANDO_INIT_CARRO },
      {
        seq: 2,
        tipo: 'ELEVADOR_NIVEL_ORIGEN',
        dispositivo: 'ELEVADOR',
        nivel: origen.valor.nivel,
        comando: construirComandoElevadorIrNivel(origen.valor.nivel),
      },
      { seq: 3, tipo: 'CARRO_BUSCA', dispositivo: 'CARRO', comando: buscar.valor },
      {
        seq: 4,
        tipo: 'ELEVADOR_NIVEL_DESTINO',
        dispositivo: 'ELEVADOR',
        nivel: destino.valor.nivel,
        comando: construirComandoElevadorIrNivel(destino.valor.nivel),
      },
      {
        seq: 5,
        tipo: orden.tipo === 'PICK' ? 'CARRO_DEJA' : 'CARRO_DEVUELVE',
        dispositivo: 'CARRO',
        comando: dejar.valor,
      },
    ],
  }
}

/** `CARRO.COMMANDS.INIT` de planta. */
const COMANDO_INIT_CARRO = 41000
