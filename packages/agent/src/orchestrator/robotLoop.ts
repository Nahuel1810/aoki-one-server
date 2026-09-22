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
  transicionarOrden,
} from '@aoki-one/domain'
import type { PasoDeOrden } from '@aoki-one/domain'
import type { Orden } from '../persistence/index.js'
import type { FalloDeEjecucion } from '../transport/errorClassification.js'
import { resolverSlotDeOrden } from './slotWait.js'
import { ejecutarPasoConReintentos } from './stepExecutor.js'
import type { EstadoOrden, Lado } from '@aoki-one/domain'

import type { DependenciasDelOrquestador } from './ports.js'

export type ResultadoDeCicloDeRobot =
  | { readonly tipo: 'ROBOT_NO_REGISTRADO'; readonly robotId: string }
  | { readonly tipo: 'SIN_TRABAJO' }
  /** Ya hay una orden en curso: no se arranca la siguiente. */
  | { readonly tipo: 'ROBOT_OCUPADO'; readonly ordenActivaId: string }
  /** Sin slot disponible de ese lado: la orden espera sin perder su lugar y el robot se libera. */
  | { readonly tipo: 'ORDEN_EN_ESPERA_DE_SLOT'; readonly ordenId: string; readonly lado: Lado }
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

  const pendientes = await repositorios.ordenes.listar({
    siteId,
    robotId,
    estados: ['PENDING'],
  })
  const proxima = elegirProximaOrden(
    pendientes.map((orden) => ({ ordenId: orden.id, creadaEn: orden.creadaEn })),
  )
  if (proxima === undefined) {
    return { tipo: 'SIN_TRABAJO' }
  }

  const orden = pendientes.find((candidata) => candidata.id === proxima.ordenId)
  if (orden === undefined) {
    return { tipo: 'SIN_TRABAJO' }
  }

  const slot = await resolverSlotDeOrden(dependencias, orden)
  if (!slot.ok) {
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
    return { tipo: 'ORDEN_EN_ESPERA_DE_SLOT', ordenId: orden.id, lado: slot.valor.lado }
  }

  const slotLocationCode = slot.valor.slotLocationCode

  // RF07: un PICK sobre un cajon que YA esta apoyado no genera maniobra.
  if (orden.tipo === 'PICK') {
    const yaApoyado = await repositorios.slots.buscarPorCajonDeOrigen(robotId, orden.locationCode)
    if (yaApoyado !== undefined && yaApoyado.estado.estado === 'OCUPADO') {
      const resolucion = resolverPick(yaApoyado.estado.contenido)
      if (resolucion.ok && resolucion.valor.tipo === 'TERMINAR_SIN_MANIOBRA') {
        await repositorios.slots.guardarEstado(robotId, yaApoyado.locationCode, {
          estado: 'OCUPADO',
          contenido: {
            cajon: yaApoyado.estado.contenido.cajon,
            pendingReturns: resolucion.valor.pendingReturns,
          },
        })
        await repositorios.ordenes.actualizar(orden.id, {
          estado: 'DONE',
          slotLocationCode: yaApoyado.locationCode,
          waitingForSlot: false,
          finalizadaEn: reloj.ahoraMs(),
        })
        return {
          tipo: 'ORDEN_TERMINADA',
          ordenId: orden.id,
          estadoFinal: 'DONE',
          huboManiobra: false,
        }
      }
    }
  }

  // Toma del robot y del slot, y arranque de la orden.
  await repositorios.robots.fijarOrdenActiva(robotId, orden.id)
  await repositorios.ordenes.actualizar(orden.id, {
    estado: 'IN_PROGRESS',
    slotLocationCode,
    waitingForSlot: false,
    iniciadaEn: reloj.ahoraMs(),
  })

  const ejecucion = await ejecutarManiobra(dependencias, { ...orden, slotLocationCode })

  await repositorios.robots.fijarOrdenActiva(robotId, null)

  return {
    tipo: 'ORDEN_TERMINADA',
    ordenId: orden.id,
    estadoFinal: ejecucion.estadoFinal,
    huboManiobra: true,
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
): Promise<{ readonly estadoFinal: EstadoOrden }> {
  const { repositorios, reloj } = dependencias

  const pasos = construirPasosDeOrden(orden)
  if (!pasos.ok) {
    await marcarEnError(dependencias, orden, pasos.motivo)
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
      await marcarEnError(dependencias, orden, mensajeDeFallo(fallo))
      return { estadoFinal: 'ERROR' }
    }

    await repositorios.pasos.actualizar(orden.id, paso.seq, {
      estado: 'DONE',
      intentos: resultado.valor.intentos,
      finalizadoEn: reloj.ahoraMs(),
    })
    await repositorios.ordenes.actualizar(orden.id, { currentStepIndex: paso.seq })
  }

  await repositorios.ordenes.actualizar(orden.id, {
    estado: 'DONE',
    finalizadaEn: reloj.ahoraMs(),
  })
  return { estadoFinal: 'DONE' }
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
  const { repositorios, reloj } = dependencias
  const siguiente = transicionarOrden(orden.estado, { tipo: 'FALLAR', motivo })
  await repositorios.ordenes.actualizar(orden.id, {
    estado: siguiente.ok ? siguiente.valor : 'ERROR',
    errorReason: motivo,
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
