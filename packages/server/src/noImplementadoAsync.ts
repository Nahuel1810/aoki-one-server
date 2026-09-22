// Corte de una firma ASINCRONICA todavia no implementada.
//
// `noImplementado` del dominio tira sincronicamente. Usado como cuerpo de una
// funcion declarada `Promise<T>` el tipo de retorno MIENTE: la funcion nunca
// devuelve una promesa, asi que un test escrito como
// `await expect(fn()).rejects.toThrow()` no falla por el "No implementado" sino
// por la excepcion sincronica, que es otra via. Aca el fallo viaja por el canal
// que la firma promete.
//
// Esta duplicado en `packages/agent`: agente y servidor son procesos distintos
// y no dependen uno del otro; lo unico que comparten es `@aoki-one/domain`.

import { noImplementado } from '@aoki-one/domain'

/** Promesa ya rechazada con el mismo error que produce `noImplementado`. */
export async function noImplementadoAsync(nombre: string, contexto: object = {}): Promise<never> {
  // El await es lo que hace que el rechazo sea asincronico y no una excepcion
  // sincronica disfrazada de promesa.
  await Promise.resolve()
  return noImplementado(nombre, contexto)
}
