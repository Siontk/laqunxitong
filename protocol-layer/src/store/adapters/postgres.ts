/**
 * L3 Postgres 适配器。
 *
 * 用途：
 *   - creds 长期持久化（每账号 ~10KB JSONB）
 *   - 周期 snapshot 写入
 *   - 跨 region 异步复制
 *
 * 表结构：
 *   CREATE TABLE creds_store (
 *     key TEXT PRIMARY KEY,
 *     value JSONB NOT NULL,
 *     expires_at TIMESTAMPTZ NULL,
 *     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 *   CREATE INDEX idx_creds_expires ON creds_store(expires_at) WHERE expires_at IS NOT NULL;
 */

import { Pool, type PoolClient } from 'pg'

import type { StoreAdapter } from './types.js'

export class PostgresStoreAdapter<TValue> implements StoreAdapter<TValue> {
  readonly layer = 'L3' as const

  constructor(
    private readonly pool: Pool,
    private readonly tableName: string = 'creds_store'
  ) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        expires_at TIMESTAMPTZ NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_expires
        ON ${this.tableName}(expires_at) WHERE expires_at IS NOT NULL;
    `)
  }

  async get(key: string): Promise<TValue | null> {
    const r = await this.pool.query<{ value: TValue; expires_at: Date | null }>(
      `SELECT value, expires_at FROM ${this.tableName} WHERE key = $1`,
      [key]
    )
    if (r.rowCount === 0) return null
    const row = r.rows[0]!
    if (row.expires_at && row.expires_at.getTime() < Date.now()) {
      await this.delete(key)
      return null
    }
    return row.value
  }

  async set(key: string, value: TValue, ttlSec?: number): Promise<void> {
    const expiresAt = ttlSec ? new Date(Date.now() + ttlSec * 1000) : null
    await this.pool.query(
      `INSERT INTO ${this.tableName} (key, value, expires_at, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
      [key, value, expiresAt]
    )
  }

  async delete(key: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.tableName} WHERE key = $1`, [key])
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.pool.query('SELECT 1 AS ok')
      return r.rowCount === 1
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  /** 事务支持（业务侧需要原子写多个 key 时） */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
}

export function createPostgresPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  })
}
