/**
 * KeysStore — Signal keys 高频写专用，**只走 L1 + L2**（不进 L3）。
 *
 * 设计原因（§ 11.3.3）：
 *   - 每条消息可能触发 sender-key / receiver-key / pre-key 多次写
 *   - 写放大极高（百万级账号 → 千亿次/天）
 *   - PG 撑不住，必须 Redis cluster 分片承担
 *   - 周期 snapshot 到对象存储作为冷备，崩溃时从 snapshot + 最近 N 分钟 Redis 重建
 *
 * Key 格式：
 *   keys:{accountId}:{type}:{id}
 *     type ∈ pre-key | session | sender-key | sender-key-memory | app-state-sync-key | app-state-sync-version
 */

import type { Metrics } from '../observability/metrics.js'
import type { Logger } from '../observability/logger.js'
import { MemoryStoreAdapter } from './adapters/memory.js'
import type { RedisStoreAdapter } from './adapters/redis.js'

export type KeyType =
  | 'pre-key'
  | 'session'
  | 'sender-key'
  | 'sender-key-memory'
  | 'app-state-sync-key'
  | 'app-state-sync-version'

export type KeyValue = Record<string, unknown>

export interface KeysStoreDeps {
  l1?: MemoryStoreAdapter<KeyValue>
  l2?: RedisStoreAdapter<KeyValue>
  l1MaxEntries?: number
  metrics: Metrics
  logger: Logger
  /** keys 在 L2 的 TTL（秒）。默认 7 天，过期后从 L3 snapshot 恢复 */
  l2TTLSeconds?: number
}

export class KeysStore {
  private l1: MemoryStoreAdapter<KeyValue>
  private l2?: RedisStoreAdapter<KeyValue>
  private metrics: Metrics
  private logger: Logger
  private l2TTL: number
  private hits = 0
  private misses = 0

  constructor(deps: KeysStoreDeps) {
    this.l1 = deps.l1 ?? new MemoryStoreAdapter<KeyValue>(deps.l1MaxEntries ?? 500_000)
    this.l2 = deps.l2
    this.metrics = deps.metrics
    this.logger = deps.logger
    this.l2TTL = deps.l2TTLSeconds ?? 7 * 24 * 60 * 60
    setInterval(() => this.reportHitRatio(), 30_000).unref()
  }

  private keyFor(accountId: string, type: KeyType, id: string): string {
    return `keys:${accountId}:${type}:${id}`
  }

  /** 单 key 读取 */
  async get(accountId: string, type: KeyType, id: string): Promise<KeyValue | null> {
    const key = this.keyFor(accountId, type, id)

    const fromL1 = await this.l1.get(key)
    if (fromL1) {
      this.hits++
      this.metrics.keysStoreOps.inc({ op: 'read', layer: 'L1', result: 'hit' })
      return fromL1
    }
    this.metrics.keysStoreOps.inc({ op: 'read', layer: 'L1', result: 'miss' })

    if (this.l2) {
      const fromL2 = await this.l2.get(key).catch(err => {
        this.logger.warn({ err, accountId, type, id }, 'KeysStore L2 read failed')
        this.metrics.keysStoreOps.inc({ op: 'read', layer: 'L2', result: 'error' })
        return null
      })
      if (fromL2) {
        this.hits++
        this.metrics.keysStoreOps.inc({ op: 'read', layer: 'L2', result: 'hit' })
        await this.l1.set(key, fromL2)
        return fromL2
      }
      this.metrics.keysStoreOps.inc({ op: 'read', layer: 'L2', result: 'miss' })
    }

    this.misses++
    return null
  }

  /** 批量读取，单账号一次性拉同类型多 id（避免 N 次往返） */
  async getMany(accountId: string, type: KeyType, ids: string[]): Promise<Record<string, KeyValue | null>> {
    if (ids.length === 0) return {}
    const keys = ids.map(id => this.keyFor(accountId, type, id))
    const result: Record<string, KeyValue | null> = {}
    const missingFromL1: string[] = []

    // 先 L1
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!
      const fromL1 = await this.l1.get(keys[i]!)
      if (fromL1) {
        result[id] = fromL1
        this.hits++
        this.metrics.keysStoreOps.inc({ op: 'read', layer: 'L1', result: 'hit' })
      } else {
        missingFromL1.push(id)
      }
    }

