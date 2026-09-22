// RF23 — SQLite como fuente de verdad de la EJECUCION.
//
// El Map en memoria deja de ser autoritativo y el volcado de snapshot completo
// desaparece: cada entidad se escribe incrementalmente por su repositorio. El
// servidor sigue siendo fuente de verdad de la ADMISION de pedidos; el agente
// nunca lo consulta para decidir un paso fisico.

import { noImplementado } from '@aoki-one/domain'

/**
 * Conexion a la base del agente.
 *
 * Se declara como puerto y no como el tipo de la libreria para que los tests
 * puedan abrir una base en memoria sin arrastrar el driver a cada archivo.
 */
export interface BaseDelAgente {
  readonly cerrar: () => void
}

/** Abre la base y deja aplicadas las migraciones pendientes. `:memory:` en tests. */
export function abrirBase(ruta: string): BaseDelAgente {
  return noImplementado('abrirBase', { ruta })
}
