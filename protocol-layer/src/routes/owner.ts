/**
 * Owner 路由与本地执行保护。
 *
 * 协议层不做 worker 间请求代理；业务层通过 resolve 拿 owner endpoint 后直连。
 * 如果请求打到非 owner worker，返回 NOT_OWNER，业务层刷新 owner 后重试一次。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { RouteContext, RouteRegistrar } from './_context.js'
import { NotOwnerError } from '../error/error-handler.js'

const AccountIdParam = z.object({ accountId: z.string() })
const AccountIdQuery = z.object({ accountId: z.string().optional() })
const AccountIdBody = z.object({ accountId: z.string().optional() }).passthrough()

export async function requireLocalOwner(ctx: RouteContext, accountId: string): Promise<void> {
  const owner = await ctx.registry.resolveOwner(accountId)
  if (!owner.workerId) return
  if (owner.workerId === ctx.config.workerId) return
  throw new NotOwnerError(accountId, ctx.config.workerId, {
    workerId: owner.workerId,
    endpoint: owner.worker?.endpoint
  })
}

function extractAccountId(req: FastifyRequest): string | null {
  const params = req.params && typeof req.params === 'object'
    ? AccountIdParam.safeParse(req.params)
    : null
  if (params?.success) return params.data.accountId

  const query = req.query && typeof req.query === 'object'
    ? AccountIdQuery.safeParse(req.query)
    : null
  if (query?.success && query.data.accountId) return query.data.accountId

  const body = req.body && typeof req.body === 'object'
    ? AccountIdBody.safeParse(req.body)
    : null
  if (body?.success && body.data.accountId) return body.data.accountId

  return null
}

export function addOwnerGuard(app: FastifyInstance, ctx: RouteContext): void {
  app.addHook('preHandler', async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.url.startsWith('/v1/')) return
    // 跳过：admin、解析 owner 本身、批量导入、首次授权（这些路径不需要 owner 已分配）
    if (req.url.startsWith('/v1/admin/')) return
    if (req.url.startsWith('/v1/accounts/resolve')) return
    if (req.url.startsWith('/v1/accounts/import')) return
    if (req.url.startsWith('/v1/auth/')) return
    // proxy/bind / get / delete 可以在任意 worker 调（ProxyStore 共享 Redis），无需 owner check
    // proxy/rebind 需要 owner check（要触发 owner worker 上的 socket 重建）
    if (
      req.url.endsWith('/proxy/bind') ||
      req.url.endsWith('/proxy') ||
      (req.url.includes('/proxy') && req.method === 'GET')
    ) {
      return
    }

    const accountId = extractAccountId(req)
    if (!accountId) return
    await requireLocalOwner(ctx, accountId)
  })
}

export const registerOwnerRoutes: RouteRegistrar = (app, ctx) => {
  app.get('/v1/accounts/resolve/:accountId', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const owner = await ctx.registry.resolveOwner(accountId)
    reply.send({
      accountId,
      assigned: !!owner.workerId,
      ownerWorkerId: owner.workerId,
      ownerEndpoint: owner.worker?.endpoint ?? null,
      currentWorkerId: ctx.config.workerId,
      local: owner.workerId === ctx.config.workerId,
      resolvedAt: new Date().toISOString()
    })
  })

  app.post('/v1/accounts/resolve', async (req, reply) => {
    const Body = z.object({ accountIds: z.array(z.string()).min(1).max(1000) })
    const { accountIds } = Body.parse(req.body)
    const assignment = await ctx.registry.lookupBatch(accountIds)
    const workers = new Map((await ctx.registry.listWorkers()).map(w => [w.workerId, w]))
    reply.send({
      resolvedAt: new Date().toISOString(),
      currentWorkerId: ctx.config.workerId,
      results: accountIds.map(accountId => {
        const workerId = assignment[accountId] ?? null
        const worker = workerId ? workers.get(workerId) : null
        return {
          accountId,
          assigned: !!workerId,
          ownerWorkerId: workerId,
          ownerEndpoint: worker?.endpoint ?? null,
          local: workerId === ctx.config.workerId
        }
      })
    })
  })
}
