/**
 * Messages 路由 — 15 个接口
 */

import { z } from 'zod'

import type { RouteRegistrar } from './_context.js'
import { auditInfo } from './audit-log.js'

const MediaInputShape = z.object({
  url: z.string().optional(),
  base64: z.string().optional(),
  mimetype: z.string().optional()
})

function resolveMedia(m: z.infer<typeof MediaInputShape>): Buffer | { url: string } {
  if (m.base64) return Buffer.from(m.base64, 'base64')
  if (m.url) return { url: m.url }
  throw new Error('media input must provide url or base64')
}

/**
 * 从 WA message 结构里推断 mimetype。
 * Baileys 各 *Message 子结构里都带 mimetype，按顺序找。
 */
function guessMimetype(message: unknown): string {
  const m = (message as { message?: Record<string, { mimetype?: string }> })?.message ?? {}
  return (
    m.imageMessage?.mimetype ??
    m.videoMessage?.mimetype ??
    m.audioMessage?.mimetype ??
    m.documentMessage?.mimetype ??
    m.stickerMessage?.mimetype ??
    'application/octet-stream'
  )
}

const MessageKeyShape = z.object({
  remoteJid: z.string(),
  fromMe: z.boolean(),
  id: z.string(),
  participant: z.string().optional().nullable()
})

function auditMessageSent(
  ctx: Parameters<RouteRegistrar>[1],
  messageType: string,
  accountId: string,
  jid: string,
  result: { key?: { id?: string | null; remoteJid?: string | null }; messageTimestamp?: unknown } | undefined
): void {
  auditInfo(ctx.logger, 'message.sent', {
    accountId,
    messageType,
    jid,
    messageId: result?.key?.id ?? null,
    remoteJid: result?.key?.remoteJid ?? null,
    timestamp: Number(result?.messageTimestamp ?? 0)
  })
}

