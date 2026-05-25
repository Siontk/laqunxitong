/**
 * Contacts & Chats 路由 — 10 个接口
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'

const JidParam = z.object({ jid: z.string() })
const AccountIdBody = z.object({ accountId: z.string() })

export const registerContactsRoutes: RouteRegistrar = (app, ctx) => {
  app.post('/v1/contacts/:jid/save', async (req, reply) => {
    const { jid } = JidParam.parse(req.params)
    const { accountId, contact } = z.object({ accountId: z.string(), contact: z.any() }).parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.addOrEditContact(jid, contact as never)
    reply.send({ ok: true })
  })

  app.delete('/v1/contacts/:jid', async (req, reply) => {
    const { jid } = JidParam.parse(req.params)
    const { accountId } = AccountIdBody.parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.removeContact(jid)
    reply.send({ ok: true })
  })

  app.post('/v1/contacts/:jid/block', async (req, reply) => {
    const { jid } = JidParam.parse(req.params)
    const { accountId } = AccountIdBody.parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.updateBlockStatus(jid, 'block')
    reply.send({ ok: true })
  })

  app.post('/v1/contacts/:jid/unblock', async (req, reply) => {
    const { jid } = JidParam.parse(req.params)
    const { accountId } = AccountIdBody.parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    await sock.updateBlockStatus(jid, 'unblock')
    reply.send({ ok: true })
  })

  // chats
  function chatRoute(modKey: 'mute' | 'clear' | 'delete' | 'archive' | 'pin' | 'markRead') {
    return async (
      req: { params: { jid: string }; body?: unknown },
      reply: { send: (x: unknown) => unknown }
    ) => {
      const { jid } = JidParam.parse(req.params)
      const body = z.object({ accountId: z.string() }).passthrough().parse(req.body)
      const sock = ctx.accounts.getSocket(body.accountId)
      // body 里其他字段透传给 chatModify
      const { accountId: _aid, ...modValue } = body as Record<string, unknown>
      await sock.chatModify({ [modKey]: modValue as never } as never, jid)
      reply.send({ ok: true })
    }
  }
  app.post('/v1/chats/:jid/mute', async (req, reply) => chatRoute('mute')(req as never, reply as never))
  app.post('/v1/chats/:jid/clear', async (req, reply) => chatRoute('clear')(req as never, reply as never))
  app.post('/v1/chats/:jid/delete', async (req, reply) => chatRoute('delete')(req as never, reply as never))
  app.post('/v1/chats/:jid/archive', async (req, reply) => chatRoute('archive')(req as never, reply as never))
  app.post('/v1/chats/:jid/pin', async (req, reply) => chatRoute('pin')(req as never, reply as never))
  app.post('/v1/chats/:jid/mark-read', async (req, reply) => chatRoute('markRead')(req as never, reply as never))
}
