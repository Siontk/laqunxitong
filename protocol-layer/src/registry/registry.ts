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
 *   unsea:{registry}:assign                 hash: accountId → workerId
 *   unsea:{registry}:assigned_at            hash: accountId → assignedAtMs
 *   unsea:{registry}:workers                hash: workerId → JSON {nodeId, region, capacity, ...}
 *   unsea:{registry}:load                   hash: workerId → currentLoad（原子计数器）
 *   unsea:{registry}:hb                     hash: workerId → lastHeartbeatMs
 *   unsea:{registry}:worker_accounts:<wid>  set : accountId 集合（反向索引，O(1) 拉某 worker 名下账号）
 *   unsea:{registry}:lock                   分布式锁，防止两个 master 同时分配
 *
 * 容量计数策略：
 *   - assign 通过 Lua 原子做 check-load-and-incr：保证多 master 并发不超容量
 *   - 释放槽位走 DEC_LOAD_LUA（不低于 0）
 *   - worker 心跳通过 LUA 做 max(本地, Redis)，避免 HGET→HSET 中间丢 HINCRBY +1
 *   - reassign 跨 worker 时新 worker +1（旧 worker 由心跳 force 同步纠正）
 *
 * 50w 扩容关键改动（vs 旧版）：
 *   - 用 worker_accounts:<wid> SET 反向索引取代 HGETALL registry:assign 扫全表
 *   - assign / reassign / unassign 通过 Lua 在 SET 与 hash 之间保持一致
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
const WORKER_ACCOUNTS_PREFIX = 'registry:worker_accounts:'
const CLUSTER_TAG = '{registry}:'

/** 原子释放 load：HINCRBY -1 但不低于 0 */
const DEC_LOAD_LUA = `
local v = tonumber(redis.call('HGET', KEYS[1], ARGV[1])) or 0
if v <= 0 then
  redis.call('HSET', KEYS[1], ARGV[1], '0')
  return 0
end
return redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
`

/**
 * 原子 assign：单一 Lua 完成 check-existing → check-capacity → +1 → 写索引。
 *
 * KEYS:
 *   [1] ASSIGN_KEY            hash
 *   [2] ASSIGNED_AT_KEY       hash
 *   [3] LOAD_KEY              hash
 *   [4] WORKER_ACCOUNTS:<wid> set
 * ARGV:
 *   [1] accountId
 *   [2] workerId
 *   [3] capacity (string number)
 *   [4] now (string ms)
 *
 * Return:
 *   {1, workerId}            新分配成功
 *   {0, existingWorkerId}    accountId 已被分配
 *   {-1, "FULL"}             目标 worker 已满，调用方需要换一个
 */
const ATOMIC_ASSIGN_LUA = `
local existing = redis.call('HGET', KEYS[1], ARGV[1])
if existing then
  return {0, existing}
end
local load = tonumber(redis.call('HGET', KEYS[3], ARGV[2])) or 0
local cap = tonumber(ARGV[3])
if load >= cap then
  return {-1, 'FULL'}
end
redis.call('HINCRBY', KEYS[3], ARGV[2], 1)
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[4])
redis.call('SADD', KEYS[4], ARGV[1])
return {1, ARGV[2]}
`

/**
 * 原子 reassign：把 accountId 从旧 worker 搬到新 worker。
 *
 * KEYS:
 *   [1] ASSIGN_KEY
 *   [2] ASSIGNED_AT_KEY
 *   [3] LOAD_KEY
 *   [4] WORKER_ACCOUNTS:<newWid>
 *   [5] WORKER_ACCOUNTS:<oldWid>（旧 worker 可空，但 KEYS 不能动态省略，
 *       所以调用方在 oldWid 为空时把 KEYS[5] 设成一个占位 set key，
 *       配合 ARGV[4] 为空字符串触发 skip 逻辑）
 * ARGV:
 *   [1] accountId
 *   [2] newWorkerId
 *   [3] now
 *   [4] oldWorkerId（可空字符串）
 *
 * Return: -1=owner 不匹配或不存在 / 0=已在目标 worker（noop） / 1=完成迁移
 */
const ATOMIC_REASSIGN_LUA = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur then
  return -1
end
if cur == ARGV[2] then
  return 0
end
if #ARGV[4] > 0 and cur ~= ARGV[4] then
  return -1
end
if #ARGV[4] > 0 then
  redis.call('SREM', KEYS[5], ARGV[1])
