/**
 * Failover — worker 死时把其账号迁到其他 worker。
 *
 * 策略（§ 4.5 类型 B + § 11.3.4 限流）：
 *   1. 列出死 worker 名下账号
 *   2. 按节点级令牌桶速率迁移（避免接收方 worker 被瞬时上线打爆）
 *   3. Registry 更新 assign，新 worker 在心跳时会感知并主动 online
 *   4. 失败的账号留在 unassigned，下一轮重试
 */

import type { Logger } from '../observability/logger.js'
import type { EventPublisher } from '../events/publisher.js'
import type { Registry, WorkerInfo } from './registry.js'

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

    const liveWorkers = (await this.registry.listWorkers()).filter(w => w.workerId !== deadWorkerId)
    if (liveWorkers.length === 0) {
      this.logger.error('no live workers available for migration')
      // 解除分配，等新 worker 接管
      for (const acc of accounts) {
        await this.registry.unassign(acc)
        await this.publisher.publish('account.owner_unassigned', acc, {
          accountId: acc,
          previousOwnerWorkerId: deadWorkerId,
          previousOwnerEndpoint: null,
          reason: 'failover_no_live_worker',
          unassignedAt: new Date().toISOString()
        })
      }
      return
    }

    // 按容量排序（剩余容量大的优先）
    liveWorkers.sort((a, b) => b.capacity - b.currentLoad - (a.capacity - a.currentLoad))

    let migrated = 0
    let failed = 0
    for (const accountId of accounts) {
      const target = pickWorkerWithCapacity(liveWorkers)
      if (!target) {
        await this.registry.unassign(accountId)
        await this.publisher.publish('account.owner_unassigned', accountId, {
          accountId,
          previousOwnerWorkerId: deadWorkerId,
          previousOwnerEndpoint: null,
          reason: 'failover_no_capacity',
          unassignedAt: new Date().toISOString()
        })
        failed++
        continue
      }
      try {
        await this.registry.reassign(accountId, target.workerId)
        await this.publisher.publish('account.owner_changed', accountId, {
          accountId,
          previousOwnerWorkerId: deadWorkerId,
          ownerWorkerId: target.workerId,
          ownerEndpoint: target.endpoint,
          reason: 'failover',
          changedAt: new Date().toISOString()
        })
        target.currentLoad++ // 内存中更新，下次循环用
        migrated++
      } catch (err) {
        this.logger.warn({ err, accountId }, 'failed to reassign')
        failed++
      }
    }

    this.logger.warn(
      { deadWorkerId, migrated, failed, total: accounts.length },
      'migration done'
    )
  }
}

function pickWorkerWithCapacity(workers: WorkerInfo[]): WorkerInfo | null {
  for (const w of workers) {
    if (w.currentLoad < w.capacity) return w
  }
  return null
}
