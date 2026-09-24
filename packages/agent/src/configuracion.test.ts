// T26/T38 — Lo que el entorno del agente NO puede decidir por nadie.
//
// El agente arranca solo al prender la notebook de la sucursal y la unica
// persona cerca es un operario frente a la tablet. Por eso lo que se afirma aca
// no es "parsea variables": es que cada capacidad peligrosa esta APAGADA cuando
// nadie la pidio, y que una variable rota no degrada en un default silencioso.
//
// Los tres defaults que este test traba son los que, si se invierten, producen
// una sucursal que parece andar:
//
//   - RF20: `SIMULAR_PLC` en false. Simular es contestar OK sin mover el robot.
//   - RF22: sin token, el comando directo a PLC deshabilitado. Es el unico
//     endpoint que escribe registros salteandose las maquinas de estado.
//   - T26: enlace apagado. En el cutover la sucursal corre primero sola.

import { describe, expect, it } from 'vitest'

import {
  describirErrorDeConfiguracion,
  leerConfiguracion,
  VARIABLE_DE_AGENT_ID,
  VARIABLE_DE_BIND,
  VARIABLE_DE_KEY_ID,
  VARIABLE_DE_PUERTO,
  VARIABLE_DE_RUTA_DE_BASE,
  VARIABLE_DE_SECRETO,
  VARIABLE_DE_SERVIDOR_URL,
  VARIABLE_DE_SIMULAR_PLC,
  VARIABLE_DE_SITE_ID,
  VARIABLE_DE_TOKEN_DE_MANTENIMIENTO,
  VARIABLE_DE_ZONA_DE_PICKEO,
} from './configuracion.js'

/** Lo minimo que el agente exige. Todo lo demas tiene default. */
const MINIMO: Readonly<Record<string, string>> = {
  [VARIABLE_DE_SITE_ID]: 'SUC-CENTRO',
  [VARIABLE_DE_AGENT_ID]: 'AG-1',
  [VARIABLE_DE_RUTA_DE_BASE]: 'C:/aoki-one/agente.db',
  [VARIABLE_DE_ZONA_DE_PICKEO]: '3X02AE1, 3X01AE1',
}

function leerValida(extra: Readonly<Record<string, string>> = {}): ReturnType<
  typeof leerConfiguracion
> {
  return leerConfiguracion({ ...MINIMO, ...extra })
}

describe('los defaults del agente fallan cerrados', () => {
  it('sin nada configurado no simula el PLC, no se conecta y no acepta comando directo', () => {
    const configuracion = leerValida()

    expect(configuracion.ok).toBe(true)
    if (!configuracion.ok) {
      return
    }
    // RF20, RF22, T26: los tres apagados, y los tres por omision.
    expect(configuracion.valor.simularPlc).toBe(false)
    expect(configuracion.valor.tokenDeMantenimiento).toBeNull()
    expect(configuracion.valor.enlace).toBeNull()
  })

  it('escucha en loopback mientras nadie escriba otra interfaz', () => {
    // RF22 apoya toda la autorizacion del operario en estar en la LAN. Un
    // default en 0.0.0.0 convertiria en "estar frente a la tablet" a cualquier
    // otra interfaz de la notebook: el wifi de invitados, una VPN, un telefono
    // compartiendo datos.
    const configuracion = leerValida()

    expect(configuracion.ok).toBe(true)
    if (!configuracion.ok) {
      return
    }
    expect(configuracion.valor.httpBind).toBe('127.0.0.1')
  })

  it('abrir el bind a la LAN es una decision explicita, y se respeta', () => {
    const configuracion = leerValida({ [VARIABLE_DE_BIND]: '192.168.10.20' })

    expect(configuracion.ok).toBe(true)
    if (!configuracion.ok) {
      return
    }
    expect(configuracion.valor.httpBind).toBe('192.168.10.20')
  })

  it('un booleano que nadie sabe leer es un error, no un default', () => {
    // El caso peligroso de los dos lados: `si` leido como false arranca contra
    // un PLC que no esta, y `no` leido como true deja a la planta creyendo que
    // el robot se mueve.
    const configuracion = leerValida({ [VARIABLE_DE_SIMULAR_PLC]: 'si' })

    expect(configuracion.ok).toBe(false)
    if (configuracion.ok) {
      return
    }
    expect(configuracion.error[0]?.codigo).toBe('VARIABLE_NO_ES_BOOLEANO')
  })

  it('el token de mantenimiento configurado habilita el comando directo', () => {
    const configuracion = leerValida({ [VARIABLE_DE_TOKEN_DE_MANTENIMIENTO]: 'token-de-servicio' })

    expect(configuracion.ok).toBe(true)
    if (!configuracion.ok) {
      return
    }
    expect(configuracion.valor.tokenDeMantenimiento).toBe('token-de-servicio')
  })
})

