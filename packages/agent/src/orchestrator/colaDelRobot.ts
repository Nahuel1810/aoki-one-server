// RF09 y RF10 — De las ordenes PENDING y el estado vivo de la zona, la cola que
// el dominio ordena.
//
// Aca esta la mitad que el dominio no puede tener: mirar los slots. El dominio
// decide CUAL sigue; este modulo contesta las dos preguntas que esa decision
// necesita y que solo se pueden contestar leyendo la zona de pickeo:
//   - que ordenes NO pueden avanzar ahora (RF10, la espera que no bloquea);
//   - que lados tienen la zona llena (RF09, la inversion PICK/PUT).
//
// Las dos se calculan contra el estado VIVO de los slots y no contra el flag
// `waitingForSlot` persistido. Es lo que hace que la espera sea por evento: en
// cuanto el slot se libera la orden vuelve a ser elegible sola, sin depender de
// que alguien le baje el flag. El flag queda como lo que es, un dato para el
// operario, y se sincroniza aparte.

import { parsearLocationCode } from '@aoki-one/domain'
import type { ColaDeRobot, Lado, OrdenEnCola } from '@aoki-one/domain'

import type { Orden, SlotDeRobot } from '../persistence/index.js'
import { ordenQueRetiene } from './slotWait.js'

const LADOS: readonly Lado[] = ['LEFT', 'RIGHT']

export interface ColaDelRobot {
  readonly cola: ColaDeRobot
  /**
   * Las que ni siquiera se pueden ubicar en un lado.
   *
   * No entran a la cola —no hay lado con el que ordenarlas— pero tampoco se
   * pueden dejar afuera y ya: una orden que nadie elige nunca es exactamente el
   * bloqueo invisible que RF10 viene a cerrar. Se sirven aparte, y el ciclo las
   * termina en ERROR sin mover el robot.
   */
  readonly conUbicacionInvalida: readonly Orden[]
}

export function armarColaDelRobot(
  pendientes: readonly Orden[],
  zona: readonly SlotDeRobot[],
): ColaDelRobot {
  const ordenes: OrdenEnCola[] = []
  const conUbicacionInvalida: Orden[] = []

  for (const orden of pendientes) {
    const ubicacion = parsearLocationCode(orden.locationCode)
    if (!ubicacion.ok) {
      conUbicacionInvalida.push(orden)
      continue
    }
    ordenes.push({
      ordenId: orden.id,
      creadaEn: orden.creadaEn,
      tipo: orden.tipo,
      lado: ubicacion.valor.lado,
      esperandoSlot: estaEsperandoSlot(orden, ubicacion.valor.lado, ubicacion.valor.baseCode, zona),
    })
  }

  return {
    cola: { ordenes, ladosConZonaLlena: LADOS.filter((lado) => zonaLlena(lado, zona)) },
    conUbicacionInvalida,
  }
}

/** Un lado sin ningun slot LIBRE. Un lado sin slots configurados cuenta como lleno. */
function zonaLlena(lado: Lado, zona: readonly SlotDeRobot[]): boolean {
  return !zona.some((slot) => slot.lado === lado && slot.estado.estado === 'LIBRE')
}

/**
 * Si la orden puede avanzar AHORA.
 *
 * Es deliberadamente mas gruesa que `resolverSlotDeOrden`, que sigue siendo la
 * autoridad: aca alcanza con no elegir la que seguro no puede avanzar. Un falso
 * negativo (la eligio y termina esperando igual) cuesta un ciclo; un falso
 * positivo la saltearia sin motivo, asi que ante la duda la orden es elegible.
 */
function estaEsperandoSlot(
  orden: Orden,
  lado: Lado,
  baseCode: string,
  zona: readonly SlotDeRobot[],
): boolean {
  // El slot que la orden YA tiene tomado se reusa (RF13, RF15): el retry de una
  // orden que fallo a mitad de maniobra no necesita un slot libre, necesita el
  // suyo, y su slot no esta LIBRE justamente porque lo retiene ella.
  const retenido = zona.some(
    (slot) => slot.locationCode === orden.slotLocationCode && ordenQueRetiene(slot.estado) === orden.id,
  )
  if (retenido) {
    return false
  }

  if (orden.tipo === 'PUT') {
    // Para un PUT el locationCode ES el slot del que sale el cajon.
    const slot = zona.find((candidato) => candidato.locationCode === baseCode)
    if (slot === undefined) {
      // Un slot que no existe no es una espera: es un pedido invalido y hay que
      // servirlo para que muera rapido. Esperar por el es esperar para siempre.
      return false
    }
    // LIBRE es la devolucion manual fuera-de-libros y OCUPADO la estandar (RF11).
    // RESERVADO, BUSCANDO, DEVOLVIENDO o ERROR: lo tiene otra maniobra.
    return slot.estado.estado !== 'LIBRE' && slot.estado.estado !== 'OCUPADO'
  }

  // RF07: un PICK de un cajon que ya esta apoyado termina sin maniobra y sin
  // tomar un slot nuevo. Si esperara por la zona llena, dos pedidos del mismo
  // cajon se trabarian justo cuando la zona se llena, que es cuando mas pasa.
  const yaApoyado = zona.some(
    (slot) =>
      slot.estado.estado === 'OCUPADO' &&
      slot.estado.contenido.cajon.ubicacionDeOrigen === orden.locationCode,
  )
  if (yaApoyado) {
    return false
  }

  return zonaLlena(lado, zona)
}
