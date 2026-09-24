// RF10 y RF05 — Que slot usa la orden, o por que espera.
//
// Un PICK toma el slot libre mas cercano del MISMO LADO (el ranking es dominio
// puro). Si no hay ninguno, la orden NO se reencola: queda PENDING con
// `waitingForSlot` en true y el robot se libera. Conserva su `creadaEn`, que es
// como no pierde su lugar: el legacy hace `clearActive` mas `enqueue` y la manda
// al final de la cola cada vez que espera.
//
// Un PUT espera por la misma via cuando el slot que tiene que tomar esta ocupado
// por otra maniobra o inutilizable: esperar es el resultado, no un error (ver
// `resolverDestinoDePut`).
//
// La espera es por lado: una orden esperando el lado izquierdo no bloquea a una
// del derecho.

import { parsearLocationCode, rankearSlotsParaPick, transicionarSlot } from '@aoki-one/domain'
import { resolverDestinoDePut } from './putTargetResolution.js'
import type {
  ErrorLocationCode,
  ErrorSeleccionSlot,
  ErrorTransicionSlot,
  EstadoSlot,
  Lado,
  NombreEstadoSlot,
  Result,
  SlotInexistente,
} from '@aoki-one/domain'

import type { Orden } from '../persistence/index.js'
import type { ErrorDeDestinoDePut } from './putTargetResolution.js'
import type { DependenciasDelOrquestador } from './ports.js'

/**
 * Por que espera la orden.
 *
 * Los dos motivos se resuelven distinto y por eso se distinguen: el PICK se
 * reactiva cuando se libera CUALQUIER slot de ese lado, y el PUT cuando se libera
 * EL suyo.
 */
export type MotivoDeEspera =
  /** PICK sin ningun slot LIBRE de ese lado. */
  | { readonly tipo: 'SIN_SLOT_LIBRE' }
  /** PUT sobre un slot que ahora esta RESERVADO, BUSCANDO, DEVOLVIENDO o ERROR. */
  | {
      readonly tipo: 'SLOT_DE_PUT_NO_DISPONIBLE'
      readonly slotLocationCode: string
      readonly estado: NombreEstadoSlot
    }

export type ResolucionDeSlot =
  | {
      readonly tipo: 'SLOT_ASIGNADO'
      readonly slotLocationCode: string
      /**
       * A donde va el cajon en un PUT, ya resuelto por RF11.
       *
       * Viaja en la resolucion ademas de persistirse porque el ciclo del robot
       * arma los pasos con la orden que ya tenia en la mano: leer de ahi el
       * `targetLocation` daria el del pedido —o `null`— en vez del que acaba de
       * resolverse contra el cajon en libros. En un PICK es el de la orden, que
       * no se usa para nada.
       */
      readonly targetLocation: string | null
    }
  /** La orden espera sin perder su lugar y el robot queda libre. */
  | { readonly tipo: 'EN_ESPERA'; readonly lado: Lado; readonly motivo: MotivoDeEspera }

export type ErrorDeResolucionDeSlot =
  | {
      readonly codigo: 'LOCATION_CODE_INVALIDO'
      readonly recibido: string
      readonly causa: ErrorLocationCode
    }
  | { readonly codigo: 'SELECCION_INVALIDA'; readonly causa: ErrorSeleccionSlot }
  /** Solo lo genuinamente invalido de un PUT: un slot tomado sale por EN_ESPERA. */
  | { readonly codigo: 'DESTINO_DE_PUT_INVALIDO'; readonly causa: ErrorDeDestinoDePut }
  /**
   * El slot de un PUT no existe en la zona de pickeo de ese robot.
   *
   * NO es una espera. Un slot tomado se destraba solo; uno que no existe no
   * aparece nunca, asi que esperarlo es esperar para siempre —y, con el robot
   * eligiendo esa orden en cada ciclo, arrastraba a toda la cola—. El legacy
   * contestaba 400 al crear la orden ("PUT requiere locationCode de zona pickeo
   * configurada"): la validacion de admision vuelve, y esto es la red por si la
   * zona cambia despues de admitida.
   */
  | { readonly codigo: 'SLOT_DE_PUT_INEXISTENTE'; readonly causa: SlotInexistente }
  /**
   * La reserva del slot la rechazo la maquina de estados.
   *
   * Antes se ignoraba y la orden seguia adelante sobre un slot que no estaba
   * reservado para ella. Un rechazo aca es una carrera con otra maniobra: sale
   * por el canal de error en vez de terminar en dos ordenes sobre el mismo slot.
   */
  | {
      readonly codigo: 'RESERVA_DE_SLOT_RECHAZADA'
      readonly slotLocationCode: string
      readonly causa: ErrorTransicionSlot
    }

