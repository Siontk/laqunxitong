/**
 * 重连控制器 — § 4.5 三类重连。
 *
 * 类型 A：计划性 IP 轮换 / 515 restart
 *         立即重连，无退避；不计入 reconnect 失败
 * 类型 B：意外断开（428/408 / 网络抖动）
 *         指数退避：5s → 30s → 2min → 10min → 冷却
 * 类型 C：终态错误（401 / 403 / badSession）
 *         不重连，直接 NEED_REAUTH
 *
 * 每次重连前要拿令牌（接 reconnect-limiter），令牌耗尽则等待。
 */

import type { Logger } from '../observability/logger.js'
import type { Metrics } from '../observability/metrics.js'
import type { ReconnectGate } from '../rate-limit/reconnect-limiter.js'

const BACKOFF_LADDER_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000]
const COOLDOWN_AFTER_ATTEMPTS = BACKOFF_LADDER_MS.length

export interface ReconnectExecutor {
  /** 实际执行 ws 重建（worker.account-manager 提供） */
  doReconnect(accountId: string): Promise<void>
  /** 重连退避耗尽后释放运行资源（可选） */
  onReconnectExhausted?(accountId: string, type: 'A' | 'B' | 'C', reason: string): Promise<void> | void
}

interface AccountReconnectState {
  attempt: number
  nextScheduledAt: number
  timer: NodeJS.Timeout | null
  inFlight: boolean
}

export class ReconnectController {
  private state = new Map<string, AccountReconnectState>()

  constructor(
    private readonly gate: ReconnectGate,
    private readonly executor: ReconnectExecutor,
    private readonly logger: Logger,
    private readonly metrics: Metrics
  ) {}

  /**
   * 注册一次重连请求。
   * type 决定退避策略和限流行为。
   */
  schedule(
    accountId: string,
    type: 'A' | 'B' | 'C',
    reason: string
  ): { willReconnect: boolean; delayMs: number } {
    if (type === 'C') {
      this.cancel(accountId)
      return { willReconnect: false, delayMs: 0 }
    }

    const s = this.getState(accountId)
    if (s.inFlight) {
      this.logger.debug({ accountId, type }, 'reconnect already in-flight, skip')
      return { willReconnect: true, delayMs: 0 }
    }

    let delay = 0
    if (type === 'A') {
      delay = Math.floor(Math.random() * 500) // 0-500ms jitter
      s.attempt = 0
    } else {
      if (s.attempt >= COOLDOWN_AFTER_ATTEMPTS) {
        this.logger.warn(
          { accountId, attempt: s.attempt },
          'reconnect cooldown — handed off to business layer'
        )
        return { willReconnect: false, delayMs: 0 }
      }
      delay = BACKOFF_LADDER_MS[s.attempt]!
      s.attempt++
    }

    s.nextScheduledAt = Date.now() + delay
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(() => {
      this.executeNow(accountId, type, reason).catch(err => {
        this.logger.error({ err, accountId }, 'reconnect execution failed')
      })
    }, delay)
    s.timer.unref?.()

    this.metrics.reconnectTotal.inc({ type, reason })
    this.logger.info({ accountId, type, reason, delayMs: delay, attempt: s.attempt }, 'reconnect scheduled')
    return { willReconnect: true, delayMs: delay }
  }

  /** 重连成功，清状态 */
  onSuccess(accountId: string): void {
    const s = this.state.get(accountId)
    if (s) {
      s.attempt = 0
      s.inFlight = false
      if (s.timer) clearTimeout(s.timer)
      s.timer = null
    }
  }

  /** 取消（账号下线 / logout 时） */
  cancel(accountId: string): void {
    const s = this.state.get(accountId)
    if (s?.timer) clearTimeout(s.timer)
    this.state.delete(accountId)
  }

  private async executeNow(
    accountId: string,
    type: 'A' | 'B' | 'C',
    reason: string
  ): Promise<void> {
    const s = this.getState(accountId)
    s.inFlight = true

    // 限流：A 不限流，B 必须拿令牌
    const allowed = await this.gate.waitReconnect(accountId, type, 10_000)
    if (!allowed) {
      this.logger.warn({ accountId, type }, 'reconnect token wait timeout')
      s.inFlight = false
      // 重新延迟一段时间再试
      this.schedule(accountId, type, `retry-after-token:${reason}`)
      return
    }

    const startedAt = Date.now()
    try {
      await this.executor.doReconnect(accountId)
      const durSec = (Date.now() - startedAt) / 1000
      this.metrics.reconnectDurationSec.observe({ type }, durSec)
      this.onSuccess(accountId)
    } catch (err) {
      this.logger.error({ err, accountId, type }, 'reconnect attempt failed')
      s.inFlight = false
      const retry = this.schedule(accountId, type, `attempt_failed:${reason}`)
      if (!retry.willReconnect) {
        await this.executor.onReconnectExhausted?.(accountId, type, reason)
      }
    }
  }

  private getState(accountId: string): AccountReconnectState {
    let s = this.state.get(accountId)
    if (!s) {
      s = { attempt: 0, nextScheduledAt: 0, timer: null, inFlight: false }
      this.state.set(accountId, s)
    }
    return s
  }

  /** 调度状态快照（运维用） */
  snapshot(): Record<string, { attempt: number; nextInMs: number; inFlight: boolean }> {
    const now = Date.now()
    const out: Record<string, { attempt: number; nextInMs: number; inFlight: boolean }> = {}
    for (const [id, s] of this.state) {
      out[id] = {
        attempt: s.attempt,
        nextInMs: Math.max(0, s.nextScheduledAt - now),
        inFlight: s.inFlight
      }
    }
    return out
  }
}
