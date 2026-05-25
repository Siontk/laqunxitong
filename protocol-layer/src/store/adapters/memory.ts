/**
 * L1 内存 LRU 适配器。
 *
 * 用途：
 *   - creds 热缓存（每账号 ~10KB，1k 账号 ~10MB）
 *   - keys 短期热缓存（每账号 session/sender-key ~50KB，按需）
 *
 * 不持久化。进程退出即丢失，依赖 L2/L3 回源。
 */

import type { StoreAdapter } from './types.js'

interface Entry<T> {
  value: T
  expiresAt?: number
  accessedAt: number
}

export class MemoryStoreAdapter<TValue> implements StoreAdapter<TValue> {
  readonly layer = 'L1' as const
  private readonly map = new Map<string, Entry<TValue>>()

  constructor(private readonly maxEntries: number = 10_000) {
    // 定期清过期
    setInterval(() => this.purgeExpired(), 60_000).unref()
  }

  async get(key: string): Promise<TValue | null> {
    const entry = this.map.get(key)
    if (!entry) return null
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.map.delete(key)
      return null
    }
    entry.accessedAt = Date.now()
    return entry.value
  }

  async set(key: string, value: TValue, ttlSec?: number): Promise<void> {
    if (this.map.size >= this.maxEntries && !this.map.has(key)) {
      this.evictLRU()
    }
    this.map.set(key, {
      value,
      expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : undefined,
      accessedAt: Date.now()
    })
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null
  }

  async ping(): Promise<boolean> {
    return true
  }

  size(): number {
    return this.map.size
  }

  private evictLRU(): void {
    let oldestKey: string | null = null
    let oldestAccess = Infinity
    for (const [k, v] of this.map) {
      if (v.accessedAt < oldestAccess) {
        oldestAccess = v.accessedAt
        oldestKey = k
      }
    }
    if (oldestKey) this.map.delete(oldestKey)
  }

  private purgeExpired(): void {
    const now = Date.now()
    for (const [k, v] of this.map) {
      if (v.expiresAt && v.expiresAt < now) this.map.delete(k)
    }
  }
}
