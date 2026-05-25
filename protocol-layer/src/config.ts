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

  // ── NATS ──
  nats: z.object({
    servers: z.string().default('nats://localhost:4222'),
    streamName: z.string().default('UNSEA_EVENTS'),
    eventSubjectPrefix: z.string().default('unsea.v1.events'),
    dlqDir: z.string().default('/tmp/unsea-event-dlq')
  }),

  // ── Redis（L2 keys + Registry + 令牌桶）──
  redis: z.object({
    url: z.string().default('redis://localhost:6379'),
    db: z.coerce.number().default(0),
    keyPrefix: z.string().default('unsea:')
  }),

  // ── Postgres（L3 creds 持久化）──
  postgres: z.object({
    enabled: z.coerce.boolean().default(false),
    connectionString: z.string().default('postgres://unsea:unsea@localhost:5432/unsea')
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
    nats: {
      servers: process.env.NATS_SERVERS,
      streamName: process.env.NATS_STREAM,
      eventSubjectPrefix: process.env.NATS_SUBJECT_PREFIX,
      dlqDir: process.env.NATS_DLQ_DIR
    },
    redis: {
      url: process.env.REDIS_URL,
      db: process.env.REDIS_DB,
      keyPrefix: process.env.REDIS_KEY_PREFIX
    },
    postgres: {
      enabled: process.env.PG_ENABLED,
      connectionString: process.env.PG_CONNECTION_STRING
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
