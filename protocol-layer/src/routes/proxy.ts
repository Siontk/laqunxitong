/**
 * Proxy 路由 — bind / rebind / get（接 ProxyStore）
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'
import { auditInfo } from './audit-log.js'

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
    const previous = await ctx.proxyStore.get(accountId)
    const proxy = ProxyShape.parse(req.body)
    const record = await ctx.proxyStore.bind(accountId, proxy)
    await ctx.publisher.publish('account.proxy_changed', accountId, {
      accountId,
      oldProxyId: previous?.sessionId ?? null,
      newProxyId: record.sessionId,
      oldProxy: previous ?? null,
      newProxy: record,
      ts: new Date().toISOString()
    })
    auditInfo(ctx.logger, 'account.proxy.bind', {
      accountId,
      oldProxyId: previous?.sessionId ?? null,
      newProxyId: record.sessionId,
      country: record.country,
      protocol: record.protocol
    })
    reply.send({ ok: true, accountId, binding: record })
  })

  app.post('/v1/accounts/:accountId/proxy/rebind', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const previous = await ctx.proxyStore.get(accountId)
    const proxy = ProxyShape.parse(req.body)
    const record = await ctx.proxyStore.bind(accountId, proxy)
    // 触发 worker 重建 socket
    await ctx.accounts.rebindProxy(accountId, proxy).catch(err => {
      ctx.logger.warn({ err, accountId }, 'rebindProxy on worker failed — account may not be online here')
    })
    await ctx.publisher.publish('account.proxy_changed', accountId, {
      accountId,
      oldProxyId: previous?.sessionId ?? null,
      newProxyId: record.sessionId,
      oldProxy: previous ?? null,
      newProxy: record,
      ts: new Date().toISOString()
    })
    auditInfo(ctx.logger, 'account.proxy.rebind', {
      accountId,
      oldProxyId: previous?.sessionId ?? null,
      newProxyId: record.sessionId,
      country: record.country,
      protocol: record.protocol
    })
    reply.send({ ok: true, accountId, binding: record })
  })

  app.get('/v1/accounts/:accountId/proxy', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const record = await ctx.proxyStore.get(accountId)
    if (!record) return reply.code(404).send({ code: 'NO_PROXY', message: 'no proxy bound' })
    auditInfo(ctx.logger, 'account.proxy.get', { accountId, proxySessionId: record.sessionId, country: record.country })
    reply.send(record)
  })

  app.delete('/v1/accounts/:accountId/proxy', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    await ctx.proxyStore.delete(accountId)
    auditInfo(ctx.logger, 'account.proxy.delete', { accountId })
    reply.send({ ok: true })
  })
}
