/**
 * Proxy 路由 — bind / rebind / get（接 ProxyStore）
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'

const AccountIdParam = z.object({ accountId: z.string() })

const ProxyShape = z.object({
  protocol: z.enum(['socks5', 'http']),
  url: z.string(),
  sessionId: z.string(),
  country: z.string()
}).passthrough()

export const registerProxyRoutes: RouteRegistrar = (app, ctx) => {
  app.post('/v1/accounts/:accountId/proxy/bind', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const proxy = ProxyShape.parse(req.body)
    const record = await ctx.proxyStore.bind(accountId, proxy)
    reply.send({ ok: true, accountId, binding: record })
  })

  app.post('/v1/accounts/:accountId/proxy/rebind', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const proxy = ProxyShape.parse(req.body)
    const record = await ctx.proxyStore.bind(accountId, proxy)
    // 触发 worker 重建 socket
    await ctx.accounts.rebindProxy(accountId, proxy).catch(err => {
      ctx.logger.warn({ err, accountId }, 'rebindProxy on worker failed — account may not be online here')
    })
    reply.send({ ok: true, accountId, binding: record })
  })

  app.get('/v1/accounts/:accountId/proxy', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const record = await ctx.proxyStore.get(accountId)
    if (!record) return reply.code(404).send({ code: 'NO_PROXY', message: 'no proxy bound' })
    reply.send(record)
  })

  app.delete('/v1/accounts/:accountId/proxy', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    await ctx.proxyStore.delete(accountId)
    reply.send({ ok: true })
  })
}
