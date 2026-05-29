/**
 * 启动入口（master / worker / standalone 三种角色）。
 *
 * standalone：单进程内 master + worker 一起跑，本地 dev 用
 * worker：仅承载 socket，注册到 Registry，从命令端收任务
 * master：仅做 Registry 仲裁 + failover
 */

import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import Sensible from '@fastify/sensible'
import Swagger from '@fastify/swagger'
import SwaggerUi from '@fastify/swagger-ui'

import { loadConfig, type Config } from './config.js'
import { createLogger, type Logger } from './observability/logger.js'
import { createMetrics, type Metrics } from './observability/metrics.js'
import { registerHealthRoutes } from './observability/health.js'
import { registerErrorHandler } from './error/error-handler.js'
import { createEventPublisher, type EventPublisher } from './events/publisher.js'
import { attachRedisGuards, createRedis, RedisStoreAdapter } from './store/adapters/redis.js'
import { MemoryStoreAdapter } from './store/adapters/memory.js'
import { MySqlStoreAdapter, createMySqlPool } from './store/adapters/mysql.js'
import type { StoreAdapter } from './store/adapters/types.js'
import { CredsStore } from './store/creds-store.js'
import { KeysStore } from './store/keys-store.js'
import { ProxyStore } from './store/proxy-store.js'
import { AccountRuntimeStore, type AccountRuntimeRecord } from './store/account-runtime-store.js'
import {
  AccountBrowserDisplayStore,
  AccountDeviceStore,
  type AccountDeviceProfile,
  type BrowserDisplay
} from './store/account-device-store.js'
import { Registry } from './registry/registry.js'
import { Master } from './registry/master.js'
import { TokenBucketReconnectGate } from './rate-limit/reconnect-limiter.js'
import { OperationGate } from './rate-limit/operation-gate.js'
import { OnlineGate } from './rate-limit/online-limiter.js'
import { AccountManager } from './worker/account-manager.js'
import { StaleDetector } from './worker/stale-detector.js'
import { AssignmentReconciler } from './worker/assignment-reconciler.js'
import { registerAllRoutes } from './routes/index.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger(config)
  const metrics = createMetrics(config)

  logger.info({ role: config.role, nodeId: config.nodeId, workerId: config.workerId }, 'starting protocol-layer')

  // ── 依赖装配 ──
  const redisOpts = {
    commandTimeoutMs: config.redis.commandTimeoutMs,
    maxRetriesPerRequest: config.redis.maxRetriesPerRequest,
    maxOfflineQueueSize: config.redis.maxOfflineQueueSize,
    connectTimeoutMs: config.redis.connectTimeoutMs
  }
  const redis = createRedis(config.redis.url, config.redis.db, redisOpts)
  const registryRedis = config.redis.registryUrl ? createRedis(config.redis.registryUrl, config.redis.db, redisOpts) : redis
  const keysRedis = config.redis.keysUrl ? createRedis(config.redis.keysUrl, config.redis.db, redisOpts) : redis
  const rateLimitRedis = config.redis.rateLimitUrl ? createRedis(config.redis.rateLimitUrl, config.redis.db, redisOpts) : redis
  const runtimeRedis = config.redis.runtimeUrl ? createRedis(config.redis.runtimeUrl, config.redis.db, redisOpts) : redis

  // Redis 客户端错误监控（任一实例 error 都打 warn + 计 metric）
  const redisErrorHandler = (err: Error, name: string): void => {
    logger.warn({ err: err.message, instance: name }, 'redis client error')
    metrics.redisClientErrorTotal.inc({ instance: name })
  }
  attachRedisGuards(redis, 'default', config.redis.maxOfflineQueueSize, redisErrorHandler)
  if (registryRedis !== redis) attachRedisGuards(registryRedis, 'registry', config.redis.maxOfflineQueueSize, redisErrorHandler)
  if (keysRedis !== redis) attachRedisGuards(keysRedis, 'keys', config.redis.maxOfflineQueueSize, redisErrorHandler)
  if (rateLimitRedis !== redis) attachRedisGuards(rateLimitRedis, 'ratelimit', config.redis.maxOfflineQueueSize, redisErrorHandler)
  if (runtimeRedis !== redis) attachRedisGuards(runtimeRedis, 'runtime', config.redis.maxOfflineQueueSize, redisErrorHandler)
  await Promise.all([
    redis.ping(),
    registryRedis.ping(),
    keysRedis.ping(),
    rateLimitRedis.ping(),
    runtimeRedis.ping()
  ])
  logger.info(
    {
      registryDedicated: registryRedis !== redis,
      keysDedicated: keysRedis !== redis,
      rateLimitDedicated: rateLimitRedis !== redis,
      runtimeDedicated: runtimeRedis !== redis
    },
    'redis connected'
  )

  const registry = new Registry(registryRedis, logger, config.redis.keyPrefix)

  const publisher = await createEventPublisher(config, metrics, logger)

  // L1（配置化：4C8G × 4 worker 默认 50k creds + 200k keys，每 worker ~ 250MB L1 内存预算）
  const credsL1 = new MemoryStoreAdapter<Record<string, unknown>>(config.worker.credsL1Size)
  const keysL1 = new MemoryStoreAdapter<Record<string, unknown>>(config.worker.keysL1Size)
  // L2
  const credsL2 = new RedisStoreAdapter<Record<string, unknown>>(redis, config.redis.keyPrefix)
  const keysL2 = new RedisStoreAdapter<Record<string, unknown>>(keysRedis, config.redis.keyPrefix)
  // L3
  let credsL3: StoreAdapter<Record<string, unknown>> | undefined
  if (config.mysql.enabled) {
    const mysqlPool = createMySqlPool(config.mysql.connectionUri, {
      connectionLimit: config.mysql.connectionLimit,
      maxIdle: config.mysql.maxIdle,
      idleTimeoutMs: config.mysql.idleTimeoutMs,
      connectTimeoutMs: config.mysql.connectTimeoutMs
    })
    const mysqlStore = new MySqlStoreAdapter<Record<string, unknown>>(mysqlPool, 'creds_store')
    await mysqlStore.ensureSchema()
    credsL3 = mysqlStore
    logger.info(
      {
        connectionLimit: config.mysql.connectionLimit,
        maxIdle: config.mysql.maxIdle
      },
      'mysql L3 connected'
    )
  }

  const credsStore = new CredsStore({ l1: credsL1, l2: credsL2, l3: credsL3, metrics, logger })
  const keysStore = new KeysStore({ l1: keysL1, l2: keysL2, metrics, logger })
  const proxyStore = new ProxyStore({
    l2: new RedisStoreAdapter(runtimeRedis, config.redis.keyPrefix),
    logger
  })
  const runtimeStore = new AccountRuntimeStore(
    new RedisStoreAdapter<AccountRuntimeRecord>(runtimeRedis, config.redis.keyPrefix),
    logger
  )
  const deviceStore = new AccountDeviceStore(
    new RedisStoreAdapter<AccountDeviceProfile>(runtimeRedis, config.redis.keyPrefix),
    logger
  )
  const browserDisplayStore = new AccountBrowserDisplayStore(
    new RedisStoreAdapter<BrowserDisplay>(runtimeRedis, config.redis.keyPrefix),
    logger
  )

  const gate = new TokenBucketReconnectGate(config, rateLimitRedis, logger)
  const operationGate = new OperationGate({ redis: rateLimitRedis, config, logger, metrics, publisher })
  const onlineGate = new OnlineGate(config, rateLimitRedis, logger)
  const accounts = new AccountManager({
    config,
    logger,
    metrics,
    publisher,
    credsStore,
    keysStore,
    runtimeStore,
    registry,
    gate
  })

  // ── 角色分支 ──
  let master: Master | null = null
  let staleDetector: StaleDetector | null = null
  let assignmentReconciler: AssignmentReconciler | null = null

  if (config.role === 'master' || config.role === 'standalone') {
    master = new Master({ registry, redis: registryRedis, publisher, logger, metrics, config: { nodeId: config.nodeId } })
    await master.start()
  }

  if (config.role === 'worker' || config.role === 'standalone') {
    // 注册自身
    await registry.registerWorker({
      workerId: config.workerId,
      nodeId: config.nodeId,
      region: config.region,
      capacity: config.worker.maxAccountsPerWorker,
      currentLoad: 0,
      endpoint: config.http.publicEndpoint ?? `http://${config.http.host}:${config.http.port}`,
      registeredAt: Date.now()
    })
    // 心跳（温和覆盖：load 只增不减，由 releaseSlot 主动 -1 驱动下降）
    setInterval(() => {
      registry.heartbeat(config.workerId, accounts.activeSize()).catch(err =>
        logger.warn({ err }, 'heartbeat failed')
      )
    }, config.worker.heartbeatIntervalMs).unref()

    // 启动 90s 后做一次硬同步（force=true），确保 reconciler 完成首轮 adopt
    // 后 Registry load 精确反映本 worker 真实 activeSize，纠正可能的累计漂移
    setTimeout(() => {
      registry
        .heartbeat(config.workerId, accounts.activeSize(), { force: true })
        .then(() => logger.info({ activeSize: accounts.activeSize() }, 'force load sync done'))
        .catch(err => logger.warn({ err }, 'force load sync failed'))
    }, 90_000).unref()

    // 每小时做一次硬同步（生产环境用于纠正长期累计漂移）
    setInterval(() => {
      registry
        .heartbeat(config.workerId, accounts.activeSize(), { force: true })
        .catch(err => logger.warn({ err }, 'periodic force load sync failed'))
    }, 60 * 60_000).unref()

    if (config.worker.heartbeatEventEnabled) {
      setInterval(() => {
        const reportedAt = new Date().toISOString()
        for (const accountId of accounts.listAccounts()) {
          publisher.publish('account.heartbeat', accountId, {
            accountId,
            state: accounts.getState(accountId),
            activeSize: accounts.activeSize(),
            workerId: config.workerId,
            reportedAt
          }, accounts.getEvidence(accountId)).catch(err =>
            logger.warn({ err, accountId }, 'account heartbeat event publish failed')
          )
        }
      }, config.worker.heartbeatEventIntervalMs).unref()
      logger.info(
        { intervalMs: config.worker.heartbeatEventIntervalMs },
        'account heartbeat Kafka events enabled'
      )
    }

    // STALE 兜底
    staleDetector = new StaleDetector(
      accounts,
      config.worker.staleCheckIntervalMs,
      config.worker.staleThresholdMs,
      logger,
      metrics
    )
    staleDetector.start()

    assignmentReconciler = new AssignmentReconciler({
      workerId: config.workerId,
      registry,
      accounts,
      proxyStore,
      credsStore,
      runtimeStore,
      logger,
      metrics,
      intervalMs: config.worker.heartbeatIntervalMs,
      maxAccounts: config.worker.maxAccountsPerWorker,
      adoptBatchSize: config.rateLimit.coldStartBatchSize,
      adoptIntervalMs: Math.min(
        500,
        Math.max(50, Math.floor(config.rateLimit.coldStartIntervalMs / Math.max(1, config.rateLimit.coldStartBatchSize)))
      )
    })
    assignmentReconciler.start()
  }

  // ── Fastify ──
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: config.http.bodyLimitBytes,
    requestIdLogLabel: 'reqId'
  }) as unknown as FastifyInstance
  await app.register(Sensible)
  await app.register(Swagger, {
    mode: 'static',
    specification: { path: config.http.openapiSpecPath, baseDir: process.cwd() }
  })
  await app.register(SwaggerUi, { routePrefix: '/docs' })

  // 进程级 shutdown 标志 — uncaughtException 触发后，readyz 立即返 false
  // 让前置 LB 在 graceful window 期间停止分流量
  let isShuttingDown = false

  registerErrorHandler(app, logger)
  registerHealthRoutes(app, {
    logger,
    isReady: async () => {
      if (isShuttingDown) return false
      const r = await redis.ping().then(() => true).catch(() => false)
      const rr = await registryRedis.ping().then(() => true).catch(() => false)
      const kr = await keysRedis.ping().then(() => true).catch(() => false)
      const lr = await rateLimitRedis.ping().then(() => true).catch(() => false)
      const tr = await runtimeRedis.ping().then(() => true).catch(() => false)
      return r && rr && kr && lr && tr && publisher.isReady()
    },
    isLive: async () => !isShuttingDown
  })

  // Prometheus
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', metrics.registry.contentType)
    return metrics.registry.metrics()
  })

  // HTTP 指标
  app.addHook('onResponse', (req, reply, done) => {
    const route = (req.routeOptions?.url ?? req.url) ?? 'unknown'
    metrics.httpDuration.observe(
      { method: req.method, route, status: String(reply.statusCode) },
      reply.elapsedTime / 1000
    )
    metrics.httpRequests.inc({ method: req.method, route, status: String(reply.statusCode) })
    done()
  })

  // 业务路由
  await registerAllRoutes(app, {
    config,
    logger,
    metrics,
    publisher,
    operationGate,
    reconnectGate: gate,
    onlineGate,
    accounts,
    registry,
    credsStore,
    keysStore,
    proxyStore,
    runtimeStore,
    deviceStore,
    browserDisplayStore
  })

  await app.listen({ host: config.http.host, port: config.http.port })
  logger.info({ port: config.http.port }, 'protocol-layer ready')

  // ── 优雅退出 ──
  const shutdown = async (sig: string): Promise<void> => {
    logger.warn({ sig }, 'shutdown initiated')
    try {
      staleDetector?.stop()
      assignmentReconciler?.stop()
      if (master) await master.stop()
      // 注销 worker
      if (config.role === 'worker' || config.role === 'standalone') {
        await registry.unregisterWorker(config.workerId).catch(() => {})
      }
      await app.close()
      await publisher.close()
      if (credsL3?.close) await credsL3.close().catch(() => {})
      const clients = new Set([redis, registryRedis, keysRedis, rateLimitRedis, runtimeRedis])
      await Promise.all(
        [...clients].map(client => ('quit' in client ? (client as { quit: () => Promise<unknown> }).quit().catch(() => {}) : Promise.resolve()))
      )
    } catch (err) {
      logger.error({ err }, 'shutdown error')
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  /**
   * uncaughtException 处理策略（单点环境优化）：
   *
   * 默认 Node 行为：进程立刻 exit。在 PM2 / k8s 拉起前会丢失 in-flight 状态。
   *
   * 我们的策略：
   *   1. 记录到日志 + metric（不掩盖错误，便于排查）
   *   2. 给定一个 graceful window（默认 10s），让 in-flight 请求处理完
   *   3. 期间所有 /readyz 返回 503，前置 LB 不再分流量
   *   4. window 结束后再调 shutdown（注销 worker、关 publisher、quit Redis）
   *   5. 最后 exit(1) 让 PM2 / k8s 重启
   *
   * 注：极少数 fatal 错误（如 V8 内部 panic）会绕过这套，直接 exit。那种就靠 PM2 兜底。
   */
  let inUncaughtRecovery = false
  const fatalRecover = async (kind: 'uncaught' | 'unhandled', err: unknown): Promise<void> => {
    metrics.uncaughtErrorTotal.inc({ kind })
    if (inUncaughtRecovery) {
      logger.fatal({ err, kind }, 'second fatal during recovery — exit immediately')
      process.exit(1)
    }
    inUncaughtRecovery = true
    logger.fatal({ err, kind }, 'fatal error — entering graceful drain (10s)')
    // 标记 not ready：前置 LB 不再分新流量
    isShuttingDown = true
    setTimeout(() => {
      shutdown(`fatal:${kind}`)
        .catch(shutdownErr => {
          logger.error({ shutdownErr }, 'shutdown during fatal failed')
          process.exit(1)
        })
    }, 10_000).unref()
  }
  process.on('uncaughtException', err => {
    fatalRecover('uncaught', err).catch(() => process.exit(1))
  })
  process.on('unhandledRejection', err => {
    // unhandled rejection 不立即 fatal — 只记日志 + metric
    // （Node 22+ 默认会 crash，但我们要让进程在 PM2 拉起前 graceful 一下）
    metrics.uncaughtErrorTotal.inc({ kind: 'unhandled' })
    logger.error({ err }, 'unhandledRejection (logged, not fatal)')
  })
}

main().catch(err => {
  console.error('bootstrap failed:', err)
  process.exit(1)
})

export type { Config, Logger, Metrics, EventPublisher }
