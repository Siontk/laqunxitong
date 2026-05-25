/**
 * 事件类型与 Kafka topic 路由。
 *
 * Kafka message key 固定用 accountId，保证同账号事件落到同一 partition。
 */

export const EVENT_TYPES = [
  'account.state_changed',
  'account.heartbeat',
  'account.online_changed',
  'account.stale_detected',
  'account.need_reauth',
  'account.type_detected',
  'account.proxy_failed',
  'account.proxy_rotated',
  'account.rate_limited',
  'account.restricted',
  'account.new_chat_capping',
  'account.owner_assigned',
  'account.owner_changed',
  'account.owner_unassigned',
  'pairing.code_generated',
  'qr.code_generated',
  'pairing.completed',
  'pairing.failed',
  'message.received',
  'message.ack',
  'group.participant_changed',
  'group.metadata_updated'
] as const

export type EventType = (typeof EVENT_TYPES)[number]

/** 必须可靠投递的事件（Kafka producer ack=all） */
export const CRITICAL_EVENTS = new Set<EventType>([
  'account.state_changed',
  'account.need_reauth',
  'account.restricted',
  'account.new_chat_capping',
  'account.proxy_failed',
  'account.owner_assigned',
  'account.owner_changed',
  'account.owner_unassigned',
  'pairing.code_generated',
  'qr.code_generated',
  'pairing.completed',
  'pairing.failed',
  'message.received',
  'message.ack',
  'group.participant_changed'
])

/** 可降级事件；当前仍写 Kafka，业务侧可按需忽略或降低保留时间 */
export const BEST_EFFORT_EVENTS = new Set<EventType>([
  'account.heartbeat',
  'account.online_changed',
  'account.stale_detected',
  'account.proxy_rotated',
  'account.type_detected',
  'account.rate_limited',
  'group.metadata_updated'
])

export type EventTopicKind = 'account' | 'owner' | 'message' | 'group' | 'pairing'

export function topicKindFor(evt: EventType): EventTopicKind {
  if (evt.startsWith('account.owner_')) return 'owner'
  if (evt.startsWith('message.')) return 'message'
  if (evt.startsWith('group.')) return 'group'
  if (evt.startsWith('pairing.') || evt.startsWith('qr.')) return 'pairing'
  return 'account'
}
