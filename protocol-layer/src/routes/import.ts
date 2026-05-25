/**
 * Import 路由 — 三类登录 + baileys-json + batch
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'
import { importCredentials } from '../importers/index.js'
import type { ImportResult } from '../types/api.js'
import type {
  AccountDeviceProfile,
  BrowserDisplay,
  BrowserDisplayPlatform,
  DevicePlatform,
  DeviceProfileSource
} from '../store/account-device-store.js'
import { NotOwnerError } from '../error/error-handler.js'
import { browserFromDisplay } from '../worker/socket-browser.js'

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

const BaileysJsonBody = z.object({
  accountId: z.string().optional(),
  json: z.object({ creds: z.record(z.string(), z.unknown()), keys: z.record(z.string(), z.unknown()).optional() }),
  proxy: ProxyShape,
  autoOnline: z.boolean().default(true),
  deviceProfile: DeviceProfileBody.optional(),
  browserDisplay: BrowserDisplayBody.optional()
})

const ParamsBody = z.object({
  wid: z.string(),
  clientStaticPrivateKey: z.string(),
  clientStaticPublicKey: z.string(),
  identityPrivateKey: z.string(),
  identityPublicKey: z.string(),
  registrationID: z.number(),
  signPreKeyID: z.number(),
  signPreKeyPrivateKey: z.string(),
  signPreKeyPublicKey: z.string(),
  signPreKeySignature: z.string(),
  vip: z.boolean().optional(),
  qrId: z.string().optional(),
  proxy: ProxyShape,
  autoOnline: z.boolean().default(true),
  deviceProfile: DeviceProfileBody.optional(),
  browserDisplay: BrowserDisplayBody.optional()
}).passthrough()

const SixBody = z.object({
  wid: z.string(),
  clientStaticPrivateKey: z.string(),
  clientStaticPublicKey: z.string(),
  identityPrivateKey: z.string(),
  identityPublicKey: z.string(),
  deviceIdentityKey: z.string().optional(),
  phoneId: z.string().optional(),
  wsDeviceId: z.number().default(0),
  vip: z.boolean().optional(),
  qrId: z.string().optional(),
  proxy: ProxyShape,
  autoOnline: z.boolean().default(true),
  deviceProfile: DeviceProfileBody.optional(),
  browserDisplay: BrowserDisplayBody.optional()
}).passthrough()

const LegacyJsonBody = z.object({
  accountJsonBase64: z.string(),
  qrId: z.string().optional(),
  proxy: ProxyShape,
  autoOnline: z.boolean().default(true),
  deviceProfile: DeviceProfileBody.optional(),
  browserDisplay: BrowserDisplayBody.optional()
})

type ImportRouting = {
  ownerWorkerId: string
  ownerEndpoint: string | null
  currentWorkerId: string
  local: boolean
}

type RoutedImportResult = ImportResult & {
  routing: ImportRouting
  deviceProfile: AccountDeviceProfile
  browserDisplay?: BrowserDisplay
}

export const registerImportRoutes: RouteRegistrar = (app, ctx) => {
  async function persistAndMaybeOnline(
    accountId: string,
    converted: ReturnType<typeof importCredentials>,
    proxy: z.infer<typeof ProxyShape>,
    autoOnline: boolean,
    convertedFrom: ImportResult['convertedFrom'],
    vipHint?: boolean,
    deviceProfile?: AccountDeviceProfile,
    browserDisplay?: BrowserDisplay | null
  ): Promise<RoutedImportResult> {
    const decision = await ctx.registry.assign(accountId, proxy.country || ctx.config.region)
    const owner = await ctx.registry.resolveOwner(accountId)
    const isLocalOwner = decision.workerId === ctx.config.workerId
    if (decision.isNew) {
      await ctx.publisher.publish('account.owner_assigned', accountId, {
        accountId,
        ownerWorkerId: decision.workerId,
        ownerEndpoint: owner.worker?.endpoint ?? null,
        currentWorkerId: ctx.config.workerId,
        reason: 'import',
        assignedAt: new Date().toISOString()
      })
    }
    await ctx.runtimeStore.clear(accountId)

    if (converted.creds) {
      await ctx.credsStore.save(accountId, converted.creds)
    }
    await ctx.proxyStore.bind(accountId, proxy)
    const persistedDeviceProfile =
      deviceProfile ?? buildDeviceProfile(accountId, convertedFrom ?? 'baileys_json', {}, converted.creds)
    await ctx.deviceStore.save(persistedDeviceProfile)
    if (browserDisplay) await ctx.browserDisplayStore.save(browserDisplay)
    if (converted.keys && Object.keys(converted.keys).length > 0) {
      for (const [type, idMap] of Object.entries(converted.keys)) {
        const entries = Object.entries(idMap ?? {}).map(([id, value]) => ({
          type: type as 'pre-key' | 'session' | 'sender-key',
          id,
          value: value as Record<string, unknown>
        }))
        if (entries.length > 0) await ctx.keysStore.setMany(accountId, entries)
      }
    }

    let result: ImportResult['result'] = 'IMPORTED_OFFLINE'
    if (converted.result === 'CONVERTED_FULL') result = 'IMPORTED_OFFLINE'
    else if (converted.result === 'CONVERTED_PARTIAL') result = 'IMPORTED_OFFLINE'
    else result = converted.result as ImportResult['result']

    if (autoOnline && converted.creds && isLocalOwner) {
      try {
        await ctx.accounts.online(
          accountId,
          proxy,
          vipHint,
          browserDisplay ? browserFromDisplay(browserDisplay, ctx.config) : undefined
        )
        result = 'IMPORTED_ONLINE'
      } catch (err) {
        ctx.logger.warn({ err, accountId }, 'autoOnline failed')
      }
    }

    const detection = isLocalOwner
      ? (() => {
          try {
            return ctx.accounts.getDetection(accountId)
          } catch {
            return null
          }
        })()
      : null
    const meCreds = converted.creds?.me as { id?: string } | undefined
    return {
      result,
      accountId,
      phone: extractPhone(meCreds?.id ?? ''),
      jid: meCreds?.id,
      accountType: detection?.accountType ?? 'UNKNOWN',
      businessDetection: detection ?? undefined,
      deviceProfile: persistedDeviceProfile,
      browserDisplay: browserDisplay ?? undefined,
      convertedFrom,
      warnings: converted.warnings ?? [],
      evidence: undefined,
      routing: {
        ownerWorkerId: decision.workerId,
        ownerEndpoint: owner.worker?.endpoint ?? null,
        currentWorkerId: ctx.config.workerId,
        local: isLocalOwner
      }
    }
  }

  app.post('/v1/accounts/import/baileys-json', async (req, reply) => {
    const body = BaileysJsonBody.parse(req.body)
    const accountId = body.accountId ?? `acc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const converted = importCredentials({
      format: 'baileys_json',
      body: { format: 'baileys_json', data: body.json as { creds: Record<string, unknown>; keys: Record<string, Record<string, unknown>> } }
    })
    const result = await persistAndMaybeOnline(
      accountId,
      converted,
      body.proxy,
      body.autoOnline,
      'baileys_json',
      undefined,
      buildDeviceProfile(accountId, 'baileys_json', body, converted.creds),
      buildBrowserDisplay(accountId, body.browserDisplay, ctx.config.baileys.browserName)
    )
    if (body.autoOnline && !result.routing.local) {
      throw new NotOwnerError(accountId, ctx.config.workerId, {
        workerId: result.routing.ownerWorkerId,
        endpoint: result.routing.ownerEndpoint
      })
    }
    reply.send(result)
  })

  app.post('/v1/accounts/import/params', async (req, reply) => {
    const body = ParamsBody.parse(req.body)
    const accountId = `acc_${body.wid}`
    const converted = importCredentials({
      format: 'params',
      body: { format: 'params', data: body }
    })
    const result = await persistAndMaybeOnline(
      accountId,
      converted,
      body.proxy,
      body.autoOnline,
      'params',
      body.vip,
      buildDeviceProfile(accountId, 'params', body, converted.creds),
      buildBrowserDisplay(accountId, body.browserDisplay, ctx.config.baileys.browserName)
    )
    if (body.autoOnline && !result.routing.local) {
      throw new NotOwnerError(accountId, ctx.config.workerId, {
        workerId: result.routing.ownerWorkerId,
        endpoint: result.routing.ownerEndpoint
      })
    }
    reply.send(result)
  })

  app.post('/v1/accounts/import/six', async (req, reply) => {
    const body = SixBody.parse(req.body)
    const accountId = `acc_${body.wid}${body.wsDeviceId ? `_d${body.wsDeviceId}` : ''}`
    const converted = importCredentials({
      format: 'six',
      body: { format: 'six', data: body }
    })
    const result = await persistAndMaybeOnline(
      accountId,
      converted,
      body.proxy,
      body.autoOnline,
      'six',
      body.vip,
      buildDeviceProfile(accountId, 'six', body, converted.creds),
      buildBrowserDisplay(accountId, body.browserDisplay, ctx.config.baileys.browserName)
    )
    if (body.autoOnline && !result.routing.local) {
      throw new NotOwnerError(accountId, ctx.config.workerId, {
        workerId: result.routing.ownerWorkerId,
        endpoint: result.routing.ownerEndpoint
      })
    }
    reply.send(result)
  })

  app.post('/v1/accounts/import/legacy-json', async (req, reply) => {
    const body = LegacyJsonBody.parse(req.body)
    const accountId = `acc_legacy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const converted = importCredentials({
      format: 'legacy_json',
      body: { format: 'legacy_json', data: body }
    })
    const result = await persistAndMaybeOnline(
      accountId,
      converted,
      body.proxy,
      body.autoOnline,
      'legacy_json',
      undefined,
      buildDeviceProfile(accountId, 'legacy_json', body, converted.creds),
      buildBrowserDisplay(accountId, body.browserDisplay, ctx.config.baileys.browserName)
    )
    if (body.autoOnline && !result.routing.local) {
      throw new NotOwnerError(accountId, ctx.config.workerId, {
        workerId: result.routing.ownerWorkerId,
        endpoint: result.routing.ownerEndpoint
      })
    }
    reply.send(result)
  })

  app.post('/v1/accounts/import/batch', async (req, reply) => {
    const Item = z.union([
      z.object({ format: z.literal('baileys_json'), data: BaileysJsonBody }),
      z.object({ format: z.literal('params'), data: ParamsBody }),
      z.object({ format: z.literal('six'), data: SixBody }),
      z.object({ format: z.literal('legacy_json'), data: LegacyJsonBody })
    ])
    const Body = z.object({
      items: z.array(Item).min(1).max(500),
      autoOnline: z.boolean().default(true),
      concurrency: z.number().min(1).max(20).default(5),
      coldStartBatchSize: z.number().min(1).max(200).optional(),
      coldStartBatchIntervalMs: z.number().min(0).optional()
    })
    const { items, autoOnline, concurrency, coldStartBatchSize, coldStartBatchIntervalMs } = Body.parse(
      req.body
    )

    // 默认按 § 4.5 冷启动节奏：50 个/批，间隔 30s
    const batchSize = coldStartBatchSize ?? ctx.config.rateLimit.coldStartBatchSize
    const batchInterval = coldStartBatchIntervalMs ?? ctx.config.rateLimit.coldStartIntervalMs

    const results: Array<{ accountId: string; result: string; error?: string; data?: unknown }> = []
    let cursor = 0
    let processedInCurrentBatch = 0

    function accountIdForItem(item: z.infer<typeof Item>): string {
      if (item.format === 'baileys_json') {
        return item.data.accountId ?? `acc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      }
      if (item.format === 'params') return `acc_${item.data.wid}`
      if (item.format === 'six') return `acc_${item.data.wid}${item.data.wsDeviceId ? `_d${item.data.wsDeviceId}` : ''}`
      return `acc_legacy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    }

    async function processOne(item: z.infer<typeof Item>): Promise<void> {
      const accountId = accountIdForItem(item)
      try {
        if (item.format === 'baileys_json') {
          const converted = importCredentials({
            format: 'baileys_json',
            body: {
              format: 'baileys_json',
              data: item.data.json as { creds: Record<string, unknown>; keys: Record<string, Record<string, unknown>> }
            }
          })
          const r = await persistAndMaybeOnline(
            accountId,
            converted,
            item.data.proxy,
            autoOnline && item.data.autoOnline,
            'baileys_json',
            undefined,
            buildDeviceProfile(accountId, 'baileys_json', item.data, converted.creds),
            buildBrowserDisplay(accountId, item.data.browserDisplay, ctx.config.baileys.browserName)
          )
          results.push({ accountId, result: r.routing.local ? r.result : 'ASSIGNED_REMOTE', data: r })
        } else if (item.format === 'params') {
          const converted = importCredentials({ format: 'params', body: { format: 'params', data: item.data } })
          const r = await persistAndMaybeOnline(
            accountId,
            converted,
            item.data.proxy,
            autoOnline && item.data.autoOnline,
            'params',
            item.data.vip,
            buildDeviceProfile(accountId, 'params', item.data, converted.creds),
            buildBrowserDisplay(accountId, item.data.browserDisplay, ctx.config.baileys.browserName)
          )
          results.push({ accountId, result: r.routing.local ? r.result : 'ASSIGNED_REMOTE', data: r })
        } else if (item.format === 'six') {
          const converted = importCredentials({ format: 'six', body: { format: 'six', data: item.data } })
          const r = await persistAndMaybeOnline(
            accountId,
            converted,
            item.data.proxy,
            autoOnline && item.data.autoOnline,
            'six',
            item.data.vip,
            buildDeviceProfile(accountId, 'six', item.data, converted.creds),
            buildBrowserDisplay(accountId, item.data.browserDisplay, ctx.config.baileys.browserName)
          )
          results.push({ accountId, result: r.routing.local ? r.result : 'ASSIGNED_REMOTE', data: r })
        } else {
          const converted = importCredentials({
            format: 'legacy_json',
            body: { format: 'legacy_json', data: item.data }
          })
          const r = await persistAndMaybeOnline(
            accountId,
            converted,
            item.data.proxy,
            autoOnline && item.data.autoOnline,
            'legacy_json',
            undefined,
            buildDeviceProfile(accountId, 'legacy_json', item.data, converted.creds),
            buildBrowserDisplay(accountId, item.data.browserDisplay, ctx.config.baileys.browserName)
          )
          results.push({ accountId, result: r.routing.local ? r.result : 'ASSIGNED_REMOTE', data: r })
        }
      } catch (err) {
        results.push({
          accountId,
          result: 'INVALID_CREDENTIAL',
          error: (err as Error).message
        })
      }
    }

    async function worker(): Promise<void> {
      while (cursor < items.length) {
        // 冷启动批次节流：每 batchSize 个之后等待 batchInterval ms
        if (processedInCurrentBatch >= batchSize) {
          processedInCurrentBatch = 0
          if (batchInterval > 0) {
            ctx.logger.info(
              { batchSize, batchInterval, processed: cursor },
              'batch import: cold start gap'
            )
            await new Promise(r => setTimeout(r, batchInterval))
          }
        }
        const idx = cursor++
        processedInCurrentBatch++
        await processOne(items[idx]!)
      }
    }

    const workers: Promise<void>[] = []
    for (let i = 0; i < concurrency; i++) workers.push(worker())
    await Promise.all(workers)

    reply.send({
      total: items.length,
      succeeded: results.filter(r =>
        ['IMPORTED_ONLINE', 'IMPORTED_OFFLINE', 'CONVERTED_FULL', 'CONVERTED_PARTIAL', 'ASSIGNED_REMOTE'].includes(r.result)
      ).length,
      failed: results.filter(r => r.error || !['IMPORTED_ONLINE', 'IMPORTED_OFFLINE', 'ASSIGNED_REMOTE'].includes(r.result))
        .length,
      results
    })
  })
}

function extractPhone(jid: string): string {
  return jid.split('@')[0]?.split(':')[0] ?? ''
}

type ImportBodyWithDevice = {
  deviceProfile?: z.infer<typeof DeviceProfileBody>
  browserDisplay?: z.infer<typeof BrowserDisplayBody>
  [key: string]: unknown
}

function buildDeviceProfile(
  accountId: string,
  sourceFormat: NonNullable<ImportResult['convertedFrom']>,
  body: ImportBodyWithDevice,
  creds?: Record<string, unknown>
): AccountDeviceProfile {
  const explicit = body.deviceProfile
  const source = resolveDeviceProfileSource(sourceFormat, body, explicit)
  const wsDeviceId = numberOrNull(explicit?.wsDeviceId ?? body.wsDeviceId)
  const platform = normalizeDevicePlatform(
    explicit?.platform ?? inferPlatformFromBody(body) ?? (creds?.platform as string | undefined)
  )

  return {
    accountId,
    platform,
    source,
    manufacturer: stringOrNull(explicit?.manufacturer ?? body.manufacturer),
    model: stringOrNull(explicit?.model ?? body.model ?? body.device),
    osVersion: stringOrNull(explicit?.osVersion ?? body.osVersion),
    device: stringOrNull(explicit?.device ?? body.device),
    deviceUUID: stringOrNull(explicit?.deviceUUID ?? body.deviceUUID),
    phoneUUID: stringOrNull(explicit?.phoneUUID ?? body.phoneUUID ?? body.phoneId),
    whatsappVersion: stringOrNull(explicit?.whatsappVersion ?? body.whatsappVersion),
    wsDeviceId,
    deviceCompanion: explicit?.deviceCompanion ?? (wsDeviceId !== null && wsDeviceId > 0),
    note: explicit?.note ?? defaultDeviceNote(source),
    updatedAt: new Date().toISOString()
  }
}

function resolveDeviceProfileSource(
  sourceFormat: NonNullable<ImportResult['convertedFrom']>,
  body: ImportBodyWithDevice,
  explicit?: z.infer<typeof DeviceProfileBody>
): DeviceProfileSource {
  if (explicit) return 'import_body'
  if (sourceFormat === 'params' && hasAny(body, ['platform', 'device', 'manufacturer', 'osVersion', 'deviceUUID', 'phoneUUID', 'whatsappVersion'])) {
    return 'params_fields'
  }
  if (sourceFormat === 'six' && hasAny(body, ['wsDeviceId', 'phoneId', 'deviceIdentityKey'])) return 'six_fields'
  if (sourceFormat === 'legacy_json') return 'legacy_json'
  if (sourceFormat === 'baileys_json') return 'creds_platform'
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

function inferPlatformFromBody(body: ImportBodyWithDevice): string | undefined {
  const explicitPlatform = body.platform
  if (typeof explicitPlatform === 'string') return explicitPlatform

  const hints = [
    body.manufacturer,
    body.model,
    body.device,
    body.roProductDevice,
    body.roProductBoard
  ]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase()

  if (!hints) return undefined
  if (hints.includes('windows') || hints.includes('win')) return 'windows'
  if (hints.includes('macos') || hints.includes('mac os') || hints.includes('macbook')) return 'macos'
  if (hints.includes('linux') || hints.includes('ubuntu')) return 'linux'
  return undefined
}

function hasAny(body: ImportBodyWithDevice, keys: string[]): boolean {
  return keys.some(k => body[k] !== undefined && body[k] !== null && body[k] !== '')
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function defaultDeviceNote(source: DeviceProfileSource): string | null {
  if (source === 'import_body') return null
  return 'metadata only; does not change Baileys socket browser fingerprint'
}

function buildBrowserDisplay(
  accountId: string,
  input: z.infer<typeof BrowserDisplayBody> | undefined,
  fallbackBrowserName: string
): BrowserDisplay | null {
  const platformValue = input?.platform
  if (!input || !platformValue) return null
  return {
    accountId,
    browserName: input.browserName ?? fallbackBrowserName,
    platform: normalizeBrowserDisplayPlatform(platformValue),
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
