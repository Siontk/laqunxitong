/**
 * Prometheus 指标。
 *
 * 核心指标（按 § 6 生产指标 + § 11.3 跨阶段必备）：
 *   - 进程：RSS / heap / event_loop_lag
 *   - 账号：state_gauge / accounts_total（按状态切片）
 *   - 重连：reconnect_total / stale_total / reconnect_seconds_histogram
 *   - WA 错误码：disconnect_total{semantic} / wa_error_total{code}
 *   - 风控：restriction_active / new_chat_capping{status}
 *   - 代理：proxy_failed_total / proxy_rotated_total / bytes_sent / bytes_recv
 *   - 事件总线：events_published_total / events_publish_errors_total
 *   - 接口：http_request_duration_seconds / http_requests_total
 *   - SessionStore：creds_store_hits / keys_store_hits / l1_hit_ratio
 */

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

import type { Config } from '../config.js'

export interface Metrics {
  registry: Registry

  // 账号
  accountsByState: Gauge<string>
  accountsTotal: Gauge

  // 重连
  reconnectTotal: Counter<string>
  reconnectDurationSec: Histogram<string>
  staleDetectedTotal: Counter

  // WA 错误
  disconnectTotal: Counter<string>
  waErrorTotal: Counter<string>

  // 风控
  restrictionActive: Gauge<string>
  /**
   * 每次"new chat capping"状态切换的累计计数。
   * label: status = NONE/FIRST_WARNING/SECOND_WARNING/CAPPED
   * PromQL: rate(unsea_message_capping_transition_total{status="CAPPED"}[5m])
   *
   * （旧版 messageCappingStatus 是 Gauge.inc() 误用，单调累计无法 dec，已删除。
   * "当前处于 CAPPED 状态的账号数"由业务侧聚合事件后维护，不放进 Prometheus
   * 避免按 accountId 切片导致 cardinality 爆炸。）
   */
  messageCappingTransitionTotal: Counter<string>

  // 代理
  proxyFailedTotal: Counter
  proxyRotatedTotal: Counter
  /**
   * 代理流量计数，只按 country / tier 聚合。
   * 旧版用 proxy_session（≈ accountId）做 label，50w 账号 = 50w series，
   * Prometheus 单 metric 必炸，已删除。
   * 账号级流量审计走日志 / OLAP，不要 metric。
   */
  proxyBytesSent: Counter<string>
  proxyBytesRecv: Counter<string>

  // 事件
  eventsPublishedTotal: Counter<string>
  eventsPublishErrorsTotal: Counter<string>

  // 接口
  httpDuration: Histogram<string>
  httpRequests: Counter<string>

  // SessionStore
  credsStoreOps: Counter<string>
  keysStoreOps: Counter<string>
  l1HitRatio: Gauge<string>

  // 业务
  pairingTotal: Counter<string>
  groupCreateTotal: Counter<string>
  groupAddParticipantsTotal: Counter<string>

  /**
   * 群操作端到端耗时（从 operationGate.runGroup 进入到 sock 调用完返回）。
   * label: operation = create / add / remove / promote / demote / subject / desc / settings / ...
   *        result = success / partial / error
   * 用于看真实 SLA 和 worker 端 libsignal+网络 RTT 总耗时。
   *
   * 竞品参考：1000 账号 × 100 群 × 100 人 / 18min ≈ 200 ops/s 全网。
   * p95 add 耗时 < 5s 才能达到该吞吐。
   */
  groupOpDurationSec: Histogram<string>

  /**
   * 单 worker 当前并发执行中的群操作数（in-flight）。
   * 用于判断 workerGroupOpPerSec 是否限流过严或过松。
   */
  groupOpInflight: Gauge<string>

  /**
   * online 触发计数（按 result 切片）。
   * label: result = ok / rejected / error / waited
   *        source = api / batch / reconciler / failover
   */
  onlineTotal: Counter<string>

  /**
   * 当前并发执行中的 online 操作（含 Noise 握手期间）。
   * 用来看 libsignal CPU 压力是否堆积。> 50 持续说明 nodeOnlinePerSec 设过高。
   */
  onlineInflight: Gauge<string>

  /**
   * 端到端 online 耗时（从 API 进入到 VERIFYING/ONLINE 状态机翻转）。
   */
  onlineDurationSec: Histogram<string>

  /**
   * Redis 客户端连接 / 命令错误累计。
   * label: instance = default / registry / keys / ratelimit / runtime
   * 用来告警 Redis 抖动 — rate > 1/s 持续 1min 视为 Redis 不稳。
   */
  redisClientErrorTotal: Counter<string>

  /**
   * Kafka producer 当前 inflight 消息数。
   * 用来告警 producer queue 膨胀 — > 1000 持续 1min 视为 Kafka 卡死。
   */
  kafkaProducerInflight: Gauge

  /**
   * 主动捕获的 libsignal / Baileys 异常计数。
   * label: kind = decrypt / encrypt / handshake / unknown
   */
  libsignalErrorTotal: Counter<string>

