/**
 * Event Bridge — Baileys 内部事件 → Kafka 业务事件转换。
 *
 * 业务事件全部从这里发出（§ 3.9 / 附录 A.12）：
 *   account.state_changed / heartbeat / online_changed / stale_detected
 *   account.need_reauth / type_detected / proxy_failed / proxy_rotated
 *   account.rate_limited / restricted / new_chat_capping
 *   pairing.code_generated / qr.code_generated / pairing.completed / pairing.failed
 *   message.received / message.ack / group.participant_changed / group.metadata_updated
 *
 * 每条事件强制带 evidence + occurredAt + workerId（业务层乱序检测）。
 */

import type { WASocket } from 'baileys'

import type { EventPublisher } from '../events/publisher.js'
import type { Logger } from '../observability/logger.js'
import type { Metrics } from '../observability/metrics.js'
import type { BusinessDetection } from '../types/api.js'

export interface EventBridgeContext {
  accountId: string
  /** 调用方提供：当前 evidence 快照（由 AccountManager 维护） */
  getEvidence: () => Record<string, unknown>
  /** 业务上下文（业务侧识别用） */
  getBusinessDetection: () => BusinessDetection | null
}

export function attachEventBridge(
  sock: WASocket,
  ctx: EventBridgeContext,
  publisher: EventPublisher,
  logger: Logger,
  metrics: Metrics
): () => void {
  const ev = sock.ev

  // ──────── connection.update ────────
  const onConnUpdate = (update: Parameters<Parameters<typeof ev.on<'connection.update'>>[1]>[0]): void => {
    if (update.qr) {
      publisher.publish('qr.code_generated', ctx.accountId, {
        qrBase64: update.qr,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    }
    if (update.reachoutTimeLock) {
      publisher.publish(
        'account.restricted',
        ctx.accountId,
        {
          isActive: !!update.reachoutTimeLock.isActive,
          restrictedUntil: update.reachoutTimeLock.timeEnforcementEnds?.toISOString() ?? null,
          enforcementType: update.reachoutTimeLock.enforcementType ?? 'DEFAULT'
        },
        ctx.getEvidence()
      )
    }
    // online/offline 状态变化由 AccountManager 在状态机变迁时主动发，这里不重复
  }
  ev.on('connection.update', onConnUpdate)

  // ──────── messages.upsert / received ────────
  const onMsgUpsert = (data: Parameters<Parameters<typeof ev.on<'messages.upsert'>>[1]>[0]): void => {
    for (const msg of data.messages) {
      if (!msg.key.remoteJid) continue
      const fromJid = msg.key.remoteJid
      const isGroup = fromJid.endsWith('@g.us')
      const content = (msg.message ?? {}) as unknown as Record<string, unknown>
      const type = inferMessageType(content)

      publisher.publish(
        'message.received',
        ctx.accountId,
        {
          key: msg.key,
          fromJid,
          pushName: msg.pushName ?? null,
          isGroup,
          messageType: type,
          content,
          hasMedia: hasMediaContent(content),
          receivedAt: new Date().toISOString()
        },
        ctx.getEvidence()
      )
    }
  }
  ev.on('messages.upsert', onMsgUpsert)

  // ──────── messages.update / ack ────────
  const onMsgUpdate = (updates: Parameters<Parameters<typeof ev.on<'messages.update'>>[1]>[0]): void => {
    for (const u of updates) {
      if (!u.update) continue
      // 撤回 / 状态变化
      if (u.update.status != null || u.update.message === null) {
        publisher.publish(
          'message.ack',
          ctx.accountId,
          {
            key: u.key,
            status: u.update.message === null ? 'revoked' : mapAckStatus(u.update.status),
            ackedAt: new Date().toISOString()
          },
          ctx.getEvidence()
        )
      }
    }
  }
  ev.on('messages.update', onMsgUpdate)

  // ──────── group-participants.update ────────
  const onGroupPart = (
    update: Parameters<Parameters<typeof ev.on<'group-participants.update'>>[1]>[0]
  ): void => {
    publisher.publish(
      'group.participant_changed',
      ctx.accountId,
      {
        groupJid: update.id,
        action: update.action,
        participants: update.participants,
        operator: update.author ?? null,
        occurredAt: new Date().toISOString()
      },
      ctx.getEvidence()
    )
  }
  ev.on('group-participants.update', onGroupPart)

  // ──────── groups.update（元数据变更）────────
  const onGroupsUpdate = (updates: Parameters<Parameters<typeof ev.on<'groups.update'>>[1]>[0]): void => {
    for (const g of updates) {
      if (!g.id) continue
      publisher.publish(
        'group.metadata_updated',
        ctx.accountId,
        {
          groupJid: g.id,
          changes: {
            subject: g.subject ?? null,
            description: g.desc ?? null,
            announce: g.announce ?? null,
            restrict: g.restrict ?? null
          },
          operator: 'unknown',
          occurredAt: new Date().toISOString()
        },
        ctx.getEvidence()
      )
    }
  }
  ev.on('groups.update', onGroupsUpdate)

  // ──────── message-capping.update ────────
  const onCapping = (info: Parameters<Parameters<typeof ev.on<'message-capping.update'>>[1]>[0]): void => {
    metrics.messageCappingStatus.inc({ status: info.capping_status ?? 'NONE' })
    publisher.publish(
      'account.new_chat_capping',
      ctx.accountId,
      {
        cappingStatus: info.capping_status ?? 'NONE',
        remaining:
          info.total_quota != null && info.used_quota != null
            ? info.total_quota - info.used_quota
            : null,
        cycleEnd: info.cycle_end_timestamp ?? null
      },
      ctx.getEvidence()
    )
  }
  ev.on('message-capping.update', onCapping)

  // 返回解绑函数
  return () => {
    ev.off('connection.update', onConnUpdate)
    ev.off('messages.upsert', onMsgUpsert)
    ev.off('messages.update', onMsgUpdate)
    ev.off('group-participants.update', onGroupPart)
    ev.off('groups.update', onGroupsUpdate)
    ev.off('message-capping.update', onCapping)
  }
}

function inferMessageType(msg: Record<string, unknown>): string {
  if (msg.conversation || msg.extendedTextMessage) return 'text'
  if (msg.imageMessage) return 'image'
  if (msg.videoMessage) return 'video'
  if (msg.audioMessage) return 'audio'
  if (msg.documentMessage) return 'document'
  if (msg.locationMessage) return 'location'
  if (msg.contactMessage || msg.contactsArrayMessage) return 'contact'
  if (msg.stickerMessage) return 'sticker'
  if (msg.reactionMessage) return 'reaction'
  return 'system'
}

function hasMediaContent(msg: Record<string, unknown>): boolean {
  return !!(msg.imageMessage || msg.videoMessage || msg.audioMessage || msg.documentMessage || msg.stickerMessage)
}

function mapAckStatus(status: number | null | undefined): string {
  // baileys WAMessageStatus: 0=ERROR, 1=PENDING, 2=SERVER_ACK, 3=DELIVERY_ACK, 4=READ, 5=PLAYED
  switch (status) {
    case 2:
      return 'server_ack'
    case 3:
      return 'delivery_ack'
    case 4:
      return 'read'
    case 5:
      return 'played'
    case 0:
      return 'error'
    default:
      return 'pending'
  }
}
