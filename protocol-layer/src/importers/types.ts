/**
 * 共享类型：Apifox 三类登录 → Baileys auth_state 的转换层。
 *
 * 设计原则：
 *   1. 纯函数。无副作用，可单测。
 *   2. 输出统一 ImportResult，结果枚举与 OpenAPI 一致。
 *   3. 不做 ws / 网络 IO。online 由上层 importer.ts 调度。
 *   4. 失败情形必须显式枚举，不能 throw 兜底 Error。
 */

export type ConvertResult =
  | 'CONVERTED_FULL'          // creds 全 + keys 全，可直接 online
  | 'CONVERTED_PARTIAL'       // creds 全 + keys 缺/部分，online 后首次重连需要补
  | 'NEED_REAUTH'             // 材料不足，必须重新走 pairing
  | 'UNSUPPORTED_FORMAT'      // 输入字段命名不对应
  | 'INVALID_CREDENTIAL'      // 字段在但解码失败 / 长度错 / base64 错

export interface ConvertOutput {
  result: ConvertResult
  /** 转出的 baileys creds，部分字段可能缺省 */
  creds?: Record<string, unknown>
  /** 转出的 baileys keys，可能整体缺失 */
  keys?: Record<string, Record<string, unknown>>
  warnings: string[]
  /** 转换器内部供 debug 用的元数据，业务侧可忽略 */
  meta?: {
    source: 'params' | 'six' | 'legacy_json'
    inputFieldsPresent: string[]
    inputFieldsMissing: string[]
  }
}

/** Apifox /api/login/paramsLogin body */
export interface ParamsLoginInput {
  wid: string
  cc?: string | null
  clientStaticPrivateKey: string
  clientStaticPublicKey: string
  country?: string | null
  device?: string | null
  deviceUUID?: string | null
  identityPrivateKey: string
  identityPublicKey: string
  language?: string | null
  manufacturer?: string | null
  mcc?: string | null
  mnc?: string | null
  osBuildNumber?: string | null
  osVersion?: string | null
  phoneUUID?: string | null
  qrId?: string | null
  registrationID: number
  roProductBoard?: string | null
  roProductDevice?: string | null
  signPreKeyID: number
  signPreKeyPrivateKey: string
  signPreKeyPublicKey: string
  signPreKeySignature: string
  vip?: boolean
  whatsappVersion?: string | null
}

/** Apifox /api/login/sixLogin body */
export interface SixLoginInput {
  wid: string
  cc?: string | null
  clientStaticPrivateKey: string
  clientStaticPublicKey: string
  identityPrivateKey: string
  identityPublicKey: string
  /** ADVSignedDeviceIdentity protobuf base64，分身设备身份密钥；主设备可能为空 */
  deviceIdentityKey?: string
  phoneId?: string | null
  operator?: string | null
  wsDeviceId?: number
  qrId?: string | null
  vip?: boolean
}

/** Apifox /api/login/jsonLogin body */
export interface LegacyJsonLoginInput {
  /** base64 编码的旧 JSON 字符串 */
  accountJsonBase64: string
  qrId?: string | null
}
