/**
 * 账号类型识别（§ 4.7.6）。
 *
 * 信号源（按可靠度从高到低）：
 *   1. creds.platform（pair-success 时填）— smba/smbi = Business
 *   2. creds.me.name（pair-success 的 biz 节点）— 存在即 Business
 *   3. creds.me.verifiedName — BUSINESS_VERIFIED
 *   4. 兜底 sock.getBusinessProfile(selfJid)
 */

import type { WASocket } from 'baileys'

import type { BusinessDetection } from '../types/api.js'
import type { Logger } from '../observability/logger.js'

export interface DetectInput {
  creds: { platform?: string; me?: { name?: string; verifiedName?: string; id?: string } }
  /** 仅当 creds 不够明确时，主动调 Baileys API 兜底 */
  fallbackSocket?: WASocket
  /** 来自 paramsLogin/sixLogin 的 vip 字段，作为初始猜测 */
  vipHint?: boolean
}

export async function detectAccountType(
  input: DetectInput,
  logger: Logger
): Promise<BusinessDetection> {
  const platform = (input.creds.platform ?? 'unknown') as BusinessDetection['platform']
  const bizName = input.creds.me?.name ?? null
  const verifiedName = input.creds.me?.verifiedName ?? null

  // 优先 1：platform = smba/smbi
  const platformSaysBusiness = platform === 'smba' || platform === 'smbi'
  // 优先 2：creds.me.name 非空 = bizName
  const hasBizName = bizName != null && bizName !== ''

  if (platformSaysBusiness || hasBizName) {
    return {
      accountType: verifiedName ? 'BUSINESS_VERIFIED' : 'BUSINESS_STANDARD',
      isBusiness: true,
      isVerified: verifiedName != null,
      platform,
      bizName,
      verifiedName,
      source: platformSaysBusiness ? 'creds_meta' : 'pair_success',
      detectedAt: new Date().toISOString()
    }
  }

  // 兜底：调 getBusinessProfile(selfJid)
  if (input.fallbackSocket && input.creds.me?.id) {
    try {
      const profile = await input.fallbackSocket.getBusinessProfile(input.creds.me.id)
      if (profile) {
        return {
          accountType: 'BUSINESS_STANDARD',
          isBusiness: true,
          isVerified: false,
          platform,
          bizName: null,
          verifiedName: null,
          source: 'business_profile_query',
          detectedAt: new Date().toISOString()
        }
      }
    } catch (err) {
      logger.debug({ err }, 'getBusinessProfile fallback query failed')
    }
  }

  // 没有确定证据，且没有 vipHint → PERSONAL
  if (!input.vipHint) {
    return {
      accountType: 'PERSONAL',
      isBusiness: false,
      isVerified: false,
      platform,
      bizName: null,
      verifiedName: null,
      source: 'creds_meta',
      detectedAt: new Date().toISOString()
    }
  }

  // vipHint=true 但其他证据都没 → UNKNOWN（等 online 后重新探测）
  return {
    accountType: 'UNKNOWN',
    isBusiness: false,
    isVerified: false,
    platform,
    bizName: null,
    verifiedName: null,
    source: 'vip_hint',
    detectedAt: new Date().toISOString()
  }
}
