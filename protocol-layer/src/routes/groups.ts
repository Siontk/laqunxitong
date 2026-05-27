/**
 * Groups 路由 — 22 个接口
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'
import { auditInfo, auditInfoSampled, summarizeParticipantResults } from './audit-log.js'

const GroupJidParam = z.object({ groupJid: z.string() })
const AccountIdParam = z.object({ accountId: z.string() })

const AccountIdBody = z.object({ accountId: z.string() })
const ParticipantsBody = z.object({
  accountId: z.string(),
  participants: z.array(z.string()).min(1).max(50),
  timeoutMs: z.number().int().positive().max(120_000).default(30_000)
})

const GroupHealth = z.enum(['HEALTHY', 'RISK', 'BANNED', 'FULL', 'UNKNOWN', 'ERROR'])

function inviteCodeFrom(input: string): string {
  const trimmed = input.trim()
  const match = trimmed.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/)
  return match?.[1] ?? trimmed.replace(/^https?:\/\//, '')
}

function participantCode(status: string | number | undefined): string {
  const s = String(status ?? '500')
  if (s === '200') return 'OK'
  if (s === '403') return 'PRIVACY_BLOCKED'
  if (s === '408') return 'TIMEOUT'
  if (s === '409') return 'ALREADY_IN'
  if (s === '419') return 'GROUP_FULL'
  return 'SERVER_ERROR'
}

function normalizeParticipantResults(
  groupJid: string,
  results: Array<Record<string, unknown>>,
  timeoutMs: number | undefined,
  expectedCount: number
): { groupJid: string; partial: boolean; timeoutMs?: number; results: Array<Record<string, unknown>> } {
  const normalized = results.map(r => {
    const rawStatus = String(r.status ?? '500')
    return {
      ...r,
      rawStatus,
      status: participantCode(rawStatus)
    }
  })
  return {
    groupJid,
    partial: normalized.length < expectedCount,
    timeoutMs,
    results: normalized
  }
}

async function withParticipantTimeout(
  action: Promise<Array<Record<string, unknown>>>,
  timeoutMs: number
): Promise<{ timedOut: boolean; results: Array<Record<string, unknown>> }> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    timer.unref?.()
  })
  const result = await Promise.race([action, timeout])
  if (timer) clearTimeout(timer)
  if (result === 'timeout') {
    action.catch(() => {
      // the route already returned partial=true; any late failure is not actionable here
    })
    return { timedOut: true, results: [] }
  }
  return { timedOut: false, results: result }
}

function auditParticipantAction(
  ctx: Parameters<RouteRegistrar>[1],
  action: string,
  accountId: string,
  groupJid: string,
  results: ReturnType<typeof normalizeParticipantResults>
): void {
  auditInfo(ctx.logger, action, {
    accountId,
    groupJid,
    partial: results.partial,
    timeoutMs: results.timeoutMs,
    ...summarizeParticipantResults(results.results)
  })
}

async function runParticipantMutation(
  ctx: Parameters<RouteRegistrar>[1],
  accountId: string,
  groupJid: string,
  action: string,
  fn: () => Promise<{ timedOut: boolean; results: Array<Record<string, unknown>> }>,
  timeoutMs: number,
  expectedCount: number
): Promise<ReturnType<typeof normalizeParticipantResults>> {
  return ctx.operationGate.runGroup(accountId, action, async () => {
    const r = await fn()
    const results = normalizeParticipantResults(groupJid, r.results, timeoutMs, expectedCount)
    auditParticipantAction(ctx, action, accountId, groupJid, results)
    return {
      value: results,
      holdLockUntilTtl: r.timedOut
    }
  })
}

export const registerGroupsRoutes: RouteRegistrar = (app, ctx) => {
  // ─── 创建 / 拉人 / 移除 / 升降级 ───
  app.post('/v1/groups/create', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), subject: z.string().max(100), participants: z.array(z.string()).min(1) })
    const { accountId, subject, participants } = Body.parse(req.body)
    await ctx.operationGate.runGroup(accountId, 'group.create', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      const created = await sock.groupCreate(subject, participants)
      ctx.metrics.groupCreateTotal.inc({ result: 'success' })
      const results = normalizeParticipantResults(
        created.id,
        created.participants?.map(p => ({ jid: p.id, status: '200' })) ?? [],
        undefined,
        participants.length
      )
      auditParticipantAction(ctx, 'group.create', accountId, created.id, results)
      reply.send({
        groupJid: created.id,
        results
      })
    }).catch(err => {
      ctx.metrics.groupCreateTotal.inc({ result: 'error' })
      throw err
    })
  })

  app.post('/v1/groups/:groupJid/participants/add', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, participants, timeoutMs } = ParticipantsBody.parse(req.body)
    const results = await runParticipantMutation(ctx, accountId, groupJid, 'group.participants.add', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      return withParticipantTimeout(
        sock.groupParticipantsUpdate(groupJid, participants, 'add') as unknown as Promise<Array<Record<string, unknown>>>,
        timeoutMs
      )
    }, timeoutMs, participants.length)
    for (const p of results.results) ctx.metrics.groupAddParticipantsTotal.inc({ result: String(p.status ?? 'unknown') })
    reply.send(results)
  })

  app.post('/v1/groups/:groupJid/participants/remove', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, participants, timeoutMs } = ParticipantsBody.parse(req.body)
    const results = await runParticipantMutation(ctx, accountId, groupJid, 'group.participants.remove', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      return withParticipantTimeout(
        sock.groupParticipantsUpdate(groupJid, participants, 'remove') as unknown as Promise<Array<Record<string, unknown>>>,
        timeoutMs
      )
    }, timeoutMs, participants.length)
    reply.send(results)
  })

  app.post('/v1/groups/:groupJid/participants/promote', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, participants, timeoutMs } = ParticipantsBody.parse(req.body)
    const results = await runParticipantMutation(ctx, accountId, groupJid, 'group.participants.promote', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      return withParticipantTimeout(
        sock.groupParticipantsUpdate(groupJid, participants, 'promote') as unknown as Promise<Array<Record<string, unknown>>>,
        timeoutMs
      )
    }, timeoutMs, participants.length)
    reply.send(results)
  })

  app.post('/v1/groups/:groupJid/participants/demote', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, participants, timeoutMs } = ParticipantsBody.parse(req.body)
    const results = await runParticipantMutation(ctx, accountId, groupJid, 'group.participants.demote', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      return withParticipantTimeout(
        sock.groupParticipantsUpdate(groupJid, participants, 'demote') as unknown as Promise<Array<Record<string, unknown>>>,
        timeoutMs
      )
    }, timeoutMs, participants.length)
    reply.send(results)
  })

  app.post('/v1/groups/preview', async (req, reply) => {
    const { accountId, inviteLink } = z.object({ accountId: z.string(), inviteLink: z.string() }).parse(req.body)
    const inviteCode = inviteCodeFrom(inviteLink)
    const sock = ctx.accounts.getSocket(accountId)
    const meta = await sock.groupGetInviteInfo(inviteCode)
    const memberCount = meta.participants?.length ?? meta.size ?? 0
    auditInfo(ctx.logger, 'group.preview', {
      accountId,
      groupJid: meta.id,
      memberCount,
      inviteCodeSuffix: inviteCode.slice(-6)
    })
    reply.send({
      groupJid: meta.id,
      subject: meta.subject ?? null,
      memberCount,
      size: memberCount,
      isBanned: false,
      ownerJid: meta.owner ?? null,
      desc: meta.desc ?? null,
      announce: !!meta.announce,
      restrict: !!meta.restrict,
      inviteCode,
      previewAt: new Date().toISOString()
    })
  })

  // ─── 群信息查询 ───
  app.get('/v1/groups/:groupJid/metadata', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId } = z.object({ accountId: z.string() }).parse(req.query)
    const sock = ctx.accounts.getSocket(accountId)
    const meta = await sock.groupMetadata(groupJid)
    auditInfo(ctx.logger, 'group.metadata', {
      accountId,
      groupJid,
      size: meta.participants?.length ?? 0,
      announce: !!meta.announce,
      restrict: !!meta.restrict
    })
    reply.send({
      ...meta,
      size: meta.participants?.length ?? 0,
      isBanned: false,
      lastActivityAt: null
    })
  })

  app.get('/v1/groups/:groupJid/participants', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId } = z.object({ accountId: z.string() }).parse(req.query)
    const sock = ctx.accounts.getSocket(accountId)
    const meta = await sock.groupMetadata(groupJid)
    auditInfo(ctx.logger, 'group.participants.list', { accountId, groupJid, count: meta.participants.length })
    reply.send(meta.participants)
  })

  app.get('/v1/accounts/:accountId/groups', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const sock = ctx.accounts.getSocket(accountId)
    const all = await sock.groupFetchAllParticipating()
    const list = Object.values(all).map(g => ({
      groupJid: g.id,
      subject: g.subject,
      size: g.participants.length,
      owner: g.owner,
      isAdmin: g.participants.some(p => p.id === sock.user?.id && (p.admin === 'admin' || p.admin === 'superadmin')),
      announce: !!g.announce,
      creation: g.creation
    }))
    auditInfo(ctx.logger, 'group.list', { accountId, total: list.length })
    reply.send({ total: list.length, groups: list })
  })

  // ─── 群设置 ───
  app.post('/v1/groups/:groupJid/subject', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, subject } = z.object({ accountId: z.string(), subject: z.string().max(100) }).parse(req.body)
    await ctx.operationGate.runGroup(accountId, 'group.subject.update', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      await sock.groupUpdateSubject(groupJid, subject)
    })
    auditInfoSampled(ctx.config, ctx.logger, 'group.subject.update', { accountId, groupJid })
    reply.send({ success: true, groupJid })
  })

  app.post('/v1/groups/:groupJid/description', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, description } = z.object({ accountId: z.string(), description: z.string().nullable() }).parse(req.body)
    await ctx.operationGate.runGroup(accountId, 'group.description.update', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      await sock.groupUpdateDescription(groupJid, description ?? undefined)
    })
    auditInfoSampled(ctx.config, ctx.logger, 'group.description.update', { accountId, groupJid, cleared: description === null })
    reply.send({ success: true, groupJid })
  })

  app.post('/v1/groups/:groupJid/announcement-text', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, text } = z.object({ accountId: z.string(), text: z.string().max(512) }).parse(req.body)
    await ctx.operationGate.runGroup(accountId, 'group.announcement_text.update', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      await sock.groupUpdateDescription(groupJid, text)
    })
    await ctx.publisher.publish('group.metadata_updated', accountId, {
      groupJid,
      changes: { description: text, announcementText: text },
      operator: accountId,
      occurredAt: new Date().toISOString()
    })
    auditInfoSampled(ctx.config, ctx.logger, 'group.announcement_text.update', { accountId, groupJid, appliedAs: 'description' })
    reply.send({ success: true, groupJid, text, appliedAs: 'description' })
  })

  app.post('/v1/groups/:groupJid/picture', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, image } = z.object({ accountId: z.string(), image: z.object({ url: z.string().optional(), base64: z.string().optional() }) }).parse(req.body)
    await ctx.operationGate.runGroup(accountId, 'group.picture.update', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      const buf = image.base64 ? Buffer.from(image.base64, 'base64') : { url: image.url! }
      await sock.updateProfilePicture(groupJid, buf as never)
    })
    auditInfoSampled(ctx.config, ctx.logger, 'group.picture.update', { accountId, groupJid, input: image.base64 ? 'base64' : 'url' })
    reply.send({ success: true })
  })

  // ─── 邀请 ───
  app.get('/v1/groups/:groupJid/invite-code', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId } = z.object({ accountId: z.string() }).parse(req.query)
    const sock = ctx.accounts.getSocket(accountId)
    const code = (await sock.groupInviteCode(groupJid)) ?? ''
    auditInfo(ctx.logger, 'group.invite_code.get', { accountId, groupJid, inviteCodeSuffix: code.slice(-6) })
    reply.send({ groupJid, inviteCode: code, inviteUrl: `https://chat.whatsapp.com/${code}` })
  })

  app.post('/v1/groups/:groupJid/invite/revoke', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId } = AccountIdBody.parse(req.body)
    const code = await ctx.operationGate.runGroup(accountId, 'group.invite_code.revoke', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      return (await sock.groupRevokeInvite(groupJid)) ?? ''
    })
    auditInfoSampled(ctx.config, ctx.logger, 'group.invite_code.revoke', { accountId, groupJid, inviteCodeSuffix: code.slice(-6) })
    reply.send({ groupJid, inviteCode: code, inviteUrl: `https://chat.whatsapp.com/${code}` })
  })

  app.post('/v1/groups/join', async (req, reply) => {
    const { accountId, inviteCode, inviteLink } = z.object({
      accountId: z.string(),
      inviteCode: z.string().optional(),
      inviteLink: z.string().optional()
    }).refine(v => v.inviteCode || v.inviteLink, { message: 'inviteCode or inviteLink is required' }).parse(req.body)
    const code = inviteCode ?? inviteCodeFrom(inviteLink!)
    const groupJid = await ctx.operationGate.runGroup(accountId, 'group.join', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      return sock.groupAcceptInvite(code)
    })
    auditInfoSampled(ctx.config, ctx.logger, 'group.join', { accountId, groupJid, inviteCodeSuffix: code.slice(-6), joined: !!groupJid })
    reply.send({ groupJid, joined: !!groupJid })
  })

  app.post('/v1/groups/:groupJid/leave', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId } = AccountIdBody.parse(req.body)
    await ctx.operationGate.runGroup(accountId, 'group.leave', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      await sock.groupLeave(groupJid)
    })
    auditInfoSampled(ctx.config, ctx.logger, 'group.leave', { accountId, groupJid })
    reply.send({ success: true, groupJid })
  })

  // ─── 群权限设置 ───
  app.post('/v1/groups/:groupJid/settings/announcement', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, mode } = z.object({ accountId: z.string(), mode: z.enum(['announcement', 'not_announcement']) }).parse(req.body)
    await ctx.operationGate.runGroup(accountId, 'group.settings.announcement', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      await sock.groupSettingUpdate(groupJid, mode)
    })
    auditInfoSampled(ctx.config, ctx.logger, 'group.settings.announcement', { accountId, groupJid, mode })
    reply.send({ success: true })
  })

  app.post('/v1/groups/:groupJid/settings/locked', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, mode } = z.object({ accountId: z.string(), mode: z.enum(['locked', 'unlocked']) }).parse(req.body)
    await ctx.operationGate.runGroup(accountId, 'group.settings.locked', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      await sock.groupSettingUpdate(groupJid, mode)
    })
    auditInfoSampled(ctx.config, ctx.logger, 'group.settings.locked', { accountId, groupJid, mode })
    reply.send({ success: true })
  })

  app.post('/v1/groups/:groupJid/settings/member-add-mode', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, mode } = z.object({ accountId: z.string(), mode: z.enum(['admin_add', 'all_member_add']) }).parse(req.body)
    await ctx.operationGate.runGroup(accountId, 'group.settings.member_add_mode', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      await sock.groupMemberAddMode(groupJid, mode)
    })
    auditInfoSampled(ctx.config, ctx.logger, 'group.settings.member_add_mode', { accountId, groupJid, mode })
    reply.send({ success: true })
  })

  app.post('/v1/groups/:groupJid/settings/join-approval', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, mode } = z.object({ accountId: z.string(), mode: z.enum(['on', 'off']) }).parse(req.body)
    await ctx.operationGate.runGroup(accountId, 'group.settings.join_approval', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      await sock.groupJoinApprovalMode(groupJid, mode)
    })
    auditInfoSampled(ctx.config, ctx.logger, 'group.settings.join_approval', { accountId, groupJid, mode })
    reply.send({ success: true })
  })

  // ─── 入群审批 ───
  app.get('/v1/groups/:groupJid/pending', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId } = z.object({ accountId: z.string() }).parse(req.query)
    const sock = ctx.accounts.getSocket(accountId)
    const list = await sock.groupRequestParticipantsList(groupJid)
    auditInfo(ctx.logger, 'group.pending.list', { accountId, groupJid, total: list.length })
    reply.send({
      total: list.length,
      pending: list.map(p => ({ jid: p.jid, requestedAt: Number(p.request_time ?? Date.now() / 1000) }))
    })
  })

  app.post('/v1/groups/:groupJid/pending/approve', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, participants, timeoutMs } = ParticipantsBody.parse(req.body)
    const results = await runParticipantMutation(ctx, accountId, groupJid, 'group.pending.approve', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      return withParticipantTimeout(
        sock.groupRequestParticipantsUpdate(groupJid, participants, 'approve') as unknown as Promise<Array<Record<string, unknown>>>,
        timeoutMs
      )
    }, timeoutMs, participants.length)
    reply.send(results)
  })

  app.post('/v1/groups/:groupJid/pending/reject', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, participants, timeoutMs } = ParticipantsBody.parse(req.body)
    const results = await runParticipantMutation(ctx, accountId, groupJid, 'group.pending.reject', async () => {
      const sock = ctx.accounts.getSocket(accountId)
      return withParticipantTimeout(
        sock.groupRequestParticipantsUpdate(groupJid, participants, 'reject') as unknown as Promise<Array<Record<string, unknown>>>,
        timeoutMs
      )
    }, timeoutMs, participants.length)
    reply.send(results)
  })

  app.post('/v1/groups/health-report', async (req, reply) => {
    const Body = z.object({
      reports: z.array(z.object({
        accountId: z.string().optional(),
        groupJid: z.string(),
        health: GroupHealth,
        memberCount: z.number().int().nonnegative().optional(),
        checkedAt: z.string(),
        errorCode: z.string().optional().nullable(),
        subject: z.string().optional().nullable()
      })).min(1).max(500)
    })
    const { reports } = Body.parse(req.body)
    for (const report of reports) {
      await ctx.publisher.publish('group.health_reported', report.accountId ?? report.groupJid, report)
    }
    auditInfo(ctx.logger, 'group.health_report', {
      accepted: reports.length,
      health: reports.reduce<Record<string, number>>((acc, r) => {
        acc[r.health] = (acc[r.health] ?? 0) + 1
        return acc
      }, {})
    })
    reply.send({ accepted: reports.length, rejected: 0 })
  })
}