end
redis.call('HINCRBY', KEYS[3], ARGV[2], 1)
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
redis.call('SADD', KEYS[4], ARGV[1])
return 1
`

/**
 * 原子 unassign：删 hash + SET 一致，按需 -1 load。
 *
 * KEYS:
 *   [1] ASSIGN_KEY
 *   [2] ASSIGNED_AT_KEY
 *   [3] LOAD_KEY
 *   [4] WORKER_ACCOUNTS:<wid>
 * ARGV:
 *   [1] accountId
 *   [2] releaseSlot ('1' 释放 load / '0' 不释放)
 *   [3] expectedWorkerId
 *
 * Return: -1=找不到 / 0=workerId 不一致（已被别人挪走，不动 load）/ 1=正常删
 */
const ATOMIC_UNASSIGN_LUA = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur then return -1 end
if ARGV[3] ~= '' and cur ~= ARGV[3] then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('SREM', KEYS[4], ARGV[1])
if ARGV[2] == '1' then
  local v = tonumber(redis.call('HGET', KEYS[3], cur)) or 0
  if v > 0 then
    redis.call('HINCRBY', KEYS[3], cur, -1)
  end
end
return 1
`

/**
 * 原子心跳：HSET hb + 按 max(target, 当前) 写 load，不会丢 HINCRBY +1。
 *
 * KEYS:
 *   [1] HB_KEY
 *   [2] LOAD_KEY
 * ARGV:
 *   [1] workerId
 *   [2] nowMs
 *   [3] targetLoad（""=只更新 hb，不动 load）
 *   [4] force ('1' = HSET target；'0' = max(target, current)）
 *
 * Return: effective load
 */
const ATOMIC_HEARTBEAT_LUA = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
if ARGV[3] == nil or ARGV[3] == '' then
  local v = tonumber(redis.call('HGET', KEYS[2], ARGV[1])) or 0
  return v
end
local target = tonumber(ARGV[3]) or 0
if target < 0 then target = 0 end
local cur = tonumber(redis.call('HGET', KEYS[2], ARGV[1])) or 0
local effective
if ARGV[4] == '1' then
  effective = target
elseif target > cur then
  effective = target
else
  effective = cur
