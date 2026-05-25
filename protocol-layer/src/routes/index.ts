/**
 * Routes 统一注册器。
 * server.ts 调一次 registerAllRoutes(app, ctx) 即可。
 */

import type { FastifyInstance } from 'fastify'

import type { RouteContext } from './_context.js'
import { addOwnerGuard, registerOwnerRoutes } from './owner.js'
import { registerAdminRoutes } from './admin.js'
import { registerAuthRoutes } from './auth.js'
import { registerImportRoutes } from './import.js'
import { registerExportRoutes } from './export.js'
import { registerLifecycleRoutes } from './lifecycle.js'
import { registerStatusRoutes } from './status.js'
import { registerRestrictionRoutes } from './restriction.js'
import { registerProxyRoutes } from './proxy.js'
import { registerGroupsRoutes } from './groups.js'
import { registerMessagesRoutes } from './messages.js'
import { registerContactsRoutes } from './contacts.js'
import { registerProfileRoutes } from './profile.js'
import { registerBusinessRoutes } from './business.js'
import { registerChannelsRoutes } from './channels.js'

export async function registerAllRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  addApiKeyGuard(app, ctx)
  addOwnerGuard(app, ctx)
  await registerOwnerRoutes(app, ctx)
  await registerAdminRoutes(app, ctx)
  await registerAuthRoutes(app, ctx)
  await registerImportRoutes(app, ctx)
  await registerExportRoutes(app, ctx)
  await registerLifecycleRoutes(app, ctx)
  await registerStatusRoutes(app, ctx)
  await registerRestrictionRoutes(app, ctx)
  await registerProxyRoutes(app, ctx)
  await registerGroupsRoutes(app, ctx)
  await registerMessagesRoutes(app, ctx)
  await registerContactsRoutes(app, ctx)
  await registerProfileRoutes(app, ctx)
  await registerBusinessRoutes(app, ctx)
  await registerChannelsRoutes(app, ctx)
}

function addApiKeyGuard(app: FastifyInstance, ctx: RouteContext): void {
  const keys = ctx.config.http.apiKeys
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)
  if (keys.length === 0) return
  const allowed = new Set(keys)

  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/healthz') || req.url.startsWith('/livez') || req.url.startsWith('/readyz')) return
    if (req.url.startsWith('/metrics')) return
    if (req.url.startsWith('/docs')) return
    if (!req.url.startsWith('/v1/')) return

    const apiKey = req.headers['x-api-key']
    const bearer = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice('Bearer '.length)
      : undefined
    const token = Array.isArray(apiKey) ? apiKey[0] : apiKey ?? bearer
    if (token && allowed.has(token)) return
    reply.code(401).send({ code: 'UNAUTHORIZED', message: 'missing or invalid API key' })
  })
}
