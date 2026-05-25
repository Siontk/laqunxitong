/**
 * CredsStore — 三层组合，专用于 Baileys creds（auth_state 主体）。
 *
 * 读策略：L1 → L2 → L3，命中即回写上层
 * 写策略：
 *   - creds 变更立即三层同写（creds 变化频率低，每次 pairing/版本升级才动）
 *   - 异步双写：L1 同步 + L2 同步 + L3 异步（业务可用性优先）
 *
 * 落到 § 2 SessionStore 设计 + § 11.3.3 存储拆分。
 */

import type { Metrics } from '../observability/metrics.js'
import type { Logger } from '../observability/logger.js'
import { MemoryStoreAdapter } from './adapters/memory.js'
import type { RedisStoreAdapter } from './adapters/redis.js'
import type { PostgresStoreAdapter } from './adapters/postgres.js'

/** Baileys creds 结构（来自 openapi BaileysAuthState.creds） */
export type CredsRecord = Record<string, unknown>

export interface CredsStoreDeps {
  l1?: MemoryStoreAdapter<CredsRecord>
  l2?: RedisStoreAdapter<CredsRecord>
  l3?: PostgresStoreAdapter<CredsRecord>
  metrics: Metrics
  logger: Logger
}

export class CredsStore {
  private l1: MemoryStoreAdapter<CredsRecord>
  private l2?: RedisStoreAdapter<CredsRecord>
  private l3?: PostgresStoreAdapter<CredsRecord>
  private metrics: Metrics
  private logger: Logger
  private hits = 0
  private misses = 0

  constructor(deps: CredsStoreDeps) {
    this.l1 = deps.l1 ?? new MemoryStoreAdapter<CredsRecord>(50_000)
    this.l2 = deps.l2
    this.l3 = deps.l3
    this.metrics = deps.metrics
    this.logger = deps.logger
    setInterval(() => this.reportHitRatio(), 30_000).unref()
  }

  private keyFor(accountId: string): string {
    return `creds:${accountId}`
  }

  async load(accountId: string): Promise<CredsRecord | null> {
    const key = this.keyFor(accountId)

    // L1
    const fromL1 = await this.l1.get(key)
    if (fromL1) {
      this.hits++
      this.metrics.credsStoreOps.inc({ op: 'read', layer: 'L1', result: 'hit' })
      return fromL1
    }
    this.metrics.credsStoreOps.inc({ op: 'read', layer: 'L1', result: 'miss' })

    // L2
    if (this.l2) {
      const fromL2 = await this.l2.get(key).catch(err => {
        this.logger.warn({ err, accountId }, 'L2 read failed')
        this.metrics.credsStoreOps.inc({ op: 'read', layer: 'L2', result: 'error' })
        return null
      })
      if (fromL2) {
        this.hits++
        this.metrics.credsStoreOps.inc({ op: 'read', layer: 'L2', result: 'hit' })
        await this.l1.set(key, fromL2)
        return fromL2
      }
      this.metrics.credsStoreOps.inc({ op: 'read', layer: 'L2', result: 'miss' })
    }

    // L3
    if (this.l3) {
      const fromL3 = await this.l3.get(key).catch(err => {
        this.logger.warn({ err, accountId }, 'L3 read failed')
        this.metrics.credsStoreOps.inc({ op: 'read', layer: 'L3', result: 'error' })
        return null
      })
      if (fromL3) {
        this.hits++
        this.metrics.credsStoreOps.inc({ op: 'read', layer: 'L3', result: 'hit' })
        await this.l1.set(key, fromL3)
        if (this.l2) await this.l2.set(key, fromL3).catch(() => {})
        return fromL3
      }
      this.metrics.credsStoreOps.inc({ op: 'read', layer: 'L3', result: 'miss' })
    }

    this.misses++
    return null
  }

  async save(accountId: string, creds: CredsRecord): Promise<void> {
    const key = this.keyFor(accountId)
    // L1 同步
    await this.l1.set(key, creds)
    this.metrics.credsStoreOps.inc({ op: 'write', layer: 'L1', result: 'hit' })

    // L2 同步（关键账号数据，不容丢）
    if (this.l2) {
      try {
        await this.l2.set(key, creds)
        this.metrics.credsStoreOps.inc({ op: 'write', layer: 'L2', result: 'hit' })
      } catch (err) {
        this.logger.error({ err, accountId }, 'L2 write failed')
        this.metrics.credsStoreOps.inc({ op: 'write', layer: 'L2', result: 'error' })
      }
    }

    // L3 异步（不阻塞业务可用性）
    if (this.l3) {
      this.l3
        .set(key, creds)
        .then(() => {
          this.metrics.credsStoreOps.inc({ op: 'write', layer: 'L3', result: 'hit' })
        })
        .catch(err => {
          this.logger.error({ err, accountId }, 'L3 async write failed')
          this.metrics.credsStoreOps.inc({ op: 'write', layer: 'L3', result: 'error' })
        })
    }
  }

  async delete(accountId: string): Promise<void> {
    const key = this.keyFor(accountId)
    await this.l1.delete(key)
    if (this.l2) await this.l2.delete(key).catch(() => {})
    if (this.l3) await this.l3.delete(key).catch(() => {})
  }

  async has(accountId: string): Promise<boolean> {
    return (await this.load(accountId)) !== null
  }

  private reportHitRatio(): void {
    const total = this.hits + this.misses
    if (total === 0) return
    this.metrics.l1HitRatio.set({ store: 'creds' }, this.hits / total)
    this.hits = 0
    this.misses = 0
  }
}