    if (missingFromL1.length === 0 || !this.l2) {
      for (const id of missingFromL1) result[id] = null
      return result
    }

    // L2 批量
    const l2keys = missingFromL1.map(id => this.keyFor(accountId, type, id))
    const fromL2 = await this.l2.mget!(l2keys).catch(err => {
      this.logger.warn({ err, accountId, type }, 'KeysStore L2 mget failed')
      return missingFromL1.map(() => null)
    })
    for (let i = 0; i < missingFromL1.length; i++) {
      const id = missingFromL1[i]!
      const v = fromL2[i]
      if (v != null) {
        result[id] = v
        this.hits++
        this.metrics.keysStoreOps.inc({ op: 'read', layer: 'L2', result: 'hit' })
        await this.l1.set(this.keyFor(accountId, type, id), v).catch(() => {})
      } else {
        result[id] = null
        this.misses++
        this.metrics.keysStoreOps.inc({ op: 'read', layer: 'L2', result: 'miss' })
      }
    }
    return result
  }

  async set(accountId: string, type: KeyType, id: string, value: KeyValue): Promise<void> {
    const key = this.keyFor(accountId, type, id)
    await this.l1.set(key, value)
    this.metrics.keysStoreOps.inc({ op: 'write', layer: 'L1', result: 'hit' })

    if (this.l2) {
      this.l2
        .set(key, value, this.l2TTL)
        .then(() => {
          this.metrics.keysStoreOps.inc({ op: 'write', layer: 'L2', result: 'hit' })
        })
        .catch(err => {
          this.logger.warn({ err, accountId, type, id }, 'KeysStore L2 write failed')
          this.metrics.keysStoreOps.inc({ op: 'write', layer: 'L2', result: 'error' })
        })
    }
  }

  /** 批量写入（适合 Baileys keys.set 一次写多个） */
  async setMany(
    accountId: string,
    entries: Array<{ type: KeyType; id: string; value: KeyValue }>
  ): Promise<void> {
    if (entries.length === 0) return
    for (const e of entries) {
      await this.l1.set(this.keyFor(accountId, e.type, e.id), e.value)
    }
    this.metrics.keysStoreOps.inc({ op: 'write', layer: 'L1', result: 'hit' }, entries.length)

    if (this.l2 && this.l2.mset) {
      const l2entries = entries.map(e => ({
        key: this.keyFor(accountId, e.type, e.id),
        value: e.value,
        ttlSec: this.l2TTL
      }))
      this.l2
        .mset(l2entries)
        .then(() => {
          this.metrics.keysStoreOps.inc({ op: 'write', layer: 'L2', result: 'hit' }, entries.length)
        })
        .catch(err => {
          this.logger.warn({ err, accountId, count: entries.length }, 'KeysStore L2 mset failed')
          this.metrics.keysStoreOps.inc({ op: 'write', layer: 'L2', result: 'error' }, entries.length)
        })
    }
  }

  async delete(accountId: string, type: KeyType, id: string): Promise<void> {
    const key = this.keyFor(accountId, type, id)
    await this.l1.delete(key)
    if (this.l2) await this.l2.delete(key).catch(() => {})
  }

  /**
   * 全量导出账号 keys（用于 /v1/accounts/{id}/export/baileys-json）。
   *
   * 通过 Redis SCAN + MGET 拉所有 keys:{accountId}:* 项目，
   * 按 type 分组返回 nested 结构 `{ "pre-key": { id: value }, "session": {...} }`，
   * 适配 Baileys auth_state JSON。
   *
   * 注意：百万级 keys 时此操作昂贵，业务侧应避免在热路径调用。
   * 导出 / 迁移时调一次即可。
   */
  async scanAll(accountId: string): Promise<Record<KeyType, Record<string, Record<string, unknown>>>> {
    const result: Record<KeyType, Record<string, Record<string, unknown>>> = {
      'pre-key': {},
      session: {},
      'sender-key': {},
      'sender-key-memory': {},
      'app-state-sync-key': {},
      'app-state-sync-version': {}
    }
    if (!this.l2) return result

    const raw = this.l2.raw()
    const scanStream = (
      raw as {
        scanStream?: (opts: { match: string; count: number }) => NodeJS.ReadableStream
      }
    ).scanStream
    if (!scanStream) return result

    const prefix = (this.l2 as { raw: () => unknown; keyPrefix?: string })['keyPrefix'] ?? ''
    const matchPattern = `${prefix}keys:${accountId}:*`
    const stream = scanStream.call(raw, { match: matchPattern, count: 500 })

    const allKeys: string[] = []
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (batch: string[]) => {
        if (batch.length > 0) allKeys.push(...batch)
      })
      stream.on('end', () => resolve())
      stream.on('error', reject)
    })

    if (allKeys.length === 0) return result

    // 分块 MGET，避免单次 MGET 太大
    const CHUNK = 200
    for (let i = 0; i < allKeys.length; i += CHUNK) {
      const slice = allKeys.slice(i, i + CHUNK)
      const values = (await raw.mget(...slice)) as Array<string | null>
      for (let j = 0; j < slice.length; j++) {
        const fullKey = slice[j]!
        const value = values[j]
        if (value == null) continue
        // 解析 key 结构 `{prefix}keys:{accountId}:{type}:{id}`
        const noPrefix = prefix ? fullKey.slice(prefix.length) : fullKey
        const parts = noPrefix.split(':') // ["keys", accountId, type, ...idParts]
        if (parts.length < 4 || parts[0] !== 'keys') continue
        const type = parts[2] as KeyType
        const id = parts.slice(3).join(':')
        if (!result[type]) continue
        try {
          result[type][id] = JSON.parse(value) as Record<string, unknown>
        } catch (err) {
          this.logger.warn({ err, fullKey }, 'scanAll: failed to parse value')
        }
      }
    }

    return result
  }

  /**
   * 统计单账号 keys 总数（运维用）
   */
  async count(accountId: string): Promise<number> {
    if (!this.l2) return 0
    const raw = this.l2.raw()
    const scanStream = (
      raw as { scanStream?: (opts: { match: string; count: number }) => NodeJS.ReadableStream }
    ).scanStream
    if (!scanStream) return 0
    const prefix = (this.l2 as { keyPrefix?: string })['keyPrefix'] ?? ''
    const matchPattern = `${prefix}keys:${accountId}:*`
    let n = 0
    await new Promise<void>((resolve, reject) => {
      const stream = scanStream.call(raw, { match: matchPattern, count: 500 })
      stream.on('data', (batch: string[]) => {
        n += batch.length
      })
      stream.on('end', () => resolve())
      stream.on('error', reject)
    })
    return n
  }

  async clear(accountId: string): Promise<void> {
    // 注：实际生产应该 SCAN + DEL 模式，这里简化
    // 触发场景：账号 logout / NEED_REAUTH 不可恢复
    this.logger.info({ accountId }, 'clearing all keys for account')
    // L1 没有 prefix-delete，简单忽略（进程下次重启会重置）
    // L2 用 SCAN + UNLINK
    if (this.l2) {
      const raw = this.l2.raw()
      const stream = (raw as { scanStream?: (opts: { match: string; count: number }) => NodeJS.ReadableStream }).scanStream?.({
        match: `keys:${accountId}:*`,
        count: 1000
      })
      if (stream) {
        await new Promise<void>((resolve, reject) => {
          stream.on('data', async (keys: string[]) => {
            if (keys.length > 0) {
              try {
                await raw.unlink(...keys)
              } catch (err) {
                this.logger.warn({ err }, 'unlink batch failed')
              }
            }
          })
          stream.on('end', () => resolve())
          stream.on('error', reject)
        })
      }
    }
  }

  private reportHitRatio(): void {
    const total = this.hits + this.misses
    if (total === 0) return
    this.metrics.l1HitRatio.set({ store: 'keys' }, this.hits / total)
    this.hits = 0
    this.misses = 0
  }
}
