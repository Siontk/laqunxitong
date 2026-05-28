/**
 * 类型快捷别名 — 给业务侧调用方用，避免每次都写 components["schemas"]["X"]。
 *
 * 使用方式：
 *   import type { AccountStatus, ImportResult, MessageKey } from './aliases'
 *
 * 这个文件是手写的，不会被 openapi-typescript 覆盖。
 */

import type { components, paths, webhooks, operations } from './types'

// ──── Schemas ────
export type Evidence = components['schemas']['Evidence']
export type ErrorResponse = components['schemas']['ErrorResponse']

// 代理
export type ProxyBinding = components['schemas']['ProxyBinding']
export type ProxyBindingResult = components['schemas']['ProxyBindingResult']

// Apifox 三类登录
export type ParamsLoginBody = components['schemas']['ParamsLoginBody']
export type SixLoginBody = components['schemas']['SixLoginBody']
export type LegacyJsonLoginBody = components['schemas']['LegacyJsonLoginBody']

// Baileys & 便携 JSON
export type BaileysAuthState = components['schemas']['BaileysAuthState']
export type FlatCredsExport = components['schemas']['FlatCredsExport']
export type PortableExport = components['schemas']['PortableExport']
export type BatchExportResult = components['schemas']['BatchExportResult']
export type ImportResult = components['schemas']['ImportResult']

// 批量上线（4C8G × 2000 账号场景的主入口）
export type BatchOnlineItem = components['schemas']['BatchOnlineItem']
export type BatchOnlineBody = components['schemas']['BatchOnlineBody']
export type BatchOnlineItemResult = components['schemas']['BatchOnlineItemResult']
export type BatchOnlineRemoteItem = components['schemas']['BatchOnlineRemoteItem']
export type BatchOnlineSummary = components['schemas']['BatchOnlineSummary']
export type BatchOnlineResult = components['schemas']['BatchOnlineResult']
export type BatchOnlineItemStatus = BatchOnlineItemResult['result']  // 'accepted' | 'timeout' | 'proxy_required' | 'error'

// 批量下线（保留 creds / owner，释放 runtime slot）
export type BatchOfflineBody = components['schemas']['BatchOfflineBody']
export type BatchOfflineItemResult = components['schemas']['BatchOfflineItemResult']
export type BatchOfflineRemoteItem = components['schemas']['BatchOfflineRemoteItem']
export type BatchOfflineSummary = components['schemas']['BatchOfflineSummary']
export type BatchOfflineResult = components['schemas']['BatchOfflineResult']
export type BatchOfflineItemStatus = BatchOfflineItemResult['result']  // 'offline' | 'already_offline' | 'not_found' | 'error'

// 设备元数据
export type DeviceProfile = components['schemas']['DeviceProfile']
export type DevicePlatform = DeviceProfile['platform']
export type DeviceProfileSource = DeviceProfile['source']
export type BrowserDisplay = components['schemas']['BrowserDisplay']
export type BrowserDisplayPlatform = BrowserDisplay['platform']

// 账号类型识别（你重点关注的）
export type BusinessDetection = components['schemas']['BusinessDetection']
export type AccountType = BusinessDetection['accountType']    // 'PERSONAL' | 'BUSINESS_STANDARD' | 'BUSINESS_VERIFIED' | 'UNKNOWN'

// 状态机
export type AccountStatus = components['schemas']['AccountStatus']
export type AccountState = AccountStatus['state']             // 13 个状态枚举

// 风控
export type RestrictionState = components['schemas']['RestrictionState']
export type EnforcementType = NonNullable<RestrictionState['enforcementType']>
export type MessageCapState = components['schemas']['MessageCapState']
export type CappingStatus = NonNullable<MessageCapState['cappingStatus']>
export type UsabilityState = components['schemas']['UsabilityState']

// 群
export type GroupParticipant = components['schemas']['GroupParticipant']
export type GroupMetadata = components['schemas']['GroupMetadata']
export type GroupParticipantResults = components['schemas']['GroupParticipantResults']
export type GroupListItem = components['schemas']['GroupListItem']

// 消息
export type MessageKey = components['schemas']['MessageKey']
export type MessageSendResult = components['schemas']['MessageSendResult']
export type MediaInput = components['schemas']['MediaInput']
export type TextMessageBody = components['schemas']['TextMessageBody']
export type ImageMessageBody = components['schemas']['ImageMessageBody']
export type DownloadMediaBody = components['schemas']['DownloadMediaBody']
export type DownloadMediaResult = components['schemas']['DownloadMediaResult']

// Business / 频道
export type Product = components['schemas']['Product']
export type CatalogResult = components['schemas']['CatalogResult']
export type ChannelMessage = components['schemas']['ChannelMessage']
export type ChannelMessageList = components['schemas']['ChannelMessageList']

// ──── 工具：判断 Business ────
export function isBusinessAccount(detection: BusinessDetection | undefined | null): boolean {
  if (!detection) return false
  return detection.accountType === 'BUSINESS_STANDARD' || detection.accountType === 'BUSINESS_VERIFIED'
}

export function isVerifiedBusiness(detection: BusinessDetection | undefined | null): boolean {
  return detection?.accountType === 'BUSINESS_VERIFIED'
}

export function isPersonalAccount(detection: BusinessDetection | undefined | null): boolean {
  return detection?.accountType === 'PERSONAL'
}

/**
 * 业务侧最常用的"能不能下发任务"判定。
 * 必须同时满足：online、creds 有效、未被风控、新 chat 配额未封顶。
 */
export function canDispatchGroupTask(usability: UsabilityState): boolean {
  return (
    usability.state === 'ONLINE' &&
    usability.canCreateGroup === true &&
    usability.canAddToGroup === true &&
    usability.blockedReason == null
  )
}

// ──── 事件类型（webhook payload）────
export type WebhookEvents = webhooks
export type StateChangedEvent = NonNullable<webhooks['account.state_changed']['post']['requestBody']>['content']['application/json']
export type NeedReauthEvent = NonNullable<webhooks['account.need_reauth']['post']['requestBody']>['content']['application/json']
export type RestrictedEvent = NonNullable<webhooks['account.restricted']['post']['requestBody']>['content']['application/json']
export type CappingEvent = NonNullable<webhooks['account.new_chat_capping']['post']['requestBody']>['content']['application/json']
export type OwnerAssignedEvent = NonNullable<webhooks['account.owner_assigned']['post']['requestBody']>['content']['application/json']
export type OwnerChangedEvent = NonNullable<webhooks['account.owner_changed']['post']['requestBody']>['content']['application/json']
export type OwnerUnassignedEvent = NonNullable<webhooks['account.owner_unassigned']['post']['requestBody']>['content']['application/json']
export type TypeDetectedEvent = NonNullable<webhooks['account.type_detected']['post']['requestBody']>['content']['application/json']
export type MessageReceivedEvent = NonNullable<webhooks['message.received']['post']['requestBody']>['content']['application/json']

// ──── 路径 / 操作快捷别名 ────
export type ApiPaths = paths
export type ApiOperations = operations
