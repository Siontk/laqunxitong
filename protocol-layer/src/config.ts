/**
 * 配置加载与 schema。
 * 所有运行时参数从环境变量读，带默认值。
 */

import { z } from 'zod'

export const WORKER_ROLES = ['master', 'worker', 'standalone'] as const
export type WorkerRole = (typeof WORKER_ROLES)[number]

const ConfigSchema = z.object({
  // ── 节点身份 ──
  nodeId: z.string().min(1),
  workerId: z.string().min(1),
  role: z.enum(WORKER_ROLES).default('standalone'),
  region: z.string().default('cn-east-1'),

  // ── HTTP ──
  http: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.coerce.number().default(8080),
    publicEndpoint: z.string().optional(),
    bodyLimitBytes: z.coerce.number().default(50 * 1024 * 1024), // 50 MB（支持 baileys-json 大 payload）
    apiKeys: z.string().default(''),
    /** OpenAPI spec 文件路径，Swagger UI 用。相对 process.cwd()。
     *  dev: ../openapi/protocol-v1.yaml
     *  docker: /opt/openapi/protocol-v1.yaml
     */
    openapiSpecPath: z.string().default('../openapi/protocol-v1.yaml')
  }),

  // ── 事件总线（生产默认 Kafka / AWS MSK）──
  events: z.object({
    backend: z.enum(['kafka']).default('kafka'),
    dlqDir: z.string().default('/tmp/unsea-event-dlq')
  }),

  // ── Kafka / AWS MSK ──
  kafka: z.object({
    brokers: z.string().default('localhost:9092'),
    clientId: z.string().default('protocol-layer'),
    ssl: z.coerce.boolean().default(false),
    username: z.string().optional(),
    password: z.string().optional(),
    saslMechanism: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']).default('scram-sha-512'),
    topicAccount: z.string().default('protocol.account.events.v1'),
    topicOwner: z.string().default('protocol.owner.events.v1'),
    topicMessage: z.string().default('protocol.message.events.v1'),
    topicGroup: z.string().default('protocol.group.events.v1'),
    topicPairing: z.string().default('protocol.pairing.events.v1'),
    topicDlq: z.string().default('protocol.dlq.v1'),
    /** producer 未 ack 消息上限。超过 → 直接写本地 DLQ，防 Kafka 挂时 Node OOM。
     *  正常稳态 inflight ≈ 10-50。单 broker 偶发抖动可能瞬时到 200-500。
     *  上限 2000 给安全余量，超 2000 大概率是 broker 挂死。 */
    maxInflightMessages: z.coerce.number().default(2000)
  }),

  // ── Redis（L2 keys + Registry + 令牌桶）──
  //
  // 客户端容错参数：
  //   - commandTimeoutMs=5s    Redis 慢命令 fail-fast，不让 Node 永远等
  //   - maxRetriesPerRequest=3 失败重试 3 次后 reject 命令，业务路径自降级
  //   - maxOfflineQueueSize    Redis 挂时本地堆积命令上限，防 OOM
  //   - connectTimeoutMs=5s    连接握手超时
  redis: z.object({
    url: z.string().default('redis://localhost:6379'),
    registryUrl: z.string().optional(),
    keysUrl: z.string().optional(),
    rateLimitUrl: z.string().optional(),
    runtimeUrl: z.string().optional(),
    db: z.coerce.number().default(0),
    keyPrefix: z.string().default('unsea:'),
    commandTimeoutMs: z.coerce.number().default(5_000),
    maxRetriesPerRequest: z.coerce.number().default(3),
    maxOfflineQueueSize: z.coerce.number().default(1000),
    connectTimeoutMs: z.coerce.number().default(5_000)
  }),

  // ── MySQL（L3 creds 持久化）──
  //
  // 每 worker 一个独立连接池。4 worker × 8 = 32 connections 到 MySQL，
  // MySQL 默认 max_connections=151 一台 8C 实例够 4-5 节点共享。
  // 2000 同时上线产生 ~2000 个异步 INSERT，每 connection 处理 60+ INSERT，
  // 每个 ~ 5ms → 总耗时 ~ 300ms 写满。MySQL 是异步 L3 不阻塞业务。
  mysql: z.object({
    enabled: z.coerce.boolean().default(false),
    connectionUri: z.string().default('mysql://unsea:unsea@localhost:3306/unsea'),
    connectionLimit: z.coerce.number().default(8),
    maxIdle: z.coerce.number().default(4),
    idleTimeoutMs: z.coerce.number().default(30_000),
    connectTimeoutMs: z.coerce.number().default(5_000),
    /** 慢写阈值（ms），超过记 warn 日志，方便排查 L3 抖动 */
    slowWriteMs: z.coerce.number().default(500)
  }),

  // ── Worker 容量 ──
  //
  // 目标：4C8G 单节点 4 worker × 500 账号 = 2000 在线。
  // 关键约束：Node 单线程，每 worker 必须独立进程，max-old-space-size ≈ 1.5GB。
  worker: z.object({
    maxAccountsPerWorker: z.coerce.number().default(500),
    keepAliveIntervalMs: z.coerce.number().default(20_000),
    keepAliveJitterMinMs: z.coerce.number().default(15_000),
    keepAliveJitterMaxMs: z.coerce.number().default(20_000),
    staleCheckIntervalMs: z.coerce.number().default(5_000),
    staleThresholdMs: z.coerce.number().default(35_000),
    maxOldSpaceMB: z.coerce.number().default(1536),
    heartbeatIntervalMs: z.coerce.number().default(30_000),
    heartbeatEventEnabled: z.coerce.boolean().default(false),
    heartbeatEventIntervalMs: z.coerce.number().default(300_000),
    /** L1 keys 缓存大小。每条 ~ 1KB，4 worker × 200k = 800MB 内存预算。
     *  生产经验：命中率 80% 已足够，再大边际收益递减。 */
    keysL1Size: z.coerce.number().default(200_000),
    /** L1 creds 缓存大小。creds 比 keys 少很多，每 worker 留 50k 即可。 */
    credsL1Size: z.coerce.number().default(50_000)
  }),

  // ── 重连风暴控制 + 业务节流 ──
  //
  // 默认值是按"4C8G × 2000 账号"调好的。集群更大时直接设环境变量调高。
  //
  // 业务负载估算（参考竞品 1000 账号 × 100 群 × 100 人 / 15-20min = ~200 ops/s）：
  //   - 单 worker 500 账号稳态拉群强度 ≈ 100 ops/s
  //   - 4 worker × 100/s = 400 ops/s 节点上限，留 2 倍 burst
  rateLimit: z.object({
    /** 单节点全部 worker 加起来的重连预算 */
    nodeReconnectPerSec: z.coerce.number().default(20),
    /** 集群级重连预算（多节点协调），生产配置实际节点数 × nodeReconnectPerSec */
    globalReconnectPerSec: z.coerce.number().default(100),
    accountReconnectCooldownMs: z.coerce.number().default(60_000),
    reconnectBurst: z.coerce.number().default(40),
    /** 单 worker 群操作 token 桶填充率（10 → 100）。
     *  竞品级强度需要 ~100 ops/s/worker；调低就会限流业务 */
    workerGroupOpPerSec: z.coerce.number().default(100),
    workerGroupOpBurst: z.coerce.number().default(200),
    /** per-account 群操作锁 TTL。100 人加群可能花 30-60s，给到 90s 安全 */
    groupAccountLockTtlMs: z.coerce.number().default(90_000),
    groupAccountBusyRetryMs: z.coerce.number().default(3_000),
    workerGroupBusyRetryMs: z.coerce.number().default(2_000),
    sessionIdJitterMaxSec: z.coerce.number().default(900),
    /** 冷启动 batch 大小（每 worker）。4 worker × 25 / 15s = 6.7 acc/s 单节点上线，
     *  2000 账号大约 5 分钟全部到 ONLINE。 */
    coldStartBatchSize: z.coerce.number().default(25),
    coldStartIntervalMs: z.coerce.number().default(15_000),
    /** 单节点 /online 路由上线节奏（含批量接口）。
     *  50/s × 单节点 → 2000 账号 40s 通过限流闸门；
     *  配合 Baileys Noise 握手异步并行，端到端 ~ 60-90s 全部 ONLINE，
     *  对齐竞品 2 分钟 2000 上线 baseline。
     *  调低会让限流更紧（更慢但 CPU 更稳）；调高超过 100/s 单 4C8G 节点会卡 event loop。 */
    nodeOnlinePerSec: z.coerce.number().default(50),
    nodeOnlineBurst: z.coerce.number().default(100),
    /** 集群级上线预算（多节点协调）。生产配置实际节点数 × nodeOnlinePerSec */
    globalOnlinePerSec: z.coerce.number().default(200),
    /** 单账号 online 后冷却（防业务侧反复 /online 同一个号） */
    accountOnlineCooldownMs: z.coerce.number().default(5_000),
    /** 批量上线接口单次最大账号数 */
    batchOnlineMaxSize: z.coerce.number().default(500),
    /** 批量上线单账号 token 等待超时（超时则该账号返回 429，调用方下次重试） */
    batchOnlineWaitMs: z.coerce.number().default(60_000)
  }),

  // ── Baileys 配置 ──
  baileys: z.object({
    syncFullHistory: z.coerce.boolean().default(false),
    fireInitQueries: z.coerce.boolean().default(false),
    markOnlineOnConnect: z.coerce.boolean().default(false),
    emitOwnEvents: z.coerce.boolean().default(false),
    connectTimeoutMs: z.coerce.number().default(30_000),
    defaultQueryTimeoutMs: z.coerce.number().default(60_000),
    browserName: z.string().default('Chrome'),
    browserOS: z.enum(['macOS', 'windows', 'ubuntu']).default('macOS'),
    defaultPairingCode: z.string().regex(/^[A-Za-z0-9]{8}$/).optional()
  }),

  // ── 媒体缓存（按需下载策略）──
  media: z.object({
    storageBackend: z.enum(['none', 's3', 'local']).default('none'),
    cacheTTLSeconds: z.coerce.number().default(86_400),
    defaultDownloadPolicy: z.enum(['never', 'on_demand', 'auto']).default('on_demand')
  }),

  // ── 日志 ──
  log: z.object({
    level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    pretty: z.coerce.boolean().default(false),
    auditSuccessEnabled: z.coerce.boolean().default(true),
    auditSampleRate: z.coerce.number().min(0).max(1).default(1),
    slowOperationMs: z.coerce.number().default(3_000)
  }),

  // ── 环境 ──
  env: z.enum(['dev', 'staging', 'prod']).default('dev')
})

