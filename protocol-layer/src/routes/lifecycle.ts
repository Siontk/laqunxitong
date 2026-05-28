/**
 * Lifecycle 路由 — online / offline / logout
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'
import { auditInfo, auditWarn } from './audit-log.js'
import { AccountNotFoundError, NotOwnerError, ProtocolError } from '../error/error-handler.js'
import type { AccountDeviceProfile, BrowserDisplay, BrowserDisplayPlatform, DevicePlatform } from '../store/account-device-store.js'
import { browserFromDisplay } from '../worker/socket-browser.js'

const AccountIdParam = z.object({ accountId: z.string() })
const ProxyShape = z.object({
  protocol: z.enum(['socks5', 'http']),
  url: z.string(),
  sessionId: z.string(),
  country: z.string()
}).passthrough()
const DeviceProfileBody = z.object({
  platform: z.string().optional(),
  manufacturer: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  osVersion: z.string().nullable().optional(),
  device: z.string().nullable().optional(),
  deviceUUID: z.string().nullable().optional(),
  phoneUUID: z.string().nullable().optional(),
  whatsappVersion: z.string().nullable().optional(),
  wsDeviceId: z.number().nullable().optional(),
  deviceCompanion: z.boolean().optional(),
  note: z.string().nullable().optional()
}).passthrough()
const BrowserDisplayBody = z.object({
  browserName: z.string().min(1),
  platform: z.string().min(1),
  version: z.string().nullable().optional()
}).passthrough()
const OnlineBody = z.object({
  proxy: ProxyShape.optional(),
  deviceProfile: DeviceProfileBody.optional(),
  browserDisplay: BrowserDisplayBody.optional()
}).passthrough()
const ReconnectBody = z.object({
  reason: z.enum(['proxy_changed', 'manual', 'stale', 'task_recover']).default('manual'),
  proxy: ProxyShape.optional(),
  force: z.boolean().default(false)
}).passthrough()
const BatchOfflineBody = z.object({
  accountIds: z.array(z.string()).min(1).max(500),
  reason: z.enum(['manual', 'task_pause', 'batch_pause', 'maintenance']).default('manual'),
  maxWaitMs: z.number().int().positive().max(60_000).optional()
}).passthrough()

export const registerLifecycleRoutes: RouteRegistrar = (app, ctx) => {
  app.post('/v1/accounts/:accountId/online', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const body = OnlineBody.parse(req.body ?? {})
    const decision = await ctx.registry.assign(accountId, ctx.config.region)
    const owner = await ctx.registry.resolveOwner(accountId)
    if (decision.workerId !== ctx.config.workerId) {
      throw new NotOwnerError(accountId, ctx.config.workerId, {
        workerId: decision.workerId,
        endpoint: owner.worker?.endpoint
      })
    }
    if (decision.isNew) {
      await ctx.publisher.publish('account.owner_assigned', accountId, {
        accountId,
        ownerWorkerId: decision.workerId,
        ownerEndpoint: owner.worker?.endpoint ?? null,
        currentWorkerId: ctx.config.workerId,
        reason: 'online',
        assignedAt: new Date().toISOString()
      })
    }
    // 优先用 body 中的 proxy；没传则从 ProxyStore 取已绑定
    let proxy = body.proxy as Parameters<typeof ctx.accounts.online>[1] | undefined
    if (!proxy) {
      const stored = await ctx.proxyStore.get(accountId)
      if (!stored) {
        auditWarn(ctx.logger, 'account.online.rejected', { accountId, reason: 'PROXY_REQUIRED' })
        return reply.code(400).send({
          code: 'PROXY_REQUIRED',
          message: 'proxy binding missing — call /proxy/bind first or include in body'
        })
      }
      proxy = stored
    }
    const requestProfile = buildLifecycleDeviceProfile(accountId, body.deviceProfile)
    const browserDisplay = buildBrowserDisplay(accountId, body.browserDisplay, ctx.config.baileys.browserName)
    if (requestProfile) await ctx.deviceStore.save(requestProfile)
    if (browserDisplay) await ctx.browserDisplayStore.save(browserDisplay)

    // ─── 限流：防止业务方并发 2000 直接打爆 libsignal CPU ───
    const gate = await ctx.onlineGate.tryOnline(accountId)
    if (!gate.allowed) {
      ctx.metrics.onlineTotal.inc({ source: 'api', result: 'rejected' })
      auditWarn(ctx.logger, 'account.online.limited', {
        accountId,
        reason: gate.reason,
        retryAfterMs: gate.retryAfterMs
      })
      throw new ProtocolError(429, 'ONLINE_LIMITED', `online rate limited for ${accountId}`, {
        accountId,
        reason: gate.reason,
        retryAfterMs: gate.retryAfterMs,
        cooldownUntil: gate.retryAfterMs ? new Date(Date.now() + gate.retryAfterMs).toISOString() : null
      })
    }

    await ctx.accounts.online(
      accountId,
      proxy,
      undefined,
      browserDisplay ? browserFromDisplay(browserDisplay, ctx.config) : undefined,
      'api'
    )
    auditInfo(ctx.logger, 'account.online.accepted', {
      accountId,
      ownerWorkerId: decision.workerId,
      ownerEndpoint: owner.worker?.endpoint ?? null,
      proxySessionId: proxy.sessionId,
      proxyCountry: proxy.country,
      browserName: browserDisplay?.browserName ?? null,
      browserPlatform: browserDisplay?.platform ?? null
    })
    reply.code(202).send({
      accountId,
      accepted: true,
      stateSource: 'MANUAL_REFRESH',
      syncedAt: new Date().toISOString(),
      routing: {
        ownerWorkerId: decision.workerId,
        ownerEndpoint: owner.worker?.endpoint ?? null,
        currentWorkerId: ctx.config.workerId,
        local: true
      }
    })
  })

  /**
   * 批量上线 — 适合"主动下线后重新拉起 2000 个号"这种场景。
   *
   * 协议层会：
   *   1. 一次性解析所有 accountId 的 owner，按 ownerEndpoint 分桶；
   *      非本 worker 的部分以 `assigned_remote` 返回，业务侧分发到对应 endpoint。
   *   2. 本 worker 的部分进 OnlineGate.waitOnline 排队节奏化（默认 50/s），
   *      Noise 握手异步并行，CPU 不会被打爆。
   *
   * 设计：调用方 await 直到全部完成（或超时），避免业务侧自己做 HTTP 并发管理。
   * 2000 账号节点级（4C8G × 50/s）：~ 40s 通过限流闸门 + Noise 握手 = ~ 60-90s 全 ONLINE。
   */
  app.post('/v1/accounts/online/batch', async (req, reply) => {
    const Body = z.object({
      items: z.array(z.object({
        accountId: z.string(),
        proxy: ProxyShape.optional(),
        deviceProfile: DeviceProfileBody.optional(),
        browserDisplay: BrowserDisplayBody.optional()
      })).min(1).max(ctx.config.rateLimit.batchOnlineMaxSize),
      /** 全批次最长等待。超过的账号返回 timeout（不阻塞业务侧） */
      maxWaitMs: z.number().int().positive().max(180_000).optional()
    })
    const { items, maxWaitMs } = Body.parse(req.body)
    const waitMs = maxWaitMs ?? ctx.config.rateLimit.batchOnlineWaitMs

    // 1. owner resolve（批量 lookup，O(1) 走 hmget）
    const ownerMap = await ctx.registry.lookupBatch(items.map(i => i.accountId))
    const workers = await ctx.registry.listWorkers()
    const workersById = new Map(workers.map(w => [w.workerId, w]))

    // 2. 按 owner 分类
    const localItems: typeof items = []
    const remoteItems: Array<{ accountId: string; ownerWorkerId: string; ownerEndpoint: string | null }> = []
    const unassignedItems: typeof items = []

    for (const item of items) {
      const ownerId = ownerMap[item.accountId]
      if (!ownerId) {
        unassignedItems.push(item)
      } else if (ownerId === ctx.config.workerId) {
        localItems.push(item)
      } else {
        remoteItems.push({
          accountId: item.accountId,
          ownerWorkerId: ownerId,
          ownerEndpoint: workersById.get(ownerId)?.endpoint ?? null
        })
      }
    }

    // 3. unassigned 走 assign → 也可能落到 remote
    const newlyAssignedRemote: typeof remoteItems = []
    for (const item of unassignedItems) {
      try {
        const decision = await ctx.registry.assign(item.accountId, ctx.config.region)
        if (decision.workerId === ctx.config.workerId) {
          localItems.push(item)
          if (decision.isNew) {
            await ctx.publisher.publish('account.owner_assigned', item.accountId, {
              accountId: item.accountId,
              ownerWorkerId: decision.workerId,
              ownerEndpoint: ctx.config.http.publicEndpoint ?? null,
              currentWorkerId: ctx.config.workerId,
              reason: 'batch_online',
              assignedAt: new Date().toISOString()
            }).catch(() => {})
          }
        } else {
          newlyAssignedRemote.push({
            accountId: item.accountId,
            ownerWorkerId: decision.workerId,
            ownerEndpoint: workersById.get(decision.workerId)?.endpoint ?? null
          })
        }
      } catch (err) {
        ctx.logger.warn({ err, accountId: item.accountId }, 'batch assign failed')
        newlyAssignedRemote.push({
          accountId: item.accountId,
          ownerWorkerId: '',
          ownerEndpoint: null
        })
      }
    }

    // 4. 本地 items 并发节流上线：每个 await OnlineGate.waitOnline 拿令牌
    //    然后 accounts.online() 启 socket。返回每个的结果。
    const startedAt = Date.now()
    const results = await Promise.all(localItems.map(async item => {
      const gateOk = await ctx.onlineGate.waitOnline(item.accountId, waitMs)
      if (!gateOk) {
        ctx.metrics.onlineTotal.inc({ source: 'batch', result: 'rejected' })
        return {
          accountId: item.accountId,
          result: 'timeout' as const,
          retryAfterMs: 5_000
        }
      }
      try {
        // proxy: 优先 body，缺则查 store
        let proxy = item.proxy as Parameters<typeof ctx.accounts.online>[1] | undefined
        if (!proxy) {
          const stored = await ctx.proxyStore.get(item.accountId)
          if (!stored) {
            ctx.metrics.onlineTotal.inc({ source: 'batch', result: 'error' })
            return {
              accountId: item.accountId,
              result: 'proxy_required' as const,
              error: 'proxy binding missing'
            }
          }
          proxy = stored
        }
        const requestProfile = buildLifecycleDeviceProfile(item.accountId, item.deviceProfile)
        const browserDisplay = buildBrowserDisplay(item.accountId, item.browserDisplay, ctx.config.baileys.browserName)
        if (requestProfile) await ctx.deviceStore.save(requestProfile).catch(() => {})
        if (browserDisplay) await ctx.browserDisplayStore.save(browserDisplay).catch(() => {})
        await ctx.accounts.online(
          item.accountId,
          proxy,
          undefined,
          browserDisplay ? browserFromDisplay(browserDisplay, ctx.config) : undefined,
          'batch'
        )
        return { accountId: item.accountId, result: 'accepted' as const }
      } catch (err) {
        ctx.metrics.onlineTotal.inc({ source: 'batch', result: 'error' })
        const message = err instanceof Error ? err.message : String(err)
        return { accountId: item.accountId, result: 'error' as const, error: message }
      }
    }))

    const elapsed = Date.now() - startedAt
    const summary = results.reduce((acc, r) => {
      acc[r.result] = (acc[r.result] ?? 0) + 1
      return acc
    }, {} as Record<string, number>)

    auditInfo(ctx.logger, 'account.online.batch', {
      requested: items.length,
      local: localItems.length,
      remote: remoteItems.length + newlyAssignedRemote.length,
      elapsedMs: elapsed,
      ...summary
    })

    reply.send({
      requestedAt: new Date(startedAt).toISOString(),
      elapsedMs: elapsed,
      summary: {
        requested: items.length,
        local: localItems.length,
        remote: remoteItems.length + newlyAssignedRemote.length,
        accepted: summary.accepted ?? 0,
        timeout: summary.timeout ?? 0,
        proxyRequired: summary.proxy_required ?? 0,
        error: summary.error ?? 0
      },
      results,
      remote: [...remoteItems, ...newlyAssignedRemote].map(r => ({
        accountId: r.accountId,
        ownerWorkerId: r.ownerWorkerId,
        ownerEndpoint: r.ownerEndpoint,
        note: 'redispatch to ownerEndpoint'
      }))
    })
  })

  app.post('/v1/accounts/:accountId/offline', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    await ctx.accounts.offline(accountId)
    auditInfo(ctx.logger, 'account.offline', { accountId, reason: 'manual' })
    reply.send({ ok: true })
  })

  /**
   * 批量下线 — 只断开 socket + 释放 worker runtime slot。
   *
   * 不 logout、不删 creds、不删 proxy、不解除 Registry owner 绑定。
   * 后续再次 online/batch online 不需要重新授权。
   */
  app.post('/v1/accounts/offline/batch', async (req, reply) => {
    const { accountIds, reason } = BatchOfflineBody.parse(req.body ?? {})
    const startedAt = Date.now()

    const ownerMap = await ctx.registry.lookupBatch(accountIds)
    const workers = await ctx.registry.listWorkers()
    const workersById = new Map(workers.map(w => [w.workerId, w]))

    const localIds: string[] = []
    const remoteItems: Array<{ accountId: string; ownerWorkerId: string; ownerEndpoint: string | null }> = []
    const unassignedIds: string[] = []

    for (const accountId of accountIds) {
      const ownerId = ownerMap[accountId]
      if (!ownerId) {
        unassignedIds.push(accountId)
      } else if (ownerId === ctx.config.workerId) {
        localIds.push(accountId)
      } else {
        remoteItems.push({
          accountId,
          ownerWorkerId: ownerId,
          ownerEndpoint: workersById.get(ownerId)?.endpoint ?? null
        })
      }
    }

    const localResults = await Promise.all(localIds.map(async accountId => {
      try {
        const beforeState = ctx.accounts.getState(accountId)
        await ctx.accounts.offline(accountId)
        return {
          accountId,
          result: beforeState === 'OFFLINE' ? 'already_offline' as const : 'offline' as const
        }
      } catch (err) {
        if (err instanceof AccountNotFoundError) {
          return { accountId, result: 'already_offline' as const }
        }
        const runtime = await ctx.runtimeStore.get(accountId).catch(() => null)
        if (runtime?.slotReleased || runtime?.state === 'OFFLINE') {
          return { accountId, result: 'already_offline' as const }
        }
        const message = err instanceof Error ? err.message : String(err)
        return { accountId, result: 'error' as const, error: message }
      }
    }))

    const unassignedResults = unassignedIds.map(accountId => ({
      accountId,
      result: 'not_found' as const
    }))

    const results = [...localResults, ...unassignedResults]
    const summary = results.reduce((acc, r) => {
      acc[r.result] = (acc[r.result] ?? 0) + 1
      return acc
    }, {} as Record<string, number>)
    const elapsed = Date.now() - startedAt

    auditInfo(ctx.logger, 'account.offline.batch', {
      requested: accountIds.length,
      local: localIds.length,
      remote: remoteItems.length,
      reason,
      elapsedMs: elapsed,
      ...summary
    })

    reply.send({
      requestedAt: new Date(startedAt).toISOString(),
      elapsedMs: elapsed,
      summary: {
        requested: accountIds.length,
        local: localIds.length,
        remote: remoteItems.length,
        offline: summary.offline ?? 0,
        alreadyOffline: summary.already_offline ?? 0,
        notFound: summary.not_found ?? 0,
        error: summary.error ?? 0
      },
      results,
      remote: remoteItems.map(r => ({
        accountId: r.accountId,
        ownerWorkerId: r.ownerWorkerId,
        ownerEndpoint: r.ownerEndpoint,
        note: 'redispatch to ownerEndpoint'
      }))
    })
  })

  app.post('/v1/accounts/:accountId/reconnect', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const body = ReconnectBody.parse(req.body ?? {})
    const currentState = ctx.accounts.getState(accountId)
    if (currentState === 'NEED_REAUTH' || currentState === 'LOGGED_OUT' || currentState === 'DEVICE_REMOVED') {
      throw new ProtocolError(422, 'NEED_REAUTH', `account ${accountId} cannot reconnect from ${currentState}`, {
        accountId,
        state: currentState,
        reason: 'terminal_state'
      })
    }

    const limit = await ctx.reconnectGate.tryManualReconnect(accountId)
    if (!limit.allowed) {
      await ctx.publisher.publish('account.reconnect_limited', accountId, {
        accountId,
        state: currentState,
        retryAfterMs: limit.retryAfterMs,
        cooldownUntil: limit.cooldownUntil,
        reason: limit.reason ?? 'reconnect_limited',
        requestedReason: body.reason,
        force: body.force,
        workerId: ctx.config.workerId,
        occurredAt: new Date().toISOString()
      })
      auditWarn(ctx.logger, 'account.reconnect.limited', {
        accountId,
        state: currentState,
        retryAfterMs: limit.retryAfterMs,
        cooldownUntil: limit.cooldownUntil,
        reason: limit.reason
      })
      throw new ProtocolError(429, 'RECONNECT_LIMITED', `account ${accountId} reconnect limited`, {
        accountId,
        retryAfterMs: limit.retryAfterMs,
        cooldownUntil: limit.cooldownUntil,
        reason: limit.reason
      })
    }

    const proxy = body.proxy ?? await ctx.proxyStore.get(accountId)
    if (!proxy) {
      auditWarn(ctx.logger, 'account.reconnect.rejected', { accountId, reason: 'PROXY_REQUIRED' })
      return reply.code(400).send({
        code: 'PROXY_REQUIRED',
        message: 'proxy binding missing — call /proxy/bind first or include in body'
      })
    }
    if (body.proxy) await ctx.proxyStore.bind(accountId, body.proxy)

    const result = await ctx.accounts.requestReconnect(accountId, body.reason, proxy)
    await ctx.publisher.publish('account.reconnect_requested', accountId, {
      accountId,
      fromState: currentState,
      state: result.state,
      reason: body.reason,
      force: body.force,
      proxySessionId: proxy.sessionId,
      proxyCountry: proxy.country,
      alreadyInFlight: result.alreadyInFlight,
      workerId: ctx.config.workerId,
      requestedAt: new Date().toISOString()
    })
    auditInfo(ctx.logger, 'account.reconnect.accepted', {
      accountId,
      fromState: currentState,
      state: result.state,
      reason: body.reason,
      proxySessionId: proxy.sessionId,
      proxyCountry: proxy.country,
      alreadyInFlight: result.alreadyInFlight
    })
    reply.code(202).send({
      accountId,
      accepted: true,
      alreadyInFlight: result.alreadyInFlight,
      state: result.state,
      retryAfterMs: null,
      cooldownUntil: null
    })
  })

  app.post('/v1/accounts/:accountId/logout', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    await ctx.accounts.logout(accountId)
    await ctx.publisher.publish('account.logout', accountId, {
      accountId,
      reason: 'MANUAL',
      ts: new Date().toISOString()
    })
    auditInfo(ctx.logger, 'account.logout', { accountId, reason: 'MANUAL' })
    reply.send({ ok: true })
  })
}

