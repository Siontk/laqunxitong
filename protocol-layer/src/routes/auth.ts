/**
 * Auth 路由 — pairing code / QR
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'
import { NotOwnerError } from '../error/error-handler.js'
import type { AccountDeviceProfile, BrowserDisplay, BrowserDisplayPlatform, DevicePlatform } from '../store/account-device-store.js'
import { browserFromDisplay } from '../worker/socket-browser.js'

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

const PairingBody = z.object({
  phone: z.string().regex(/^[0-9]{10,15}$/),
  clientRefId: z.string().optional(),
  customPairingCode: z.string().regex(/^[A-Za-z0-9]{8}$/).optional(),
  deviceProfile: DeviceProfileBody.optional(),
  browserDisplay: BrowserDisplayBody.optional(),
  proxy: z.object({
    protocol: z.enum(['socks5', 'http']),
    url: z.string(),
    sessionId: z.string(),
    country: z.string()
  }).passthrough()
})

const QrBody = z.object({
  clientRefId: z.string().optional(),
  deviceProfile: DeviceProfileBody.optional(),
  browserDisplay: BrowserDisplayBody.optional(),
  proxy: z.object({
    protocol: z.enum(['socks5', 'http']),
    url: z.string(),
    sessionId: z.string(),
    country: z.string()
  }).passthrough()
})

export const registerAuthRoutes: RouteRegistrar = (app, ctx) => {
  app.post('/v1/auth/pairing-code', async (req, reply) => {
    const body = PairingBody.parse(req.body)
    const accountId = `acc_${body.phone}`
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
        reason: 'pairing_code',
        assignedAt: new Date().toISOString()
      })
    }
    // 先上线一个空 creds 的 socket（Baileys 会自动 initAuthCreds），然后调 requestPairingCode
    const deviceProfile = buildAuthDeviceProfile(accountId, body.deviceProfile)
    const browserDisplay = buildBrowserDisplay(accountId, body.browserDisplay, ctx.config.baileys.browserName)
    if (deviceProfile) await ctx.deviceStore.save(deviceProfile)
    if (browserDisplay) await ctx.browserDisplayStore.save(browserDisplay)
    await ctx.accounts.online(
      accountId,
      body.proxy,
      undefined,
      browserDisplay ? browserFromDisplay(browserDisplay, ctx.config) : undefined
    )
    const sock = ctx.accounts.getSocket(accountId)
    const requestedPairingCode = body.customPairingCode ?? ctx.config.baileys.defaultPairingCode
    const code = await sock.requestPairingCode(body.phone, requestedPairingCode)
    // 90s 内未 ONLINE 自动释放槽位，避免用户超时不输 code 占资源
    ctx.accounts.armPairingTimeout(accountId, 90_000)
    await ctx.publisher.publish('pairing.code_generated', accountId, {
      code,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })
    ctx.metrics.pairingTotal.inc({ method: 'code', result: 'initiated' })
    reply.code(202).send({
      accountId,
      pairingId: `${accountId}-${Date.now()}`,
      routing: {
        ownerWorkerId: decision.workerId,
        ownerEndpoint: owner.worker?.endpoint ?? null,
        currentWorkerId: ctx.config.workerId,
        local: true
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })
  })

  app.post('/v1/auth/qrcode', async (req, reply) => {
    const body = QrBody.parse(req.body)
    const accountId = `acc_qr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
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
        reason: 'qr',
        assignedAt: new Date().toISOString()
      })
    }
    const deviceProfile = buildAuthDeviceProfile(accountId, body.deviceProfile)
    const browserDisplay = buildBrowserDisplay(accountId, body.browserDisplay, ctx.config.baileys.browserName)
    if (deviceProfile) await ctx.deviceStore.save(deviceProfile)
    if (browserDisplay) await ctx.browserDisplayStore.save(browserDisplay)
    await ctx.accounts.online(
      accountId,
      body.proxy,
      undefined,
      browserDisplay ? browserFromDisplay(browserDisplay, ctx.config) : undefined
    )
    // QR pairing 用户可能拖时间扫码，给 180s
    ctx.accounts.armPairingTimeout(accountId, 180_000)
    // QR 通过 connection.update 事件回调（event-bridge 已接管），这里只确认开始
    ctx.metrics.pairingTotal.inc({ method: 'qr', result: 'initiated' })
    reply.code(202).send({
      accountId,
      qrSessionId: `${accountId}-${Date.now()}`,
      routing: {
        ownerWorkerId: decision.workerId,
        ownerEndpoint: owner.worker?.endpoint ?? null,
        currentWorkerId: ctx.config.workerId,
        local: true
      }
    })
  })
}

function buildAuthDeviceProfile(
  accountId: string,
  input?: z.infer<typeof DeviceProfileBody>
): AccountDeviceProfile | null {
  if (!input) return null
  const platform = normalizeDevicePlatform(input.platform)
  return {
    accountId,
    platform,
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

function normalizeDevicePlatform(value: unknown): DevicePlatform {
  if (typeof value !== 'string') return 'unknown'
  const v = value.toLowerCase()
  if (v === 'windows' || v === 'win') return 'windows'
  if (v === 'macos' || v === 'mac' || v === 'mac os' || v === 'osx' || v === 'darwin') return 'macos'
  if (v === 'linux' || v === 'ubuntu') return 'linux'
  return 'unknown'
}
