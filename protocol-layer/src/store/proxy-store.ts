/**
 * ProxyStore — 账号 → ProxyBinding 持久化。
 *
 * 设计：
 *   - 中等写频（每次 /proxy/bind 或 /proxy/rebind 触发）
 *   - 必须跨 worker 可见（账号漂移时新 worker 需要读到 binding）
 *   - 主存 L2 Redis（unsea:proxy:{accountId}），L1 内存做热缓存
 *
 * 不进 L3 PG —— binding 元数据由业务层 ProxyAllocator 持有，
 * 协议层只需要能"拿到当前应该用什么"即可。
 */

import type { ProxyBinding } from '../types/api.js'
import type { Logger } from '../observability/logger.js'
import { MemoryStoreAdapter } from './adapters/memory.js'
import type { RedisStoreAdapter } from './adapters/redis.js'

export interface ProxyBindingRecord extends ProxyBinding {
  boundAt: string
  lastRotatedAt?: string
  status: 'active' | 'migrating' | 'blacklisted' | 'dead'
}

export interface ProxyStoreDeps {
  l1?: MemoryStoreAdapter<ProxyBindingRecord>
  l2?: RedisStoreAdapter<ProxyBindingRecord>
  logger: Logger
}

export class ProxyStore {
  private l1: MemoryStoreAdapter<ProxyBindingRecord>
  private l2?: RedisStoreAdapter<ProxyBindingRecord>
  private logger: Logger

  constructor(deps: ProxyStoreDeps) {
    this.l1 = deps.l1 ?? new MemoryStoreAdapter<ProxyBindingRecord>(50_000)
    this.l2 = deps.l2
    this.logger = deps.logger
  }

  private k(accountId: string): string {
    return `proxy:${accountId}`
  }

  async get(accountId: string): Promise<ProxyBindingRecord | null> {
    const fromL1 = await this.l1.get(this.k(accountId))
    if (fromL1) return fromL1
    if (this.l2) {
      const fromL2 = await this.l2.get(this.k(accountId)).catch(err => {
        this.logger.warn({ err, accountId }, 'proxy-store L2 read failed')
        return null
      })
      if (fromL2) {
        await this.l1.set(this.k(accountId), fromL2)
        return fromL2
      }
    }
    return null
  }

  async bind(accountId: string, binding: ProxyBinding): Promise<ProxyBindingRecord> {
    const record: ProxyBindingRecord = {
      ...binding,
      boundAt: new Date().toISOString(),
      status: 'active'
    }
    await this.l1.set(this.k(accountId), record)
    if (this.l2) {
      await this.l2.set(this.k(accountId), record).catch(err => {
        this.logger.warn({ err, accountId }, 'proxy-store L2 write failed')
      })
    }
    this.logger.info({ accountId, sessionId: binding.sessionId, country: binding.country }, 'proxy bound')
    return record
  }

  async markRotated(accountId: string): Promise<void> {
    const existing = await this.get(accountId)
    if (!existing) return
    existing.lastRotatedAt = new Date().toISOString()
    await this.l1.set(this.k(accountId), existing)
    if (this.l2) {
      await this.l2.set(this.k(accountId), existing).catch(() => {})
    }
  }

  async markStatus(
    accountId: string,
    status: ProxyBindingRecord['status']
  ): Promise<void> {
    const existing = await this.get(accountId)
    if (!existing) return
    existing.status = status
    await this.l1.set(this.k(accountId), existing)
    if (this.l2) {
      await this.l2.set(this.k(accountId), existing).catch(() => {})
    }
  }

  async delete(accountId: string): Promise<void> {
    await this.l1.delete(this.k(accountId))
    if (this.l2) await this.l2.delete(this.k(accountId)).catch(() => {})
  }
}
