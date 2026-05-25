/**
 * Registry — accountId → workerId 路由仲裁。
 *
 * 设计（§ 4.8.4 + § 11.3.1）：
 *   - 单一权威，由 master 进程维护，存 Redis（hash + lock）
 *   - worker 启动时注册自己 + 心跳
 *   - master 监控 worker 心跳，掉线后把账号分给其他 worker
 *   - 一致性 hash 分片：accountId hash → 虚拟节点 → worker
 *   - 跨 region 优先就近（按 country / asn 优先匹配）
 *
 * Redis keys：
 *   unsea:registry:assign       hash: accountId → workerId
 *   unsea:registry:workers      hash: workerId → JSON {nodeId, region, capacity, ...}
 *   unsea:registry:load         hash: workerId → currentLoad（原子计数器）
 *   unsea:registry:hb           hash: workerId → lastHeartbeatMs
 *   unsea:registry:lock         分布式锁，防止两个 master 同时分配
 *
 * 容量计数策略：
 *   - assign 时 HINCRBY load +1（原子，避免并发超容量）
 *   - 释放槽位时 HINCRBY load -1（不低于 0）
 *   - worker 心跳 HSET load = 真实 activeSize（覆盖纠正漂移）
 *   - reassign 跨 worker 时新 worker +1（旧 worker 由心跳同步纠正）
 */

import type { RedisClient } from '../store/adapters/redis.js'
import type { Logger } from '../observability/logger.js'

export interface WorkerInfo {
  workerId: string
  nodeId: string
  region: string
  capacity: number
  currentLoad: number
  endpoint: string
  registeredAt: number
}

export interface AssignmentDecision {
  workerId: string
  isNew: boolean // true=新分配；false=已存在的绑定
}

export interface OwnerResolution {
  accountId: string
  workerId: string | null
  worker: WorkerInfo | null
}

const ASSIGN_KEY = 'registry:assign'
const ASSIGNED_AT_KEY = 'registry:assigned_at'
const WORKERS_KEY = 'registry:workers'
const LOAD_KEY = 'registry:load'
const HB_KEY = 'registry:hb'
const LOCK_KEY = 'registry:lock'

/** 原子释放 load：HINCRBY -1 但不低于 0 */
const DEC_LOAD_LUA = `
local v = tonumber(redis.call('HGET', KEYS[1], ARGV[1])) or 0
if v <= 0 then
  redis.call('HSET', KEYS[1], ARGV[1], '0')
  return 0
end
return redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
`

export class Registry {
  constructor(
    private readonly client: RedisClient,
    private readonly logger: Logger,
    private readonly keyPrefix: string = 'unsea:'
  ) {}

  private k(suffix: string): string {
    return `${this.keyPrefix}${suffix}`
  }

  /** ───── Worker 注册 / 心跳 ───── */

  async registerWorker(info: WorkerInfo): Promise<void> {
    await this.client.hset(this.k(WORKERS_KEY), info.workerId, JSON.stringify(info))
    await this.client.hset(this.k(HB_KEY), info.workerId, String(Date.now()))
    // 注册时 load 初始化为 0（已有值则保留，worker 重启后由心跳同步真实值）
    const existing = await this.client.hget(this.k(LOAD_KEY), info.workerId)
    if (existing == null) {
      await this.client.hset(this.k(LOAD_KEY), info.workerId, '0')
    }
    this.logger.info({ workerId: info.workerId, capacity: info.capacity }, 'worker registered')
  }

  /**
   * 心跳，同步真实 activeSize。
   *
   * 数据竞争防御：worker 启动后第一次心跳，本地 activeSize=0；
   * 但此时 master 可能已经把 N 个账号 reassign 给本 worker（HINCRBY +N），
   * Reconciler 还没 adopt 完。如果直接 HSET=0 会把累计的 reassign 增量抹掉，
   * 导致 master 误判容量空闲继续派账号过来。
   *
   * 策略：心跳 = max(本地 activeSize, Redis 现值) 的"温和覆盖"，让 load 只能增
   * 不能减；真实下降由 releaseSlot / unassign 触发的 HINCRBY -1 主动驱动。
   */
  async heartbeat(
    workerId: string,
    currentLoad?: number,
    options?: { force?: boolean }
  ): Promise<void> {
    await this.client.hset(this.k(HB_KEY), workerId, String(Date.now()))
    if (currentLoad !== undefined) {
      const target = Math.max(0, currentLoad)
      let effective: number
      if (options?.force) {
        // 强制覆盖：用于 worker 完成 adoption 后、定期做一次硬同步
        effective = target
        await this.client.hset(this.k(LOAD_KEY), workerId, String(effective))
      } else {
        const currentRedis = Number((await this.client.hget(this.k(LOAD_KEY), workerId)) ?? 0)
        effective = Math.max(target, currentRedis)
        if (effective !== currentRedis) {
          await this.client.hset(this.k(LOAD_KEY), workerId, String(effective))
        }
      }
      // 同步 worker info JSON 里的 currentLoad（让 listWorkers 简单读取）
      const raw = await this.client.hget(this.k(WORKERS_KEY), workerId)
      if (raw) {
        const info = JSON.parse(raw) as WorkerInfo
        info.currentLoad = effective
        await this.client.hset(this.k(WORKERS_KEY), workerId, JSON.stringify(info))
      }
    }
  }

