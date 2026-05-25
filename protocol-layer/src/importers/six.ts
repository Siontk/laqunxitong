/**
 * convertSixToBaileys — 接入真实 Baileys protobuf 解码。
 *
 * 关键变化（相对 PoC）：
 *   - 使用 baileys 的 proto.ADVSignedDeviceIdentity.decode 真正解码 deviceIdentityKey
 *   - 失败精确归类（base64 错 vs protobuf 错）
 *   - 解码后填到 creds.account（Baileys 期望的字段）
 *   - 主设备（wsDeviceId=0）允许 deviceIdentityKey 缺失，online 后由 Baileys 重新协商
 *   - 分身设备（wsDeviceId>0）必须有 deviceIdentityKey，否则 NEED_REAUTH
 */

import { proto } from 'baileys'

import type { ConvertOutput, SixLoginInput } from './types.js'

export function convertSixToBaileys(input: SixLoginInput): ConvertOutput {
  const warnings: string[] = []
  const present: string[] = []
  const missing: string[] = []

  const required = [
    'wid',
    'clientStaticPrivateKey',
    'clientStaticPublicKey',
    'identityPrivateKey',
    'identityPublicKey'
  ] as const

  for (const k of required) {
    const v = (input as Record<string, unknown>)[k]
    if (v === undefined || v === null || v === '') missing.push(k)
    else present.push(k)
  }

  if (missing.length > 0) {
    return {
      result: 'NEED_REAUTH',
      warnings: [`missing required fields: ${missing.join(', ')}`],
      meta: { source: 'six', inputFieldsPresent: present, inputFieldsMissing: missing }
    }
  }

  const b64 = [
    input.clientStaticPrivateKey,
    input.clientStaticPublicKey,
    input.identityPrivateKey,
    input.identityPublicKey
  ]
  for (const s of b64) {
    if (!isLikelyBase64(s)) {
      return {
        result: 'INVALID_CREDENTIAL',
        warnings: [`field is not valid base64: ${s.slice(0, 20)}...`],
        meta: { source: 'six', inputFieldsPresent: present, inputFieldsMissing: [] }
      }
    }
  }

  const wsDeviceId = input.wsDeviceId ?? 0

  // 真实 protobuf 解码 deviceIdentityKey
  let account: unknown = null
  if (input.deviceIdentityKey) {
    if (!isLikelyBase64(input.deviceIdentityKey)) {
      return {
        result: 'INVALID_CREDENTIAL',
        warnings: ['deviceIdentityKey is not valid base64'],
        meta: { source: 'six', inputFieldsPresent: present, inputFieldsMissing: [] }
      }
    }
    try {
      const buf = Buffer.from(input.deviceIdentityKey, 'base64')
      const decoded = proto.ADVSignedDeviceIdentity.decode(buf)
      account = proto.ADVSignedDeviceIdentity.toObject(decoded, {
        bytes: String, // 二进制字段 base64 输出
        longs: String
      })
    } catch (err) {
      return {
        result: 'INVALID_CREDENTIAL',
        warnings: [
          'deviceIdentityKey protobuf decode failed: ' + (err instanceof Error ? err.message : String(err))
        ],
        meta: { source: 'six', inputFieldsPresent: present, inputFieldsMissing: [] }
      }
    }
  } else if (wsDeviceId > 0) {
    return {
      result: 'NEED_REAUTH',
      warnings: [
        'wsDeviceId > 0 but deviceIdentityKey missing — companion device cannot online without advSig'
      ],
      meta: { source: 'six', inputFieldsPresent: present, inputFieldsMissing: ['deviceIdentityKey'] }
    }
  } else {
    warnings.push('deviceIdentityKey missing, advSecretKey will be re-negotiated on first online')
  }

  const creds: Record<string, unknown> = {
    noiseKey: {
      private: input.clientStaticPrivateKey,
      public: input.clientStaticPublicKey
    },
    signedIdentityKey: {
      private: input.identityPrivateKey,
      public: input.identityPublicKey
    },
    signedPreKey: undefined,
    registrationId: 0,
    advSecretKey: '',
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: { unarchiveChats: false },
    deviceId: '',
    phoneId: input.phoneId || '',
    identityId: '',
    registered: true,
    backupToken: '',
    me: { id: `${input.wid}@s.whatsapp.net` },
    account,
    signalIdentities: [],
    platform: input.vip ? 'smba' : 'android',
    lastAccountSyncTimestamp: 0,
    myAppStateKeyId: '',
    deviceCompanionId: wsDeviceId
  }

  warnings.push('signedPreKey not in six format, will be generated on first online (delay ~2s)')

  return {
    result: 'CONVERTED_PARTIAL',
    creds,
    keys: {},
    warnings,
    meta: { source: 'six', inputFieldsPresent: present, inputFieldsMissing: [] }
  }
}

function isLikelyBase64(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0) return false
  return /^[A-Za-z0-9+/=_-]+$/.test(s)
}
