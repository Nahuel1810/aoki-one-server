// RF22, primer nivel — Hasta donde llega la API local.
//
// Toda la autorizacion del operario se apoya en la red: no hay login, y estar en
// la LAN de la sucursal equivale a estar parado frente a la tablet. Ese
// razonamiento se cae si el listener queda en `0.0.0.0`, porque entonces
// cualquier otra interfaz que la notebook tenga —el wifi de invitados, una VPN,
// el telefono compartiendo datos— tambien pasa a ser "estar frente a la tablet".
//
// Hasta ahora la prohibicion vivia SOLO en prosa: en un comentario y en el
// archivo de entorno. Nada la verificaba, asi que un `0.0.0.0` escrito de apuro
// abria la superficie entera sin que nada avisara.
//
// Lo que NO se hace aca es abortar el arranque. Un bind mal escrito dejaria al
// robot sin trabajar, y eso es peor que la exposicion que se quiere evitar: la
// sucursal opera supervisada y detras de su propio router. Se avisa fuerte, se
// deja el dato a la vista en `/health`, y la decision queda en manos de quien
// opera.

/** Hasta donde se puede llegar al listener. */
export type AlcanceDelBind =
  /** Solo desde la propia notebook. Es el default. */
  | 'LOOPBACK'
  /** Desde la LAN de la sucursal. Es lo que necesita la tablet. */
  | 'LAN_PRIVADA'
  /** Desde cualquier interfaz de la maquina, o desde una direccion publica. */
  | 'EXPUESTO'

/** `0.0.0.0` y `::` son "todas las interfaces", que es el caso que importa. */
const TODAS_LAS_INTERFACES = new Set(['0.0.0.0', '::', '[::]', '*'])

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Los rangos privados de RFC 1918, mas el link-local de APIPA.
 *
 * `172.16` a `172.31`, no `172.` entero: `172.32.0.1` es una direccion publica y
 * tratarla como privada seria exactamente el error que esta funcion existe para
 * evitar.
 */
function esPrivadaIPv4(bind: string): boolean {
  const partes = bind.split('.')
  if (partes.length !== 4) {
    return false
  }
  const numeros = partes.map((parte) => Number(parte))
  if (numeros.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false
  }
  const [a, b] = numeros as [number, number, number, number]
  if (a === 10) {
    return true
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true
  }
  if (a === 192 && b === 168) {
    return true
  }
  // 169.254.x.x: link-local. No es LAN ruteada, pero tampoco sale de la red.
  return a === 169 && b === 254
}

/** Las direcciones locales unicas de IPv6 (`fc00::/7`) y el link-local (`fe80::/10`). */
function esPrivadaIPv6(bind: string): boolean {
  const limpia = bind.replace(/^\[|\]$/g, '').toLowerCase()
  return /^f[cd]/.test(limpia) || limpia.startsWith('fe80')
}

/**
 * Clasifica el bind configurado. Nunca tira: un valor que no se reconoce cae en
 * `EXPUESTO`, que es el lado seguro del error —avisar de mas sobre algo que
 * resulto inofensivo cuesta una linea de log; callarse sobre algo abierto cuesta
 * la superficie entera.
 */
export function clasificarBind(bind: string): AlcanceDelBind {
  const normalizado = bind.trim().toLowerCase()
  if (LOOPBACK.has(normalizado)) {
    return 'LOOPBACK'
  }
  if (TODAS_LAS_INTERFACES.has(normalizado)) {
    return 'EXPUESTO'
  }
  if (esPrivadaIPv4(normalizado) || esPrivadaIPv6(normalizado)) {
    return 'LAN_PRIVADA'
  }
  return 'EXPUESTO'
}

/** Que decirle a quien opera cuando el bind no es de fiar. Vacio = no hay nada que decir. */
export function advertenciaDeBind(bind: string): string | null {
  if (clasificarBind(bind) !== 'EXPUESTO') {
    return null
  }
  return (
    `la API local esta escuchando en "${bind}", que no es ni loopback ni una direccion de red ` +
    'privada. Toda la autorizacion del operario (RF22) se apoya en que solo se llegue desde la ' +
    'LAN de la sucursal: con este bind, cualquier otra interfaz de la notebook —wifi de ' +
    'invitados, VPN, un telefono compartiendo datos— alcanza los endpoints que mueven el robot. ' +
    'Poné AOKI_AGENT_HTTP_BIND en la IP de LAN de la notebook.'
  )
}
