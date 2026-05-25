import type { Config } from '../config.js'
import type { AccountDeviceProfile, BrowserDisplay, BrowserDisplayPlatform, DevicePlatform } from '../store/account-device-store.js'

export type SocketBrowser = [string, string, string]

export interface SocketBrowserHint {
  platform?: DevicePlatform | string | null
  browserName?: string | null
  osVersion?: string | null
}

export interface BrowserDisplayHint {
  platform?: BrowserDisplayPlatform | string | null
  browserName?: string | null
  version?: string | null
}

export function browserFromConfig(config: Config): SocketBrowser {
  if (config.baileys.browserOS === 'macOS') return ['Mac OS', config.baileys.browserName, '14.4.1']
  if (config.baileys.browserOS === 'windows') return ['Windows', config.baileys.browserName, '10.0.22631']
  return ['Ubuntu', config.baileys.browserName, '22.04.4']
}

export function browserFromDeviceProfile(
  profile: Pick<AccountDeviceProfile, 'platform' | 'osVersion'> | null | undefined,
  fallback: Config
): SocketBrowser {
  return browserFromHint(profile, fallback)
}

export function browserFromDisplay(
  display: BrowserDisplay | null | undefined,
  fallback: Config
): SocketBrowser {
  if (!display) return browserFromConfig(fallback)
  const browserName = display.browserName || fallback.baileys.browserName || 'Chrome'
  const version = display.version || browserVersionForPlatform(display.platform, fallback)
  switch (normalizeDisplayPlatform(display.platform)) {
    case 'ios':
      return ['iOS', browserName, version]
    case 'android':
      return ['Android', browserName, version]
    case 'windows':
      return ['Windows', browserName, version]
    case 'macos':
      return ['Mac OS', browserName, version]
    case 'linux':
      return ['Ubuntu', browserName, version]
    case 'unknown':
    default:
      return browserFromConfig(fallback)
  }
}

export function browserFromHint(hint: SocketBrowserHint | null | undefined, fallback: Config): SocketBrowser {
  const fallbackBrowser = browserFromConfig(fallback)
  if (!hint?.platform) return fallbackBrowser

  const browserName = hint.browserName || fallback.baileys.browserName || 'Chrome'
  const osVersion = hint.osVersion || fallbackBrowser[2]

  switch (normalizePlatform(hint.platform)) {
    case 'windows':
      return ['Windows', browserName, osVersion]
    case 'macos':
      return ['Mac OS', browserName, osVersion]
    case 'linux':
      return ['Ubuntu', browserName, osVersion]
    case 'unknown':
    default:
      return fallbackBrowser
  }
}

function normalizePlatform(value: string): DevicePlatform {
  const v = value.toLowerCase()
  if (v === 'windows' || v === 'win') return 'windows'
  if (v === 'macos' || v === 'mac' || v === 'mac os' || v === 'osx' || v === 'darwin') return 'macos'
  if (v === 'linux' || v === 'ubuntu') return 'linux'
  return 'unknown'
}

function normalizeDisplayPlatform(value: string): BrowserDisplayPlatform {
  const v = value.toLowerCase()
  if (v === 'windows' || v === 'win') return 'windows'
  if (v === 'macos' || v === 'mac' || v === 'mac os' || v === 'osx' || v === 'darwin') return 'macos'
  if (v === 'linux' || v === 'ubuntu') return 'linux'
  if (v === 'ios' || v === 'iphone' || v === 'ipad') return 'ios'
  if (v === 'android') return 'android'
  return 'unknown'
}

function browserVersionForPlatform(platform: BrowserDisplayPlatform, fallback: Config): string {
  switch (platform) {
    case 'windows':
      return '10.0.22631'
    case 'macos':
      return '14.4.1'
    case 'linux':
      return '22.04.4'
    case 'ios':
      return '17.5'
    case 'android':
      return '14'
    case 'unknown':
    default:
      return browserFromConfig(fallback)[2]
  }
}
