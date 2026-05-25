/**
 * Kafka 事件发布器。
 *
 * 设计原则：
 *   1. Kafka message key 固定用 accountId，保证同账号事件分区内有序。
 *   2. 事件 envelope 不变，功能层只需要从 Kafka topic 消费。
 *   3. 失败重试 3 次，仍失败写入本地 DLQ 文件并报警。
 */

import { Kafka, logLevel, type Producer, type SASLOptions } from 'kafkajs'
import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Config } from '../config.js'
import type { Metrics } from '../observability/metrics.js'
import type { Logger } from '../observability/logger.js'
import { type EventType, topicKindFor } from './subjects.js'

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
  let producer: Producer | null = null
  let connected = false

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
      messages: [
        {
          key: envelope.accountId,
          value: JSON.stringify(envelope),
          headers: {
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
    const envelope: EventEnvelope = {
      event: evt,
      version: 'v1',
      accountId,
      occurredAt: new Date().toISOString(),
      workerId: config.workerId,
      evidence,
      data: data as Record<string, unknown>
    }

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