  async unregisterWorker(workerId: string): Promise<void> {
    await this.client.hdel(this.k(WORKERS_KEY), workerId)
    await this.client.hdel(this.k(HB_KEY), workerId)
    await this.client.hdel(this.k(LOAD_KEY), workerId)
    this.logger.info({ workerId }, 'worker unregistered')
  }

  /**
   * 列出已注册的 worker。
   * @param options.includeDead - 默认 false，排除心跳超时的 worker；
   *   true 时返回所有注册过的 worker（含 dead），仅 master/failover 处置 dead 时用
   * @param options.deadThresholdMs - 心跳超时阈值，默认 60s
   */
  async listWorkers(options?: {
    includeDead?: boolean
    deadThresholdMs?: number
  }): Promise<WorkerInfo[]> {
    const [workersMap, loadMap, hbMap] = await Promise.all([
      this.client.hgetall(this.k(WORKERS_KEY)),
      this.client.hgetall(this.k(LOAD_KEY)),
      this.client.hgetall(this.k(HB_KEY))
    ])
    const includeDead = options?.includeDead ?? false
    const threshold = options?.deadThresholdMs ?? 60_000
    const now = Date.now()

    return Object.values(workersMap)
      .map(s => JSON.parse(s) as WorkerInfo)
      .filter(info => {
        if (includeDead) return true
        const lastHb = Number(hbMap[info.workerId] ?? 0)
        return lastHb > 0 && now - lastHb <= threshold
      })
      .map(info => {
        const realtimeLoad = loadMap[info.workerId]
        if (realtimeLoad != null) info.currentLoad = Math.max(0, Number(realtimeLoad))
        return info
      })
  }

  async getWorker(workerId: string): Promise<WorkerInfo | null> {
    const raw = await this.client.hget(this.k(WORKERS_KEY), workerId)
    if (!raw) return null
    const info = JSON.parse(raw) as WorkerInfo
    const realtimeLoad = await this.client.hget(this.k(LOAD_KEY), workerId)
    if (realtimeLoad != null) info.currentLoad = Math.max(0, Number(realtimeLoad))
    return info
  }

  async getDeadWorkers(thresholdMs: number = 60_000): Promise<string[]> {
    const hb = await this.client.hgetall(this.k(HB_KEY))
    const now = Date.now()
    const dead: string[] = []
    for (const [wid, ts] of Object.entries(hb)) {
      if (now - Number(ts) > thresholdMs) dead.push(wid)
    }
    return dead
  }

  /** ───── 账号路由 ───── */

  async lookup(accountId: string): Promise<string | null> {
    return this.client.hget(this.k(ASSIGN_KEY), accountId)
  }

  async resolveOwner(accountId: string): Promise<OwnerResolution> {
    const workerId = await this.lookup(accountId)
    if (!workerId) return { accountId, workerId: null, worker: null }
    return {
      accountId,
      workerId,
      worker: await this.getWorker(workerId)
    }
  }

  async lookupBatch(accountIds: string[]): Promise<Record<string, string | null>> {
    if (accountIds.length === 0) return {}
    const values = await this.client.hmget(this.k(ASSIGN_KEY), ...accountIds)
    const result: Record<string, string | null> = {}
    accountIds.forEach((id, i) => {
      result[id] = values[i] ?? null
    })
    return result
  }

