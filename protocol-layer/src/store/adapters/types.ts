/**
 * 三层适配器统一接口。
 *
 * 设计原则：
 *   - L1 内存（LRU）— 进程内热数据
 *   - L2 Redis — 跨进程共享、TTL 兜底、Worker 漂移时拉取
 *   - L3 MySQL — 长期持久化 + 跨 region 复制
 *
 * 所有适配器实现同一接口，CredsStore/KeysStore 按需组合。
 */

export interface StoreAdapter<TValue> {
  /** 适配器名称，用于指标 label */
  readonly layer: 'L1' | 'L2' | 'L3'

  get(key: string): Promise<TValue | null>
  set(key: string, value: TValue, ttlSec?: number): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>

  /** 批量获取，未命中返回 null */
  mget?(keys: string[]): Promise<Array<TValue | null>>
  /** 批量写入 */
  mset?(entries: Array<{ key: string; value: TValue; ttlSec?: number }>): Promise<void>

  /** 健康检查 */
  ping(): Promise<boolean>
  close?(): Promise<void>
}
