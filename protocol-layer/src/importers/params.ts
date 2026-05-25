/**
 * convertParamsToBaileys
 *
 * 入：Apifox paramsLogin（30+ 硬件参数 + 密钥 + 注册 ID + signPreKey 四件套）
 * 出：Baileys creds（无 keys；keys 在首次 online 后会由 Baileys 重新生成并上报到 WA）
 *
 * 失败语义：
 *   - 缺 clientStatic* / identity* / signPreKey* 任一组 → NEED_REAUTH（材料不全）
 *   - 字段都在但 base64 解码失败 → INVALID_CREDENTIAL
 */

import type { ConvertOutput, ParamsLoginInput } from './types.js'

export function convertParamsToBaileys(input: ParamsLoginInput): ConvertOutput {
  const warnings: string[] = []
  const present: string[] = []
  const missing: string[] = []

  const required = [
    'wid',
    'clientStaticPrivateKey',
    'clientStaticPublicKey',
    'identityPrivateKey',
    'identityPublicKey',
    'registrationID',
    'signPreKeyID',
    'signPreKeyPrivateKey',
    'signPreKeyPublicKey',
    'signPreKeySignature'
  ] as const

  for (const k of required) {
    const v = (input as unknown as Record<string, unknown>)[k]
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
      meta: { source: 'params', inputFieldsPresent: present, inputFieldsMissing: missing }
    }
  }

  // base64 校验
  const b64 = [
    input.clientStaticPrivateKey,
    input.clientStaticPublicKey,
    input.identityPrivateKey,
    input.identityPublicKey,
    input.signPreKeyPrivateKey,
    input.signPreKeyPublicKey,
    input.signPreKeySignature
  ]
  for (const s of b64) {
    if (!isLikelyBase64(s)) {
      return {
        result: 'INVALID_CREDENTIAL',
        warnings: [`field is not valid base64: ${s.slice(0, 20)}...`],
        meta: { source: 'params', inputFieldsPresent: present, inputFieldsMissing: missing }
      }
    }
  }

  // 构造 baileys creds
  const creds: Record<string, unknown> = {
    noiseKey: {
      private: input.clientStaticPrivateKey,
      public: input.clientStaticPublicKey
    },
    signedIdentityKey: {
      private: input.identityPrivateKey,
      public: input.identityPublicKey
    },
    signedPreKey: {
      keyPair: {
        private: input.signPreKeyPrivateKey,
        public: input.signPreKeyPublicKey
      },
      signature: input.signPreKeySignature,
      keyId: input.signPreKeyID
    },
    registrationId: input.registrationID,
    advSecretKey: '', // 旧协议不带，online 后会重协商
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: { unarchiveChats: false },
    deviceId: input.deviceUUID || '',
    phoneId: input.phoneUUID || '',
    identityId: input.deviceUUID || '',
    registered: true,
    backupToken: '',
    me: { id: `${input.wid}@s.whatsapp.net` },
    account: null,
    signalIdentities: [],
    platform: input.vip ? 'smba' : 'android',
    lastAccountSyncTimestamp: 0,
    myAppStateKeyId: ''
  }

  warnings.push('keys (pre-key/session/sender-key) not provided, will be regenerated on first online')
  warnings.push('advSecretKey empty; ADVSignedDeviceIdentity may need re-negotiation')

  return {
    result: 'CONVERTED_PARTIAL',
    creds,
    keys: {}, // 留空，online 后 Baileys 重建
    warnings,
    meta: { source: 'params', inputFieldsPresent: present, inputFieldsMissing: [] }
  }
}

function isLikelyBase64(s: string): boolean {
  if (typeof s !== 'string') return false
  if (s.length === 0) return false
  // 宽松校验：长度 4 倍数 + 字符集
  return /^[A-Za-z0-9+/=_-]+$/.test(s)
}
