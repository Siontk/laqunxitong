/**
 * 13 状态机 — § 4.4 + § 4.7.2。
 *
 * 状态：NEW / IMPORTED / PAIRING / VERIFYING / ONLINE / STALE / OFFLINE
 *       RECONNECTING / PROXY_FAILED / RATE_LIMITED / NEED_REAUTH / LOGGED_OUT / DEVICE_REMOVED
 *
 * 设计原则：
 *   - 单 worker 内串行（无并发竞态）
 *   - 每次变迁必有 evidence + 触发事件 publishOnTransition
 *   - 业务层只看 state，不看 ws 内部细节
 */

import type { AccountState } from '../types/api.js'

export interface StateTransition {
  from: AccountState
  to: AccountState
  reason: string
  rawCode?: number
  rawReason?: string
  semantic?: string
  occurredAt: string
}

/**
 * 合法状态转换矩阵。任何不在表里的转换视为 bug 抛错。
 */
const VALID_TRANSITIONS: Record<AccountState, AccountState[]> = {
  NEW: ['IMPORTED', 'PAIRING'],
  IMPORTED: ['VERIFYING', 'OFFLINE', 'NEED_REAUTH'],
  PAIRING: ['VERIFYING', 'NEED_REAUTH', 'OFFLINE'],
  VERIFYING: ['ONLINE', 'RECONNECTING', 'OFFLINE', 'NEED_REAUTH', 'PROXY_FAILED'],
  ONLINE: [
    'STALE',
    'RECONNECTING',
    'OFFLINE',
    'PROXY_FAILED',
    'RATE_LIMITED',
    'NEED_REAUTH',
    'LOGGED_OUT',
    'DEVICE_REMOVED'
  ],
  STALE: ['RECONNECTING'],
  OFFLINE: ['VERIFYING', 'RECONNECTING', 'LOGGED_OUT', 'NEED_REAUTH'],
  RECONNECTING: ['VERIFYING', 'ONLINE', 'OFFLINE', 'PROXY_FAILED', 'RATE_LIMITED', 'NEED_REAUTH'],
  PROXY_FAILED: ['RECONNECTING', 'OFFLINE'],
  RATE_LIMITED: ['RECONNECTING', 'OFFLINE'],
  NEED_REAUTH: ['PAIRING', 'LOGGED_OUT'],
  LOGGED_OUT: ['NEW', 'IMPORTED'],
  DEVICE_REMOVED: ['NEW']
}

export class StateMachine {
  private current: AccountState = 'NEW'
  private history: StateTransition[] = []

  constructor(
    public readonly accountId: string,
    initial: AccountState = 'NEW'
  ) {
    this.current = initial
  }

  get state(): AccountState {
    return this.current
  }

  get lastTransition(): StateTransition | null {
    return this.history[this.history.length - 1] ?? null
  }

  canTransitionTo(target: AccountState): boolean {
    return VALID_TRANSITIONS[this.current]?.includes(target) ?? false
  }

  /**
   * 执行状态转换，返回是否真的发生了变化。
   * 非法转换抛 InvalidTransitionError。
   */
  transitionTo(
    target: AccountState,
    reason: string,
    detail?: { rawCode?: number; rawReason?: string; semantic?: string }
  ): StateTransition | null {
    if (target === this.current) return null

    if (!this.canTransitionTo(target)) {
      throw new InvalidTransitionError(this.accountId, this.current, target, reason)
    }

    const t: StateTransition = {
      from: this.current,
      to: target,
      reason,
      rawCode: detail?.rawCode,
      rawReason: detail?.rawReason,
      semantic: detail?.semantic,
      occurredAt: new Date().toISOString()
    }
    this.history.push(t)
    if (this.history.length > 50) this.history.shift()
    this.current = target
    return t
  }

  /** 业务侧能否下发任务（必须 ONLINE） */
  isUsable(): boolean {
    return this.current === 'ONLINE'
  }

  /** 是否已死（终态，不再重连） */
  isTerminal(): boolean {
    return this.current === 'NEED_REAUTH' || this.current === 'LOGGED_OUT' || this.current === 'DEVICE_REMOVED'
  }

  /** 是否需要重新授权 */
  needsReauth(): boolean {
    return this.current === 'NEED_REAUTH'
  }

  recentHistory(n: number = 10): StateTransition[] {
    return this.history.slice(-n)
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly accountId: string,
    public readonly from: AccountState,
    public readonly to: AccountState,
    public readonly reason: string
  ) {
    super(`invalid state transition for ${accountId}: ${from} → ${to} (${reason})`)
    this.name = 'InvalidTransitionError'
  }
}
