/**
 * Kafka 事件发布器。
 *
 * 设计原则：
 *   1. Kafka message key 固定用 accountId，保证同账号事件分区内有序。
 *   2. 事件 envelope 不变，功能层只需要从 Kafka topic 消费。
 *   3. 失败重试 3 次，仍失败写入本地 DLQ 文件并报警。
 */

import { Kafka, CompressionTypes, logLevel, type Producer, type SASLOptions } from 'kafkajs'
import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Config } from '../config.js'
import type { Metrics } from '../observability/metrics.js'
import type { Logger } from '../observability/logger.js'
import { type EventType, topicKindFor } from './subjects.js'

export interface EventEnvelope<TData = Record<string, unknown>> {
  eventId: string
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
  let producer: Producer | null = null
  let connected = false
  let inflightCount = 0
  const maxInflight = config.kafka.maxInflightMessages

  const trackInflight = (delta: number): void => {
    inflightCount += delta
    metrics.kafkaProducerInflight.set(Math.max(0, inflightCount))
  }

  async function writeDlq(envelope: EventEnvelope, err: unknown): Promise<void> {
    const day = new Date().toISOString().slice(0, 10)
    await mkdir(config.events.dlqDir, { recursive: true })
    const line = JSON.stringify({
      failedAt: new Date().toISOString(),
      backend: config.events.backend,
      workerId: config.workerId,
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      envelope
    })
    await appendFile(join(config.events.dlqDir, `${day}.jsonl`), `${line}\n`, 'utf8')
  }

  function kafkaSasl(): SASLOptions | undefined {
    if (!config.kafka.username || !config.kafka.password) return undefined
    return {
      mechanism: config.kafka.saslMechanism,
      username: config.kafka.username,
      password: config.kafka.password
    } as SASLOptions
  }

  function topicFor(evt: EventType): string {
    const kind = topicKindFor(evt)
    if (kind === 'owner') return config.kafka.topicOwner
    if (kind === 'message') return config.kafka.topicMessage
    if (kind === 'group') return config.kafka.topicGroup
    if (kind === 'pairing') return config.kafka.topicPairing
    return config.kafka.topicAccount
  }

  function createEventId(accountId: string, evt: EventType): string {
    const ts = Date.now().toString(36)
    const rand = Math.random().toString(36).slice(2, 10)
    return `${accountId}:${evt}:${ts}:${rand}`
  }

  async function connectKafka(): Promise<void> {
    const kafka = new Kafka({
      clientId: config.kafka.clientId,
      brokers: config.kafka.brokers.split(',').map(s => s.trim()).filter(Boolean),
      ssl: config.kafka.ssl,
      sasl: kafkaSasl(),
      logLevel: logLevel.NOTHING
    })
    producer = kafka.producer({
      allowAutoTopicCreation: false,
      // idempotent=true 保证消息不重复（forced maxInFlight=1 + acks=-1）。
      // 在 2000 账号规模下，单条 send 的网络往返开销不可忽视，但比起重复消息
      // 的业务侧去重成本，幂等仍然更划算。Kafka 客户端自身会在 protocol 层做
      // 一定程度的 batching（同 broker 多 partition 合并 produce request）。
      idempotent: true,
      maxInFlightRequests: 1,
      retry: {
        retries: 5,
        initialRetryTime: 300
      }
    })
    await producer.connect()
    connected = true
    logger.info(
      {
        backend: config.events.backend,
        brokers: config.kafka.brokers,
        topics: {
          account: config.kafka.topicAccount,
          owner: config.kafka.topicOwner,
          message: config.kafka.topicMessage,
          group: config.kafka.topicGroup,
          pairing: config.kafka.topicPairing
        }
      },
      'kafka event publisher connected'
    )
  }

  await connectKafka().catch(err => {
    connected = false
    logger.error({ err, brokers: config.kafka.brokers }, 'failed initial Kafka connect — will retry on publish')
  })

