/**
 * Export 路由 — 标准 Baileys 导出 + 竞品兼容平铺导出
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'

const AccountIdParam = z.object({ accountId: z.string() })
const ExportFormat = z.enum(['baileys-json', 'portable', 'creds-json'])

function extractPhone(jid: string | undefined): string {
  if (!jid) return ''
  return jid.split('@')[0]?.split(':')[0] ?? ''
}

function normalizeBufferLike(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { type: 'Buffer', data: value.toString('base64') }
  }
  if (value instanceof Uint8Array) {
    return { type: 'Buffer', data: Buffer.from(value).toString('base64') }
  }
  if (Array.isArray(value) && value.every(v => typeof v === 'number')) {
    return { type: 'Buffer', data: Buffer.from(value).toString('base64') }
  }
  if (value && typeof value === 'object') {
    if ((value as { type?: string }).type === 'Buffer' && 'data' in (value as Record<string, unknown>)) {
      const data = (value as { data?: unknown }).data
      if (typeof data === 'string') return { type: 'Buffer', data }
      if (Array.isArray(data) && data.every(v => typeof v === 'number')) {
        return { type: 'Buffer', data: Buffer.from(data).toString('base64') }
      }
    }
    if (Array.isArray(value)) return value.map(item => normalizeBufferLike(item))
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) out[key] = normalizeBufferLike(nested)
    return out
  }
  return value
}

function buildFlatCredsExport(creds: Record<string, unknown>): Record<string, unknown> {
  const flat = normalizeBufferLike(creds) as Record<string, unknown>
  const meId = (flat.me as { id?: string } | undefined)?.id
  return {
    ...flat,
    Phone: (flat.Phone as string | undefined) ?? extractPhone(meId)
  }
}

export const registerExportRoutes: RouteRegistrar = (app, ctx) => {
  app.get('/v1/accounts/:accountId/export/baileys-json', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const creds = await ctx.credsStore.load(accountId)
    if (!creds) return reply.code(404).send({ code: 'NOT_FOUND', message: 'no creds' })

    // 全量 dump keys（来自 L2 Redis）
    const keys = await ctx.keysStore.scanAll(accountId)

    reply.send({
      schema: 'baileys.auth_state.v1',
      creds,
      keys
    })
  })

  app.get('/v1/accounts/:accountId/export/creds-json', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const creds = await ctx.credsStore.load(accountId)
    if (!creds) return reply.code(404).send({ code: 'NOT_FOUND', message: 'no creds' })

    reply.send(buildFlatCredsExport(creds))
  })

  app.get('/v1/accounts/:accountId/export/portable', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const creds = await ctx.credsStore.load(accountId)
    if (!creds) return reply.code(404).send({ code: 'NOT_FOUND', message: 'no creds' })

    const keys = await ctx.keysStore.scanAll(accountId)
    const detection = getDetectionOrNull(ctx, accountId)
    const proxy = await ctx.proxyStore.get(accountId)
    const deviceProfile = await ctx.deviceStore.get(accountId)
    const browserDisplay = await ctx.browserDisplayStore.get(accountId)
    const meId = (creds.me as { id?: string } | undefined)?.id

    reply.send({
      schema: 'unsea.portable.v1',
      exportedAt: new Date().toISOString(),
      baileys: { creds, keys },
      account: {
        phone: meId?.split('@')[0]?.split(':')[0] ?? '',
        jid: meId,
        accountType: detection?.accountType ?? 'UNKNOWN',
        platform: (creds.platform as string) ?? 'unknown',
        verifiedName: detection?.verifiedName ?? null,
        pushName: null,
        pairedAt: null
      },
      deviceProfile,
      browserDisplay,
      proxy: proxy
        ? {
            sessionId: proxy.sessionId,
            country: proxy.country,
            asn: proxy.asn,
            tier: proxy.tier ?? 'standard'
          }
        : null,
      legacy: null
    })
  })

  app.post('/v1/accounts/export/batch', async (req, reply) => {
    const Body = z.object({
      accountIds: z.array(z.string()).min(1).max(500),
      format: ExportFormat.default('portable'),
      concurrency: z.number().min(1).max(20).default(5)
    })
    const { accountIds, format, concurrency } = Body.parse(req.body)

    const results: Array<{ accountId: string; success: boolean; data?: unknown; error?: string }> = []
    const sem = new Array<Promise<void>>(0)
    let cursor = 0

    async function worker(): Promise<void> {
      while (cursor < accountIds.length) {
        const idx = cursor++
        const accountId = accountIds[idx]!
        try {
          const creds = await ctx.credsStore.load(accountId)
          if (!creds) {
            results.push({ accountId, success: false, error: 'NOT_FOUND' })
            continue
          }
          if (format === 'baileys-json') {
            const keys = await ctx.keysStore.scanAll(accountId)
            results.push({ accountId, success: true, data: { schema: 'baileys.auth_state.v1', creds, keys } })
          } else if (format === 'creds-json') {
            results.push({ accountId, success: true, data: buildFlatCredsExport(creds) })
          } else {
            const keys = await ctx.keysStore.scanAll(accountId)
            const detection = getDetectionOrNull(ctx, accountId)
            const proxy = await ctx.proxyStore.get(accountId)
            const deviceProfile = await ctx.deviceStore.get(accountId)
            const browserDisplay = await ctx.browserDisplayStore.get(accountId)
            const meId = (creds.me as { id?: string } | undefined)?.id
            results.push({
              accountId,
              success: true,
              data: {
                schema: 'unsea.portable.v1',
                exportedAt: new Date().toISOString(),
                baileys: { creds, keys },
                account: {
                  phone: meId?.split('@')[0]?.split(':')[0] ?? '',
                  jid: meId,
                  accountType: detection?.accountType ?? 'UNKNOWN',
                  platform: (creds.platform as string) ?? 'unknown',
                  verifiedName: detection?.verifiedName ?? null
                },
                deviceProfile,
                browserDisplay,
                proxy: proxy
                  ? { sessionId: proxy.sessionId, country: proxy.country, asn: proxy.asn }
                  : null
              }
            })
          }
        } catch (err) {
          results.push({ accountId, success: false, error: (err as Error).message })
        }
      }
    }

    for (let i = 0; i < concurrency; i++) sem.push(worker())
    await Promise.all(sem)

    reply.send({
      total: accountIds.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    })
  })
}

function getDetectionOrNull(ctx: Parameters<RouteRegistrar>[1], accountId: string) {
  try {
    return ctx.accounts.getDetection(accountId)
  } catch {
    return null
  }
}