function buildLifecycleDeviceProfile(
  accountId: string,
  input?: z.infer<typeof DeviceProfileBody>
): AccountDeviceProfile | null {
  if (!input) return null
  return {
    accountId,
    platform: normalizeDevicePlatform(input.platform),
    source: 'import_body',
    manufacturer: input.manufacturer ?? null,
    model: input.model ?? input.device ?? null,
    osVersion: input.osVersion ?? null,
    device: input.device ?? null,
    deviceUUID: input.deviceUUID ?? null,
    phoneUUID: input.phoneUUID ?? null,
    whatsappVersion: input.whatsappVersion ?? null,
    wsDeviceId: input.wsDeviceId ?? null,
    deviceCompanion: input.deviceCompanion ?? false,
    note: input.note ?? null,
    updatedAt: new Date().toISOString()
  }
}

function normalizeDevicePlatform(value: unknown): DevicePlatform {
  if (typeof value !== 'string') return 'unknown'
  const v = value.toLowerCase()
  if (v === 'windows' || v === 'win') return 'windows'
  if (v === 'macos' || v === 'mac' || v === 'mac os' || v === 'osx' || v === 'darwin') return 'macos'
  if (v === 'linux' || v === 'ubuntu') return 'linux'
  return 'unknown'
}

function buildBrowserDisplay(
  accountId: string,
  input: z.infer<typeof BrowserDisplayBody> | undefined,
  fallbackBrowserName: string
): BrowserDisplay | null {
  if (!input) return null
  return {
    accountId,
    browserName: input.browserName ?? fallbackBrowserName,
    platform: normalizeBrowserDisplayPlatform(input.platform),
    version: input.version ?? null,
    updatedAt: new Date().toISOString()
  }
}

function normalizeBrowserDisplayPlatform(value: string | undefined): BrowserDisplayPlatform {
  if (!value) return 'unknown'
  const v = value.toLowerCase()
  if (v === 'windows' || v === 'win') return 'windows'
  if (v === 'macos' || v === 'mac' || v === 'mac os' || v === 'osx' || v === 'darwin') return 'macos'
  if (v === 'linux' || v === 'ubuntu') return 'linux'
  if (v === 'ios' || v === 'iphone' || v === 'ipad') return 'ios'
  if (v === 'android') return 'android'
  return 'unknown'
}
