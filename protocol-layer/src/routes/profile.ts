/**
 * Profile 路由 — 5 个接口
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'

const MediaInputShape = z.object({ url: z.string().optional(), base64: z.string().optional() })

export const registerProfileRoutes: RouteRegistrar = (app, ctx) => {
  app.post('/v1/profile/name', async (req, reply) => {
    const { accountId, name } = z.object({ accountId: z.string(), name: z.string() }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.updateProfileName(name)
    reply.send({ ok: true })
  })

  app.post('/v1/profile/status', async (req, reply) => {
    const { accountId, status } = z.object({ accountId: z.string(), status: z.string() }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.updateProfileStatus(status)
    reply.send({ ok: true })
  })

  app.post('/v1/profile/picture', async (req, reply) => {
    const { accountId, image } = z.object({ accountId: z.string(), image: MediaInputShape }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    const selfJid = sock.user?.id
    if (!selfJid) return reply.code(400).send({ code: 'NO_SELF_JID' })
    const buf = image.base64 ? Buffer.from(image.base64, 'base64') : { url: image.url! }
    await sock.updateProfilePicture(selfJid, buf as never)
    reply.send({ ok: true })
  })

  app.delete('/v1/profile/picture', async (req, reply) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    const selfJid = sock.user?.id
    if (!selfJid) return reply.code(400).send({ code: 'NO_SELF_JID' })
    await sock.removeProfilePicture(selfJid)
    reply.send({ ok: true })
  })

  app.get('/v1/profile/:jid/picture-url', async (req, reply) => {
    const { jid } = z.object({ jid: z.string() }).parse(req.params)
    const { accountId, type } = z.object({ accountId: z.string(), type: z.enum(['image', 'preview']).default('preview') }).parse(req.query)
    const sock = ctx.accounts.getSocket(accountId)
    const url = await sock.profilePictureUrl(jid, type)
    reply.send({ jid, url })
  })
}
