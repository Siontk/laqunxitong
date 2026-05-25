/**
 * STALE Detector — § 4.7.2 半开 ws 兜底。
 *
 * worker 启动时启动一个 tick 定时器，每 staleCheckIntervalMs 跑一次：
 *   遍历所有 ONLINE 账号，如果 (now - lastDateRecv) > staleThresholdMs：
 *     → 强制 force-close ws → 转 STALE → 立即重连
 *
 * Baileys 自身的 keepAlive 也会在 keepAliveIntervalMs+5s 内主动 end(connectionLost)，
 * 这个 detector 是双保险，避免 keepAlive 定时器卡住的极端情况。
 */

import type { Logger } from '../observability/logger.js'
import type { Metrics } from '../observability/metrics.js'

export interface StaleObserver {
  /**
   * 获取所有当前应该处于 ONLINE 的账号的最后接收时间。
   * 返回 Map<accountId, lastDateRecvMs>
   */
  getOnlineLastRecvMap(): Map<string, number>

  /**
   * 标记账号为 STALE 并触发重连。
   */
  markStaleAndReconnect(accountId: string, ageMs: number): Promise<void>
}

export class StaleDetector {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly observer: StaleObserver,
    private readonly checkIntervalMs: number,
    private readonly thresholdMs: number,
    private readonly logger: Logger,
    private readonly metrics: Metrics
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch(err => this.logger.error({ err }, 'stale tick failed'))
    }, this.checkIntervalMs)
    this.logger.info(
      { checkIntervalMs: this.checkIntervalMs, thresholdMs: this.thresholdMs },
      'stale detector started'
    )
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    const map = this.observer.getOnlineLastRecvMap()
    const now = Date.now()
    for (const [accountId, lastRecv] of map) {
      const age = now - lastRecv
      if (age > this.thresholdMs) {
        this.metrics.staleDetectedTotal.inc()
        this.logger.warn({ accountId, ageMs: age }, 'STALE detected — forcing reconnect')
        await this.observer.markStaleAndReconnect(accountId, age).catch(err => {
          this.logger.error({ err, accountId }, 'markStaleAndReconnect failed')
        })
      }
    }
  }
}