  /**
   * 为账号分配 worker（如果已有则直接返回）。
   * 用分布式锁保证两个 master 不会同时分配；分配成功后 HINCRBY load +1（原子，
   * 防止 N 个 master 同时给同一个 worker 分账号导致超容量）。
   */
  async assign(accountId: string, preferredRegion?: string): Promise<AssignmentDecision> {
    const existing = await this.lookup(accountId)
    if (existing) return { workerId: existing, isNew: false }

    const lockToken = `${Date.now()}-${Math.random()}`
    const lockKey = this.k(`${LOCK_KEY}:assign:${accountId}`)
    const acquired = await this.client.set(lockKey, lockToken, 'PX', 5_000, 'NX')
    if (!acquired) {
      await new Promise(r => setTimeout(r, 50))
      const again = await this.lookup(accountId)
      if (again) return { workerId: again, isNew: false }
      throw new Error(`assignment lock contention for ${accountId}`)
    }

    try {
      const workers = await this.listWorkers()
      if (workers.length === 0) throw new Error('no workers available')

      // 1. 优先同 region
      const sameRegion = preferredRegion ? workers.filter(w => w.region === preferredRegion) : []
      const candidates = sameRegion.length > 0 ? sameRegion : workers

      // 2. 排除已满（用实时 load）
      const available = candidates.filter(w => w.currentLoad < w.capacity)
      if (available.length === 0) {
        throw new Error(
          `all workers full (${candidates.length} candidates, all >= capacity; max=${Math.max(...candidates.map(w => w.capacity))})`
        )
      }

      // 3. 选负载比例最低的
      available.sort((a, b) => a.currentLoad / a.capacity - b.currentLoad / b.capacity)
      const target = available[0]!

      // 4. 原子 +1 + 写 assign + 记录 assignedAt（用 MULTI 保证一起完成）
      const now = String(Date.now())
      const pipe = this.client.multi()
      pipe.hincrby(this.k(LOAD_KEY), target.workerId, 1)
      pipe.hset(this.k(ASSIGN_KEY), accountId, target.workerId)
      pipe.hset(this.k(ASSIGNED_AT_KEY), accountId, now)
      await pipe.exec()

      this.logger.info(
        {
          accountId,
          workerId: target.workerId,
          loadBefore: target.currentLoad,
          loadAfter: target.currentLoad + 1,
          capacity: target.capacity
        },
        'account assigned'
      )
      return { workerId: target.workerId, isNew: true }
    } finally {
      const lua = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`
      await this.client.eval(lua, 1, lockKey, lockToken)
    }
  }

  /**
   * 跨 worker 重分配。新 worker +1，旧 worker 不立即 -1（由心跳同步纠正）。
   * 等心跳是因为：旧 worker 可能还在尾部清理 socket，立即 -1 会让 listWorkers
   * 显示比真实少 1，引导后续 assign 误判容量。
   */
  async reassign(accountId: string, newWorkerId: string): Promise<void> {
    const oldWorkerId = await this.lookup(accountId)
    if (oldWorkerId === newWorkerId) return

    const pipe = this.client.multi()
    pipe.hincrby(this.k(LOAD_KEY), newWorkerId, 1)
    pipe.hset(this.k(ASSIGN_KEY), accountId, newWorkerId)
    pipe.hset(this.k(ASSIGNED_AT_KEY), accountId, String(Date.now()))
    await pipe.exec()
    this.logger.info({ accountId, oldWorkerId, newWorkerId }, 'account reassigned')
  }

  async unassign(accountId: string, options?: { releaseSlot?: boolean }): Promise<void> {
    const workerId = await this.lookup(accountId)
    await this.client.hdel(this.k(ASSIGN_KEY), accountId)
    await this.client.hdel(this.k(ASSIGNED_AT_KEY), accountId)
    if (workerId && options?.releaseSlot !== false) {
      await this.client.eval(DEC_LOAD_LUA, 1, this.k(LOAD_KEY), workerId)
    }
  }

  /**
   * 拉某 worker 下所有账号 + 各账号的 assignedAt 时间戳。
   * 用于 Reconciler 算 adoption 延迟指标。
   */
  async listAssignmentsOnWorker(workerId: string): Promise<Array<{ accountId: string; assignedAt: number }>> {
    const [assignMap, atMap] = await Promise.all([
      this.client.hgetall(this.k(ASSIGN_KEY)),
      this.client.hgetall(this.k(ASSIGNED_AT_KEY))
    ])
    return Object.entries(assignMap)
      .filter(([, w]) => w === workerId)
      .map(([accountId]) => ({
        accountId,
        assignedAt: Number(atMap[accountId] ?? 0)
      }))
  }

  /**
   * 释放 worker 上一个槽位（不改 assign，只调减计数）。
   * 用于 account-manager 临时释放运行槽位（NEED_REAUTH / 重连耗尽 / offline）。
   * 心跳会最终纠正，这里是为了立即让其他 master 看到容量空出来。
   */
  async releaseSlot(workerId: string): Promise<void> {
    await this.client.eval(DEC_LOAD_LUA, 1, this.k(LOAD_KEY), workerId).catch(err =>
      this.logger.warn({ err, workerId }, 'releaseSlot failed')
    )
  }

  /** 列出某 worker 名下所有账号 */
  async listAccountsOnWorker(workerId: string): Promise<string[]> {
    const map = await this.client.hgetall(this.k(ASSIGN_KEY))
    return Object.entries(map)
      .filter(([, w]) => w === workerId)
      .map(([acc]) => acc)
  }
}
