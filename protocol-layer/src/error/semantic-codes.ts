/**
 * Baileys DisconnectReason / 上行 ack error / 心跳异常 → 协议层统一语义码。
 *
 * 设计原则（§ 4.4 NEED_REAUTH 触发表 + § 4.5 三类重连）：
 *   - 协议层对外只暴露 semantic + rawCode + rawReason
 *   - 业务层按 semantic 做调度决策，不关心 raw
 *   - 未识别的 disconnect 默认归 RECONNECTING（保守）
 */

import { DisconnectReason } from 'baileys'

import type { SemanticErrorCode } from '../types/api.js'

export interface SemanticTranslation {
  semantic: SemanticErrorCode | 'OK'
  /** 重连分类（§ 4.5）— A 立即 / B 退避 / C 终态不重连 */
  reconnectClass: 'A' | 'B' | 'C' | 'none'
  /** 是否触发 NEED_REAUTH（设备已被踢、creds 失效） */
  needReauth: boolean
  /** 原始码（用于诊断、上报 raw） */
  rawCode: number | null
  rawReason: string | null
}

/**
 * 翻译 Baileys 的 close 事件 statusCode → 语义码。
 *
 * § 4.4 / 4.5 真值表：
 *  515 restartRequired      → A 类立即重连，OK
 *  408 timedOut / connectionLost → A/B 类重连，semantic=RECONNECTING
 *  428 connectionClosed     → B 类退避，semantic=RECONNECTING
 *  440 connectionReplaced   → 另设备登录占用，business 决策（视为 NEED_REAUTH）
 *  401 loggedOut            → NEED_REAUTH，C 类不重连
 *  401 device_removed       → NEED_REAUTH，C 类不重连
 *  401 multideviceMismatch  → NEED_REAUTH，C 类不重连
 *  403 forbidden            → NEED_REAUTH（多数情况账号已废）
 *  500 badSession           → NEED_REAUTH
 *  503 unavailableService   → B 类退避
 *  proxy auth failed / timeout → PROXY_FAILED（不动 creds）
 */
export function translateDisconnect(
  statusCode: number | undefined,
  reason: string | undefined,
  hint?: { isProxyError?: boolean; isRateLimited?: boolean }
): SemanticTranslation {
  if (hint?.isProxyError) {
    return {
      semantic: 'PROXY_FAILED',
      reconnectClass: 'B',
      needReauth: false,
      rawCode: statusCode ?? null,
      rawReason: reason ?? 'proxy error'
    }
  }
  if (hint?.isRateLimited) {
    return {
      semantic: 'RATE_LIMITED',
      reconnectClass: 'B',
      needReauth: false,
      rawCode: statusCode ?? 429,
      rawReason: reason ?? 'rate limited'
    }
  }

  switch (statusCode) {
    case DisconnectReason.restartRequired: // 515
      return { semantic: 'RECONNECTING', reconnectClass: 'A', needReauth: false, rawCode: 515, rawReason: 'restart required' }
    case DisconnectReason.connectionLost: // 408
    case DisconnectReason.timedOut: // 408
      return { semantic: 'RECONNECTING', reconnectClass: 'A', needReauth: false, rawCode: statusCode, rawReason: reason ?? 'connection lost' }
    case DisconnectReason.connectionClosed: // 428
      return { semantic: 'RECONNECTING', reconnectClass: 'B', needReauth: false, rawCode: 428, rawReason: 'connection closed' }
    case DisconnectReason.connectionReplaced: // 440
      return { semantic: 'NEED_REAUTH', reconnectClass: 'C', needReauth: true, rawCode: 440, rawReason: 'connection replaced' }
    case DisconnectReason.loggedOut: // 401
      return { semantic: 'NEED_REAUTH', reconnectClass: 'C', needReauth: true, rawCode: 401, rawReason: reason ?? 'logged out' }
    case DisconnectReason.multideviceMismatch: // 411
      return { semantic: 'NEED_REAUTH', reconnectClass: 'C', needReauth: true, rawCode: 411, rawReason: 'multi-device mismatch' }
    case DisconnectReason.forbidden: // 403
      return { semantic: 'NEED_REAUTH', reconnectClass: 'C', needReauth: true, rawCode: 403, rawReason: reason ?? 'forbidden' }
    case DisconnectReason.badSession: // 500
      return { semantic: 'NEED_REAUTH', reconnectClass: 'C', needReauth: true, rawCode: 500, rawReason: 'bad session' }
    case DisconnectReason.unavailableService: // 503
      return { semantic: 'RECONNECTING', reconnectClass: 'B', needReauth: false, rawCode: 503, rawReason: 'unavailable service' }
    default:
      return {
        semantic: 'RECONNECTING',
        reconnectClass: 'B',
        needReauth: false,
        rawCode: statusCode ?? null,
        rawReason: reason ?? 'unknown disconnect'
      }
  }
}

/**
 * 消息 ack 中的 error 码（来自 § 3 中 SERVER_ERROR_CODES + 群组 per-participant）
 */
export const ACK_ERROR_CODES = {
  // 详见 Baileys src/Utils/decode-wa-message.ts
  MESSAGE_ACCOUNT_RESTRICTION: '463',
  SMAX_INVALID: '479',
  // 群组 per-participant
  PRIVACY_FORBIDDEN: '403',
  TIMEOUT: '408',
  ALREADY_MEMBER: '409',
  GROUP_FULL: '419',
  SERVER_ERROR: '500'
} as const

export type AckErrorCode = (typeof ACK_ERROR_CODES)[keyof typeof ACK_ERROR_CODES]

/** 463 / 479 等 ack error 翻译，触发 reachoutTimelock 重查 */
export function isAccountRestrictionAckError(code: string | undefined): boolean {
  return code === ACK_ERROR_CODES.MESSAGE_ACCOUNT_RESTRICTION
}