end
redis.call('HSET', KEYS[2], ARGV[1], tostring(effective))
return effective
`

export class Registry {
  constructor(
    private readonly client: RedisClient,
    private readonly logger: Logger,
    private readonly keyPrefix: string = 'unsea:'
  ) {}

  private k(suffix: string): string {
    return `${this.keyPrefix}${CLUSTER_TAG}${suffix}`
  }

  /** 旧版未加 Redis Cluster hash tag 的 key，仅用于读兼容 / backfill。 */
  private legacyK(suffix: string): string {
    return `${this.keyPrefix}${suffix}`
  }

  private workerAccountsKey(workerId: string): string {
    return this.k(`${WORKER_ACCOUNTS_PREFIX}${workerId}`)
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
   * 数据竞争防御：HGET→HSET 不是原子的，期间可能有 assign HINCRBY +1。
   * 通过 ATOMIC_HEARTBEAT_LUA 在一条 Lua 里做 max 比较 + HSET，避免丢增量。
   *
   * 策略：
   *   - 默认（force=false）= max(本地 activeSize, Redis 现值)，load 只增不减
   *   - force=true：硬同步覆盖（用于 worker 启动后首轮 adopt 完成、或每小时纠偏）
   *
   * 真实下降由 releaseSlot / unassign 触发的 HINCRBY -1 主动驱动。
   */
  async heartbeat(
    workerId: string,
    currentLoad?: number,
    options?: { force?: boolean }
  ): Promise<void> {
    const now = String(Date.now())
    const target = currentLoad === undefined ? '' : String(Math.max(0, currentLoad))
    const force = options?.force ? '1' : '0'
    await this.client.eval(
      ATOMIC_HEARTBEAT_LUA,
      2,
      this.k(HB_KEY),
      this.k(LOAD_KEY),
      workerId,
      now,
      target,
      force
    )
  }

  async unregisterWorker(workerId: string): Promise<void> {
    await this.client.hdel(this.k(WORKERS_KEY), workerId)
    await this.client.hdel(this.k(HB_KEY), workerId)
    await this.client.hdel(this.k(LOAD_KEY), workerId)
    // 反向索引也一并清理（即使后续别人复用同名 workerId 也不会读到脏数据）
    await this.client.del(this.workerAccountsKey(workerId)).catch(() => {})
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
    const current = await this.client.hget(this.k(ASSIGN_KEY), accountId)
    if (current) return current
    const legacy = await this.client.hget(this.legacyK(ASSIGN_KEY), accountId)
    if (!legacy) return null
    await this.backfillAssignment(accountId, legacy)
    return legacy
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
    const missingIds = accountIds.filter((id, i) => values[i] == null)
    const legacyValues = missingIds.length > 0
      ? await this.client.hmget(this.legacyK(ASSIGN_KEY), ...missingIds)
      : []
    const result: Record<string, string | null> = {}
    accountIds.forEach((id, i) => {
      result[id] = values[i] ?? null
    })
    await Promise.all(missingIds.map(async (id, i) => {
      const legacy = legacyValues[i]
      if (!legacy) return
      result[id] = legacy
      await this.backfillAssignment(id, legacy)
    }))
    return result
  }

  /**
   * 为账号分配 worker（如果已有则直接返回）。
   *
   * 流程：
   *   1. per-account 锁（防同一 accountId 双分配）
   *   2. 选最低负载 worker 作 target
   *   3. ATOMIC_ASSIGN_LUA 原子 check-load-and-incr（防多 master 超容量）
   *   4. 如果 target 满了，重新选下一档继续，最多 retryMax 次
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

    const retryMax = 5
    try {
      const triedFull = new Set<string>()

      for (let attempt = 0; attempt < retryMax; attempt++) {
        const workers = await this.listWorkers()
        if (workers.length === 0) throw new Error('no workers available')

        // 1. 优先同 region
        const sameRegion = preferredRegion ? workers.filter(w => w.region === preferredRegion) : []
        const candidates = (sameRegion.length > 0 ? sameRegion : workers).filter(
          w => !triedFull.has(w.workerId)
        )

        // 2. 排除已满（用实时 load）
        const available = candidates.filter(w => w.currentLoad < w.capacity)
        if (available.length === 0) {
          throw new Error(
            `all workers full (${candidates.length} candidates remaining after ${triedFull.size} tried; ` +
              `max capacity=${workers.length > 0 ? Math.max(...workers.map(w => w.capacity)) : 0})`
          )
        }

        // 3. 选负载比例最低的
        available.sort((a, b) => a.currentLoad / a.capacity - b.currentLoad / b.capacity)
        const target = available[0]!
        const now = String(Date.now())

        const ret = (await this.client.eval(
          ATOMIC_ASSIGN_LUA,
          4,
          this.k(ASSIGN_KEY),
          this.k(ASSIGNED_AT_KEY),
          this.k(LOAD_KEY),
          this.workerAccountsKey(target.workerId),
          accountId,
          target.workerId,
          String(target.capacity),
          now
        )) as [number, string]

        const code = Number(ret[0])
        const value = String(ret[1] ?? '')
        if (code === 1) {
          this.logger.info(
            {
              accountId,
              workerId: target.workerId,
              loadBefore: target.currentLoad,
              capacity: target.capacity,
              attempt
            },
            'account assigned'
          )
          return { workerId: target.workerId, isNew: true }
        }
        if (code === 0) {
          // 锁外抢先分配了同一个 accountId（不太可能，但完整处理）
          return { workerId: value, isNew: false }
        }
        // code === -1：target 真满了（中间被别人 +1 过），换一个
        triedFull.add(target.workerId)
        this.logger.warn(
          { accountId, workerId: target.workerId, attempt },
          'atomic assign rejected — target full, retrying with next worker'
        )
      }

      throw new Error(`assign retry exhausted (${retryMax}) for ${accountId}`)
    } finally {
      const lua = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`
      await this.client.eval(lua, 1, lockKey, lockToken)
    }
  }

  /**
   * 跨 worker 重分配。新 worker +1，旧 worker 不立即 -1（由心跳同步纠正）。
   *
   * 用 ATOMIC_REASSIGN_LUA 保证 SET 反向索引和 hash 一致。
   * 旧 worker 即使为空也要传一个占位 SET key（KEYS 参数不能动态省略）。
   */
  async reassign(accountId: string, newWorkerId: string): Promise<boolean> {
    const oldWorkerId = await this.lookup(accountId)
    if (oldWorkerId === newWorkerId) return true

    const ret = (await this.client.eval(
      ATOMIC_REASSIGN_LUA,
      5,
      this.k(ASSIGN_KEY),
      this.k(ASSIGNED_AT_KEY),
      this.k(LOAD_KEY),
      this.workerAccountsKey(newWorkerId),
      this.workerAccountsKey(oldWorkerId ?? '__none__'),
      accountId,
      newWorkerId,
      String(Date.now()),
      oldWorkerId ?? ''
    )) as number

    if (Number(ret) === 1) {
      this.logger.info({ accountId, oldWorkerId, newWorkerId }, 'account reassigned')
      return true
    }
    if (Number(ret) === 0) return true
    this.logger.warn({ accountId, oldWorkerId, newWorkerId }, 'account reassign skipped — owner changed or missing')
    return false
  }

  async unassign(accountId: string, options?: { releaseSlot?: boolean; expectedWorkerId?: string }): Promise<boolean> {
    const workerId = options?.expectedWorkerId ?? await this.lookup(accountId)
    if (!workerId) {
      // 已经没绑定了：尽力一次清理（罕见 path）
      await this.client.hdel(this.k(ASSIGN_KEY), accountId).catch(() => {})
      await this.client.hdel(this.k(ASSIGNED_AT_KEY), accountId).catch(() => {})
      return false
    }
    const releaseSlot = options?.releaseSlot !== false ? '1' : '0'
    const ret = (await this.client.eval(
      ATOMIC_UNASSIGN_LUA,
      4,
      this.k(ASSIGN_KEY),
      this.k(ASSIGNED_AT_KEY),
      this.k(LOAD_KEY),
      this.workerAccountsKey(workerId),
      accountId,
      releaseSlot,
      options?.expectedWorkerId ?? workerId
    )) as number
    return Number(ret) === 1
  }

  /**
   * 拉某 worker 下所有账号 + 各账号的 assignedAt 时间戳。
   * 用于 Reconciler 算 adoption 延迟指标。
   *
   * 关键路径：SMEMBERS（O(N) where N=单 worker 账号数，≤ capacity 500）
   * + HMGET assigned_at。不再 HGETALL registry:assign 扫全表。
   */
  async listAssignmentsOnWorker(
    workerId: string
  ): Promise<Array<{ accountId: string; assignedAt: number }>> {
    const accountIds = await this.client.smembers(this.workerAccountsKey(workerId))
    if (accountIds.length === 0) {
      const backfilled = await this.backfillWorkerAccounts(workerId)
      if (backfilled.length === 0) return []
      const ats = await this.client.hmget(this.k(ASSIGNED_AT_KEY), ...backfilled)
      return backfilled.map((accountId, i) => ({
        accountId,
        assignedAt: Number(ats[i] ?? 0)
      }))
    }
    const ats = await this.client.hmget(this.k(ASSIGNED_AT_KEY), ...accountIds)
    return accountIds.map((accountId, i) => ({
      accountId,
      assignedAt: Number(ats[i] ?? 0)
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

  /**
   * 列出某 worker 名下所有账号（用 SET 反向索引，O(1) 命中）。
   * 历史调用方：failover / admin 视图。
   */
  async listAccountsOnWorker(workerId: string): Promise<string[]> {
    const accountIds = await this.client.smembers(this.workerAccountsKey(workerId))
    if (accountIds.length > 0) return accountIds
    return this.backfillWorkerAccounts(workerId)
  }

  /**
   * 反向索引一致性检查（仅运维 / 启动时跑一次）。
   * 扫 registry:assign 全表对比 SET，找出漂移。生产慎用。
   */
  async auditWorkerAccountsIndex(): Promise<{
    missingInSet: Array<{ accountId: string; workerId: string }>
    extraInSet: Array<{ accountId: string; workerId: string }>
  }> {
    const map = await this.client.hgetall(this.k(ASSIGN_KEY))
    const byWorker = new Map<string, Set<string>>()
    for (const [acc, wid] of Object.entries(map)) {
      if (!byWorker.has(wid)) byWorker.set(wid, new Set())
      byWorker.get(wid)!.add(acc)
    }
    const missingInSet: Array<{ accountId: string; workerId: string }> = []
    const extraInSet: Array<{ accountId: string; workerId: string }> = []
    for (const [wid, expected] of byWorker) {
      const actual = new Set(await this.client.smembers(this.workerAccountsKey(wid)))
      for (const acc of expected) if (!actual.has(acc)) missingInSet.push({ accountId: acc, workerId: wid })
      for (const acc of actual) if (!expected.has(acc)) extraInSet.push({ accountId: acc, workerId: wid })
    }
    return { missingInSet, extraInSet }
  }

  /**
   * 从旧 hash / 当前 hash 补齐 worker_accounts 反向索引。
   *
   * 仅在 SET 为空或 lookup 命中旧 key 时触发，避免正常路径扫全表。
   *
   * 防雪崩：
   *   - per-worker 分布式锁（{registry}:backfill:lock:<wid>），避免同一 worker 内多调用方
   *     并发都跑 HSCAN（reconciler / failover / admin 可能同时来）
   *   - 用 HSCAN COUNT=500 替代 HGETALL，分批读取不阻塞 Redis 单线程
   *   - 批量写入也用 chunk 100，避免 pipeline 单批过大撑爆 Redis 出队队列
   *
   * 跨 worker 并发是 OK 的：每个 worker 自己 filter 自己 workerId，互不干扰。
   */
  private async backfillWorkerAccounts(workerId: string): Promise<string[]> {
    const lockKey = this.k(`backfill:lock:${workerId}`)
    const lockToken = `${Date.now()}-${Math.random()}`
    const acquired = await this.client.set(lockKey, lockToken, 'PX', 120_000, 'NX')
    if (!acquired) {
      // 别的调用方正在 backfill — 直接读当前 SET 状态返回（可能为部分结果）
      this.logger.debug({ workerId }, 'backfill skipped — another in progress')
      return this.client.smembers(this.workerAccountsKey(workerId))
    }

    const ids = new Set<string>()
    const assignedAtCache = new Map<string, string>()

    try {
      // 双 hash（current + legacy）都扫一遍
      await this.hscanFilter(this.k(ASSIGN_KEY), workerId, ids)
      await this.hscanFilter(this.legacyK(ASSIGN_KEY), workerId, ids)

      if (ids.size === 0) return []

      const accountIds = [...ids]

      // 拉 assignedAt（current 优先；缺失再从 legacy 补）
      // HMGET 一批 1000 字段是安全的
      const CHUNK = 1000
      for (let i = 0; i < accountIds.length; i += CHUNK) {
        const slice = accountIds.slice(i, i + CHUNK)
        const [curAt, legAt] = await Promise.all([
          this.client.hmget(this.k(ASSIGNED_AT_KEY), ...slice),
          this.client.hmget(this.legacyK(ASSIGNED_AT_KEY), ...slice)
        ])
        slice.forEach((id, idx) => {
          assignedAtCache.set(id, curAt[idx] ?? legAt[idx] ?? String(Date.now()))
        })
      }

      // 写回：chunk 100 个账号一个 pipeline，3 ops/账号 = 300 ops/pipeline
      const WRITE_CHUNK = 100
      for (let i = 0; i < accountIds.length; i += WRITE_CHUNK) {
        const slice = accountIds.slice(i, i + WRITE_CHUNK)
        const pipe = this.client.pipeline()
        for (const accountId of slice) {
          pipe.hset(this.k(ASSIGN_KEY), accountId, workerId)
          pipe.hset(this.k(ASSIGNED_AT_KEY), accountId, assignedAtCache.get(accountId) ?? String(Date.now()))
          pipe.sadd(this.workerAccountsKey(workerId), accountId)
        }
        await pipe.exec()
      }

      this.logger.warn(
        { workerId, count: accountIds.length },
        'registry worker_accounts index backfilled'
      )
      return accountIds
    } finally {
      const releaseLua = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`
      await this.client.eval(releaseLua, 1, lockKey, lockToken).catch(() => {})
    }
  }

  /**
   * 用 HSCAN 替代 HGETALL 扫某个 assign hash，把 value==workerId 的 field 收到 ids。
   *
   * Redis 单线程下 HSCAN COUNT=500 单次响应小，不阻塞其它命令。
   * HSCAN 不保证不重复（可能在 rehash 时重复返回），但 Set 天然去重。
   */
  private async hscanFilter(hashKey: string, workerId: string, ids: Set<string>): Promise<void> {
    let cursor = '0'
    const COUNT = 500
    do {
      const ret = (await this.client.hscan(hashKey, cursor, 'COUNT', COUNT)) as [string, string[]]
      cursor = ret[0]
      const fields = ret[1]
      for (let i = 0; i < fields.length; i += 2) {
        const accountId = fields[i]!
        const wid = fields[i + 1]
        if (wid === workerId) ids.add(accountId)
      }
    } while (cursor !== '0')
  }

  private async backfillAssignment(accountId: string, workerId: string): Promise<void> {
    const assignedAt = await this.client.hget(this.legacyK(ASSIGNED_AT_KEY), accountId)
    const pipe = this.client.pipeline()
    pipe.hset(this.k(ASSIGN_KEY), accountId, workerId)
    pipe.hset(this.k(ASSIGNED_AT_KEY), accountId, assignedAt ?? String(Date.now()))
    pipe.sadd(this.workerAccountsKey(workerId), accountId)
    await pipe.exec()
    this.logger.warn({ accountId, workerId }, 'registry assignment backfilled from legacy keys')
  }
}
