// Portado de tests/architecture/modularity.test.js :: "Se puede inyectar
// ConnectionService fake sin tocar orquestador" (T02).
//
// TRADUCIDO, y la regla se reemplaza por una MAS FUERTE.
//
// Que afirmaba el legacy: `services.connectionService === fakeConnection` y que
// un paso ejecutado contra el doble hace exactamente una llamada al transporte.
// El archivo vivia en tests/architecture/ pero no afirmaba NADA de arquitectura:
// no habia una sola assercion sobre direccion de dependencias entre capas, y el
// assert de identidad del fake era tautologico (src/app.js hace literalmente
// `options.connectionService || new ConnectionService(...)`, o sea que afirmaba
// el operador ||). El nombre ademas miente: dice "sin tocar orquestador" y el
// cuerpo llama al orquestador.
//
// Que afirma ahora: la regla de capas que la spec si pide, en el RNF de Calidad:
// `domain/` es puro — sin I/O, sin Date.now() ni randomUUID directos, 100%
// testeable sin mocks de red. Se verifica leyendo los fuentes del paquete.
//
// La mitad con contenido real del test legacy —que un paso OK hace exactamente
// una llamada al puerto de transporte inyectado— se porta en
// packages/agent/src/orchestrator/stepExecutor, que es donde vive la ejecucion
// de un paso (RF12, RF16).
//
// EXCEPCION DELIBERADA A LA REGLA DE ORO DE T02: este test PUEDE pasar en verde
// desde el primer dia, y esta bien. Todos los demas tests portados arrancan
// rojos porque llaman a una firma que tira NotImplemented; este no llama a
// ninguna: lee los archivos fuente. No prueba comportamiento, prueba una
// invariante estructural que tiene que valer siempre, tambien mientras T03 a T10
// implementan el dominio. Es justamente su valor: es lo unico que va a fallar el
// dia que alguien meta un `Date.now()` adentro de `domain/`.

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

interface FuenteDelDominio {
  readonly nombre: string
  readonly codigo: string
}

/**
 * Saca comentarios de bloque y de linea.
 *
 * Sin esto la prosa de los propios comentarios del dominio —que nombran
 * `Date.now()` y `randomUUID` para explicar por que NO se usan— haria fallar el
 * test por el motivo equivocado. El guardia `[^:]` evita cortar un `https://`
 * dentro de un string.
 */
function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function fuentesDelDominio(): readonly FuenteDelDominio[] {
  const directorio = fileURLToPath(new URL('.', import.meta.url))

  return readdirSync(directorio)
    .filter((nombre) => nombre.endsWith('.ts') && !nombre.endsWith('.test.ts'))
    .map((nombre) => ({
      nombre,
      codigo: sinComentarios(readFileSync(`${directorio}${nombre}`, 'utf8')),
    }))
}

function archivosQueUsan(patron: RegExp): readonly string[] {
  return fuentesDelDominio()
    .filter((fuente) => patron.test(fuente.codigo))
    .map((fuente) => fuente.nombre)
}

describe('RNF de Calidad — packages/domain es puro', () => {
  it('hay fuentes del dominio para inspeccionar', () => {
    // Red de seguridad del propio test: si el filtro dejara de encontrar
    // archivos, los dos asserts de abajo pasarian sobre una lista vacia.
    expect(fuentesDelDominio().length).toBeGreaterThan(0)
  })

  it('no importa modulos de node ni abre I/O de red o disco', () => {
    expect(archivosQueUsan(/from\s+['"]node:/)).toEqual([])
    expect(archivosQueUsan(/require\s*\(/)).toEqual([])
    expect(archivosQueUsan(/\bfetch\s*\(/)).toEqual([])
    expect(archivosQueUsan(/\bprocess\./)).toEqual([])
  })

  it('no usa Date.now(), new Date(), randomUUID ni Math.random(): se inyectan', () => {
    expect(archivosQueUsan(/\bDate\.now\s*\(/)).toEqual([])
    expect(archivosQueUsan(/\bnew\s+Date\b/)).toEqual([])
    expect(archivosQueUsan(/\brandomUUID\b/)).toEqual([])
    expect(archivosQueUsan(/\bMath\.random\s*\(/)).toEqual([])
  })
})
