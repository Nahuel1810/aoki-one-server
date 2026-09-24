// Resultado tipado de una operacion del dominio.
//
// RF06 exige que una transicion invalida sea "error del dominio, no un estado
// silencioso". El legacy devuelve `null` en reserveSlot / reserveSlotForPut /
// reserveOccupiedSlotForPut y el llamador no puede distinguir "no se pudo" de
// "no habia nada". Aca el error es un VALOR de retorno discriminado: ni `null`,
// ni excepcion. El dominio no tira; el compilador obliga a mirar `ok` antes de
// tocar `valor`.

/**
 * Exito (`ok: true`) con `valor`, o fallo (`ok: false`) con `error`.
 *
 * Los errores de cada modulo son a su vez uniones discriminadas por `codigo`,
 * para que el llamador pueda distinguir los casos sin parsear mensajes.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly valor: T }
  | { readonly ok: false; readonly error: E }
