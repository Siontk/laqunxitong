/**
 * 事件发布器。
 *
 * 设计原则：
 *   1. 关键事件走 JetStream + publish ack（保证至少一次）
 *   2. 容忍丢失走普通 publish
 *   3. 每条事件强制带 evidence + occurredAt + workerId（业务层乱序检测）
 *   4. 失败重试 3 次，仍失败写入本地 DLQ 文件 + Prometheus 报警
 */

import { type JetStreamClient, type NatsConnection, StringCodec, connect, type JetStreamManager } from 'nats'
import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Config } from '../config.js'
import type { Metrics } from '../observability/metrics.js'
import type { Logger } from '../observability/logger.js'
import {
  type EventType,
  CRITICAL_EVENTS,
  subjectFor
} from './subjects.js'

export interface EventEnvelope<TData = Record<string, unknown>> {
  event: EventType
  version: string
  accountId: string
  occurredAt: string
  workerId: string
  evidence?: Record<string, unknown>
  data: TData
}

export interface EventPublisher {
  publish<TData>(evt: EventType, accountId: string, data: TData, evidence?: Record<string, unknown>): Promise<void>
  isReady: () => boolean
  close: () => Promise<void>
}

export async function createEventPublisher(
  config: Config,
  metrics: Metrics,
  logger: Logger
): Promise<EventPublisher> {
  let nc: NatsConnection | null = null
  let js: JetStreamClient | null = null
  let jsm: JetStreamManager | null = null
  let connected = false
  const sc = StringCodec()

  async function writeDlq(envelope: EventEnvelope, err: unknown): Promise<void> {
    const day = new Date().toISOString().slice(0, 10)
    await mkdir(config.nats.dlqDir, { recursive: true })
    const line = JSON.stringify({
      failedAt: new Date().toISOString(),
      workerId: config.workerId,
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      envelope
    })
    await appendFile(join(config.nats.dlqDir, `${day}.jsonl`), `${line}\n`, 'utf8')
  }

  async function connectNats(): Promise<void> {
    nc = await connect({
      servers: config.nats.servers.split(',').map(s => s.trim()),
      reconnect: true,
      maxReconnectAttempts: -1,
      pingInterval: 20_000,
      name: `${config.nodeId}/${config.workerId}`
    })
    js = nc.jetstream()
    jsm = await nc.jetstreamManager()
    connected = true

    // 确保流存在
    try {
      await jsm.streams.info(config.nats.streamName)
    } catch (_e) {
      await jsm.streams.add({
        name: config.nats.streamName,
        subjects: [`${config.nats.eventSubjectPrefix}.>`],
        retention: 'limits' as 'limits' | 'workqueue' | 'interest',
        max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 天 ns
        storage: 'file' as 'file' | 'memory'
      })
      logger.info({ stream: config.nats.streamName }, 'JetStream stream created')
    }

    // 断线监控
    ;(async () => {
      for await (const status of nc!.status()) {
        logger.warn({ status: status.type }, 'NATS connection status changed')
        if (status.type === 'disconnect') connected = false
        if (status.type === 'reconnect') connected = true
      }
    })()
  }

  await connectNats().catch(err => {
    logger.error({ err }, 'failed initial NATS connect — will retry on publish')
  })

  async function publishOnce(envelope: EventEnvelope, critical: boolean): Promise<void> {
    if (!nc || !connected) {
      throw new Error('NATS not connected')
    }
    const subject = subjectFor(config.nats.eventSubjectPrefix, envelope.event)
    const payload = sc.encode(JSON.stringify(envelope))

    if (critical && js) {
      await js.publish(subject, payload, {
        msgID: `${envelope.accountId}-${envelope.event}-${envelope.occurredAt}`
      })
    } else {
      nc.publish(subject, payload)
    }
  }

  async function publish<TData>(
    evt: EventType,
    accountId: string,
    data: TData,
    evidence?: Record<string, unknown>
  ): Promise<void> {
    const envelope: EventEnvelope = {
      event: evt,
      version: 'v1',
      accountId,
      occurredAt: new Date().toISOString(),
      workerId: config.workerId,
      evidence,
      data: data as Record<string, unknown>
    }
    const critical = CRITICAL_EVENTS.has(evt)
    let lastErr: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await publishOnce(envelope, critical)
        metrics.eventsPublishedTotal.inc({ event: evt })
        return
      } catch (err) {
        lastErr = err
        metrics.eventsPublishErrorsTotal.inc({ event: evt, reason: 'publish_failed' })
        logger.warn({ err, evt, attempt, accountId }, 'event publish attempt failed')
        await new Promise(r => setTimeout(r, attempt * 200))
      }
    }
    metrics.eventsPublishErrorsTotal.inc({ event: evt, reason: 'dlq' })
    try {
      await writeDlq(envelope, lastErr)
      logger.error({ envelope, err: lastErr, dlqDir: config.nats.dlqDir }, 'event publish exhausted — written to DLQ')
    } catch (dlqErr) {
      metrics.eventsPublishErrorsTotal.inc({ event: evt, reason: 'dlq_write_failed' })
      logger.error({ envelope, err: lastErr, dlqErr }, 'event publish exhausted — DLQ write failed')
    }
  }

  return {
    publish,
    isReady: () => connected,
    close: async () => {
      if (nc) await nc.drain()
    }
  }
}
