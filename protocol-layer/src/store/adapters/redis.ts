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

import { Redis, type Cluster, type RedisOptions } from 'ioredis'

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

export interface RedisClientOptions {
  /** 单条命令最长等待时间（默认 5s）。Redis 慢命令 / 网络抖动时 fail-fast，避免 Node 永远等。 */
  commandTimeoutMs?: number
  /** 单条命令最多重试次数（默认 3）。超过 → reject 命令，业务路径自己决定降级。 */
  maxRetriesPerRequest?: number
  /** Redis offline 时 client 内部 queue 上限（默认 1000）。
   *  超过 → 拒绝新命令，避免 Redis 长时间挂时 Node heap 撑爆。 */
  maxOfflineQueueSize?: number
  /** 连接握手超时（默认 5s） */
  connectTimeoutMs?: number
}

function isRedisClusterUrl(url: string): boolean {
  return url.includes(',') || /^rediss?:\/\/clustercfg\./i.test(url)
}

function parseRedisClusterNodes(url: string): Array<{ host: string; port: number }> {
  const protocol = url.startsWith('rediss://') ? 'rediss:' : 'redis:'
  return url
    .replace(/^rediss?:\/\//, '')
    .split(',')
    .map(s => {
      const u = new URL(`${protocol}//${s}`)
      return { host: u.hostname, port: Number(u.port || 6379) }
    })
}

/**
 * 构造 Redis 客户端（单机或 cluster）。
 * 集群模式下 URL 格式：
 *   - redis://host1:port1,host2:port2,host3:port3
 *   - rediss://clustercfg.xxx.cache.amazonaws.com:6379
 *
 * 默认参数针对单点测试环境调好：
 *   - commandTimeout=5s → Redis 慢命令不会让业务路径卡死
 *   - maxRetriesPerRequest=3 → 失败 3 次直接 reject，业务做降级
 *   - maxOfflineQueueSize=1000 → Redis 长时间挂时不会把 Node heap 撑爆
 *   - retryStrategy 指数退避 max 5s → 连接抖动时快速自愈，不疯狂打 syscall
 */
export function createRedis(
  url: string,
  db: number = 0,
  options?: RedisClientOptions
): RedisClient {
  const commandTimeout = options?.commandTimeoutMs ?? 5_000
  const maxRetriesPerRequest = options?.maxRetriesPerRequest ?? 3
  const maxOfflineQueueSize = options?.maxOfflineQueueSize ?? 1000
  const connectTimeout = options?.connectTimeoutMs ?? 5_000

  /**
   * 重连退避：50ms → 100ms → ... → 5s 封顶
   * Redis 真挂的话每 5s 试一次，不疯狂连。
   */
  const retryStrategy = (times: number): number => Math.min(50 * Math.pow(1.5, times), 5_000)

  /**
   * 出错时如果是 READONLY（主从切换）立即重连。
   * 返回 1 = 重连并 resend 命令；false = 不重连
   */
  const reconnectOnError = (err: Error): boolean | 1 | 2 => {
    const msg = err.message
    if (msg.includes('READONLY')) return 1
    return false
  }

  const useTls = url.startsWith('rediss://')

  if (isRedisClusterUrl(url)) {
    const nodes = parseRedisClusterNodes(url)
    return new Redis.Cluster(nodes, {
      redisOptions: {
        db,
        commandTimeout,
        maxRetriesPerRequest,
        connectTimeout,
        reconnectOnError,
        ...(useTls ? { tls: {} } : {})
      },
      clusterRetryStrategy: retryStrategy,
      enableOfflineQueue: true,
      enableReadyCheck: true
    })
  }
  const redisOpts: RedisOptions = {
    db,
    commandTimeout,
    maxRetriesPerRequest,
    connectTimeout,
    retryStrategy,
    reconnectOnError,
    enableOfflineQueue: true,
    enableReadyCheck: true,
    maxLoadingRetryTime: 10_000
  }
  // ioredis 没有 native maxOfflineQueueSize；offlineQueue 长度由 attachRedisGuards 自检
  return new Redis(url, redisOpts)
}

/**
 * 给 Redis client 装上 offline queue 上限保护 + 监控。
 * server.ts 启动时对每个 Redis 实例都调一次。
 */
export function attachRedisGuards(
  client: RedisClient,
  name: string,
  maxOfflineQueueSize: number,
  onError: (err: Error, name: string) => void
): void {
  const c = client as unknown as {
    offlineQueue?: unknown[]
    on(event: string, fn: (...args: unknown[]) => void): void
  }
  c.on('error', (err: unknown) => {
    onError(err as Error, name)
  })
  // 定期检查 offline queue 长度
  setInterval(() => {
    const queue = c.offlineQueue
    if (Array.isArray(queue) && queue.length > maxOfflineQueueSize) {
      onError(
        new Error(`redis client[${name}] offline queue overflow: ${queue.length} > ${maxOfflineQueueSize}`),
        name
      )
      // 截断队列（拒绝最老的命令）
      queue.splice(0, queue.length - maxOfflineQueueSize)
    }
  }, 5_000).unref()
}
