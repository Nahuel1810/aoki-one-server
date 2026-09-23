// RF32 — Credenciales por sucursal y presencia del agente.
//
// El secreto se guarda HASHEADO. Con el secreto en claro, cualquiera que lea la
// base (un backup, un dump, un join mal hecho en un log) puede firmar pedidos
// como si fuera la sucursal.

import { createHash } from 'node:crypto'

import type { BaseDelServidor } from './database.js'

export interface CredencialDeAgente {
  readonly keyId: string
  readonly siteId: string
  readonly revocadaEn: number | null
  readonly ultimoVisto: number | null
}

export interface Presencia {
  readonly siteId: string
  readonly agentId: string
  readonly ultimoLatido: number
  readonly estado: Readonly<Record<string, unknown>>
}

export interface CredentialsRepository {
  readonly alta: (keyId: string, siteId: string, secreto: string) => Promise<CredencialDeAgente>
  /** Devuelve la credencial solo si el secreto coincide y no esta revocada. */
  readonly verificar: (keyId: string, secreto: string) => Promise<CredencialDeAgente | undefined>
  readonly buscar: (keyId: string) => Promise<CredencialDeAgente | undefined>
  readonly revocar: (keyId: string, ahoraMs: number) => Promise<void>
  readonly registrarLatido: (presencia: Presencia) => Promise<void>
  readonly presencias: () => Promise<readonly Presencia[]>
}

export function hashearSecreto(secreto: string): string {
  return createHash('sha256').update(secreto, 'utf8').digest('hex')
}

interface FilaDeCredencial {
  readonly key_id: string
  readonly site_id: string
  readonly secreto_hash: string
  readonly revocada_en: number | null
  readonly ultimo_visto: number | null
}

interface FilaDePresencia {
  readonly site_id: string
  readonly agent_id: string
  readonly ultimo_latido: number
  readonly estado_json: string
}

export function crearCredentialsRepository(base: BaseDelServidor): CredentialsRepository {
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
          `INSERT INTO agent_credentials (key_id, site_id, secreto_hash, revocada_en, ultimo_visto)
           VALUES (?, ?, ?, NULL, NULL)
           ON CONFLICT(key_id) DO UPDATE SET
             site_id = excluded.site_id,
             secreto_hash = excluded.secreto_hash,
             revocada_en = NULL`,
        )
        .run(keyId, siteId, hashearSecreto(secreto))
      return Promise.resolve({ keyId, siteId, revocadaEn: null, ultimoVisto: null })
    },

    verificar: (keyId, secreto) => {
      const fila = buscarFila(keyId)
      if (fila === undefined || fila.revocada_en !== null) {
        return Promise.resolve(undefined)
      }
      if (fila.secreto_hash !== hashearSecreto(secreto)) {
        return Promise.resolve(undefined)
      }
      return Promise.resolve(aCredencial(fila))
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
