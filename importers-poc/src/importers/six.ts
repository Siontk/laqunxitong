/**
 * convertSixToBaileys
 *
 * 入：Apifox sixLogin（六段密钥 + deviceIdentityKey + phoneId + wsDeviceId + wid）
 * 出：Baileys creds（advSecretKey 由 deviceIdentityKey 解码出 ADVSignedDeviceIdentity 后填充）
 *
 * 失败语义：
 *   - 缺六段（clientStatic*/identity*）任一 → NEED_REAUTH
 *   - 有 deviceIdentityKey 但 protobuf 解码失败 → INVALID_CREDENTIAL
 *   - 无 deviceIdentityKey 且 wsDeviceId > 0（分身设备）→ NEED_REAUTH（分身设备没 advSig 无法上线）
 *   - 无 deviceIdentityKey 且 wsDeviceId == 0（主设备）→ CONVERTED_PARTIAL（首次 online 会重协商）
 */

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
    if (v === undefined || v === null || v === '') {
      missing.push(k)
    } else {
      present.push(k)
    }
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

  // 解码 deviceIdentityKey（ADVSignedDeviceIdentity protobuf）
  let accountObj: unknown = null
  let advSecretKey = ''
  if (input.deviceIdentityKey) {
    try {
      // 真实实现需要引入 baileys protobuf decode：
      //   import { proto } from 'baileys'
      //   const buf = Buffer.from(input.deviceIdentityKey, 'base64')
      //   const account = proto.ADVSignedDeviceIdentity.decode(buf)
      //   accountObj = proto.ADVSignedDeviceIdentity.toObject(account)
      // PoC 阶段先做 base64 校验占位
      if (!isLikelyBase64(input.deviceIdentityKey)) {
        return {
          result: 'INVALID_CREDENTIAL',
          warnings: ['deviceIdentityKey is not valid base64'],
          meta: { source: 'six', inputFieldsPresent: present, inputFieldsMissing: [] }
        }
      }
      accountObj = { __raw_base64: input.deviceIdentityKey, __decoded: false }
      advSecretKey = '' // 真实实现从 protobuf 提取
      warnings.push('deviceIdentityKey present but not fully decoded in PoC')
    } catch (_e) {
      return {
        result: 'INVALID_CREDENTIAL',
        warnings: ['deviceIdentityKey protobuf decode failed'],
        meta: { source: 'six', inputFieldsPresent: present, inputFieldsMissing: [] }
      }
    }
  } else if (wsDeviceId > 0) {
    // 分身设备没 deviceIdentityKey → 无法上线
    return {
      result: 'NEED_REAUTH',
      warnings: ['wsDeviceId > 0 but deviceIdentityKey missing — companion device cannot online without advSig'],
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
    // signedPreKey 六段不带，online 后 Baileys 重新生成并上传
    signedPreKey: undefined,
    registrationId: 0, // 六段不带
    advSecretKey,
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
    account: accountObj,
    signalIdentities: [],
    platform: input.vip ? 'smba' : 'android',
    lastAccountSyncTimestamp: 0,
    myAppStateKeyId: '',
    // 分身设备 ID
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
  if (typeof s !== 'string') return false
  if (s.length === 0) return false
  return /^[A-Za-z0-9+/=_-]+$/.test(s)
}
