// Andamiaje de la fase de contratos (paso previo a T02).
//
// El esqueleto declara tipos y firmas REALES y ninguna implementacion: toda
// funcion del dominio termina en `noImplementado(...)`. Asi la suite de
// aceptacion de T02 compila (typecheck y lint verdes) y falla en runtime (suite
// roja), que es justamente el contrato: se pone verde recien cuando T03 en
// adelante implementen de verdad.
//
// Por la misma razon el esqueleto no exporta ninguna constante con su valor de
// planta (41000, las tablas de errores, los 12 slots de pickeo): un test que
// afirmara esa constante pasaria en verde en T02 sin que nadie haya escrito la
// logica. Ese conocimiento entra con la implementacion que lo usa.

/**
 * Corta una firma declarada y todavia no implementada.
 *
 * Devuelve `never`, asi que sirve como cuerpo de cualquier funcion sin importar
 * su tipo de retorno y sin inventar un valor de mentira.
 *
 * `contexto` esta para referenciar los parametros de la firma: con
 * `noUnusedParameters` activo una firma vacia no compila, y prefijarlos con
 * guion bajo esconderia cuales son las entradas reales del contrato.
 */
export function noImplementado(nombre: string, contexto: object = {}): never {
  const campos = Object.keys(contexto).join(', ')
  throw new Error(campos === '' ? `No implementado: ${nombre}` : `No implementado: ${nombre} (${campos})`)
}
