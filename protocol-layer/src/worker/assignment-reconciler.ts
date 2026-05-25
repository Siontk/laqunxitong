/**
 * AssignmentReconciler — worker 低频接管扫描。
 *
 * Master/failover 只更新 Registry；具体 socket 拉起由 owner worker 自己完成。
 * 这样协议层不做请求代理，也不让业务层决定账号归属。
 *
 * 容量与节奏（§ 4.5 + § 11.3.4）：
 *   - 接管前判 activeSize < maxAccounts，避免 OOM
 *   - 单 tick 最多 adoptBatchSize 个，剩下等下次 tick
 *   - 每个 adopt 之间 sleep adoptIntervalMs，避免 ws 瞬时风暴
 *
 * Registry load 计数：
 *   - adopt 路径**不**调 Registry.assign（账号已分给本 worker），所以**不重复 +1**
 *   - master 在 reassign / failover 时已经 +1 过
 *   - worker 心跳每 heartbeatIntervalMs 上报真实 activeSize，最终一致兜底
 *   - 如果 worker 重启没 graceful exit，Registry load 可能比真实值高，
 *     重启后第一次心跳会 HSET 覆盖纠正
 */

import type { Logger } from '../observability/logger.js'
import type { Metrics } from '../observability/metrics.js'
import type { Registry } from '../registry/registry.js'
import type { ProxyStore } from '../store/proxy-store.js'
import type { CredsStore } from '../store/creds-store.js'
import type { AccountRuntimeStore } from '../store/account-runtime-store.js'
import type { AccountManager } from './account-manager.js'

export interface AssignmentReconcilerDeps {
  workerId: string
  registry: Registry
  accounts: AccountManager
  proxyStore: ProxyStore
  credsStore: CredsStore
  runtimeStore: AccountRuntimeStore
  logger: Logger
  metrics: Metrics
  intervalMs?: number
  /** 单 worker 容量上限（activeSize 不能超过此值），来自 config.worker.maxAccountsPerWorker */
  maxAccounts: number
  /** 单 tick 最多接管多少账号，默认 50 */
  adoptBatchSize?: number
  /** 每个 adopt 之间间隔（毫秒），默认 200ms */
  adoptIntervalMs?: number
}

export class AssignmentReconciler {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly deps: AssignmentReconcilerDeps) {}

  start(): void {
    const intervalMs = this.deps.intervalMs ?? 30_000
    this.timer = setInterval(() => {
      this.tick().catch(err => this.deps.logger.warn({ err }, 'assignment reconcile failed'))
    }, intervalMs)
    this.timer.unref()
    this.tick().catch(err => this.deps.logger.warn({ err }, 'assignment reconcile failed'))
    this.deps.logger.info(
      {
        intervalMs,
        adoptBatchSize: this.deps.adoptBatchSize ?? 50,
        adoptIntervalMs: this.deps.adoptIntervalMs ?? 200,
        maxAccounts: this.deps.maxAccounts
      },
      'assignment reconciler started'
    )
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    const batchSize = this.deps.adoptBatchSize ?? 50
    const adoptInterval = this.deps.adoptIntervalMs ?? 200

    try {
      const assignments = await this.deps.registry.listAssignmentsOnWorker(this.deps.workerId)
      const local = new Set(this.deps.accounts.listAccounts())
      const now = Date.now()

      // 计算 pending adoption 延迟（assigned 但 local 不在的）
      const pending = assignments.filter(a => !local.has(a.accountId))
      const maxAgeSec = pending.reduce(
        (m, a) => Math.max(m, a.assignedAt > 0 ? (now - a.assignedAt) / 1000 : 0),
        0
      )
      this.deps.metrics.pendingAdoptionSec.set({ stage: 'max' }, maxAgeSec)
      this.deps.metrics.pendingAdoptionSec.set({ stage: 'count' }, pending.length)

      let adopted = 0
      let skippedReleased = 0
      let skippedMissing = 0
      let skippedFull = 0

      for (const { accountId } of assignments) {
        if (local.has(accountId)) continue

        // 容量护栏
        if (this.deps.accounts.activeSize() >= this.deps.maxAccounts) {
          skippedFull++
          continue
        }
        // 单 tick 接管上限（剩下等下次）
        if (adopted >= batchSize) break

        const [creds, proxy, runtime] = await Promise.all([
          this.deps.credsStore.load(accountId),
          this.deps.proxyStore.get(accountId),
          this.deps.runtimeStore.get(accountId)
        ])
        if (runtime?.slotReleased) {
          skippedReleased++
          this.deps.logger.debug({ accountId, state: runtime.state }, 'skip released account slot')
          continue
        }
        if (!creds || !proxy) {
          skippedMissing++
          this.deps.logger.warn(
            { accountId, hasCreds: !!creds, hasProxy: !!proxy },
            'assigned account cannot be auto-adopted yet'
          )
          continue
        }

        this.deps.logger.info({ accountId }, 'adopting assigned account')
        try {
          await this.deps.accounts.online(accountId, proxy)
          adopted++
          if (adoptInterval > 0 && adopted < batchSize) {
            await new Promise(r => setTimeout(r, adoptInterval))
          }
        } catch (err) {
          this.deps.logger.warn({ err, accountId }, 'adopt online failed')
        }
      }

      if (adopted > 0 || skippedFull > 0 || skippedMissing > 0 || pending.length > 0) {
        this.deps.logger.info(
          {
            adopted,
            skippedReleased,
            skippedMissing,
            skippedFull,
            assignedTotal: assignments.length,
            localTotal: local.size,
            pendingTotal: pending.length,
            pendingMaxAgeSec: Math.round(maxAgeSec),
            activeNow: this.deps.accounts.activeSize()
          },
          'assignment reconcile tick done'
        )
      }
    } finally {
      this.running = false
    }
  }
}
