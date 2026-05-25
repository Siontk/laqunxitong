/**
 * Master 进程 — 监控 worker 心跳 + 死 worker 上的账号迁移。
 *
 * 启动方式：`WORKER_ROLE=master npm start`
 * HA：主备模式（Redis 锁），单时刻只有一个 master 在跑迁移。
 */

import type { Logger } from '../observability/logger.js'
import type { Metrics } from '../observability/metrics.js'
import type { RedisClient } from '../store/adapters/redis.js'
import type { EventPublisher } from '../events/publisher.js'
import type { Registry } from './registry.js'
import { Failover } from './failover.js'

export interface MasterDeps {
  registry: Registry
  redis: RedisClient
  publisher: EventPublisher
  logger: Logger
  metrics: Metrics
  config: {
    nodeId: string
    deadThresholdMs?: number
    checkIntervalMs?: number
  }
}

export class Master {
  private failover: Failover
  private timer: NodeJS.Timeout | null = null
  private isLeader = false

  constructor(private readonly deps: MasterDeps) {
    this.failover = new Failover(deps.registry, deps.publisher, deps.logger)
  }

  async start(): Promise<void> {
    const intervalMs = this.deps.config.checkIntervalMs ?? 10_000
    this.timer = setInterval(() => {
      this.tick().catch(err =>
        this.deps.logger.error({ err }, 'master tick failed')
      )
    }, intervalMs)
    this.deps.logger.info({ intervalMs }, 'master started')
    // 立刻跑一次
    await this.tick()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.isLeader) {
      await this.releaseLeadership()
    }
  }

  /**
   * 尝试获得 master leadership（Redis lock 5s TTL，10s 续期）。
   * 主备模式：只有 leader 跑迁移逻辑，备 master 仅等待。
   */
  private async acquireLeadership(): Promise<boolean> {
    const lockKey = 'unsea:master:leader'
    const token = this.deps.config.nodeId
    const acquired = await this.deps.redis.set(lockKey, token, 'PX', 15_000, 'NX')
    if (acquired) {
      this.isLeader = true
      this.deps.logger.info({ nodeId: token }, 'became master leader')
      return true
    }
    // 续期：如果当前持有者是自己，刷新 TTL
    if (this.isLeader) {
      const lua = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("pexpire",KEYS[1],ARGV[2]) else return 0 end`
      const refreshed = (await this.deps.redis.eval(lua, 1, lockKey, token, '15000')) as number
      if (refreshed === 1) return true
      // 续期失败说明被抢
      this.isLeader = false
      this.deps.logger.warn('lost master leadership')
    }
    return false
  }

  private async releaseLeadership(): Promise<void> {
    const lua = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`
    await this.deps.redis.eval(lua, 1, 'unsea:master:leader', this.deps.config.nodeId)
    this.isLeader = false
  }

  private async tick(): Promise<void> {
    const acquired = await this.acquireLeadership()
    if (!acquired) return

    const dead = await this.deps.registry.getDeadWorkers(this.deps.config.deadThresholdMs ?? 60_000)
    if (dead.length === 0) return

    this.deps.logger.warn({ deadWorkers: dead }, 'dead workers detected')
    for (const workerId of dead) {
      await this.failover.migrateWorker(workerId)
      await this.deps.registry.unregisterWorker(workerId)
    }
  }
}