describe('el enlace con el servidor: o esta entero o no esta', () => {
  it('las tres variables juntas lo encienden, sin barra final en la URL', () => {
    const configuracion = leerValida({
      // Con barra final a proposito: el cliente arma las rutas concatenando, y
      // un `//` en el medio un proxy puede no resolverlo igual que el servidor.
      [VARIABLE_DE_SERVIDOR_URL]: 'https://pedidos.midominio.com/',
      [VARIABLE_DE_KEY_ID]: 'key-1',
      [VARIABLE_DE_SECRETO]: 'secreto-1',
    })

    expect(configuracion.ok).toBe(true)
    if (!configuracion.ok) {
      return
    }
    expect(configuracion.valor.enlace).toEqual({
      urlBase: 'https://pedidos.midominio.com',
      keyId: 'key-1',
      secreto: 'secreto-1',
    })
  })

  it('media credencial no arranca, y dice cual falta', () => {
    // Un despliegue a medio terminar no puede degradar a "enlace apagado": eso
    // produce una sucursal que parece andar y no reporta nada.
    const configuracion = leerValida({
      [VARIABLE_DE_SERVIDOR_URL]: 'https://pedidos.midominio.com',
      [VARIABLE_DE_KEY_ID]: 'key-1',
    })

    expect(configuracion.ok).toBe(false)
    if (configuracion.ok) {
      return
    }
    const descripcion = configuracion.error.map(describirErrorDeConfiguracion).join(' ')
    expect(descripcion).toContain(VARIABLE_DE_SECRETO)
  })
})

describe('el entorno roto se corrige de una sola pasada', () => {
  it('lista TODO lo que falta, no el primer error', () => {
    // Quien pone la notebook en marcha esta parado en la sucursal: descubrir la
    // siguiente variable rota recien en el proximo reinicio no es una opcion.
    const configuracion = leerConfiguracion({})

    expect(configuracion.ok).toBe(false)
    if (configuracion.ok) {
      return
    }
    const variables = configuracion.error.map((error) =>
      'variable' in error ? error.variable : error.codigo,
    )
    expect(variables).toEqual(
      expect.arrayContaining([
        VARIABLE_DE_SITE_ID,
        VARIABLE_DE_AGENT_ID,
        VARIABLE_DE_RUTA_DE_BASE,
        VARIABLE_DE_ZONA_DE_PICKEO,
      ]),
    )
  })

  it('reporta todos los slots mal escritos de la zona de pickeo, no el primero', () => {
    const configuracion = leerValida({ [VARIABLE_DE_ZONA_DE_PICKEO]: '3X02AE1,PEPE,3X01ZZ9' })

    expect(configuracion.ok).toBe(false)
    if (configuracion.ok) {
      return
    }
    const invalidos = configuracion.error.filter((error) => error.codigo === 'UBICACION_INVALIDA')
    expect(invalidos).toHaveLength(2)
  })

  it('un puerto que no es entero no se convierte en el default', () => {
    const configuracion = leerValida({ [VARIABLE_DE_PUERTO]: '3000 ; rm -rf' })

    expect(configuracion.ok).toBe(false)
    if (configuracion.ok) {
      return
    }
    const descripcion = configuracion.error.map(describirErrorDeConfiguracion).join(' ')
    expect(descripcion).toContain(VARIABLE_DE_PUERTO)
  })
})
