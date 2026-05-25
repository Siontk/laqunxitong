/**
 * NATS subject 常量表。
 *
 * 规范：unsea.v1.events.{event_name}
 * 19 事件按 § 3.9 / 附录 A.12 定义，对应 OpenAPI webhooks 部分。
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

/** 必须可靠投递的事件（走 JetStream + ack） */
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

/** 容忍丢失的事件（普通 NATS 即可） */
export const BEST_EFFORT_EVENTS = new Set<EventType>([
  'account.heartbeat',
  'account.online_changed',
  'account.stale_detected',
  'account.proxy_rotated',
  'account.type_detected',
  'account.rate_limited',
  'group.metadata_updated'
])

export function subjectFor(prefix: string, evt: EventType): string {
  return `${prefix}.${evt}`
}
