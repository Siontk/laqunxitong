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
    topicDlq: z.string().default('protocol.dlq.v1')
  }),

  // ── Redis（L2 keys + Registry + 令牌桶）──
  redis: z.object({
    url: z.string().default('redis://localhost:6379'),
    db: z.coerce.number().default(0),
    keyPrefix: z.string().default('unsea:')
  }),

  // ── MySQL（L3 creds 持久化）──
  mysql: z.object({
    enabled: z.coerce.boolean().default(false),
    connectionUri: z.string().default('mysql://unsea:unsea@localhost:3306/unsea')
  }),

  // ── Worker 容量 ──
  worker: z.object({
    maxAccountsPerWorker: z.coerce.number().default(400),
    keepAliveIntervalMs: z.coerce.number().default(30_000),
    staleCheckIntervalMs: z.coerce.number().default(5_000),
    staleThresholdMs: z.coerce.number().default(35_000),
    maxOldSpaceMB: z.coerce.number().default(1280),
    heartbeatIntervalMs: z.coerce.number().default(30_000)
  }),

  // ── 重连风暴控制 ──
  rateLimit: z.object({
    nodeReconnectPerSec: z.coerce.number().default(10),
    globalReconnectPerSec: z.coerce.number().default(50),
    sessionIdJitterMaxSec: z.coerce.number().default(900),
    coldStartBatchSize: z.coerce.number().default(50),
    coldStartIntervalMs: z.coerce.number().default(30_000)
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
    pretty: z.coerce.boolean().default(false)
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
      topicDlq: process.env.KAFKA_TOPIC_DLQ
    },
    redis: {
      url: process.env.REDIS_URL,
      db: process.env.REDIS_DB,
      keyPrefix: process.env.REDIS_KEY_PREFIX
    },
    mysql: {
      enabled: process.env.MYSQL_ENABLED,
      connectionUri: process.env.MYSQL_CONNECTION_URI
    },
    worker: {
      maxAccountsPerWorker: process.env.MAX_ACCOUNTS_PER_WORKER,
      keepAliveIntervalMs: process.env.KEEPALIVE_INTERVAL_MS,
      staleCheckIntervalMs: process.env.STALE_CHECK_INTERVAL_MS,
      staleThresholdMs: process.env.STALE_THRESHOLD_MS,
      maxOldSpaceMB: process.env.MAX_OLD_SPACE_MB,
      heartbeatIntervalMs: process.env.HEARTBEAT_INTERVAL_MS
    },
    rateLimit: {
      nodeReconnectPerSec: process.env.NODE_RECONNECT_PER_SEC,
      globalReconnectPerSec: process.env.GLOBAL_RECONNECT_PER_SEC,
      sessionIdJitterMaxSec: process.env.SESSION_JITTER_MAX_SEC,
      coldStartBatchSize: process.env.COLD_START_BATCH_SIZE,
      coldStartIntervalMs: process.env.COLD_START_INTERVAL_MS
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
      pretty: process.env.LOG_PRETTY
    },
    env: process.env.NODE_ENV as 'dev' | 'staging' | 'prod' | undefined
  })
}
