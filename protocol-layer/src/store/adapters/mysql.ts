/**
 * L3 MySQL 适配器。
 *
 * 用途：
 *   - creds 长期持久化（每账号约 10KB JSON）
 *   - 周期 snapshot 写入
 *   - 后续跨 region 复制 / 冷备恢复
 */

import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise'

import type { StoreAdapter } from './types.js'

interface StoreRow extends RowDataPacket {
  value: string | Record<string, unknown>
  expires_at: Date | null
}

function parseMysqlJson<TValue>(value: string | Record<string, unknown>): TValue | null {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as TValue
    } catch {
      return null
    }
  }
  return value as TValue
}

function assertSafeTableName(tableName: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(tableName)) {
    throw new Error(`unsafe mysql table name: ${tableName}`)
  }
}

export class MySqlStoreAdapter<TValue> implements StoreAdapter<TValue> {
  readonly layer = 'L3' as const

  constructor(
    private readonly pool: Pool,
    private readonly tableName: string = 'creds_store'
  ) {
    assertSafeTableName(tableName)
  }

  async ensureSchema(): Promise<void> {
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (
        \`key\` VARCHAR(255) PRIMARY KEY,
        \`value\` JSON NOT NULL,
        expires_at DATETIME(3) NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
          ON UPDATE CURRENT_TIMESTAMP(3),
        INDEX idx_${this.tableName}_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `)
  }

  async get(key: string): Promise<TValue | null> {
    const [rows] = await this.pool.execute<StoreRow[]>(
      `SELECT \`value\`, expires_at FROM \`${this.tableName}\` WHERE \`key\` = ? LIMIT 1`,
      [key]
    )
    const row = rows[0]
    if (!row) return null
    if (row.expires_at && row.expires_at.getTime() < Date.now()) {
      await this.delete(key)
      return null
    }
    return parseMysqlJson<TValue>(row.value)
  }

  async set(key: string, value: TValue, ttlSec?: number): Promise<void> {
    const expiresAt = ttlSec ? new Date(Date.now() + ttlSec * 1000) : null
    await this.pool.execute(
      `INSERT INTO \`${this.tableName}\` (\`key\`, \`value\`, expires_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE
         \`value\` = VALUES(\`value\`),
         expires_at = VALUES(expires_at),
         updated_at = CURRENT_TIMESTAMP(3)`,
      [key, JSON.stringify(value), expiresAt]
    )
  }

  async delete(key: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(`DELETE FROM \`${this.tableName}\` WHERE \`key\` = ?`, [key])
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null
  }

  async ping(): Promise<boolean> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>('SELECT 1 AS ok')
      return rows.length === 1
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async transaction<T>(fn: (client: PoolConnection) => Promise<T>): Promise<T> {
    const client = await this.pool.getConnection()
    try {
      await client.beginTransaction()
      const result = await fn(client)
      await client.commit()
      return result
    } catch (err) {
      await client.rollback()
      throw err
    } finally {
      client.release()
    }
  }
}

export interface MySqlPoolOptions {
  connectionLimit?: number
  maxIdle?: number
  idleTimeoutMs?: number
  connectTimeoutMs?: number
}

export function createMySqlPool(uri: string, options?: MySqlPoolOptions): Pool {
  return mysql.createPool({
    uri,
    connectionLimit: options?.connectionLimit ?? 8,
    maxIdle: options?.maxIdle ?? 4,
    idleTimeout: options?.idleTimeoutMs ?? 30_000,
    connectTimeout: options?.connectTimeoutMs ?? 5_000,
    waitForConnections: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  })
}
