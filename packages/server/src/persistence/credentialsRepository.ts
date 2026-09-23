// RF32 — Credenciales por sucursal y presencia del agente.
//
// El secreto se guarda CIFRADO, no hasheado. La diferencia no es de gusto: el
// servidor autentica verificando la firma HMAC del request, y para eso tiene que
// poder recomputarla, o sea recuperar el secreto. Con un hash lo unico que podia
// hacer era pedirle el secreto al cliente y compararlo, que es como quedo RF26
// hasta aca: el secreto viajaba en claro en cada llamada y la firma no
// autenticaba nada, porque quien podia firmar ya se habia identificado
// mandandolo.
//
// El cifrado en reposo cubre lo que cubria el hash: quien lee la base sin tener
// la clave del entorno del servidor no puede hacerse pasar por una sucursal.

import type { Result } from '@aoki-one/domain'

import { cifrar, descifrar, type ClaveDeCifrado, type ErrorDeDescifrado } from './cifrado.js'
import type { BaseDelServidor } from './database.js'

export interface CredencialDeAgente {
  readonly keyId: string
  readonly siteId: string
  readonly revocadaEn: number | null
  readonly ultimoVisto: number | null
}

/** La credencial mas el material con el que se verifica su firma. Nunca sale de la API. */
export interface SecretoDeSucursal {
  readonly credencial: CredencialDeAgente
  readonly secreto: string
}

export type FalloDeCredencial =
  | { readonly codigo: 'INEXISTENTE' }
  | { readonly codigo: 'REVOCADA' }
  /**
   * La fila esta, pero no se puede descifrar: la clave del entorno no es la que
   * cifro, o la fila esta alterada. Es un fallo DEL SERVIDOR, no del cliente, y
   * por eso se distingue de "credencial invalida".
   */
  | { readonly codigo: 'SECRETO_ILEGIBLE'; readonly motivo: ErrorDeDescifrado['codigo'] }

export interface Presencia {
  readonly siteId: string
  readonly agentId: string
  readonly ultimoLatido: number
  readonly estado: Readonly<Record<string, unknown>>
}

export interface CredentialsRepository {
  readonly alta: (keyId: string, siteId: string, secreto: string) => Promise<CredencialDeAgente>
  /**
   * Resuelve el secreto por keyId para verificar una firma.
   *
   * Es el reemplazo de la vieja `verificar(keyId, secreto)`: el secreto no entra
   * por parametro porque no llega del cliente, sale de aca.
   */
  readonly resolverSecreto: (keyId: string) => Promise<Result<SecretoDeSucursal, FalloDeCredencial>>
  readonly buscar: (keyId: string) => Promise<CredencialDeAgente | undefined>
  readonly revocar: (keyId: string, ahoraMs: number) => Promise<void>
  readonly registrarLatido: (presencia: Presencia) => Promise<void>
  readonly presencias: () => Promise<readonly Presencia[]>
}

interface FilaDeCredencial {
  readonly key_id: string
  readonly site_id: string
  readonly secreto_cifrado: string
  readonly revocada_en: number | null
  readonly ultimo_visto: number | null
}

interface FilaDePresencia {
  readonly site_id: string
  readonly agent_id: string
  readonly ultimo_latido: number
  readonly estado_json: string
}

export function crearCredentialsRepository(
  base: BaseDelServidor,
  clave: ClaveDeCifrado,
): CredentialsRepository {
  const { sql } = base

  function aCredencial(fila: FilaDeCredencial): CredencialDeAgente {
    return {
      keyId: fila.key_id,
      siteId: fila.site_id,
      revocadaEn: fila.revocada_en,
      ultimoVisto: fila.ultimo_visto,
    }
  }

  function buscarFila(keyId: string): FilaDeCredencial | undefined {
    const fila = sql.prepare('SELECT * FROM agent_credentials WHERE key_id = ?').get(keyId)
    return fila === undefined ? undefined : (fila as FilaDeCredencial)
  }

  return {
    alta: (keyId, siteId, secreto) => {
      sql
        .prepare(
          `INSERT INTO agent_credentials (key_id, site_id, secreto_cifrado, revocada_en, ultimo_visto)
           VALUES (?, ?, ?, NULL, NULL)
           ON CONFLICT(key_id) DO UPDATE SET
             site_id = excluded.site_id,
             secreto_cifrado = excluded.secreto_cifrado,
             revocada_en = NULL`,
        )
        .run(keyId, siteId, cifrar(clave, secreto))
      return Promise.resolve({ keyId, siteId, revocadaEn: null, ultimoVisto: null })
    },

    resolverSecreto: (keyId) => {
      const fila = buscarFila(keyId)
      if (fila === undefined) {
        return Promise.resolve({ ok: false, error: { codigo: 'INEXISTENTE' } })
      }
      if (fila.revocada_en !== null) {
        return Promise.resolve({ ok: false, error: { codigo: 'REVOCADA' } })
      }

      const secreto = descifrar(clave, fila.secreto_cifrado)
      if (!secreto.ok) {
        return Promise.resolve({
          ok: false,
          error: { codigo: 'SECRETO_ILEGIBLE', motivo: secreto.error.codigo },
        })
      }

      return Promise.resolve({
        ok: true,
        valor: { credencial: aCredencial(fila), secreto: secreto.valor },
      })
    },

    buscar: (keyId) => {
      const fila = buscarFila(keyId)
      return Promise.resolve(fila === undefined ? undefined : aCredencial(fila))
    },

    revocar: (keyId, ahoraMs) => {
      sql.prepare('UPDATE agent_credentials SET revocada_en = ? WHERE key_id = ?').run(ahoraMs, keyId)
      return Promise.resolve()
    },

    registrarLatido: (presencia) => {
      sql
        .prepare(
          `INSERT INTO agent_heartbeats (site_id, agent_id, ultimo_latido, estado_json)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(site_id) DO UPDATE SET
             agent_id = excluded.agent_id,
             ultimo_latido = excluded.ultimo_latido,
             estado_json = excluded.estado_json`,
        )
        .run(
          presencia.siteId,
          presencia.agentId,
          presencia.ultimoLatido,
          JSON.stringify(presencia.estado),
        )
      sql
        .prepare('UPDATE agent_credentials SET ultimo_visto = ? WHERE site_id = ?')
        .run(presencia.ultimoLatido, presencia.siteId)
      return Promise.resolve()
    },

    presencias: () =>
      Promise.resolve(
        sql
          .prepare('SELECT * FROM agent_heartbeats ORDER BY site_id')
          .all()
          .map((fila: unknown) => {
            const f = fila as FilaDePresencia
            return {
              siteId: f.site_id,
              agentId: f.agent_id,
              ultimoLatido: f.ultimo_latido,
              estado: JSON.parse(f.estado_json) as Readonly<Record<string, unknown>>,
            }
          }),
      ),
  }
}
