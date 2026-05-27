/**
 * Restriction 路由 — 风控查询三件套
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'
import { auditInfo } from './audit-log.js'

const AccountIdParam = z.object({ accountId: z.string() })

export const registerRestrictionRoutes: RouteRegistrar = (app, ctx) => {
  app.get('/v1/accounts/:accountId/restriction', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const sock = ctx.accounts.getSocket(accountId)
    const r = await sock.fetchAccountReachoutTimelock()
    if (r.isActive) {
      ctx.metrics.restrictionActive.inc({ enforcement_type: r.enforcementType ?? 'DEFAULT' })
    }
    const restrictedUntil = r.timeEnforcementEnds?.toISOString() ?? null
    const riskLevel = r.isActive ? 'HIGH' : 'NONE'
    const fetchedAt = new Date().toISOString()
    auditInfo(ctx.logger, 'account.restriction', {
      accountId,
      isActive: !!r.isActive,
      restrictedUntil,
      riskLevel,
      enforcementType: r.enforcementType ?? 'DEFAULT'
    })
    reply.send({
      accountId,
      isActive: !!r.isActive,
      restrictedUntil,
      riskStartTime: null,
      riskEndTime: restrictedUntil,
      cooldownUntil: restrictedUntil,
      riskLevel,
      source: 'reachout_timelock',
      detectedAt: fetchedAt,
      enforcementType: r.enforcementType ?? 'DEFAULT',
      raw: r,
      fetchedAt
    })
  })

  app.get('/v1/accounts/:accountId/message-cap', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const sock = ctx.accounts.getSocket(accountId)
    const r = await sock.fetchNewChatMessageCap()
    const used = r?.used_quota ?? 0
    const total = r?.total_quota ?? 0
    const remaining = Math.max(0, total - used)
    auditInfo(ctx.logger, 'account.message_cap', {
      accountId,
      totalQuota: total,
      usedQuota: used,
      remaining,
      cappingStatus: r?.capping_status ?? 'NONE'
    })
    reply.send({
      accountId,
      totalQuota: total,
      usedQuota: used,
      remaining,
      cycleStart: r?.cycle_start_timestamp ?? null,
      cycleEnd: r?.cycle_end_timestamp ?? null,
      cappingStatus: r?.capping_status ?? 'NONE',
      oteStatus: r?.ote_status ?? null,
      mvStatus: r?.mv_status ?? null,
      fetchedAt: new Date().toISOString()
    })
  })

  app.get('/v1/accounts/:accountId/usability', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const state = ctx.accounts.getState(accountId)
    const evidence = ctx.accounts.getEvidence(accountId)

    // 并发拉两个
    let restriction: { isActive: boolean; restrictedUntil: string | null; enforcementType: string } | null = null
    let cap: { cappingStatus: string; remaining: number; cycleEnd: string | null } | null = null
    try {
      const sock = ctx.accounts.getSocket(accountId)
      const [rRaw, cRaw] = await Promise.allSettled([
        sock.fetchAccountReachoutTimelock(),
        sock.fetchNewChatMessageCap()
      ])
      if (rRaw.status === 'fulfilled') {
        restriction = {
          isActive: !!rRaw.value.isActive,
          restrictedUntil: rRaw.value.timeEnforcementEnds?.toISOString() ?? null,
          enforcementType: rRaw.value.enforcementType ?? 'DEFAULT'
        }
      }
      if (cRaw.status === 'fulfilled' && cRaw.value) {
        const used = cRaw.value.used_quota ?? 0
        const total = cRaw.value.total_quota ?? 0
        cap = {
          cappingStatus: cRaw.value.capping_status ?? 'NONE',
          remaining: Math.max(0, total - used),
          cycleEnd: cRaw.value.cycle_end_timestamp ?? null
        }
      }
    } catch (err) {
      ctx.logger.warn({ err, accountId }, 'usability fetch failed')
    }

    const isOnline = state === 'ONLINE'
    const restrictedActive = restriction?.isActive === true
    const capped = cap?.cappingStatus === 'CAPPED'
    let blockedReason: string | null = null
    let blockedUntil: string | null = null
    if (!isOnline) blockedReason = state === 'NEED_REAUTH' ? 'NEED_REAUTH' : 'OFFLINE'
    else if (restrictedActive) {
      blockedReason = 'REACHOUT_TIMELOCK'
      blockedUntil = restriction?.restrictedUntil ?? null
    } else if (capped) {
      blockedReason = 'NEW_CHAT_CAPPED'
      blockedUntil = cap?.cycleEnd ?? null
    }

    const canSendNewChat = isOnline && !restrictedActive && !capped
    auditInfo(ctx.logger, 'account.usability', {
      accountId,
      state,
      canSendText: isOnline && !restrictedActive,
      canSendNewChat,
      blockedReason,
      blockedUntil
    })
    reply.send({
      accountId,
      state,
      canSendText: isOnline && !restrictedActive,
      canSendNewChat,
      canCreateGroup: canSendNewChat,
      canAddToGroup: canSendNewChat,
      canSendMedia: isOnline,
      canFollowChannel: isOnline,
      blockedReason,
      blockedUntil,
      restriction,
      messageCap: cap,
      evidence
    })
  })
}
