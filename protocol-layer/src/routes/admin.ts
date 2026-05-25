/**
 * Admin 路由 — 运维与诊断接口。
 *
 * 这些接口不在主业务流上，提供给运维 / 调试 / 兜底修复用。
 * 生产环境应在 nginx / k8s 上加 ACL（仅内网 / 仅 ops jumphost）。
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'

export const registerAdminRoutes: RouteRegistrar = (app, ctx) => {
  /**
   * 强制把本 worker 的 activeSize 硬同步到 Registry load。
   *
   * 何时用：
   *   - 怀疑 Registry currentLoad 与真实 activeSize 偏差大
   *   - worker 重启后没等到自动 90s 硬同步就需要立即纠偏
   */
  app.post('/v1/admin/sync-load', async (_req, reply) => {
    const before = (await ctx.registry.getWorker(ctx.config.workerId))?.currentLoad ?? 0
    const real = ctx.accounts.activeSize()
    await ctx.registry.heartbeat(ctx.config.workerId, real, { force: true })
    ctx.logger.warn(
      { workerId: ctx.config.workerId, before, after: real, drift: before - real },
      'manual force load sync'
    )
    reply.send({
      workerId: ctx.config.workerId,
      registryLoadBefore: before,
      registryLoadAfter: real,
      driftCorrected: before - real,
      syncedAt: new Date().toISOString()
    })
  })

  /** 列出所有活着的 worker（含实时 load / capacity / endpoint） */
  app.get('/v1/admin/workers', async (req, reply) => {
    const Query = z.object({ includeDead: z.coerce.boolean().default(false) })
    const { includeDead } = Query.parse(req.query)
    const workers = await ctx.registry.listWorkers({ includeDead })
    reply.send({
      total: workers.length,
      currentWorkerId: ctx.config.workerId,
      workers
    })
  })

  /** 本 worker 内部账号视图（运维诊断） */
  app.get('/v1/admin/accounts', async (_req, reply) => {
    const ids = ctx.accounts.listAccounts()
    const sample = ids.slice(0, 50).map(id => {
      try {
        return {
          accountId: id,
          state: ctx.accounts.getState(id),
          evidence: ctx.accounts.getEvidence(id),
          detection: ctx.accounts.getDetection(id)
        }
      } catch {
        return { accountId: id, state: 'UNKNOWN' }
      }
    })
    reply.send({
      workerId: ctx.config.workerId,
      activeSize: ctx.accounts.activeSize(),
      totalSize: ids.length,
      sample
    })
  })

  /** 列出 dead worker（master 排查 failover 用） */
  app.get('/v1/admin/dead-workers', async (req, reply) => {
    const Query = z.object({ thresholdMs: z.coerce.number().default(60_000) })
    const { thresholdMs } = Query.parse(req.query)
    const dead = await ctx.registry.getDeadWorkers(thresholdMs)
    reply.send({ thresholdMs, deadWorkerIds: dead, checkedAt: new Date().toISOString() })
  })

  /** 手动 unassign（运维兜底，慎用） */
  app.post('/v1/admin/unassign', async (req, reply) => {
    const Body = z.object({
      accountId: z.string(),
      releaseSlot: z.boolean().default(true)
    })
    const { accountId, releaseSlot } = Body.parse(req.body)
    const before = await ctx.registry.resolveOwner(accountId)
    await ctx.registry.unassign(accountId, { releaseSlot })
    await ctx.publisher.publish('account.owner_unassigned', accountId, {
      accountId,
      previousOwnerWorkerId: before.workerId,
      previousOwnerEndpoint: before.worker?.endpoint ?? null,
      currentWorkerId: ctx.config.workerId,
      releaseSlot,
      reason: 'admin_unassign',
      unassignedAt: new Date().toISOString()
    })
    ctx.logger.warn({ accountId, by: 'admin' }, 'manual unassign')
    reply.send({ accountId, unassigned: true, releaseSlot })
  })
}
