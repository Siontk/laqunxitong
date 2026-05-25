/**
 * Channels（newsletter）路由 — 4 个接口
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'

export const registerChannelsRoutes: RouteRegistrar = (app, ctx) => {
  app.post('/v1/channels/follow', async (req, reply) => {
    const { accountId, jid } = z.object({ accountId: z.string(), jid: z.string() }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.newsletterFollow(jid)
    reply.send({ success: true, jid })
  })

  app.post('/v1/channels/unfollow', async (req, reply) => {
    const { accountId, jid } = z.object({ accountId: z.string(), jid: z.string() }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.newsletterUnfollow(jid)
    reply.send({ success: true, jid })
  })

  app.get('/v1/channels/:jid/messages', async (req, reply) => {
    const { jid } = z.object({ jid: z.string() }).parse(req.params)
    const { accountId, count, since, after } = z.object({
      accountId: z.string(),
      count: z.coerce.number().default(50),
      since: z.coerce.number().optional(),
      after: z.string().optional()
    }).parse(req.query)
    const sock = ctx.accounts.getSocket(accountId)
    const msgs = await sock.newsletterFetchMessages(jid, count, since ?? 0, Number(after ?? 0))
    reply.send({ jid, total: msgs?.length ?? 0, messages: msgs ?? [], nextCursor: null })
  })

  app.post('/v1/channels/:jid/reaction', async (req, reply) => {
    const { jid } = z.object({ jid: z.string() }).parse(req.params)
    const { accountId, serverId, reaction } = z.object({
      accountId: z.string(),
      serverId: z.string(),
      reaction: z.string()
    }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.newsletterReactMessage(jid, serverId, reaction || undefined)
    reply.send({ success: true })
  })
}
