/**
 * L2 Redis 适配器。
 *
 * 用途：
 *   - keys 主存储（每条消息 ratchet 都会触发写，写放大极高，必须用 Redis）
 *   - creds 跨节点共享（账号在 worker 间漂移时使用）
 *   - Registry 仲裁状态
 *
 * 序列化：JSON.stringify / JSON.parse，二进制字段已在上层做 base64。
 */

import { Redis, type Cluster } from 'ioredis'

import type { StoreAdapter } from './types.js'

export type RedisClient = Redis | Cluster

export class RedisStoreAdapter<TValue> implements StoreAdapter<TValue> {
  readonly layer = 'L2' as const

  constructor(
    private readonly client: RedisClient,
    public readonly keyPrefix: string = 'unsea:'
  ) {}

  private k(key: string): string {
    return `${this.keyPrefix}${key}`
  }

  async get(key: string): Promise<TValue | null> {
    const raw = await this.client.get(this.k(key))
    if (raw == null) return null
    try {
      return JSON.parse(raw) as TValue
    } catch {
      return null
    }
  }

  async set(key: string, value: TValue, ttlSec?: number): Promise<void> {
    const raw = JSON.stringify(value)
    if (ttlSec) {
      await this.client.set(this.k(key), raw, 'EX', ttlSec)
    } else {
      await this.client.set(this.k(key), raw)
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.k(key))
  }

  async has(key: string): Promise<boolean> {
    return (await this.client.exists(this.k(key))) > 0
  }

  async mget(keys: string[]): Promise<Array<TValue | null>> {
    if (keys.length === 0) return []
    const raws = await this.client.mget(keys.map(k => this.k(k)))
    return raws.map(r => {
      if (r == null) return null
      try {
        return JSON.parse(r) as TValue
      } catch {
        return null
      }
    })
  }

  async mset(entries: Array<{ key: string; value: TValue; ttlSec?: number }>): Promise<void> {
    if (entries.length === 0) return
    // 用 pipeline 批量执行
    const pipe = this.client.pipeline()
    for (const e of entries) {
      const raw = JSON.stringify(e.value)
      if (e.ttlSec) {
        pipe.set(this.k(e.key), raw, 'EX', e.ttlSec)
      } else {
        pipe.set(this.k(e.key), raw)
      }
    }
    await pipe.exec()
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.client.ping()
      return r === 'PONG'
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    if ('quit' in this.client) await this.client.quit()
  }

  raw(): RedisClient {
    return this.client
  }
}

/**
 * 构造 Redis 客户端（单机或 cluster）。
 * 集群模式下 URL 格式：redis://host1:port1,host2:port2,host3:port3
 */
export function createRedis(url: string, db: number = 0): RedisClient {
  if (url.includes(',')) {
    const nodes = url
      .replace(/^redis:\/\//, '')
      .split(',')
      .map(s => {
        const [host, port] = s.split(':')
        return { host: host ?? 'localhost', port: Number(port ?? 6379) }
      })
    return new Redis.Cluster(nodes, { redisOptions: { db } })
  }
  return new Redis(url, { db })
}
