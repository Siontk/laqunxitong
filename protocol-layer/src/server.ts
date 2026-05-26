/**
 * 启动入口（master / worker / standalone 三种角色）。
 *
 * standalone：单进程内 master + worker 一起跑，本地 dev 用
 * worker：仅承载 socket，注册到 Registry，从命令端收任务
 * master：仅做 Registry 仲裁 + failover
 */

import Fastify from 'fastify'
import Sensible from '@fastify/sensible'
import Swagger from '@fastify/swagger'
import SwaggerUi from '@fastify/swagger-ui'

import { loadConfig, type Config } from './config.js'
import { createLogger, type Logger } from './observability/logger.js'
import { createMetrics, type Metrics } from './observability/metrics.js'
import { registerHealthRoutes } from './observability/health.js'
import { registerErrorHandler } from './error/error-handler.js'
import { createEventPublisher, type EventPublisher } from './events/publisher.js'
import { createRedis, RedisStoreAdapter } from './store/adapters/redis.js'
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
  const redis = createRedis(config.redis.url, config.redis.db)
  await redis.ping()
  logger.info('redis connected')

  const registry = new Registry(redis, logger, config.redis.keyPrefix)

  const publisher = await createEventPublisher(config, metrics, logger)

  // L1
  const credsL1 = new MemoryStoreAdapter<Record<string, unknown>>(50_000)
  const keysL1 = new MemoryStoreAdapter<Record<string, unknown>>(500_000)
  // L2
  const credsL2 = new RedisStoreAdapter<Record<string, unknown>>(redis, config.redis.keyPrefix)
  const keysL2 = new RedisStoreAdapter<Record<string, unknown>>(redis, config.redis.keyPrefix)
  // L3
  let credsL3: StoreAdapter<Record<string, unknown>> | undefined
  if (config.mysql.enabled) {
    const mysqlPool = createMySqlPool(config.mysql.connectionUri)
    const mysqlStore = new MySqlStoreAdapter<Record<string, unknown>>(mysqlPool, 'creds_store')
    await mysqlStore.ensureSchema()
    credsL3 = mysqlStore
    logger.info('mysql L3 connected')
  }

  const credsStore = new CredsStore({ l1: credsL1, l2: credsL2, l3: credsL3, metrics, logger })
  const keysStore = new KeysStore({ l1: keysL1, l2: keysL2, metrics, logger })
  const proxyStore = new ProxyStore({
    l2: new RedisStoreAdapter(redis, config.redis.keyPrefix),
    logger
  })
  const runtimeStore = new AccountRuntimeStore(
    new RedisStoreAdapter<AccountRuntimeRecord>(redis, config.redis.keyPrefix),
    logger
  )
  const deviceStore = new AccountDeviceStore(
    new RedisStoreAdapter<AccountDeviceProfile>(redis, config.redis.keyPrefix),
    logger
  )
  const browserDisplayStore = new AccountBrowserDisplayStore(
    new RedisStoreAdapter<BrowserDisplay>(redis, config.redis.keyPrefix),
    logger
  )

  const gate = new TokenBucketReconnectGate(config, redis, logger)
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
    master = new Master({ registry, redis, publisher, logger, metrics, config: { nodeId: config.nodeId } })
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
    logger: logger as never,
    bodyLimit: config.http.bodyLimitBytes,
    requestIdLogLabel: 'reqId'
  })
  await app.register(Sensible)
  await app.register(Swagger, {
    mode: 'static',
    specification: { path: config.http.openapiSpecPath, baseDir: process.cwd() }
  })
  await app.register(SwaggerUi, { routePrefix: '/docs' })

  registerErrorHandler(app, logger)
  registerHealthRoutes(app, {
    logger,
    isReady: async () => {
      const r = await redis.ping().then(() => true).catch(() => false)
      return r && publisher.isReady()
    },
    isLive: async () => true
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
      if ('quit' in redis) await (redis as { quit: () => Promise<unknown> }).quit().catch(() => {})
    } catch (err) {
      logger.error({ err }, 'shutdown error')
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('uncaughtException', err => {
    logger.fatal({ err }, 'uncaughtException')
    shutdown('uncaught').catch(() => process.exit(1))
  })
  process.on('unhandledRejection', err => {
    logger.error({ err }, 'unhandledRejection')
  })
}

main().catch(err => {
  console.error('bootstrap failed:', err)
  process.exit(1)
})

export type { Config, Logger, Metrics, EventPublisher }
