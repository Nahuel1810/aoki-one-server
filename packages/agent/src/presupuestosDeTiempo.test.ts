// RF12, RF13 y RF17 — Los presupuestos de tiempo son configuracion de PLANTA.
//
// Este test no compara contra una constante escrita al lado suyo (eso solo
// afirmaria que alguien copio bien un numero): compara contra `.env.example`,
// que es lo que documenta con que valores corre hoy la notebook de la sucursal.
// Un cambio silencioso de cualquiera de los cuatro numeros rompe aca.
//
// Por que importa: el presupuesto de verificacion del reset habia bajado de 600
// intentos (~90 s) a 40 (~6 s). Cuando se agota, el paso fisico YA se ejecuto
// bien —el PLC confirmo 100 y el cajon se movio—; la orden cae igual en ERROR
// por RESET_INCOMPLETO y RF13 le dice al operario que devuelva el cajon al punto
// de origen de un paso que no fallo.

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { POLITICA_DE_REINTENTOS, TIEMPOS_DE_HANDSHAKE } from './composition.js'

/** `.env.example` vive en la raiz del repo, tres niveles arriba de este archivo. */
const RUTA_DEL_ENV = new URL('../../../.env.example', import.meta.url)

/** El valor de una variable del `.env.example`, como entero. */
function valorDelEnv(variable: string): number {
  const contenido = readFileSync(RUTA_DEL_ENV, 'utf8')
  const linea = contenido
    .split(/\r?\n/)
    .find((candidata) => candidata.startsWith(`${variable}=`))
  if (linea === undefined) {
    throw new Error(`.env.example no declara ${variable}`)
  }
  return Number(linea.slice(variable.length + 1).trim())
}

describe('presupuestos de tiempo del agente', () => {
  it('el handshake usa los cuatro numeros con los que corre la sucursal', () => {
    // Los valores absolutos, escritos a mano: si alguien cambia el .env.example
    // y el codigo a la vez, el test tiene que seguir hablando de planta.
    expect(valorDelEnv('STEP_ACK_INTERVAL_MS')).toBe(150)
    expect(valorDelEnv('STEP_ACK_MAX_ATTEMPTS')).toBe(600)
    expect(valorDelEnv('STEP_RESET_INTERVAL_MS')).toBe(150)
    expect(valorDelEnv('STEP_RESET_MAX_ATTEMPTS')).toBe(600)

    expect(TIEMPOS_DE_HANDSHAKE).toEqual({
      intervaloAckMs: 150,
      maxIntentosAck: 600,
      intervaloResetMs: 150,
      maxIntentosReset: 600,
    })
  })

  it('el presupuesto de reset es de ~90 s, no de 6 s', () => {
    // 600 x 150 ms. Es el techo que aguanta un PLC lento limpiando messageOut
    // DESPUES de haber ejecutado bien el paso.
    const techoMs = TIEMPOS_DE_HANDSHAKE.maxIntentosReset * TIEMPOS_DE_HANDSHAKE.intervaloResetMs
    expect(techoMs).toBe(90_000)
  })

  it('los reintentos por paso son los del .env.example: 3 intentos, backoff base 200 ms', () => {
    expect(valorDelEnv('MAX_RETRIES_PER_STEP')).toBe(3)
    expect(valorDelEnv('BASE_BACKOFF_MS')).toBe(200)

    expect(POLITICA_DE_REINTENTOS).toEqual({ maxIntentos: 3, baseBackoffMs: 200 })
  })
})
