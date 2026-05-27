/**
 * 重连限流器（接 § 4.5 重连风暴控制）。
 *
 * 三层桶：
 *   - 账号级 `account:{accountId}` — 单号冷却，避免换 IP / 异常状态重复重连
 *   - 节点级 `node:{nodeId}` — 单机最大并发重连（默认 10/s）
 *   - 全局级 `global` — 整个集群最大并发重连（默认 50/s）
 *
 * 类型 A（计划性 IP 轮换 / stale）走账号级冷却
 * 类型 B（意外断开）必须经过三层桶
 * 类型 C（终态错误）不重连
 */

import type { Config } from '../config.js'
import type { Logger } from '../observability/logger.js'
import type { RedisClient } from '../store/adapters/redis.js'
import { TokenBucket } from './token-bucket.js'

export interface ReconnectGate {
  /**
   * 尝试获取重连令牌。
   * @param accountId 用于打日志
   * @param type      重连分类（来自 § 4.5）
   * @returns        true=放行，false=阻塞
   */
  tryReconnect(accountId: string, type: 'A' | 'B' | 'C'): Promise<boolean>

  tryManualReconnect(accountId: string): Promise<{
    allowed: boolean
    retryAfterMs: number | null
    cooldownUntil: string | null
    reason: string | null
  }>

  /**
   * 阻塞等待（用于退避循环里）
   */
  waitReconnect(accountId: string, type: 'A' | 'B' | 'C', maxWaitMs?: number): Promise<boolean>
}

export class TokenBucketReconnectGate implements ReconnectGate {
  private nodeBucket: TokenBucket
  private globalBucket: TokenBucket
  private accountBucket: TokenBucket

  constructor(
    private readonly config: Config,
    private readonly redis: RedisClient,
    private readonly logger: Logger
  ) {
    this.nodeBucket = new TokenBucket(redis, 'rl:reconnect:node', {
      ratePerSec: config.rateLimit.nodeReconnectPerSec,
      capacity: Math.max(config.rateLimit.reconnectBurst, config.rateLimit.nodeReconnectPerSec * 2)
    })
    this.globalBucket = new TokenBucket(redis, 'rl:reconnect:global', {
      ratePerSec: config.rateLimit.globalReconnectPerSec,
      capacity: Math.max(config.rateLimit.reconnectBurst, config.rateLimit.globalReconnectPerSec * 2)
    })
    this.accountBucket = new TokenBucket(redis, 'rl:reconnect:account', {
      ratePerSec: 1000 / Math.max(1, config.rateLimit.accountReconnectCooldownMs),
      capacity: 1
    })
  }

  async tryManualReconnect(accountId: string): Promise<{ allowed: boolean; retryAfterMs: number | null; cooldownUntil: string | null; reason: string | null }> {
    const accountOk = await this.accountBucket.take(accountId)
    if (!accountOk.allowed) {
      const retryAfterMs = this.config.rateLimit.accountReconnectCooldownMs
      return {
        allowed: false,
        retryAfterMs,
        cooldownUntil: new Date(Date.now() + retryAfterMs).toISOString(),
        reason: 'account_reconnect_cooldown'
      }
    }
    const globalOk = await this.globalBucket.take('global')
    if (!globalOk.allowed) {
      const retryAfterMs = Math.ceil(1000 / Math.max(1, this.config.rateLimit.globalReconnectPerSec))
      return {
        allowed: false,
        retryAfterMs,
        cooldownUntil: new Date(Date.now() + retryAfterMs).toISOString(),
        reason: 'global_reconnect_limited'
      }
    }
    const nodeOk = await this.nodeBucket.take(this.config.nodeId)
    if (!nodeOk.allowed) {
      const retryAfterMs = Math.ceil(1000 / Math.max(1, this.config.rateLimit.nodeReconnectPerSec))
      return {
        allowed: false,
        retryAfterMs,
        cooldownUntil: new Date(Date.now() + retryAfterMs).toISOString(),
        reason: 'worker_reconnect_limited'
      }
    }
    return { allowed: true, retryAfterMs: null, cooldownUntil: null, reason: null }
  }

  async tryReconnect(accountId: string, type: 'A' | 'B' | 'C'): Promise<boolean> {
    // 类型 A 也走 account cooldown，避免换 IP 或 STALE 风暴把单号打爆。
    if (type === 'A') {
      const accountOk = await this.accountBucket.take(accountId)
      if (!accountOk.allowed) {
        this.logger.debug({ accountId, type }, 'account reconnect cooldown active')
        return false
      }
      return true
    }
    // 类型 C 不重连
    if (type === 'C') return false

    // 类型 B 走 account + global + node 三层桶
    const accountOk = await this.accountBucket.take(accountId)
    if (!accountOk.allowed) {
      this.logger.debug({ accountId, type, remaining: accountOk.tokensRemaining }, 'account reconnect cooldown active')
      return false
    }
    const globalOk = await this.globalBucket.take('global')
    if (!globalOk.allowed) {
      this.logger.debug({ accountId, type, remaining: globalOk.tokensRemaining }, 'global bucket exhausted')
      return false
    }
    const nodeOk = await this.nodeBucket.take(this.config.nodeId)
    if (!nodeOk.allowed) {
      this.logger.debug({ accountId, type, remaining: nodeOk.tokensRemaining }, 'node bucket exhausted')
      return false
    }
    return true
  }

  async waitReconnect(
    accountId: string,
    type: 'A' | 'B' | 'C',
    maxWaitMs: number = 5000
  ): Promise<boolean> {
    if (type === 'C') return false
    const accountOk = await this.accountBucket.acquire(accountId, 1, maxWaitMs)
    if (!accountOk) {
      this.logger.warn({ accountId, type }, 'account reconnect cooldown timeout')
      return false
    }
    if (type === 'A') return true
    const globalOk = await this.globalBucket.acquire('global', 1, maxWaitMs)
    if (!globalOk) {
      this.logger.warn({ accountId }, 'global bucket timeout')
      return false
    }
    return this.nodeBucket.acquire(this.config.nodeId, 1, maxWaitMs)
  }
}
