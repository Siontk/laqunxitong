/**
 * AccountRuntimeStore — 轻量账号运行状态标记。
 *
 * 用来区分“可自动接管上线”和“长期异常/终态，释放在线槽位”。
 * 不保存业务数据，只保存协议层调度需要的状态。
 */

import type { AccountState } from '../types/api.js'
import type { Logger } from '../observability/logger.js'
import type { RedisStoreAdapter } from './adapters/redis.js'

export interface AccountRuntimeRecord {
  accountId: string
  state: AccountState
  slotReleased: boolean
  reason?: string
  updatedAt: string
}

export class AccountRuntimeStore {
  constructor(
    private readonly l2: RedisStoreAdapter<AccountRuntimeRecord>,
    private readonly logger: Logger
  ) {}

  private k(accountId: string): string {
    return `runtime:${accountId}`
  }

  async mark(accountId: string, state: AccountState, slotReleased: boolean, reason?: string): Promise<void> {
    await this.l2.set(this.k(accountId), {
      accountId,
      state,
      slotReleased,
      reason,
      updatedAt: new Date().toISOString()
    }).catch(err => {
      this.logger.warn({ err, accountId, state }, 'runtime-store write failed')
    })
  }

  async get(accountId: string): Promise<AccountRuntimeRecord | null> {
    return this.l2.get(this.k(accountId)).catch(err => {
      this.logger.warn({ err, accountId }, 'runtime-store read failed')
      return null
    })
  }

  async clear(accountId: string): Promise<void> {
    await this.l2.delete(this.k(accountId)).catch(() => {})
  }
}
