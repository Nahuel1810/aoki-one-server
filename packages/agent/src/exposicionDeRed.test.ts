// RF22, primer nivel — La clasificacion del bind.
//
// Importa porque toda la autorizacion del operario se apoya en la red: no hay
// login, y estar en la LAN equivale a estar frente a la tablet. Si el listener
// queda abierto, los endpoints que mueven el robot quedan al alcance de
// cualquier interfaz de la notebook y ese razonamiento se cae entero.
//
// La regla de desempate es AVISAR DE MAS: lo que no se reconoce cae en EXPUESTO.
// Una linea de log sobre algo que resulto inofensivo no cuesta nada; callarse
// sobre algo abierto cuesta la superficie entera.

import { describe, expect, it } from 'vitest'

import { crearLogger, type RegistroDeLog } from '@aoki-one/domain'

import { crearAgente, type Agente, type OpcionesDelAgente } from './composition.js'
import { advertenciaDeBind, clasificarBind } from './exposicionDeRed.js'

describe('clasificacion del bind de la API local', () => {
  it('loopback es solo la notebook', () => {
    for (const bind of ['127.0.0.1', 'localhost', '::1', '[::1]', ' 127.0.0.1 ']) {
      expect(clasificarBind(bind)).toBe('LOOPBACK')
    }
  })

  it('los rangos privados son la LAN de la sucursal, que es lo que la tablet necesita', () => {
    for (const bind of ['192.168.1.40', '10.0.0.5', '172.16.0.1', '172.31.255.254', '169.254.1.1']) {
      expect(clasificarBind(bind)).toBe('LAN_PRIVADA')
    }
  })

  it('todas las interfaces es el caso que motiva todo esto', () => {
    for (const bind of ['0.0.0.0', '::', '[::]', '*']) {
      expect(clasificarBind(bind)).toBe('EXPUESTO')
    }
  })

  it('172.32 en adelante es PUBLICA, no privada', () => {
    // El error clasico: tratar todo `172.` como rango privado. `172.16` a
    // `172.31` lo es; `172.32.0.1` es una direccion de internet, y darla por
    // buena seria exactamente la falla que esta funcion existe para evitar.
    expect(clasificarBind('172.15.0.1')).toBe('EXPUESTO')
    expect(clasificarBind('172.32.0.1')).toBe('EXPUESTO')
    expect(clasificarBind('172.16.0.1')).toBe('LAN_PRIVADA')
    expect(clasificarBind('172.31.0.1')).toBe('LAN_PRIVADA')
  })

  it('una IP publica o un valor que no se entiende caen del lado seguro', () => {
    for (const bind of ['8.8.8.8', '200.51.1.1', 'cualquier-cosa', '', '999.1.1.1', '10.0.0']) {
      expect(clasificarBind(bind)).toBe('EXPUESTO')
    }
  })

  it('la advertencia aparece solo cuando hay algo que advertir, y dice que hacer', () => {
    expect(advertenciaDeBind('127.0.0.1')).toBeNull()
    expect(advertenciaDeBind('192.168.1.40')).toBeNull()

    const aviso = advertenciaDeBind('0.0.0.0')
    expect(aviso).not.toBeNull()
    // No alcanza con avisar: tiene que decir cual es la variable y que ponerle,
    // o el aviso se lee una vez y no se acciona nunca.
    expect(aviso).toContain('AOKI_AGENT_HTTP_BIND')
    expect(aviso).toContain('0.0.0.0')
  })
})

describe('el bind se avisa al arrancar y se ve en /health', () => {
  const BASE: OpcionesDelAgente = {
    siteId: 'SUC-TEST',
    agentId: 'AG-TEST',
    rutaDeBase: ':memory:',
    montarApi: true,
    simularPlc: true,
    httpPuerto: 0,
    httpBind: '127.0.0.1',
    zonaDePickeo: [],
    tokenDeMantenimiento: null,
    enlace: null,
  }

  async function levantar(
    httpBind: string,
  ): Promise<{ agente: Agente; base: string; logueado: RegistroDeLog[] }> {
    const logueado: RegistroDeLog[] = []
    const agente = crearAgente({
      ...BASE,
      httpBind,
      logger: crearLogger({
        componente: 'agente',
        nivelMinimo: 'DEBUG',
        ahoraMs: () => 0,
        emitir: (registro) => logueado.push(registro),
      }),
    })
    await agente.iniciar()
    const direccion = agente.direccion()
    if (direccion === null) {
      throw new Error('el agente no monto la API')
    }
    return { agente, base: `http://${direccion.host}:${String(direccion.puerto)}`, logueado }
  }

  it('con el bind abierto grita al arrancar pero ARRANCA IGUAL', async () => {
    // Que arranque es el punto. Abortar por un dato de configuracion dejaria al
    // robot sin trabajar, y eso es peor que la exposicion que se quiere evitar:
    // la sucursal opera supervisada y detras de su propio router.
    const { agente, base, logueado } = await levantar('0.0.0.0')

    try {
      const aviso = logueado.find((registro) => registro.evento === 'API_BIND_EXPUESTO')
      expect(aviso).toBeDefined()
      expect(aviso?.nivel).toBe('ERROR')

      // Y el agente quedo sirviendo: el aviso no lo dejo a medio levantar.
      expect((await fetch(`${base}/health`)).status).toBe(200)
    } finally {
      await agente.detener()
    }
  })

  it('/health dice en que direccion escucha y hasta donde llega', async () => {
    // Nadie mira la consola de la notebook. Que el alcance salga por health es
    // la diferencia entre enterarse y no enterarse de que la API quedo abierta.
    const { agente, base } = await levantar('0.0.0.0')

    try {
      const salud = (await (await fetch(`${base}/health`)).json()) as {
        data: { network: { bind: string; scope: string } }
      }
      expect(salud.data.network).toEqual({ bind: '0.0.0.0', scope: 'EXPUESTO' })
    } finally {
      await agente.detener()
    }
  })

  it('con un bind que no expone nada no hay aviso', async () => {
    // Loopback y no una IP de LAN porque el test tiene que poder ESCUCHAR en esa
    // direccion, y `192.168.x` no existe en la maquina que corre la suite. Que
    // un bind de LAN clasifique como LAN_PRIVADA lo afirman los unitarios de
    // arriba; lo que se prueba aca es el cableado: que el aviso no aparezca
    // cuando no corresponde y que el campo salga igual por health.
    const { agente, base, logueado } = await levantar('127.0.0.1')

    try {
      expect(logueado.filter((registro) => registro.evento === 'API_BIND_EXPUESTO')).toEqual([])

      const salud = (await (await fetch(`${base}/health`)).json()) as {
        data: { network: { bind: string; scope: string } }
      }
      expect(salud.data.network).toEqual({ bind: '127.0.0.1', scope: 'LOOPBACK' })
    } finally {
      await agente.detener()
    }
  })
})