  async function ensureConnected(): Promise<Producer> {
    if (producer && connected) return producer
    await connectKafka()
    if (!producer || !connected) throw new Error('Kafka not connected')
    return producer
  }

  async function publishOnce(envelope: EventEnvelope): Promise<void> {
    const p = await ensureConnected()
    await p.send({
      topic: topicFor(envelope.event),
      acks: -1,
      // GZIP/LZ4/Snappy 都能用，LZ4 综合速度最快。AWS MSK 默认开 LZ4。
      // 2000 账号 message.received + state_changed 这类高频事件压缩比能到 5-10x，
      // 节省 broker 入向带宽和 broker 端磁盘 IO。
      compression: CompressionTypes.LZ4,
      messages: [
        {
          key: envelope.accountId,
          value: JSON.stringify(envelope),
          headers: {
            eventId: envelope.eventId,
            event: envelope.event,
            version: envelope.version,
            workerId: envelope.workerId,
            occurredAt: envelope.occurredAt
          }
        }
      ]
    })
  }

  async function publish<TData>(
    evt: EventType,
    accountId: string,
    data: TData,
    evidence?: Record<string, unknown>
  ): Promise<void> {
    // ── 反压：inflight 超过阈值直接进 DLQ，不让 producer queue 撑爆 heap ──
    //
    // 触发场景：Kafka broker 挂掉或网络分区，producer 还在重试中，
    // 业务侧持续 publish 把 inflight 堆到几万。如果不限制，Node heap 飙升 OOM。
    // 限制后超出的事件直接写本地 DLQ jsonl，Kafka 恢复后由运维脚本回放。
    if (inflightCount >= maxInflight) {
      metrics.eventsPublishErrorsTotal.inc({ event: evt, reason: 'inflight_limit' })
      const envelope: EventEnvelope = {
        eventId: createEventId(accountId, evt),
        event: evt,
        version: 'v1',
        accountId,
        occurredAt: new Date().toISOString(),
        workerId: config.workerId,
        evidence,
        data: data as Record<string, unknown>
      }
      try {
        await writeDlq(envelope, new Error('inflight_limit_exceeded'))
      } catch {
        metrics.eventsPublishErrorsTotal.inc({ event: evt, reason: 'dlq_write_failed' })
      }
      return
    }

    const envelope: EventEnvelope = {
      eventId: createEventId(accountId, evt),
      event: evt,
      version: 'v1',
      accountId,
      occurredAt: new Date().toISOString(),
      workerId: config.workerId,
      evidence,
      data: data as Record<string, unknown>
    }

    trackInflight(1)
    try {
      let lastErr: unknown
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await publishOnce(envelope)
          metrics.eventsPublishedTotal.inc({ event: evt })
          return
        } catch (err) {
          lastErr = err
          connected = false
          metrics.eventsPublishErrorsTotal.inc({ event: evt, reason: 'publish_failed' })
          logger.warn({ err, evt, attempt, accountId, topic: topicFor(evt) }, 'event publish attempt failed')
          await new Promise(r => setTimeout(r, attempt * 300))
        }
      }

      metrics.eventsPublishErrorsTotal.inc({ event: evt, reason: 'dlq' })
      try {
        await writeDlq(envelope, lastErr)
        logger.error(
          { envelope, err: lastErr, dlqDir: config.events.dlqDir },
          'event publish exhausted — written to DLQ'
        )
      } catch (dlqErr) {
        metrics.eventsPublishErrorsTotal.inc({ event: evt, reason: 'dlq_write_failed' })
        logger.error({ envelope, err: lastErr, dlqErr }, 'event publish exhausted — DLQ write failed')
      }
    } finally {
      trackInflight(-1)
    }
  }

  return {
    publish,
    isReady: () => connected,
    close: async () => {
      if (producer) await producer.disconnect()
      connected = false
    }
  }
}
