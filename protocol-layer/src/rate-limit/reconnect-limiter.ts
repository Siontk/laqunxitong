/**
 * 重连限流器（接 § 4.5 重连风暴控制）。
 *
 * 两层桶：
 *   - 节点级 `node:{nodeId}` — 单机最大并发重连（默认 10/s）
 *   - 全局级 `global` — 整个集群最大并发重连（默认 50/s）
 *
 * 类型 A（计划性 IP 轮换）不走限流，直接重连
 * 类型 B（意外断开）必须经过两层桶
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

  /**
   * 阻塞等待（用于退避循环里）
   */
  waitReconnect(accountId: string, type: 'A' | 'B' | 'C', maxWaitMs?: number): Promise<boolean>
}

export class TokenBucketReconnectGate implements ReconnectGate {
  private nodeBucket: TokenBucket
  private globalBucket: TokenBucket

  constructor(
    private readonly config: Config,
    private readonly redis: RedisClient,
    private readonly logger: Logger
  ) {
    this.nodeBucket = new TokenBucket(redis, 'rl:reconnect:node', {
      ratePerSec: config.rateLimit.nodeReconnectPerSec,
      capacity: config.rateLimit.nodeReconnectPerSec * 2
    })
    this.globalBucket = new TokenBucket(redis, 'rl:reconnect:global', {
      ratePerSec: config.rateLimit.globalReconnectPerSec,
      capacity: config.rateLimit.globalReconnectPerSec * 2
    })
  }

  async tryReconnect(accountId: string, type: 'A' | 'B' | 'C'): Promise<boolean> {
    // 类型 A 立即重连，不限流（计划性 IP 轮换，本来就预期高频）
    if (type === 'A') return true
    // 类型 C 不重连
    if (type === 'C') return false

    // 类型 B 走双层桶
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
    if (type === 'A') return true
    if (type === 'C') return false
    const globalOk = await this.globalBucket.acquire('global', 1, maxWaitMs)
    if (!globalOk) {
      this.logger.warn({ accountId }, 'global bucket timeout')
      return false
    }
    return this.nodeBucket.acquire(this.config.nodeId, 1, maxWaitMs)
  }
}
