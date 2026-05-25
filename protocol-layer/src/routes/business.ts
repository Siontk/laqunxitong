/**
 * Business 路由 — 4 个接口（个人号会返 422）
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'
import { NotBusinessAccountError } from '../error/error-handler.js'

const JidParam = z.object({ jid: z.string() })

function ensureBusiness(accountId: string, accounts: { getDetection: (id: string) => { isBusiness?: boolean } | null }): void {
  const d = accounts.getDetection(accountId)
  if (!d?.isBusiness) throw new NotBusinessAccountError(accountId)
}

export const registerBusinessRoutes: RouteRegistrar = (app, ctx) => {
  // 获取他人的 Business profile（不强制要求当前账号是 Business）
  app.get('/v1/profile/business/:jid', async (req, reply) => {
    const { jid } = JidParam.parse(req.params)
    const { accountId } = z.object({ accountId: z.string() }).parse(req.query)
    const sock = ctx.accounts.getSocket(accountId)
    const profile = await sock.getBusinessProfile(jid)
    reply.send({
      jid,
      isBusiness: !!profile,
      profile: profile ?? null
    })
  })

  app.post('/v1/profile/business/update', async (req, reply) => {
    const Body = z.object({
      accountId: z.string(),
      description: z.string().optional().nullable(),
      category: z.string().optional().nullable(),
      email: z.string().optional().nullable(),
      website: z.array(z.string()).optional(),
      address: z.string().optional().nullable(),
      businessHours: z.any().optional()
    })
    const b = Body.parse(req.body)
    ensureBusiness(b.accountId, ctx.accounts)
    const sock = ctx.accounts.getSocket(b.accountId)
    await sock.updateBussinesProfile({
      description: b.description ?? undefined,
      category: b.category ?? undefined,
      email: b.email ?? undefined,
      website: b.website,
      address: b.address ?? undefined,
      businessHours: b.businessHours
    } as never)
    reply.send({ success: true })
  })

  app.get('/v1/business/catalog', async (req, reply) => {
    const { accountId, jid, limit, cursor } = z.object({
      accountId: z.string(),
      jid: z.string(),
      limit: z.coerce.number().default(20),
      cursor: z.string().optional()
    }).parse(req.query)
    const sock = ctx.accounts.getSocket(accountId)
    const r = await sock.getCatalog({ jid, limit, cursor: cursor as never })
    reply.send({
      accountId,
      targetJid: jid,
      total: r.products?.length ?? 0,
      products: r.products ?? [],
      nextCursor: r.nextPageCursor ?? null
    })
  })

  app.post('/v1/business/product', async (req, reply) => {
    const Body = z.object({
      accountId: z.string(),
      action: z.enum(['create', 'update', 'delete']),
      product: z.any().optional(),
      productIds: z.array(z.string()).optional()
    })
    const b = Body.parse(req.body)
    ensureBusiness(b.accountId, ctx.accounts)
    const sock = ctx.accounts.getSocket(b.accountId)
    if (b.action === 'create') {
      const p = await sock.productCreate(b.product as never)
      reply.send({ action: 'create', success: true, product: p })
    } else if (b.action === 'update') {
      if (!b.product?.id) return reply.code(400).send({ code: 'PRODUCT_ID_REQUIRED' })
      const p = await sock.productUpdate(b.product.id as string, b.product as never)
      reply.send({ action: 'update', success: true, product: p })
    } else {
      if (!b.productIds?.length) return reply.code(400).send({ code: 'PRODUCT_IDS_REQUIRED' })
      const r = await sock.productDelete(b.productIds)
      reply.send({ action: 'delete', success: true, deletedIds: r.deleted ?? b.productIds })
    }
  })
}
