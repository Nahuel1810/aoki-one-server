// RNF de Observabilidad — Logs estructurados con nivel y correlacion por orden.
//
// El valor entero de este modulo es la CORRELACION. Cuando una orden se traba en
// planta el operario dice "el pedido 47 se trabo", y alguien tiene que poder
// seguir ese pedido desde el alta en el servidor hasta el comando que salio al
// PLC. Con `console.log` suelto de los dos lados eso no se puede hacer: no hay
// ningun campo comun con el que cruzar las dos mitades.
//
// Por eso la correlacion no es texto libre dentro del mensaje sino un campo
// tipado, y lleva los DOS identificadores que existen de los dos lados del
// enlace: el id de la orden en el libro del servidor y el `externalOrderId` con
// el que la conoce la app de picking (que es el numero que dice el operario).
//
// Vive en `domain` porque el agente y el servidor lo necesitan igual y no
// dependen uno del otro: lo unico que comparten es este paquete. Sigue siendo
// puro — el reloj y el destino de la linea se INYECTAN—, asi que el test de
// pureza lo acepta y, sobre todo, un logger que escribe a stdout en los tests es
// ruido: ahi se inyecta `LOGGER_SILENCIOSO` o un doble que acumula en memoria.

export type NivelDeLog = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

/** Orden de severidad. Es lo que decide que se emite y que se descarta. */
const SEVERIDAD: Readonly<Record<NivelDeLog, number>> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
}

/**
 * Los ids con los que se sigue UNA orden de punta a punta.
 *
 * Los campos son nullables y no opcionales a proposito: "no lo se" es un dato
 * que el log tiene que decir. Un campo ausente se lee como olvido; un `null`
 * explicito se lee como "todavia no hay vinculo", que es justo lo que pasa con
 * una orden local antes de empujarla al servidor (RF35).
 */
export interface CorrelacionDeOrden {
  readonly siteId: string
  /**
   * Id de la orden en el libro del SERVIDOR.
   *
   * Es el MISMO valor a los dos lados del enlace —en el agente sale del vinculo
   * `sync_ordenes.orden_id_remoto`, en el servidor es `orders.id`— y por eso es
   * la clave con la que se cruzan los dos logs. `null` mientras una orden local
   * todavia no tiene contraparte remota.
   */
  readonly ordenId: string | null
  /** Id de la orden en el libro del AGENTE. `null` del lado del servidor, que no lo conoce. */
  readonly ordenIdLocal: string | null
  /** El numero que dice el operario. Tambien existe de los dos lados. */
  readonly externalOrderId: string | null
}

export interface RegistroDeLog {
  readonly ts: number
  readonly nivel: NivelDeLog
  /** Quien escribe: `agente`, `servidor`, `enlace`. */
  readonly componente: string
  /** Nombre estable del evento, en mayusculas: `ORDER_CLAIMED`, `STEP_SENT`. */
  readonly evento: string
  readonly correlacion: CorrelacionDeOrden | null
  readonly datos: Readonly<Record<string, unknown>>
}

export type DatosDeLog = Readonly<Record<string, unknown>>

export interface Logger {
  readonly debug: (evento: string, datos?: DatosDeLog) => void
  readonly info: (evento: string, datos?: DatosDeLog) => void
  readonly warn: (evento: string, datos?: DatosDeLog) => void
  readonly error: (evento: string, datos?: DatosDeLog) => void
  /**
   * Logger hijo con la orden pegada: todo lo que escriba sale correlacionado.
   *
   * Es lo que evita el modo de falla tipico de la correlacion a mano —pasar el
   * id en la mitad de las llamadas y olvidarlo justo en la que importa—: se fija
   * una vez, al empezar a trabajar la orden, y ya no se puede perder.
   */
  readonly paraOrden: (correlacion: CorrelacionDeOrden) => Logger
}

export interface OpcionesDeLogger {
  readonly componente: string
  /** Todo lo de severidad menor se descarta sin construir el registro. */
  readonly nivelMinimo: NivelDeLog
  readonly ahoraMs: () => number
  /**
   * Destino del registro YA ARMADO, no de una linea de texto.
   *
   * Asi el test afirma sobre campos —que la correlacion esta y que trae tal
   * id— en vez de parsear de vuelta lo que el logger acaba de serializar, y
   * produccion decide aparte como se escribe (ver `formatearRegistro`).
   */
  readonly emitir: (registro: RegistroDeLog) => void
}

export function crearLogger(opciones: OpcionesDeLogger): Logger {
  const { componente, nivelMinimo, ahoraMs, emitir } = opciones
  const minimo = SEVERIDAD[nivelMinimo]

  function conCorrelacion(correlacion: CorrelacionDeOrden | null): Logger {
    function escribir(nivel: NivelDeLog, evento: string, datos?: DatosDeLog): void {
      if (SEVERIDAD[nivel] < minimo) {
        return
      }
      emitir({
        ts: ahoraMs(),
        nivel,
        componente,
        evento,
        correlacion,
        datos: datos ?? {},
      })
    }

    return {
      debug: (evento, datos) => {
        escribir('DEBUG', evento, datos)
      },
      info: (evento, datos) => {
        escribir('INFO', evento, datos)
      },
      warn: (evento, datos) => {
        escribir('WARN', evento, datos)
      },
      error: (evento, datos) => {
        escribir('ERROR', evento, datos)
      },
      paraOrden: (siguiente) => conCorrelacion(siguiente),
    }
  }

  return conCorrelacion(null)
}

/**
 * Una linea JSON por registro, que es lo que sabe leer cualquier recolector.
 *
 * NUNCA tira. `datos` lo arma quien loguea y puede traer un ciclo o un BigInt
 * sin querer; un logger que mata el proceso del agente por eso es peor que no
 * loguear. Se emite el registro sin los datos y con el motivo adentro, que
 * conserva lo unico que no se puede perder: la correlacion.
 */
export function formatearRegistro(registro: RegistroDeLog): string {
  try {
    return JSON.stringify(registro)
  } catch (error) {
    return JSON.stringify({
      ...registro,
      // `String(error)` y no `error.message`: lo que tira `JSON.stringify` no
      // siempre es un Error —un `toJSON` ajeno puede tirar cualquier cosa— y una
      // rama por si acaso en el camino de emergencia del logger es una rama que
      // nunca se ejercita. Ademas el prefijo del tipo ("TypeError: ...") es parte
      // de lo que hace diagnosticable la linea.
      datos: { datosNoSerializables: String(error) },
    })
  }
}

/**
 * Logger que no escribe nada. Es el default de los tests.
 *
 * Existe como valor y no como `logger?: Logger` opcional porque el logger no es
 * una capacidad que a veces no esta: el que llama siempre loguea, y lo que
 * cambia es a donde va. Un opcional obligaria a poner `?.` en cada llamada y a
 * que el dia que alguien lo olvide el log desaparezca en silencio.
 */
export const LOGGER_SILENCIOSO: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  paraOrden: () => LOGGER_SILENCIOSO,
}
