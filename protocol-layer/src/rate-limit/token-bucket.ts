/**
 * Redis 令牌桶（Lua 实现，保证原子性）。
 *
 * 用于：
 *   - 节点级重连限流（nodeReconnectPerSec）
 *   - 全局集群级重连限流（globalReconnectPerSec）
 *   - 冷启动批次限流
 *
 * 参数：rate=每秒补充令牌数，capacity=桶容量（突发上限）
 *
 * Lua 脚本保证 take + 时间戳更新原子完成。
 */

import type { RedisClient } from '../store/adapters/redis.js'

const TAKE_LUA = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local last_ts = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  last_ts = now_ms
end

local delta = math.max(0, now_ms - last_ts) / 1000
tokens = math.min(capacity, tokens + delta * rate)

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now_ms)
redis.call('EXPIRE', key, math.ceil(capacity / rate) + 60)

return { allowed, tokens }
`

export interface TokenBucketParams {
  /** 每秒补充令牌 */
  ratePerSec: number
  /** 桶容量（突发上限） */
  capacity: number
}

export class TokenBucket {
  constructor(
    private readonly client: RedisClient,
    private readonly keyPrefix: string,
    private readonly defaults: TokenBucketParams
  ) {}

  /**
   * 尝试取 cost 个令牌。
   * 返回 { allowed: boolean, tokensRemaining: number }
   */
  async take(
    bucketKey: string,
    cost: number = 1,
    overrideParams?: Partial<TokenBucketParams>
  ): Promise<{ allowed: boolean; tokensRemaining: number }> {
    const rate = overrideParams?.ratePerSec ?? this.defaults.ratePerSec
    const capacity = overrideParams?.capacity ?? this.defaults.capacity
    const fullKey = `${this.keyPrefix}:${bucketKey}`

    const result = (await this.client.eval(
      TAKE_LUA,
      1,
      fullKey,
      String(rate),
      String(capacity),
      String(Date.now()),
      String(cost)
    )) as [number, number]
    return { allowed: result[0] === 1, tokensRemaining: result[1] }
  }

  /**
   * 阻塞等待令牌（最多等 maxWaitMs）。
   * 使用指数退避轮询；生产环境如果延迟敏感建议改用 Redis pub/sub 通知。
   */
  async acquire(
    bucketKey: string,
    cost: number = 1,
    maxWaitMs: number = 5000
  ): Promise<boolean> {
    const start = Date.now()
    let backoff = 50
    while (Date.now() - start < maxWaitMs) {
      const { allowed } = await this.take(bucketKey, cost)
      if (allowed) return true
      await new Promise(r => setTimeout(r, backoff))
      backoff = Math.min(500, backoff * 1.5)
    }
    return false
  }
}
