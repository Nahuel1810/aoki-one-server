// T23 — Linea de comandos de la migracion.
//
// Por defecto SIMULA. Escribir exige `--aplicar` escrito a mano: el comando se
// corre una sola noche, con poco descanso y sobre la base de un robot en
// produccion, y el error que no se perdona es el de haber escrito sin querer.
//
//   node dist/migracion/cli.js --origen data/persistence.db \
//     --destino /var/lib/aoki-one/agente.db --site-id SUC-CENTRO
//   node dist/migracion/cli.js ... --aplicar

import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { abrirBase } from '../persistence/database.js'
import { describirErrorDeOrigen, describirReporte, migrar } from './migrar.js'
import { abrirOrigenLegacy } from './origenLegacy.js'

const AYUDA = `Migracion de la base del robot viejo a la base del agente nuevo.

  --origen   <ruta>  base SQLite actual (se abre en SOLO LECTURA)
  --destino  <ruta>  base del agente nuevo (se crea si no existe)
  --site-id  <id>    sucursal a la que pertenece todo lo importado
  --aplicar          escribe de verdad. Sin este flag solo simula.

Correr dos veces es seguro: lo ya migrado no se duplica ni se pisa.
Si la base origen esta en uso y tiene -wal, conviene migrar desde una copia.`

/** `--clave valor`. `undefined` si el flag no esta o viene sin valor. */
export function leerFlag(argv: readonly string[], nombre: string): string | undefined {
  const indice = argv.indexOf(`--${nombre}`)
  if (indice === -1) {
    return undefined
  }
  return argv[indice + 1]
}

export async function principal(argv: readonly string[]): Promise<number> {
  const rutaOrigen = leerFlag(argv, 'origen')
  const rutaDestino = leerFlag(argv, 'destino')
  const siteId = leerFlag(argv, 'site-id')

  if (rutaOrigen === undefined || rutaDestino === undefined || siteId === undefined) {
    console.error(AYUDA)
    return 1
  }

  const origen = abrirOrigenLegacy(rutaOrigen)
  if (!origen.ok) {
    console.error(describirErrorDeOrigen(origen.error))
    return 1
  }

  const destino = abrirBase(rutaDestino)
  try {
    const reporte = await migrar(origen.valor, destino, {
      siteId,
      simulacion: !argv.includes('--aplicar'),
    })

    if (!reporte.ok) {
      console.error(describirErrorDeOrigen(reporte.error))
      return 1
    }

    console.log(describirReporte(reporte.valor))
    return 0
  } finally {
    origen.valor.cerrar()
    destino.cerrar()
  }
}

function esEntryPoint(): boolean {
  const ejecutado = process.argv[1]
  if (ejecutado === undefined) {
    return false
  }
  return fileURLToPath(import.meta.url) === ejecutado
}

if (esEntryPoint()) {
  void principal(process.argv.slice(2)).then((codigo) => {
    process.exitCode = codigo
  })
}
