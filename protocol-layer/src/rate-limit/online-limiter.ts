/**
 * 上线限流器 — 防止业务方一波 2000 并发 /online 把 libsignal CPU 打爆。
 *
 * 背景：
 *   - Node 是单线程，每个 worker 进程的 libsignal Noise 握手 ~ 20-50ms CPU
 *   - 单 worker 500 账号并发握手 = 15-25s 纯 CPU 在单核串行
 *   - 期间 event loop 卡死，心跳/重连/业务全部受影响
 *
 * 三层桶（结构对齐 ReconnectGate）：
 *   - account 级：1 个 token，60s 冷却 — 防同号反复 online
 *   - node 级：默认 50/s（4 worker × ~12/s 上线节奏）
 *   - global 级：默认 200/s（集群协调，多节点用同一全局桶）
 *
 * 2000 账号上线节奏估算：
 *   - 50/s × 节点 → 2000/50 = 40s 完成全部上线
 *   - 配合 libsignal 异步并行（~ 20ms 握手），实际 ~ 60s 端到端
 *   - 竞品 2 min 基线轻松达标
 */

import type { Config } from '../config.js'
import type { Logger } from '../observability/logger.js'
import type { RedisClient } from '../store/adapters/redis.js'
import { TokenBucket } from './token-bucket.js'

export interface OnlineGateDecision {
  allowed: boolean
  retryAfterMs: number | null
  reason: string | null
}

export class OnlineGate {
  private nodeBucket: TokenBucket
  private globalBucket: TokenBucket
  private accountBucket: TokenBucket

  constructor(
    private readonly config: Config,
    redis: RedisClient,
    private readonly logger: Logger
  ) {
    this.nodeBucket = new TokenBucket(redis, 'rl:online:node', {
      ratePerSec: config.rateLimit.nodeOnlinePerSec,
      capacity: config.rateLimit.nodeOnlineBurst
    })
    this.globalBucket = new TokenBucket(redis, 'rl:online:global', {
      ratePerSec: config.rateLimit.globalOnlinePerSec,
      capacity: Math.max(config.rateLimit.globalOnlinePerSec * 2, 100)
    })
    this.accountBucket = new TokenBucket(redis, 'rl:online:account', {
      ratePerSec: 1000 / Math.max(1, config.rateLimit.accountOnlineCooldownMs),
      capacity: 1
    })
  }

  /** 非阻塞尝试。允许通过 → allowed=true；否则带 retryAfterMs */
  async tryOnline(accountId: string): Promise<OnlineGateDecision> {
    const accountOk = await this.accountBucket.take(accountId)
    if (!accountOk.allowed) {
      return {
        allowed: false,
        retryAfterMs: this.config.rateLimit.accountOnlineCooldownMs,
        reason: 'account_online_cooldown'
      }
    }
    const globalOk = await this.globalBucket.take('global')
    if (!globalOk.allowed) {
      return {
        allowed: false,
        retryAfterMs: Math.ceil(1000 / Math.max(1, this.config.rateLimit.globalOnlinePerSec)),
        reason: 'global_online_limited'
      }
    }
    const nodeOk = await this.nodeBucket.take(this.config.nodeId)
    if (!nodeOk.allowed) {
      return {
        allowed: false,
        retryAfterMs: Math.ceil(1000 / Math.max(1, this.config.rateLimit.nodeOnlinePerSec)),
        reason: 'node_online_limited'
      }
    }
    return { allowed: true, retryAfterMs: null, reason: null }
  }

  /**
   * 阻塞等待最多 maxWaitMs，拿到三层 token 才返回 true。
   * 批量上线时用：单次提交 N 个，协议层按节奏化放行，业务方一次 await 拿全部结果。
   */
  async waitOnline(accountId: string, maxWaitMs: number = 60_000): Promise<boolean> {
    const accountOk = await this.accountBucket.acquire(accountId, 1, maxWaitMs)
    if (!accountOk) {
      this.logger.debug({ accountId }, 'online account cooldown wait timeout')
      return false
    }
    const globalOk = await this.globalBucket.acquire('global', 1, maxWaitMs)
    if (!globalOk) {
      this.logger.debug({ accountId }, 'online global wait timeout')
      return false
    }
    return this.nodeBucket.acquire(this.config.nodeId, 1, maxWaitMs)
  }
}