export type Config = z.infer<typeof ConfigSchema>

function nanoId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function loadConfig(): Config {
  return ConfigSchema.parse({
    nodeId: process.env.NODE_ID ?? `node-${nanoId()}`,
    workerId: process.env.WORKER_ID ?? `worker-${nanoId()}`,
    role: process.env.WORKER_ROLE,
    region: process.env.REGION,
    http: {
      host: process.env.HTTP_HOST,
      port: process.env.HTTP_PORT,
      publicEndpoint: process.env.PUBLIC_ENDPOINT,
      bodyLimitBytes: process.env.HTTP_BODY_LIMIT,
      apiKeys: process.env.API_KEYS,
      openapiSpecPath: process.env.OPENAPI_SPEC_PATH
    },
    events: {
      backend: process.env.EVENT_BACKEND as 'kafka' | undefined,
      dlqDir: process.env.EVENT_DLQ_DIR
    },
    kafka: {
      brokers: process.env.KAFKA_BROKERS,
      clientId: process.env.KAFKA_CLIENT_ID,
      ssl: process.env.KAFKA_SSL,
      username: process.env.KAFKA_USERNAME,
      password: process.env.KAFKA_PASSWORD,
      saslMechanism: process.env.KAFKA_SASL_MECHANISM as 'plain' | 'scram-sha-256' | 'scram-sha-512' | undefined,
      topicAccount: process.env.KAFKA_TOPIC_ACCOUNT,
      topicOwner: process.env.KAFKA_TOPIC_OWNER,
      topicMessage: process.env.KAFKA_TOPIC_MESSAGE,
      topicGroup: process.env.KAFKA_TOPIC_GROUP,
      topicPairing: process.env.KAFKA_TOPIC_PAIRING,
      topicDlq: process.env.KAFKA_TOPIC_DLQ,
      maxInflightMessages: process.env.KAFKA_MAX_INFLIGHT_MESSAGES
    },
    redis: {
      url: process.env.REDIS_URL,
      registryUrl: process.env.REGISTRY_REDIS_URL,
      keysUrl: process.env.KEYS_REDIS_URL,
      rateLimitUrl: process.env.RATELIMIT_REDIS_URL,
      runtimeUrl: process.env.RUNTIME_REDIS_URL,
      db: process.env.REDIS_DB,
      keyPrefix: process.env.REDIS_KEY_PREFIX,
      commandTimeoutMs: process.env.REDIS_COMMAND_TIMEOUT_MS,
      maxRetriesPerRequest: process.env.REDIS_MAX_RETRIES_PER_REQUEST,
      maxOfflineQueueSize: process.env.REDIS_MAX_OFFLINE_QUEUE_SIZE,
      connectTimeoutMs: process.env.REDIS_CONNECT_TIMEOUT_MS
    },
    mysql: {
      enabled: process.env.MYSQL_ENABLED,
      connectionUri: process.env.MYSQL_CONNECTION_URI,
      connectionLimit: process.env.MYSQL_CONNECTION_LIMIT,
      maxIdle: process.env.MYSQL_MAX_IDLE,
      idleTimeoutMs: process.env.MYSQL_IDLE_TIMEOUT_MS,
      connectTimeoutMs: process.env.MYSQL_CONNECT_TIMEOUT_MS,
      slowWriteMs: process.env.MYSQL_SLOW_WRITE_MS
    },
    worker: {
      maxAccountsPerWorker: process.env.MAX_ACCOUNTS_PER_WORKER,
      keepAliveIntervalMs: process.env.KEEPALIVE_INTERVAL_MS,
      keepAliveJitterMinMs: process.env.KEEPALIVE_JITTER_MIN_MS,
      keepAliveJitterMaxMs: process.env.KEEPALIVE_JITTER_MAX_MS,
      staleCheckIntervalMs: process.env.STALE_CHECK_INTERVAL_MS,
      staleThresholdMs: process.env.STALE_THRESHOLD_MS,
      maxOldSpaceMB: process.env.MAX_OLD_SPACE_MB,
      heartbeatIntervalMs: process.env.HEARTBEAT_INTERVAL_MS,
      heartbeatEventEnabled: process.env.HEARTBEAT_EVENT_ENABLED,
      heartbeatEventIntervalMs: process.env.HEARTBEAT_EVENT_INTERVAL_MS,
      keysL1Size: process.env.KEYS_L1_SIZE,
      credsL1Size: process.env.CREDS_L1_SIZE
    },
    rateLimit: {
      nodeReconnectPerSec: process.env.NODE_RECONNECT_PER_SEC,
      globalReconnectPerSec: process.env.GLOBAL_RECONNECT_PER_SEC,
      accountReconnectCooldownMs: process.env.ACCOUNT_RECONNECT_COOLDOWN_MS,
      reconnectBurst: process.env.RECONNECT_BURST,
      workerGroupOpPerSec: process.env.WORKER_GROUP_OP_PER_SEC,
      workerGroupOpBurst: process.env.WORKER_GROUP_OP_BURST,
      groupAccountLockTtlMs: process.env.GROUP_ACCOUNT_LOCK_TTL_MS,
      groupAccountBusyRetryMs: process.env.GROUP_ACCOUNT_BUSY_RETRY_MS,
      workerGroupBusyRetryMs: process.env.WORKER_GROUP_BUSY_RETRY_MS,
      sessionIdJitterMaxSec: process.env.SESSION_JITTER_MAX_SEC,
      coldStartBatchSize: process.env.COLD_START_BATCH_SIZE,
      coldStartIntervalMs: process.env.COLD_START_INTERVAL_MS,
      nodeOnlinePerSec: process.env.NODE_ONLINE_PER_SEC,
      nodeOnlineBurst: process.env.NODE_ONLINE_BURST,
      globalOnlinePerSec: process.env.GLOBAL_ONLINE_PER_SEC,
      accountOnlineCooldownMs: process.env.ACCOUNT_ONLINE_COOLDOWN_MS,
      batchOnlineMaxSize: process.env.BATCH_ONLINE_MAX_SIZE,
      batchOnlineWaitMs: process.env.BATCH_ONLINE_WAIT_MS
    },
    baileys: {
      syncFullHistory: process.env.BAILEYS_SYNC_HISTORY,
      fireInitQueries: process.env.BAILEYS_INIT_QUERIES,
      markOnlineOnConnect: process.env.BAILEYS_MARK_ONLINE,
      emitOwnEvents: process.env.BAILEYS_EMIT_OWN_EVENTS,
      connectTimeoutMs: process.env.BAILEYS_CONNECT_TIMEOUT,
      defaultQueryTimeoutMs: process.env.BAILEYS_QUERY_TIMEOUT,
      browserName: process.env.BAILEYS_BROWSER_NAME,
      browserOS: process.env.BAILEYS_BROWSER_OS as 'macOS' | 'windows' | 'ubuntu' | undefined,
      defaultPairingCode: process.env.PAIRING_DEFAULT_CODE
    },
    media: {
      storageBackend: process.env.MEDIA_BACKEND as 'none' | 's3' | 'local' | undefined,
      cacheTTLSeconds: process.env.MEDIA_CACHE_TTL,
      defaultDownloadPolicy: process.env.MEDIA_DOWNLOAD_POLICY as
        | 'never'
        | 'on_demand'
        | 'auto'
        | undefined
    },
    log: {
      level: process.env.LOG_LEVEL as
        | 'fatal'
        | 'error'
        | 'warn'
        | 'info'
        | 'debug'
        | 'trace'
        | undefined,
      pretty: process.env.LOG_PRETTY,
      auditSuccessEnabled: process.env.AUDIT_LOG_SUCCESS_ENABLED,
      auditSampleRate: process.env.AUDIT_LOG_SAMPLE_RATE,
      slowOperationMs: process.env.SLOW_OPERATION_MS
    },
    env: process.env.NODE_ENV as 'dev' | 'staging' | 'prod' | undefined
  })
}
