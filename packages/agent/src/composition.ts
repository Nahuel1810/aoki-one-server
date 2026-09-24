// Composicion del agente: donde se cablean base, transporte, orquestador y API.
//
// La capa HTTP es montable y desmontable: el agente arranca y sigue ejecutando
// ordenes con `montarApi` en false. Es lo que hace que la API sea un componente
// y no el centro del proceso.

import { noImplementado } from '@aoki-one/domain'

import type { DireccionDeEscucha, ServidorHttp } from './api/httpServer.js'
import type { DependenciasDelOrquestador } from './orchestrator/ports.js'

export interface OpcionesDelAgente {
  readonly siteId: string
  /** Ruta del archivo SQLite. `:memory:` en los tests. */
  readonly rutaDeBase: string
  readonly montarApi: boolean
  readonly simularPlc: boolean
  readonly httpPuerto: number
  readonly httpBind: string
  /**
   * Codigos de la zona de pickeo con los que se siembra la tabla `slots`
   * (`sembrarZonaDePickeo`).
   *
   * Sin este campo no habia forma de poblar la zona: ningun fixture podia poner
   * un slot en la tabla y el e2e no tenia donde dejar el cajon. Los codigos se
   * normalizan a baseCode y se deduplican, asi que `3X02AE1T` y `3X02AE1` son un
   * solo slot.
   *
   * Es requerido a proposito, como el resto de las opciones: la precedencia real
   * —`options.pickSlots` > `PICK_SLOTS` del entorno > los 12 codigos por defecto
   * de planta— se resuelve al armar estas opciones y entra con la task que la
   * testee. Aca ya llega resuelto, y arrancar sin configuracion no inventa una
   * zona en silencio.
   */
  readonly zonaDePickeo: readonly string[]
}

export interface Agente {
  readonly iniciar: () => Promise<void>
  readonly detener: () => Promise<void>
  /** `null` cuando se arranco sin montar la API. */
  readonly api: ServidorHttp | null
  /**
   * Donde quedo escuchando la API, o `null` si no se monto o todavia no arranco.
   *
   * Es una funcion y no un campo porque el dato recien existe despues de
   * `iniciar()`. Sin esto no habia forma de armar la URL de un fetch: `escuchar`
   * devuelve la direccion adentro de `iniciar()` y no la reexponia nadie, asi que
   * un test tenia que hardcodear un puerto —candidato a EADDRINUSE en CI— en vez
   * de pedir el 0 y leer el que asigno el sistema.
   */
  readonly direccion: () => DireccionDeEscucha | null
  /**
   * El orquestador ya cableado contra la base, el transporte y el reloj de este
   * agente.
   *
   * Es lo que permite ejercitar el agente SIN levantar HTTP, que es justamente lo
   * que prueba "se puede levantar app sin API": con `montarApi` en false la unica
   * superficie que quedaba era `iniciar` / `detener`, o sea que no se podia
   * afirmar que el agente sigue ejecutando ordenes.
   */
  readonly orquestador: DependenciasDelOrquestador
}

export function crearAgente(opciones: OpcionesDelAgente): Agente {
  return noImplementado('crearAgente', { opciones })
}
