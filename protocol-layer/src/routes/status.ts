/**
 * Status 路由 — 状态查询、探活、类型识别
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'

const AccountIdParam = z.object({ accountId: z.string() })

export const registerStatusRoutes: RouteRegistrar = (app, ctx) => {
  app.get('/v1/accounts/:accountId/status', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const runtime = await ctx.runtimeStore.get(accountId)
    const deviceProfile = await ctx.deviceStore.get(accountId)
    const browserDisplay = await ctx.browserDisplayStore.get(accountId)
    let state = runtime?.state
    let evidence: unknown = runtime
      ? {
          wsOpen: false,
          connectionField: 'close',
          ageMs: Date.now() - Date.parse(runtime.updatedAt),
          keepAliveIntervalMs: ctx.config.worker.keepAliveIntervalMs,
          slotReleased: runtime.slotReleased,
          reason: runtime.reason,
          updatedAt: runtime.updatedAt
        }
      : undefined
    let detection = null
    try {
      state = ctx.accounts.getState(accountId)
      evidence = ctx.accounts.getEvidence(accountId)
      detection = ctx.accounts.getDetection(accountId)
    } catch {
      // released slots are tracked by runtimeStore only
    }
    if (!state) return reply.code(404).send({ code: 'ACCOUNT_NOT_FOUND', message: `account ${accountId} not found` })
    const reportedAt = new Date().toISOString()
    const lastStateSyncTime =
      typeof evidence === 'object' && evidence && 'updatedAt' in evidence
        ? String((evidence as { updatedAt?: unknown }).updatedAt ?? reportedAt)
        : runtime?.updatedAt ?? reportedAt
    reply.send({
      accountId,
      state,
      stateSource: 'MANUAL_REFRESH',
      lastStateSyncTime,
      cooldownUntil: null,
      evidence,
      business: detection,
      deviceProfile,
      browserDisplay,
      accountType: detection?.accountType ?? 'UNKNOWN',
      workerId: ctx.config.workerId,
      reportedAt
    })
  })

  app.get('/v1/accounts/:accountId/alive', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const runtime = await ctx.runtimeStore.get(accountId)
    try {
      const evidence = ctx.accounts.getEvidence(accountId)
      reply.send({
        online: ctx.accounts.getState(accountId) === 'ONLINE',
        ageMs: evidence.ageMs,
        reportedAt: new Date().toISOString()
      })
      return
    } catch {
      // released slots are not alive
    }
    reply.send({
      online: false,
      ageMs: runtime ? Date.now() - Date.parse(runtime.updatedAt) : 0,
      state: runtime?.state ?? 'UNKNOWN',
      slotReleased: runtime?.slotReleased ?? false,
      reportedAt: new Date().toISOString()
    })
  })

  app.get('/v1/accounts/:accountId/type', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const d = ctx.accounts.getDetection(accountId)
    if (!d) return reply.code(404).send({ code: 'NOT_DETECTED', message: 'account not detected yet' })
    reply.send(d)
  })

  app.post('/v1/accounts/:accountId/type/refresh', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    // 强制走 sock.getBusinessProfile(selfJid) 兜底
    const sock = ctx.accounts.getSocket(accountId)
    const meId = sock.authState?.creds?.me?.id
    if (!meId) return reply.code(400).send({ code: 'NO_SELF_JID' })
    try {
      const profile = await sock.getBusinessProfile(meId)
      const detection = {
        accountType: profile ? 'BUSINESS_STANDARD' : 'PERSONAL',
        isBusiness: !!profile,
        isVerified: false,
        platform: (sock.authState.creds.platform as string) ?? 'unknown',
        bizName: null,
        verifiedName: null,
        source: 'business_profile_query',
        detectedAt: new Date().toISOString()
      }
      await ctx.publisher.publish('account.type_detected', accountId, { detection })
      reply.send(detection)
    } catch (err) {
      reply.code(500).send({ code: 'REFRESH_FAILED', message: (err as Error).message })
    }
  })

  app.post('/v1/accounts/:accountId/probe', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const probedAt = new Date().toISOString()
    try {
      const r = await ctx.accounts.probe(accountId, 3000)
      reply.send({ ok: true, ackedAt: new Date().toISOString(), probedAt, latencyMs: r.rttMs, rttMs: r.rttMs, reasonCode: 'OK' })
    } catch (err) {
      reply.code(503).send({ ok: false, code: 'PROBE_TIMEOUT', message: (err as Error).message, probedAt, latencyMs: null, reasonCode: 'TIMEOUT' })
    }
  })

  app.post('/v1/accounts/check-whatsapp', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), phones: z.array(z.string()).min(1) })
    const { accountId, phones } = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    const r = await sock.onWhatsApp(...phones)
    reply.send({
      results: phones.map(p => {
        const found = r?.find(x => x.jid.startsWith(p))
        return { phone: p, jid: found?.jid ?? null, exists: !!found?.exists }
      })
    })
  })
}