export const registerMessagesRoutes: RouteRegistrar = (app, ctx) => {
  // ─── 文本 ───
  app.post('/v1/messages/text', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), jid: z.string(), text: z.string().max(4096) })
    const { accountId, jid, text } = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(accountId)
    const r = await sock.sendMessage(jid, { text })
    auditMessageSent(ctx, 'text', accountId, jid, r)
    reply.send({ messageId: r?.key.id, key: r?.key, timestamp: Number(r?.messageTimestamp ?? 0), status: 'pending' })
  })

  // ─── 图片 / 视频 / 音频 / 文档 ───
  app.post('/v1/messages/image', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), jid: z.string(), image: MediaInputShape, caption: z.string().optional(), viewOnce: z.boolean().optional() })
    const b = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(b.accountId)
    const r = await sock.sendMessage(b.jid, { image: resolveMedia(b.image) as Buffer, caption: b.caption, viewOnce: b.viewOnce })
    auditMessageSent(ctx, 'image', b.accountId, b.jid, r)
    reply.send({ messageId: r?.key.id, key: r?.key, timestamp: Number(r?.messageTimestamp ?? 0), status: 'pending' })
  })

  app.post('/v1/messages/audio', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), jid: z.string(), audio: MediaInputShape, ptt: z.boolean().optional(), mimetype: z.string().optional() })
    const b = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(b.accountId)
    const r = await sock.sendMessage(b.jid, { audio: resolveMedia(b.audio) as Buffer, ptt: b.ptt, mimetype: b.mimetype ?? b.audio.mimetype })
    auditMessageSent(ctx, 'audio', b.accountId, b.jid, r)
    reply.send({ messageId: r?.key.id, key: r?.key, timestamp: Number(r?.messageTimestamp ?? 0), status: 'pending' })
  })

  app.post('/v1/messages/video', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), jid: z.string(), video: MediaInputShape, caption: z.string().optional(), gifPlayback: z.boolean().optional(), viewOnce: z.boolean().optional() })
    const b = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(b.accountId)
    const r = await sock.sendMessage(b.jid, { video: resolveMedia(b.video) as Buffer, caption: b.caption, gifPlayback: b.gifPlayback, viewOnce: b.viewOnce })
    auditMessageSent(ctx, 'video', b.accountId, b.jid, r)
    reply.send({ messageId: r?.key.id, key: r?.key, timestamp: Number(r?.messageTimestamp ?? 0), status: 'pending' })
  })

  app.post('/v1/messages/document', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), jid: z.string(), document: MediaInputShape, fileName: z.string(), mimetype: z.string(), caption: z.string().optional() })
    const b = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(b.accountId)
    const r = await sock.sendMessage(b.jid, { document: resolveMedia(b.document) as Buffer, fileName: b.fileName, mimetype: b.mimetype, caption: b.caption })
    auditMessageSent(ctx, 'document', b.accountId, b.jid, r)
    reply.send({ messageId: r?.key.id, key: r?.key, timestamp: Number(r?.messageTimestamp ?? 0), status: 'pending' })
  })

  app.post('/v1/messages/location', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), jid: z.string(), degreesLatitude: z.number(), degreesLongitude: z.number(), name: z.string().optional(), address: z.string().optional() })
    const b = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(b.accountId)
    const r = await sock.sendMessage(b.jid, { location: { degreesLatitude: b.degreesLatitude, degreesLongitude: b.degreesLongitude, name: b.name, address: b.address } })
    auditMessageSent(ctx, 'location', b.accountId, b.jid, r)
    reply.send({ messageId: r?.key.id, key: r?.key, timestamp: Number(r?.messageTimestamp ?? 0), status: 'pending' })
  })

  app.post('/v1/messages/contact-card', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), jid: z.string(), contacts: z.array(z.object({ displayName: z.string(), vcard: z.string() })) })
    const b = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(b.accountId)
    const r = await sock.sendMessage(b.jid, { contacts: { displayName: b.contacts[0]?.displayName ?? 'unknown', contacts: b.contacts } })
    auditMessageSent(ctx, 'contact-card', b.accountId, b.jid, r)
    reply.send({ messageId: r?.key.id, key: r?.key, timestamp: Number(r?.messageTimestamp ?? 0), status: 'pending' })
  })

  app.post('/v1/messages/link', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), jid: z.string(), text: z.string(), generatePreview: z.boolean().default(true) })
    const b = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(b.accountId)
    // Baileys 默认会从 text 中抓 URL 并生成 preview；generatePreview=false 则等同 text
    const r = await sock.sendMessage(b.jid, { text: b.text })
    auditMessageSent(ctx, 'link', b.accountId, b.jid, r)
    reply.send({ messageId: r?.key.id, key: r?.key, timestamp: Number(r?.messageTimestamp ?? 0), status: 'pending' })
  })

  // ─── reaction / delete / forward / read / typing ───
  app.post('/v1/messages/reaction', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), jid: z.string(), targetKey: MessageKeyShape, reaction: z.string() })
    const b = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(b.accountId)
    const r = await sock.sendMessage(b.jid, { react: { text: b.reaction, key: b.targetKey } })
    auditMessageSent(ctx, 'reaction', b.accountId, b.jid, r)
    reply.send({ messageId: r?.key.id, key: r?.key, timestamp: Number(r?.messageTimestamp ?? 0), status: 'pending' })
  })

  app.post('/v1/messages/delete', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), jid: z.string(), targetKey: MessageKeyShape, forEveryone: z.boolean().default(true) })
    const b = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(b.accountId)
    const r = await sock.sendMessage(b.jid, { delete: b.targetKey })
    void b.forEveryone
    auditMessageSent(ctx, 'delete', b.accountId, b.jid, r)
    reply.send({ messageId: r?.key.id, key: r?.key, timestamp: Number(r?.messageTimestamp ?? 0), status: 'pending' })
  })

  app.post('/v1/messages/forward', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), jid: z.string(), sourceMessage: z.any(), forceForward: z.boolean().default(false) })
    const b = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(b.accountId)
    const r = await sock.sendMessage(b.jid, { forward: b.sourceMessage as never, force: b.forceForward })
    auditMessageSent(ctx, 'forward', b.accountId, b.jid, r)
    reply.send({ messageId: r?.key.id, key: r?.key, timestamp: Number(r?.messageTimestamp ?? 0), status: 'pending' })
  })

  app.post('/v1/messages/read', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), keys: z.array(MessageKeyShape).min(1) })
    const b = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(b.accountId)
    await sock.readMessages(b.keys)
    auditInfo(ctx.logger, 'message.read', { accountId: b.accountId, count: b.keys.length })
    reply.send({ count: b.keys.length })
  })

  app.post('/v1/messages/typing', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), jid: z.string(), state: z.enum(['composing', 'recording', 'paused', 'available', 'unavailable']), durationSec: z.number().default(5) })
    const b = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(b.accountId)
    await sock.sendPresenceUpdate(b.state, b.jid)
    if ((b.state === 'composing' || b.state === 'recording') && b.durationSec > 0) {
      setTimeout(() => sock.sendPresenceUpdate('paused', b.jid).catch(() => {}), b.durationSec * 1000).unref()
    }
    auditInfo(ctx.logger, 'message.typing', { accountId: b.accountId, jid: b.jid, state: b.state, durationSec: b.durationSec })
    reply.send({ ok: true })
  })

  // ─── media download ───
  app.post('/v1/messages/:messageId/download', async (req, reply) => {
    const Body = z.object({
      accountId: z.string(),
      message: z.record(z.string(), z.unknown()),
      returnAs: z.enum(['base64', 'url', 'stream']).default('base64')
    })
    const b = Body.parse(req.body)
    void req.params // messageId 仅作 path 美化，实际靠 message.key.id

    const sock = ctx.accounts.getSocket(b.accountId)

    // 动态 import 避免顶层依赖（downloadMediaMessage 在 baileys 主包导出）
    const { downloadMediaMessage } = await import('baileys')

    try {
      if (b.returnAs === 'stream') {
        const stream = await downloadMediaMessage(
          b.message as never,
          'stream',
          {},
          {
            logger: ctx.logger.child({ accountId: b.accountId }) as never,
            reuploadRequest: sock.updateMediaMessage
          }
        )
        reply
          .header('content-type', 'application/octet-stream')
          .header('content-disposition', `attachment; filename="${b.message.key && (b.message as { key: { id: string } }).key.id}"`)
        return reply.send(stream)
      }

      const buf = await downloadMediaMessage(
        b.message as never,
        'buffer',
        {},
        {
          logger: ctx.logger.child({ accountId: b.accountId }) as never,
          reuploadRequest: sock.updateMediaMessage
        }
      )

      const mimetype = guessMimetype(b.message)

      if (b.returnAs === 'url') {
        // 生产应上传到 S3/OSS，返回 signed URL
        // 当前实现：base64 dataURL 兜底（不推荐生产用）
        if (ctx.config.media.storageBackend === 'none') {
          ctx.logger.warn(
            { accountId: b.accountId },
            'returnAs=url but media.storageBackend=none — falling back to base64'
          )
          reply.send({
            mimetype,
            sizeBytes: buf.length,
            base64: buf.toString('base64'),
            url: null
          })
          auditInfo(ctx.logger, 'message.media_downloaded', {
            accountId: b.accountId,
            returnAs: b.returnAs,
            mimetype,
            sizeBytes: buf.length,
            fallback: 'base64'
          })
          return
        }
        // TODO: 实际接 S3 / OSS / R2 上传
        reply.code(501).send({
          code: 'STORAGE_NOT_CONFIGURED',
          message: `returnAs=url requires media.storageBackend != 'none' (current: ${ctx.config.media.storageBackend})`
        })
        return
      }

      // base64
      reply.send({
        mimetype,
        sizeBytes: buf.length,
        base64: buf.toString('base64'),
        url: null
      })
      auditInfo(ctx.logger, 'message.media_downloaded', {
        accountId: b.accountId,
        returnAs: b.returnAs,
        mimetype,
        sizeBytes: buf.length
      })
    } catch (err) {
      ctx.logger.warn({ err, accountId: b.accountId }, 'downloadMediaMessage failed')
      reply.code(404).send({
        code: 'DOWNLOAD_FAILED',
        message: `media download failed: ${(err as Error).message}`
      })
    }
  })

  // ─── status broadcast ───
  app.post('/v1/messages/status', async (req, reply) => {
    const Body = z.object({ accountId: z.string(), content: z.any(), statusJidList: z.array(z.string()) })
    const b = Body.parse(req.body)
    const sock = ctx.accounts.getSocket(b.accountId)
    const r = await sock.sendMessage('status@broadcast', b.content as never, { statusJidList: b.statusJidList })
    auditMessageSent(ctx, 'status', b.accountId, 'status@broadcast', r)
    reply.send({ messageId: r?.key.id, key: r?.key, timestamp: Number(r?.messageTimestamp ?? 0), status: 'pending' })
  })
}
