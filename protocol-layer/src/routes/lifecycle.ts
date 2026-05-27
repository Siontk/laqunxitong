/**
 * Lifecycle 路由 — online / offline / logout
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'
import { auditInfo, auditWarn } from './audit-log.js'
import { NotOwnerError } from '../error/error-handler.js'
import type { AccountDeviceProfile, BrowserDisplay, BrowserDisplayPlatform, DevicePlatform } from '../store/account-device-store.js'
import { browserFromDisplay } from '../worker/socket-browser.js'

const AccountIdParam = z.object({ accountId: z.string() })
const ProxyShape = z.object({
  protocol: z.enum(['socks5', 'http']),
  url: z.string(),
  sessionId: z.string(),
  country: z.string()
}).passthrough()
const DeviceProfileBody = z.object({
  platform: z.string().optional(),
  manufacturer: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  osVersion: z.string().nullable().optional(),
  device: z.string().nullable().optional(),
  deviceUUID: z.string().nullable().optional(),
  phoneUUID: z.string().nullable().optional(),
  whatsappVersion: z.string().nullable().optional(),
  wsDeviceId: z.number().nullable().optional(),
  deviceCompanion: z.boolean().optional(),
  note: z.string().nullable().optional()
}).passthrough()
const BrowserDisplayBody = z.object({
  browserName: z.string().min(1),
  platform: z.string().min(1),
  version: z.string().nullable().optional()
}).passthrough()
const OnlineBody = z.object({
  proxy: ProxyShape.optional(),
  deviceProfile: DeviceProfileBody.optional(),
  browserDisplay: BrowserDisplayBody.optional()
}).passthrough()

export const registerLifecycleRoutes: RouteRegistrar = (app, ctx) => {
  app.post('/v1/accounts/:accountId/online', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    const body = OnlineBody.parse(req.body ?? {})
    const decision = await ctx.registry.assign(accountId, ctx.config.region)
    const owner = await ctx.registry.resolveOwner(accountId)
    if (decision.workerId !== ctx.config.workerId) {
      throw new NotOwnerError(accountId, ctx.config.workerId, {
        workerId: decision.workerId,
        endpoint: owner.worker?.endpoint
      })
    }
    if (decision.isNew) {
      await ctx.publisher.publish('account.owner_assigned', accountId, {
        accountId,
        ownerWorkerId: decision.workerId,
        ownerEndpoint: owner.worker?.endpoint ?? null,
        currentWorkerId: ctx.config.workerId,
        reason: 'online',
        assignedAt: new Date().toISOString()
      })
    }
    // 优先用 body 中的 proxy；没传则从 ProxyStore 取已绑定
    let proxy = body.proxy as Parameters<typeof ctx.accounts.online>[1] | undefined
    if (!proxy) {
      const stored = await ctx.proxyStore.get(accountId)
      if (!stored) {
        auditWarn(ctx.logger, 'account.online.rejected', { accountId, reason: 'PROXY_REQUIRED' })
        return reply.code(400).send({
          code: 'PROXY_REQUIRED',
          message: 'proxy binding missing — call /proxy/bind first or include in body'
        })
      }
      proxy = stored
    }
    const requestProfile = buildLifecycleDeviceProfile(accountId, body.deviceProfile)
    const browserDisplay = buildBrowserDisplay(accountId, body.browserDisplay, ctx.config.baileys.browserName)
    if (requestProfile) await ctx.deviceStore.save(requestProfile)
    if (browserDisplay) await ctx.browserDisplayStore.save(browserDisplay)
    await ctx.accounts.online(
      accountId,
      proxy,
      undefined,
      browserDisplay ? browserFromDisplay(browserDisplay, ctx.config) : undefined
    )
    auditInfo(ctx.logger, 'account.online.accepted', {
      accountId,
      ownerWorkerId: decision.workerId,
      ownerEndpoint: owner.worker?.endpoint ?? null,
      proxySessionId: proxy.sessionId,
      proxyCountry: proxy.country,
      browserName: browserDisplay?.browserName ?? null,
      browserPlatform: browserDisplay?.platform ?? null
    })
    reply.code(202).send({
      accountId,
      accepted: true,
      stateSource: 'MANUAL_REFRESH',
      syncedAt: new Date().toISOString(),
      routing: {
        ownerWorkerId: decision.workerId,
        ownerEndpoint: owner.worker?.endpoint ?? null,
        currentWorkerId: ctx.config.workerId,
        local: true
      }
    })
  })

  app.post('/v1/accounts/:accountId/offline', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    await ctx.accounts.offline(accountId)
    auditInfo(ctx.logger, 'account.offline', { accountId, reason: 'manual' })
    reply.send({ ok: true })
  })

  app.post('/v1/accounts/:accountId/logout', async (req, reply) => {
    const { accountId } = AccountIdParam.parse(req.params)
    await ctx.accounts.logout(accountId)
    await ctx.publisher.publish('account.logout', accountId, {
      accountId,
      reason: 'MANUAL',
      ts: new Date().toISOString()
    })
    auditInfo(ctx.logger, 'account.logout', { accountId, reason: 'MANUAL' })
    reply.send({ ok: true })
  })
}

function buildLifecycleDeviceProfile(
  accountId: string,
  input?: z.infer<typeof DeviceProfileBody>
): AccountDeviceProfile | null {
  if (!input) return null
  return {
    accountId,
    platform: normalizeDevicePlatform(input.platform),
    source: 'import_body',
    manufacturer: input.manufacturer ?? null,
    model: input.model ?? input.device ?? null,
    osVersion: input.osVersion ?? null,
    device: input.device ?? null,
    deviceUUID: input.deviceUUID ?? null,
    phoneUUID: input.phoneUUID ?? null,
    whatsappVersion: input.whatsappVersion ?? null,
    wsDeviceId: input.wsDeviceId ?? null,
    deviceCompanion: input.deviceCompanion ?? false,
    note: input.note ?? null,
    updatedAt: new Date().toISOString()
  }
}

function normalizeDevicePlatform(value: unknown): DevicePlatform {
  if (typeof value !== 'string') return 'unknown'
  const v = value.toLowerCase()
  if (v === 'windows' || v === 'win') return 'windows'
  if (v === 'macos' || v === 'mac' || v === 'mac os' || v === 'osx' || v === 'darwin') return 'macos'
  if (v === 'linux' || v === 'ubuntu') return 'linux'
  return 'unknown'
}

function buildBrowserDisplay(
  accountId: string,
  input: z.infer<typeof BrowserDisplayBody> | undefined,
  fallbackBrowserName: string
): BrowserDisplay | null {
  if (!input) return null
  return {
    accountId,
    browserName: input.browserName ?? fallbackBrowserName,
    platform: normalizeBrowserDisplayPlatform(input.platform),
    version: input.version ?? null,
    updatedAt: new Date().toISOString()
  }
}

function normalizeBrowserDisplayPlatform(value: string | undefined): BrowserDisplayPlatform {
  if (!value) return 'unknown'
  const v = value.toLowerCase()
  if (v === 'windows' || v === 'win') return 'windows'
  if (v === 'macos' || v === 'mac' || v === 'mac os' || v === 'osx' || v === 'darwin') return 'macos'
  if (v === 'linux' || v === 'ubuntu') return 'linux'
  if (v === 'ios' || v === 'iphone' || v === 'ipad') return 'ios'
  if (v === 'android') return 'android'
  return 'unknown'
}
