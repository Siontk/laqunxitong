/**
 * Failover — worker 死时把其账号迁到其他 worker。
 *
 * 策略（§ 4.5 类型 B + § 11.3.4 限流）：
 *   1. 列出死 worker 名下账号（SMEMBERS worker_accounts:<wid>，O(1)）
 *   2. 按节点级令牌桶速率迁移（避免接收方 worker 被瞬时上线打爆）
 *   3. Registry 更新 assign，新 worker 在心跳时会感知并主动 online
 *   4. 失败的账号留在 unassigned，下一轮重试
 *
 * 规模考虑（50w）：
 *   - 单 worker 最多 500 账号，迁移耗时可能几十秒~几分钟
 *   - 每迁 RELOAD_EVERY 个账号重读一次 liveWorkers，避免决策基于过时容量
 *   - reassign 走 Registry.reassign 的 Lua 原子路径，已经在 hash+set 之间保持一致
 *     （这里不再需要手动锁 accountId，并发 leader 同名 reassign 是幂等的）
 */

import type { Logger } from '../observability/logger.js'
import type { EventPublisher } from '../events/publisher.js'
import type { Registry, WorkerInfo } from './registry.js'

const RELOAD_EVERY = 50 // 每迁 50 个账号重读 liveWorkers

export class Failover {
  constructor(
    private readonly registry: Registry,
    private readonly publisher: EventPublisher,
    private readonly logger: Logger
  ) {}

  async migrateWorker(deadWorkerId: string): Promise<void> {
    const accounts = await this.registry.listAccountsOnWorker(deadWorkerId)
    if (accounts.length === 0) {
      this.logger.info({ deadWorkerId }, 'no accounts to migrate')
      return
    }

    this.logger.warn(
      { deadWorkerId, accountCount: accounts.length },
      'migrating accounts from dead worker'
    )

    let liveWorkers = await this.fetchLiveWorkers(deadWorkerId)
    if (liveWorkers.length === 0) {
      this.logger.error('no live workers available for migration')
      // 解除分配，等新 worker 接管
      for (const acc of accounts) {
        await this.unassignIfStillOwned(acc, deadWorkerId, 'failover_no_live_worker')
      }
      return
    }

    let migrated = 0
    let failed = 0
    let processed = 0

    for (const accountId of accounts) {
      processed++
      // 每 RELOAD_EVERY 个账号重读 liveWorkers（容量可能被其他 master / 业务侧 online 改变）
      if (processed % RELOAD_EVERY === 1 && processed > 1) {
        liveWorkers = await this.fetchLiveWorkers(deadWorkerId)
        if (liveWorkers.length === 0) {
          this.logger.error({ remaining: accounts.length - processed + 1 }, 'lost all live workers mid-migration')
          await this.unassignIfStillOwned(accountId, deadWorkerId, 'failover_no_live_worker')
          failed++
          continue
        }
      }

      const target = pickWorkerWithCapacity(liveWorkers)
      if (!target) {
        await this.unassignIfStillOwned(accountId, deadWorkerId, 'failover_no_capacity')
        failed++
        continue
      }
      try {
        const changed = await this.registry.reassign(accountId, target.workerId)
        if (!changed) {
          failed++
          continue
        }
        await this.publishOwnerChanged(accountId, deadWorkerId, target)
        target.currentLoad++ // 内存里更新；下次 reload 时由 Registry 真实值校正
        migrated++
      } catch (err) {
        this.logger.warn({ err, accountId }, 'failed to reassign')
        await this.unassignIfStillOwned(accountId, deadWorkerId, 'failover_reassign_failed')
        failed++
      }
    }

    this.logger.warn(
      { deadWorkerId, migrated, failed, total: accounts.length, processed },
      'migration done'
    )
  }

  private async fetchLiveWorkers(deadWorkerId: string): Promise<WorkerInfo[]> {
    const all = await this.registry.listWorkers()
    const live = all
      .filter(w => w.workerId !== deadWorkerId)
      .sort((a, b) => b.capacity - b.currentLoad - (a.capacity - a.currentLoad))
    return live
  }

  private async unassignIfStillOwned(
    accountId: string,
    deadWorkerId: string,
    reason: 'failover_no_live_worker' | 'failover_no_capacity' | 'failover_reassign_failed'
  ): Promise<void> {
    const unassigned = await this.registry.unassign(accountId, {
      expectedWorkerId: deadWorkerId,
      releaseSlot: true
    })
    if (!unassigned) {
      this.logger.warn({ accountId, deadWorkerId, reason }, 'skip owner_unassigned — owner changed')
      return
    }
    await this.publisher
      .publish('account.owner_unassigned', accountId, {
        accountId,
        previousOwnerWorkerId: deadWorkerId,
        previousOwnerEndpoint: null,
        reason,
        unassignedAt: new Date().toISOString()
      })
      .catch(err => this.logger.warn({ err, accountId, reason }, 'publish owner_unassigned failed'))
  }

  private async publishOwnerChanged(
    accountId: string,
    deadWorkerId: string,
    target: WorkerInfo
  ): Promise<void> {
    await this.publisher
      .publish('account.owner_changed', accountId, {
        accountId,
        previousOwnerWorkerId: deadWorkerId,
        ownerWorkerId: target.workerId,
        ownerEndpoint: target.endpoint,
        reason: 'failover',
        changedAt: new Date().toISOString()
      })
      .catch(err =>
        this.logger.warn({ err, accountId }, 'publish owner_changed failed')
      )
  }
}

function pickWorkerWithCapacity(workers: WorkerInfo[]): WorkerInfo | null {
  for (const w of workers) {
    if (w.currentLoad < w.capacity) return w
  }
  return null
}
