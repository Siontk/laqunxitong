/**
 * API 类型短别名 — re-export `openapi/generated/aliases.ts`。
 *
 * 业务侧约定：协议层和业务侧都从这个文件 import 类型，保持单一来源。
 * 实际类型来自 OpenAPI spec 生成。
 */

// Note: 路径相对工程根 protocol-layer/
// 实际部署时 openapi/generated 会被复制到 dist/types 或通过 npm workspace 引用
export type {
  Evidence,
  ErrorResponse,
  ProxyBinding,
  ProxyBindingResult,
  ParamsLoginBody,
  SixLoginBody,
  LegacyJsonLoginBody,
  BaileysAuthState,
  PortableExport,
  ImportResult,
  BusinessDetection,
  AccountType,
  AccountStatus,
  AccountState,
  RestrictionState,
  EnforcementType,
  MessageCapState,
  CappingStatus,
  UsabilityState,
  GroupParticipant,
  GroupMetadata,
  GroupParticipantResults,
  GroupListItem,
  MessageKey,
  MessageSendResult,
  MediaInput,
  TextMessageBody,
  ImageMessageBody,
  DownloadMediaBody,
  DownloadMediaResult,
  Product,
  CatalogResult,
  ChannelMessage,
  ChannelMessageList,
  StateChangedEvent,
  NeedReauthEvent,
  RestrictedEvent,
  CappingEvent,
  TypeDetectedEvent,
  MessageReceivedEvent
} from '../../../openapi/generated/aliases.js'

export {
  isBusinessAccount,
  isVerifiedBusiness,
  isPersonalAccount,
  canDispatchGroupTask
} from '../../../openapi/generated/aliases.js'

export type {
  AccountDeviceProfile as DeviceProfile,
  BrowserDisplay,
  BrowserDisplayPlatform,
  DevicePlatform,
  DeviceProfileSource
} from '../store/account-device-store.js'

/** 语义错误码 — 协议层内部用，对外通过 evidence/error 字段暴露 */
export type SemanticErrorCode =
  | 'PROXY_FAILED'
  | 'RATE_LIMITED'
  | 'NEED_REAUTH'
  | 'RECONNECTING'
  | 'STALE'
  | 'TIMEOUT'
  | 'INTERNAL'

/** 13 状态机所有状态 */
export const ACCOUNT_STATES = [
  'NEW',
  'IMPORTED',
  'PAIRING',
  'VERIFYING',
  'ONLINE',
  'STALE',
  'OFFLINE',
  'RECONNECTING',
  'PROXY_FAILED',
  'RATE_LIMITED',
  'NEED_REAUTH',
  'LOGGED_OUT',
  'DEVICE_REMOVED'
] as const
