// Reloj y espera inyectables.
//
// El RNF de Calidad prohibe `Date.now()` directo en la logica: el monitor de
// conectividad, los deadlines de paso y de orden y las marcas de tiempo que se
// persisten tienen que ser deterministicas en los tests. El polling del
// handshake (150 ms contra el PLC) y el backoff de reintentos tampoco pueden
// dormir de verdad en la suite: el test legacy de ELEVADOR duerme ~4,5 s reales
// porque el sleep esta cableado adentro.

import { noImplementado } from '@aoki-one/domain'

export interface Reloj {
  /** Instante actual en epoch ms. */
  readonly ahoraMs: () => number
  /** Espera `ms` milisegundos. En los tests se reemplaza por un avance virtual. */
  readonly dormir: (ms: number) => Promise<void>
}

/** Reloj real: `Date.now()` y `setTimeout`. Solo lo arma la composicion. */
export function crearRelojDelSistema(): Reloj {
  return noImplementado('crearRelojDelSistema')
}
