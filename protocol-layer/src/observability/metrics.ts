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
  messageCappingStatus: Gauge<string>

  // 代理
  proxyFailedTotal: Counter
  proxyRotatedTotal: Counter
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

  const messageCappingStatus = new Gauge({
    name: 'unsea_message_capping_status',
    help: 'Accounts by capping status',
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

  const proxyBytesSent = new Counter({
    name: 'unsea_proxy_bytes_sent_total',
    help: 'Bytes sent through proxy',
    labelNames: ['proxy_session', 'country'],
    registers: [registry]
  })

  const proxyBytesRecv = new Counter({
    name: 'unsea_proxy_bytes_recv_total',
    help: 'Bytes received through proxy',
    labelNames: ['proxy_session', 'country'],
    registers: [registry]
  })

  const eventsPublishedTotal = new Counter({
    name: 'unsea_events_published_total',
    help: 'Events published to NATS',
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
    messageCappingStatus,
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
    slotReleasedTotal,
    pendingAdoptionSec,
    eventLoopLagSec
  }
}