  /**
   * 进程未捕获异常 / promise rejection 计数（绝大多数应该是 0）。
   * 1 次都不应该出，监控里出现立刻看日志。
   */
  uncaughtErrorTotal: Counter<string>

  // slot 释放（账号被踢出 active set）
  slotReleasedTotal: Counter<string>

  // Reconciler adoption 延迟（最久未 adopt 的账号在 assign hash 里停留了多少秒）
  pendingAdoptionSec: Gauge<string>

  // event loop lag
  eventLoopLagSec: Gauge
}

export function createMetrics(config: Config): Metrics {
  const registry = new Registry()
  registry.setDefaultLabels({
    node: config.nodeId,
    worker: config.workerId,
    role: config.role,
    region: config.region
  })

  collectDefaultMetrics({ register: registry, prefix: 'unsea_' })

  const accountsByState = new Gauge({
    name: 'unsea_accounts_by_state',
    help: 'Accounts grouped by state (ONLINE/OFFLINE/NEED_REAUTH/...)',
    labelNames: ['state'],
    registers: [registry]
  })

  const accountsTotal = new Gauge({
    name: 'unsea_accounts_total',
    help: 'Total accounts owned by this worker',
    registers: [registry]
  })

  const reconnectTotal = new Counter({
    name: 'unsea_reconnect_total',
    help: 'Reconnect attempts',
    labelNames: ['type', 'reason'], // type=A|B|C, reason=planned|stale|515|...
    registers: [registry]
  })

  const reconnectDurationSec = new Histogram({
    name: 'unsea_reconnect_duration_seconds',
    help: 'Time from disconnect to ONLINE',
    labelNames: ['type'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300],
    registers: [registry]
  })

  const staleDetectedTotal = new Counter({
    name: 'unsea_stale_detected_total',
    help: 'STALE half-open ws detected',
    registers: [registry]
  })

  const disconnectTotal = new Counter({
    name: 'unsea_disconnect_total',
    help: 'Disconnect events',
    labelNames: ['semantic', 'code'], // semantic: PROXY_FAILED|RATE_LIMITED|NEED_REAUTH|RECONNECTING
    registers: [registry]
  })

  const waErrorTotal = new Counter({
    name: 'unsea_wa_error_total',
    help: 'WA-side errors received',
    labelNames: ['code'], // 401, 403, 408, 415, 419, 428, 463, 479, 515, ...
    registers: [registry]
  })

  const restrictionActive = new Gauge({
    name: 'unsea_restriction_active',
    help: 'Currently restricted accounts (reachoutTimelock isActive)',
    labelNames: ['enforcement_type'],
    registers: [registry]
  })

  const messageCappingTransitionTotal = new Counter({
    name: 'unsea_message_capping_transition_total',
    help: 'Transitions of new-chat-capping status (counter, not gauge)',
    labelNames: ['status'], // NONE/FIRST_WARNING/SECOND_WARNING/CAPPED
    registers: [registry]
  })

  const proxyFailedTotal = new Counter({
    name: 'unsea_proxy_failed_total',
    help: 'Proxy connection failures',
    registers: [registry]
  })

  const proxyRotatedTotal = new Counter({
    name: 'unsea_proxy_rotated_total',
    help: 'IP rotation events observed',
    registers: [registry]
  })

  // 只按 country / tier 聚合：50w 账号 × proxy_session label 必炸 Prometheus。
  // 账号级流量审计请走日志 + OLAP。
  const proxyBytesSent = new Counter({
    name: 'unsea_proxy_bytes_sent_total',
    help: 'Bytes sent through proxy (aggregated by country & tier, NOT by account/session)',
    labelNames: ['country', 'tier'],
    registers: [registry]
  })

  const proxyBytesRecv = new Counter({
    name: 'unsea_proxy_bytes_recv_total',
    help: 'Bytes received through proxy (aggregated by country & tier, NOT by account/session)',
    labelNames: ['country', 'tier'],
    registers: [registry]
  })

  const eventsPublishedTotal = new Counter({
    name: 'unsea_events_published_total',
    help: 'Events published to Kafka',
    labelNames: ['event'],
    registers: [registry]
  })

  const eventsPublishErrorsTotal = new Counter({
    name: 'unsea_events_publish_errors_total',
    help: 'Failed publish attempts',
    labelNames: ['event', 'reason'],
    registers: [registry]
  })

  const httpDuration = new Histogram({
    name: 'unsea_http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
    registers: [registry]
  })

  const httpRequests = new Counter({
    name: 'unsea_http_requests_total',
    help: 'HTTP requests count',
    labelNames: ['method', 'route', 'status'],
    registers: [registry]
  })

  const credsStoreOps = new Counter({
    name: 'unsea_creds_store_ops_total',
    help: 'CredsStore operations',
    labelNames: ['op', 'layer', 'result'], // op=read|write|delete, layer=L1|L2|L3, result=hit|miss|error
    registers: [registry]
  })

  const keysStoreOps = new Counter({
    name: 'unsea_keys_store_ops_total',
    help: 'KeysStore operations',
    labelNames: ['op', 'layer', 'result'],
    registers: [registry]
  })

  const l1HitRatio = new Gauge({
    name: 'unsea_l1_hit_ratio',
    help: 'L1 cache hit ratio (0-1)',
    labelNames: ['store'], // creds|keys
    registers: [registry]
  })

  const pairingTotal = new Counter({
    name: 'unsea_pairing_total',
    help: 'Pairing flows initiated',
    labelNames: ['method', 'result'], // method=code|qr, result=completed|failed|expired
    registers: [registry]
  })

  const groupCreateTotal = new Counter({
    name: 'unsea_group_create_total',
    help: 'Groups created',
    labelNames: ['result'],
    registers: [registry]
  })

  const groupAddParticipantsTotal = new Counter({
    name: 'unsea_group_add_participants_total',
    help: 'Participants added to groups',
    labelNames: ['result'], // 200/403/408/409/419/500
    registers: [registry]
  })

  const groupOpDurationSec = new Histogram({
    name: 'unsea_group_op_duration_seconds',
    help: 'End-to-end duration of group operations (libsignal + WA RTT)',
    labelNames: ['operation', 'result'],
    buckets: [0.1, 0.3, 0.5, 1, 2, 3, 5, 10, 20, 30, 60, 120],
    registers: [registry]
  })

  const groupOpInflight = new Gauge({
    name: 'unsea_group_op_inflight',
    help: 'In-flight group operations on this worker',
    registers: [registry]
  })

  const onlineTotal = new Counter({
    name: 'unsea_online_total',
    help: 'online() invocations grouped by source and result',
    labelNames: ['source', 'result'],
    registers: [registry]
  })

  const onlineInflight = new Gauge({
    name: 'unsea_online_inflight',
    help: 'In-flight online operations (incl. Noise handshake duration)',
    registers: [registry]
  })

  const onlineDurationSec = new Histogram({
    name: 'unsea_online_duration_seconds',
    help: 'End-to-end online() duration from gate-pass to state transition',
    labelNames: ['source', 'result'],
    buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 3, 5, 10, 30, 60],
    registers: [registry]
  })

  const redisClientErrorTotal = new Counter({
    name: 'unsea_redis_client_error_total',
    help: 'Redis client connection / command errors',
    labelNames: ['instance'],
    registers: [registry]
  })

  const kafkaProducerInflight = new Gauge({
    name: 'unsea_kafka_producer_inflight',
    help: 'Kafka producer in-flight messages (not yet acked by broker)',
    registers: [registry]
  })

  const libsignalErrorTotal = new Counter({
    name: 'unsea_libsignal_error_total',
    help: 'libsignal / Baileys protocol errors caught and not propagated',
    labelNames: ['kind'],
    registers: [registry]
  })

  const uncaughtErrorTotal = new Counter({
    name: 'unsea_uncaught_error_total',
    help: 'Process-level uncaught exceptions / unhandled rejections',
    labelNames: ['kind'],
    registers: [registry]
  })

  const slotReleasedTotal = new Counter({
    name: 'unsea_slot_released_total',
    help: 'Active slot released (account no longer occupies worker capacity)',
    labelNames: ['reason'], // manual / logout / need_reauth / reconnect_exhausted / other
    registers: [registry]
  })

  const pendingAdoptionSec = new Gauge({
    name: 'unsea_pending_adoption_seconds',
    help: 'Max age (seconds) of accounts assigned but not yet adopted by this worker',
    labelNames: ['stage'], // max / count
    registers: [registry]
  })

  const eventLoopLagSec = new Gauge({
    name: 'unsea_event_loop_lag_seconds',
    help: 'Event loop lag in seconds (sampled)',
    registers: [registry]
  })

  // event loop lag 监控（10s 一次）
  let lastSample = Date.now()
  setInterval(() => {
    const now = Date.now()
    const drift = (now - lastSample - 1000) / 1000
    eventLoopLagSec.set(Math.max(0, drift))
    lastSample = now
  }, 1000).unref()

  return {
    registry,
    accountsByState,
    accountsTotal,
    reconnectTotal,
    reconnectDurationSec,
    staleDetectedTotal,
    disconnectTotal,
    waErrorTotal,
    restrictionActive,
    messageCappingTransitionTotal,
    proxyFailedTotal,
    proxyRotatedTotal,
    proxyBytesSent,
    proxyBytesRecv,
    eventsPublishedTotal,
    eventsPublishErrorsTotal,
    httpDuration,
    httpRequests,
    credsStoreOps,
    keysStoreOps,
    l1HitRatio,
    pairingTotal,
    groupCreateTotal,
    groupAddParticipantsTotal,
    groupOpDurationSec,
    groupOpInflight,
    onlineTotal,
    onlineInflight,
    onlineDurationSec,
    redisClientErrorTotal,
    kafkaProducerInflight,
    libsignalErrorTotal,
    uncaughtErrorTotal,
    slotReleasedTotal,
    pendingAdoptionSec,
    eventLoopLagSec
  }
}