export async function resolverSlotDeOrden(
  dependencias: DependenciasDelOrquestador,
  orden: Orden,
): Promise<Result<ResolucionDeSlot, ErrorDeResolucionDeSlot>> {
  const { repositorios } = dependencias

  const origen = parsearLocationCode(orden.locationCode)
  if (!origen.ok) {
    return {
      ok: false,
      error: {
        codigo: 'LOCATION_CODE_INVALIDO',
        recibido: orden.locationCode,
        causa: origen.error,
      },
    }
  }

  const zona = await repositorios.slots.listarPorRobot(orden.robotId)

  // El slot que la orden YA tiene en la mano se reusa; no se vuelve a elegir.
  //
  // RF13 deja el slot como estaba cuando un paso falla, "a la espera del retry",
  // y RF15 hace lo mismo con la orden que un reinicio dejo a mitad de maniobra.
  // En los dos casos la orden vuelve a PENDING con su slot todavia tomado, y
  // resolver de nuevo seria abandonarlo: el PICK elegiria otro slot —el suyo ya
  // no esta LIBRE, asi que el ranking lo excluye— y el anterior quedaria en
  // BUSCANDO para siempre, porque el unico evento que sale de ahi es OCUPAR y lo
  // emite la maniobra que acaba de fallar. Cada retry se comeria un slot de la
  // zona de pickeo, en silencio. El PUT es peor todavia: su slot esta en
  // DEVOLVIENDO, `resolverDestinoDePut` contesta ESPERAR_SLOT y la orden queda
  // esperando el slot que ella misma retiene, sin avanzar ni fallar nunca.
  const retenido = zona.find(
    (slot) =>
      slot.locationCode === orden.slotLocationCode && ordenQueRetiene(slot.estado) === orden.id,
  )
  if (retenido !== undefined) {
    // El destino ya se resolvio y se persistio en la primera pasada: volver a
    // resolverlo contra un slot que ahora esta DEVOLVIENDO daria otra cosa.
    return {
      ok: true,
      valor: {
        tipo: 'SLOT_ASIGNADO',
        slotLocationCode: retenido.locationCode,
        targetLocation: orden.targetLocation,
      },
    }
  }

  if (orden.tipo === 'PUT') {
    // Para un PUT el locationCode ES el slot del que sale el cajon.
    const slot = zona.find((candidato) => candidato.locationCode === origen.valor.baseCode)
    if (slot === undefined) {
      // Un slot que NO EXISTE no es un estado transitorio: un typo en la tablet
      // entraba como orden valida y quedaba PENDING para siempre.
      return {
        ok: false,
        error: {
          codigo: 'SLOT_DE_PUT_INEXISTENTE',
          causa: { codigo: 'SLOT_INEXISTENTE', locationCode: origen.valor.baseCode },
        },
      }
    }

    const destino = resolverDestinoDePut({
      slotLocationCode: slot.locationCode,
      estadoDelSlot: slot.estado,
      targetLocationPedido: orden.targetLocation,
      // La zona entera, no solo el slot de esta orden: el invariante prohibe
      // devolver a CUALQUIER slot de pickeo, no solo al propio.
      zonaDePickeo: zona.map((candidato) => candidato.locationCode),
    })
    if (!destino.ok) {
      return { ok: false, error: { codigo: 'DESTINO_DE_PUT_INVALIDO', causa: destino.error } }
    }

    if (destino.valor.tipo === 'ESPERAR_SLOT') {
      return {
        ok: true,
        valor: {
          tipo: 'EN_ESPERA',
          lado: origen.valor.lado,
          motivo: {
            tipo: 'SLOT_DE_PUT_NO_DISPONIBLE',
            slotLocationCode: slot.locationCode,
            estado: destino.valor.estado,
          },
        },
      }
    }

    // El slot se RESERVA para este PUT, igual que el PICK reserva el suyo.
    //
    // Es el primer eslabon de la cadena de RF06 para una devolucion
    // (LIBRE|OCUPADO -> RESERVADO -> DEVOLVIENDO -> LIBRE) y nadie lo emitia: el
    // evento existia en el dominio, con tests, sin un solo productor. Sin el, la
    // maniobra intentaba pasar de OCUPADO a DEVOLVIENDO, la maquina rechazaba y
    // el slot se quedaba OCUPADO mientras el robot se llevaba el cajon.
    const reserva = transicionarSlot(slot.estado, {
      tipo: 'RESERVAR_PARA_PUT',
      ordenId: orden.id,
    })
    if (!reserva.ok) {
      return {
        ok: false,
        error: {
          codigo: 'RESERVA_DE_SLOT_RECHAZADA',
          slotLocationCode: slot.locationCode,
          causa: reserva.error,
        },
      }
    }
    await repositorios.slots.guardarEstado(orden.robotId, slot.locationCode, reserva.valor)

    // El destino resuelto SE PERSISTE. Sin esto el `targetLocation` de la orden
    // se queda como vino del pedido, y en la devolucion estandar —slot con cajon
    // en libros, donde RF11 dice que el destino sale del cajon y el del pedido se
    // ignora— eso es `null`: la orden muere armando los pasos, con "destino
    // invalido", y el cajon no vuelve nunca a su ubicacion de guardado.
    const targetLocation = destino.valor.destino.locationCode
    await repositorios.ordenes.actualizar(orden.id, {
      slotLocationCode: slot.locationCode,
      targetLocation,
      waitingForSlot: false,
    })
    return {
      ok: true,
      valor: { tipo: 'SLOT_ASIGNADO', slotLocationCode: slot.locationCode, targetLocation },
    }
  }

  // PICK: el slot libre mas cercano del MISMO LADO. El ranking es dominio puro.
  const ranking = rankearSlotsParaPick(
    origen.valor,
    zona.map((slot) => ({ locationCode: slot.locationCode, estado: slot.estado })),
  )
  if (!ranking.ok) {
    return { ok: false, error: { codigo: 'SELECCION_INVALIDA', causa: ranking.error } }
  }

  const ganador = ranking.valor[0]
  if (ganador === undefined) {
    // No se reencola ni se toca creadaEn: con eso conserva su lugar en la cola.
    // El legacy hacia clearActive + enqueue y la mandaba al final cada vez.
    // Vuelve a PENDING: suelta el robot pero conserva creadaEn, asi que no pierde
    // su lugar en la cola.
    await repositorios.ordenes.actualizar(orden.id, { estado: 'PENDING', waitingForSlot: true })
    return {
      ok: true,
      valor: {
        tipo: 'EN_ESPERA',
        lado: origen.valor.lado,
        motivo: { tipo: 'SIN_SLOT_LIBRE' },
      },
    }
  }

  // La reserva se persiste al asignar: entre la eleccion y la maniobra no puede
  // colarse otra orden sobre el mismo slot.
  const estadoActual = zona.find((slot) => slot.locationCode === ganador.locationCode)?.estado
  const reserva = transicionarSlot(estadoActual ?? { estado: 'LIBRE' }, {
    tipo: 'RESERVAR_PARA_PICK',
    ordenId: orden.id,
  })
  if (!reserva.ok) {
    // El ranking solo devuelve slots LIBRE, asi que un rechazo aca es una
    // carrera. Se reporta: ignorarlo mandaba la maniobra sobre un slot que
    // retiene otra orden.
    return {
      ok: false,
      error: {
        codigo: 'RESERVA_DE_SLOT_RECHAZADA',
        slotLocationCode: ganador.locationCode,
        causa: reserva.error,
      },
    }
  }
  await repositorios.slots.guardarEstado(orden.robotId, ganador.locationCode, reserva.valor)
  await repositorios.ordenes.actualizar(orden.id, {
    slotLocationCode: ganador.locationCode,
    waitingForSlot: false,
  })

  return {
    ok: true,
    valor: {
      tipo: 'SLOT_ASIGNADO',
      slotLocationCode: ganador.locationCode,
      targetLocation: orden.targetLocation,
    },
  }
}

/**
 * La orden que tiene tomado el slot, o `null` si no lo retiene ninguna.
 *
 * `OCUPADO` no retiene: el cajon esta apoyado y la orden que lo trajo ya
 * termino. `ERROR` tampoco, porque un slot inutilizable no espera a nadie.
 *
 * Se exporta porque la cancelacion (RF21) necesita la MISMA definicion de
 * "retiene": dos criterios distintos para lo mismo es como se pierde un slot.
 */
export function ordenQueRetiene(estado: EstadoSlot): string | null {
  switch (estado.estado) {
    case 'RESERVADO':
    case 'BUSCANDO':
    case 'DEVOLVIENDO':
      return estado.ordenId
    case 'LIBRE':
    case 'OCUPADO':
    case 'ERROR':
      return null
  }
}
