/**
 * AccountDeviceStore — 账号导入设备元数据。
 *
 * 这里只保存功能层选择/导入材料里带来的设备描述，供筛选、统计、导出和联调用。
 * 这里不直接承担关联设备展示名，关联设备展示由 browserDisplay 专门控制。
 */

import type { Logger } from '../observability/logger.js'
import type { RedisStoreAdapter } from './adapters/redis.js'

export type DevicePlatform = 'windows' | 'macos' | 'linux' | 'unknown'

export type DeviceProfileSource =
  | 'import_body'
  | 'creds_platform'
  | 'params_fields'
  | 'six_fields'
  | 'legacy_json'
  | 'unknown'

export interface AccountDeviceProfile {
  accountId: string
  platform: DevicePlatform
  source: DeviceProfileSource
  manufacturer?: string | null
  model?: string | null
  osVersion?: string | null
  device?: string | null
  deviceUUID?: string | null
  phoneUUID?: string | null
  whatsappVersion?: string | null
  wsDeviceId?: number | null
  deviceCompanion: boolean
  note?: string | null
  updatedAt: string
}

export type BrowserDisplayPlatform = 'windows' | 'macos' | 'linux' | 'ios' | 'android' | 'unknown'

export interface BrowserDisplay {
  accountId: string
  browserName: string
  platform: BrowserDisplayPlatform
  version?: string | null
  updatedAt: string
}

export class AccountDeviceStore {
  constructor(
    private readonly l2: RedisStoreAdapter<AccountDeviceProfile>,
    private readonly logger: Logger
  ) {}

  private k(accountId: string): string {
    return `device:${accountId}`
  }

  async save(profile: AccountDeviceProfile): Promise<void> {
    await this.l2.set(this.k(profile.accountId), profile).catch(err => {
      this.logger.warn({ err, accountId: profile.accountId }, 'account-device-store write failed')
    })
  }

  async get(accountId: string): Promise<AccountDeviceProfile | null> {
    return this.l2.get(this.k(accountId)).catch(err => {
      this.logger.warn({ err, accountId }, 'account-device-store read failed')
      return null
    })
  }

  async clear(accountId: string): Promise<void> {
    await this.l2.delete(this.k(accountId)).catch(() => {})
  }
}

export class AccountBrowserDisplayStore {
  constructor(
    private readonly l2: RedisStoreAdapter<BrowserDisplay>,
    private readonly logger: Logger
  ) {}

  private k(accountId: string): string {
    return `browser_display:${accountId}`
  }

  async save(display: BrowserDisplay): Promise<void> {
    await this.l2.set(this.k(display.accountId), display).catch(err => {
      this.logger.warn({ err, accountId: display.accountId }, 'account-browser-display-store write failed')
    })
  }

  async get(accountId: string): Promise<BrowserDisplay | null> {
    return this.l2.get(this.k(accountId)).catch(err => {
      this.logger.warn({ err, accountId }, 'account-browser-display-store read failed')
      return null
    })
  }

  async clear(accountId: string): Promise<void> {
    await this.l2.delete(this.k(accountId)).catch(() => {})
  }
}
