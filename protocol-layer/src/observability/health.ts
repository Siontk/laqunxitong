/**
 * 健康检查端点。
 *
 * /healthz   liveness  — 进程活着即 200
 * /readyz    readiness — 依赖（Redis / Kafka / PG）就绪才 200
 * /livez     存活 + 业务级（worker 心跳 + event loop lag 未爆）
 */

import type { FastifyInstance } from 'fastify'

import type { Logger } from './logger.js'

export interface HealthCheckDeps {
  isReady: () => Promise<boolean>
  isLive: () => Promise<boolean>
  logger: Logger
}

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthCheckDeps
): void {
  app.get('/healthz', async () => ({ ok: true, ts: new Date().toISOString() }))

  app.get('/readyz', async (_req, reply) => {
    try {
      const ready = await deps.isReady()
      if (!ready) {
        return reply.code(503).send({ ok: false, reason: 'not_ready' })
      }
      return { ok: true }
    } catch (err) {
      deps.logger.error({ err }, 'readyz check failed')
      return reply.code(503).send({ ok: false, reason: 'check_error' })
    }
  })

  app.get('/livez', async (_req, reply) => {
    try {
      const live = await deps.isLive()
      if (!live) {
        return reply.code(503).send({ ok: false, reason: 'not_live' })
      }
      return { ok: true }
    } catch (err) {
      deps.logger.error({ err }, 'livez check failed')
      return reply.code(503).send({ ok: false, reason: 'check_error' })
    }
  })
}
