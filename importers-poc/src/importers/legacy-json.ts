/**
 * convertLegacyJsonToBaileys
 *
 * 入：Apifox jsonLogin 的 accountJsonBase64（base64 编码的旧 JSON）
 * 出：Baileys creds + keys（旧 JSON 通常带全量，转换可达 CONVERTED_FULL）
 *
 * 失败语义：
 *   - base64 解码失败 → INVALID_CREDENTIAL
 *   - 解出的 JSON 不含已知字段名 → UNSUPPORTED_FORMAT
 *   - JSON 含字段但 creds 关键字段缺 → NEED_REAUTH
 *
 * 注意：旧 JSON 格式可能有多种变体（不同协议版本），转换器要做格式探测。
 */

import type { ConvertOutput, LegacyJsonLoginInput } from './types.js'

interface LegacyJsonV1 {
  // 已观察到的几种旧字段命名（覆盖 malaixiya 历史协议）
  noiseKey?: { private?: string; public?: string }
  noise_key?: { private?: string; public?: string }
  signedIdentityKey?: { private?: string; public?: string }
  signed_identity_key?: { private?: string; public?: string }
  signedPreKey?: { keyPair?: { private?: string; public?: string }; signature?: string; keyId?: number }
  signed_pre_key?: { keyPair?: { private?: string; public?: string }; signature?: string; keyId?: number }
  registrationId?: number
  registration_id?: number
  advSecretKey?: string
  adv_secret_key?: string
  me?: { id?: string }
  phone?: string
  wid?: string
  account?: unknown
  keys?: Record<string, Record<string, unknown>>
  [k: string]: unknown
}

export function convertLegacyJsonToBaileys(input: LegacyJsonLoginInput): ConvertOutput {
  if (!input.accountJsonBase64) {
    return {
      result: 'NEED_REAUTH',
      warnings: ['accountJsonBase64 missing'],
      meta: { source: 'legacy_json', inputFieldsPresent: [], inputFieldsMissing: ['accountJsonBase64'] }
    }
  }

  // base64 解码
  let raw: string
  try {
    raw = Buffer.from(input.accountJsonBase64, 'base64').toString('utf8')
  } catch (_e) {
    return {
      result: 'INVALID_CREDENTIAL',
      warnings: ['accountJsonBase64 not valid base64'],
      meta: { source: 'legacy_json', inputFieldsPresent: [], inputFieldsMissing: [] }
    }
  }

  // JSON 解析
  let json: LegacyJsonV1
  try {
    json = JSON.parse(raw)
  } catch (_e) {
    return {
      result: 'INVALID_CREDENTIAL',
      warnings: ['decoded payload not valid JSON'],
      meta: { source: 'legacy_json', inputFieldsPresent: [], inputFieldsMissing: [] }
    }
  }

  // 字段归一化（snake_case ↔ camelCase）
  const noiseKey = json.noiseKey ?? json.noise_key
  const sigIdKey = json.signedIdentityKey ?? json.signed_identity_key
  const sigPreKey = json.signedPreKey ?? json.signed_pre_key
  const regId = json.registrationId ?? json.registration_id
  const advSecret = json.advSecretKey ?? json.adv_secret_key
  const wid = json.wid ?? json.phone ?? (json.me?.id ? json.me.id.split('@')[0] : undefined)

  const present: string[] = []
  const missing: string[] = []

  if (noiseKey?.private && noiseKey?.public) present.push('noiseKey')
  else missing.push('noiseKey')

  if (sigIdKey?.private && sigIdKey?.public) present.push('signedIdentityKey')
  else missing.push('signedIdentityKey')

  if (wid) present.push('wid')
  else missing.push('wid')

  if (missing.length > 0) {
    return {
      result: missing.length === 3 ? 'UNSUPPORTED_FORMAT' : 'NEED_REAUTH',
      warnings: [`missing fields after legacy JSON parse: ${missing.join(', ')}`],
      meta: { source: 'legacy_json', inputFieldsPresent: present, inputFieldsMissing: missing }
    }
  }

  // signedPreKey 缺失但 noise/identity 齐 → PARTIAL；齐全 → FULL
  const isFullCreds = !!(sigPreKey?.keyPair?.private && sigPreKey?.signature && regId !== undefined)
  const hasKeys = !!(json.keys && Object.keys(json.keys).length > 0)

  const creds: Record<string, unknown> = {
    noiseKey,
    signedIdentityKey: sigIdKey,
    signedPreKey: sigPreKey,
    registrationId: regId ?? 0,
    advSecretKey: advSecret ?? '',
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: { unarchiveChats: false },
    deviceId: '',
    phoneId: '',
    identityId: '',
    registered: true,
    backupToken: '',
    me: json.me ?? { id: `${wid}@s.whatsapp.net` },
    account: json.account ?? null,
    signalIdentities: [],
    platform: 'android',
    lastAccountSyncTimestamp: 0,
    myAppStateKeyId: ''
  }

  const warnings: string[] = []
  if (!isFullCreds) warnings.push('signedPreKey or registrationId missing in legacy JSON')
  if (!hasKeys) warnings.push('keys not present, will be rebuilt on first online')

  return {
    result: isFullCreds && hasKeys ? 'CONVERTED_FULL' : 'CONVERTED_PARTIAL',
    creds,
    keys: hasKeys ? json.keys : {},
    warnings,
    meta: { source: 'legacy_json', inputFieldsPresent: present, inputFieldsMissing: [] }
  }
}
