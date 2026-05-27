/**
 * Groups 路由 — 22 个接口
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'

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
  timeoutMs?: number
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
    partial: normalized.some(r => r.status !== 'OK'),
    timeoutMs,
    results: normalized
  }
}

export const registerGroupsRoutes: RouteRegistrar = (app, ctx) => {
  // ─── 创建 / 拉人 / 移除 / 升降级 ───
  app.post('/v1/groups/create', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), subject: z.string().max(100), participants: z.array(z.string()).min(1) })
    const { accountId, subject, participants } = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    try {
      const created = await sock.groupCreate(subject, participants)
      ctx.metrics.groupCreateTotal.inc({ result: 'success' })
      reply.send({
        groupJid: created.id,
        results: normalizeParticipantResults(created.id, created.participants?.map(p => ({ jid: p.id, status: '200' })) ?? [])
      })
    } catch (err) {
      ctx.metrics.groupCreateTotal.inc({ result: 'error' })
      throw err
    }
  })

  app.post('/v1/groups/:groupJid/participants/add', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, participants, timeoutMs } = ParticipantsBody.parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    const r = await sock.groupParticipantsUpdate(groupJid, participants, 'add')
    for (const p of r) ctx.metrics.groupAddParticipantsTotal.inc({ result: p.status })
    reply.send(normalizeParticipantResults(groupJid, r as unknown as Array<Record<string, unknown>>, timeoutMs))
  })

  app.post('/v1/groups/:groupJid/participants/remove', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, participants, timeoutMs } = ParticipantsBody.parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    const r = await sock.groupParticipantsUpdate(groupJid, participants, 'remove')
    reply.send(normalizeParticipantResults(groupJid, r as unknown as Array<Record<string, unknown>>, timeoutMs))
  })

  app.post('/v1/groups/:groupJid/participants/promote', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, participants, timeoutMs } = ParticipantsBody.parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    const r = await sock.groupParticipantsUpdate(groupJid, participants, 'promote')
    reply.send(normalizeParticipantResults(groupJid, r as unknown as Array<Record<string, unknown>>, timeoutMs))
  })

  app.post('/v1/groups/:groupJid/participants/demote', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, participants, timeoutMs } = ParticipantsBody.parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    const r = await sock.groupParticipantsUpdate(groupJid, participants, 'demote')
    reply.send(normalizeParticipantResults(groupJid, r as unknown as Array<Record<string, unknown>>, timeoutMs))
  })

  app.post('/v1/groups/preview', async (req, reply) => {
    const { accountId, inviteLink } = z.object({ accountId: z.string(), inviteLink: z.string() }).parse(req.body)
    const inviteCode = inviteCodeFrom(inviteLink)
    const sock = ctx.accounts.getSocket(accountId)
    const meta = await sock.groupGetInviteInfo(inviteCode)
    const memberCount = meta.participants?.length ?? meta.size ?? 0
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
    reply.send({ total: list.length, groups: list })
  })

  // ─── 群设置 ───
  app.post('/v1/groups/:groupJid/subject', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, subject } = z.object({ accountId: z.string(), subject: z.string().max(100) }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.groupUpdateSubject(groupJid, subject)
    reply.send({ success: true, groupJid })
  })

  app.post('/v1/groups/:groupJid/description', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, description } = z.object({ accountId: z.string(), description: z.string().nullable() }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.groupUpdateDescription(groupJid, description ?? undefined)
    reply.send({ success: true, groupJid })
  })

  app.post('/v1/groups/:groupJid/announcement-text', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, text } = z.object({ accountId: z.string(), text: z.string().max(512) }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.groupUpdateDescription(groupJid, text)
    await ctx.publisher.publish('group.metadata_updated', accountId, {
      groupJid,
      changes: { description: text, announcementText: text },
      operator: sock.user?.id ?? 'self',
      occurredAt: new Date().toISOString()
    })
    reply.send({ success: true, groupJid, text, appliedAs: 'description' })
  })

  app.post('/v1/groups/:groupJid/picture', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, image } = z.object({ accountId: z.string(), image: z.object({ url: z.string().optional(), base64: z.string().optional() }) }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    const buf = image.base64 ? Buffer.from(image.base64, 'base64') : { url: image.url! }
    await sock.updateProfilePicture(groupJid, buf as never)
    reply.send({ success: true })
  })

  // ─── 邀请 ───
  app.get('/v1/groups/:groupJid/invite-code', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId } = z.object({ accountId: z.string() }).parse(req.query)
    const sock = ctx.accounts.getSocket(accountId)
    const code = await sock.groupInviteCode(groupJid)
    reply.send({ groupJid, inviteCode: code, inviteUrl: `https://chat.whatsapp.com/${code}` })
  })

  app.post('/v1/groups/:groupJid/invite/revoke', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId } = AccountIdBody.parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    const code = await sock.groupRevokeInvite(groupJid)
    reply.send({ groupJid, inviteCode: code, inviteUrl: `https://chat.whatsapp.com/${code}` })
  })

  app.post('/v1/groups/join', async (req, reply) => {
    const { accountId, inviteCode, inviteLink } = z.object({
      accountId: z.string(),
      inviteCode: z.string().optional(),
      inviteLink: z.string().optional()
    }).refine(v => v.inviteCode || v.inviteLink, { message: 'inviteCode or inviteLink is required' }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    const code = inviteCode ?? inviteCodeFrom(inviteLink!)
    const groupJid = await sock.groupAcceptInvite(code)
    reply.send({ groupJid, joined: !!groupJid })
  })

  app.post('/v1/groups/:groupJid/leave', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId } = AccountIdBody.parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.groupLeave(groupJid)
    reply.send({ success: true, groupJid })
  })

  // ─── 群权限设置 ───
  app.post('/v1/groups/:groupJid/settings/announcement', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, mode } = z.object({ accountId: z.string(), mode: z.enum(['announcement', 'not_announcement']) }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.groupSettingUpdate(groupJid, mode)
    reply.send({ success: true })
  })

  app.post('/v1/groups/:groupJid/settings/locked', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, mode } = z.object({ accountId: z.string(), mode: z.enum(['locked', 'unlocked']) }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.groupSettingUpdate(groupJid, mode)
    reply.send({ success: true })
  })

  app.post('/v1/groups/:groupJid/settings/member-add-mode', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, mode } = z.object({ accountId: z.string(), mode: z.enum(['admin_add', 'all_member_add']) }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.groupMemberAddMode(groupJid, mode)
    reply.send({ success: true })
  })

  app.post('/v1/groups/:groupJid/settings/join-approval', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, mode } = z.object({ accountId: z.string(), mode: z.enum(['on', 'off']) }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.groupJoinApprovalMode(groupJid, mode)
    reply.send({ success: true })
  })

  // ─── 入群审批 ───
  app.get('/v1/groups/:groupJid/pending', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId } = z.object({ accountId: z.string() }).parse(req.query)
    const sock = ctx.accounts.getSocket(accountId)
    const list = await sock.groupRequestParticipantsList(groupJid)
    reply.send({
      total: list.length,
      pending: list.map(p => ({ jid: p.jid, requestedAt: Number(p.request_time ?? Date.now() / 1000) }))
    })
  })

  app.post('/v1/groups/:groupJid/pending/approve', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, participants, timeoutMs } = ParticipantsBody.parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    const r = await sock.groupRequestParticipantsUpdate(groupJid, participants, 'approve')
    reply.send(normalizeParticipantResults(groupJid, r as unknown as Array<Record<string, unknown>>, timeoutMs))
  })

  app.post('/v1/groups/:groupJid/pending/reject', async (req, reply) => {
    const { groupJid } = GroupJidParam.parse(req.params)
    const { accountId, participants, timeoutMs } = ParticipantsBody.parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    const r = await sock.groupRequestParticipantsUpdate(groupJid, participants, 'reject')
    reply.send(normalizeParticipantResults(groupJid, r as unknown as Array<Record<string, unknown>>, timeoutMs))
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
    reply.send({ accepted: reports.length, rejected: 0 })
  })
}
