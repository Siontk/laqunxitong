/**
 * Fastify 统一错误处理。
 *
 * 1. zod / 验证错误 → 400 + 字段详情
 * 2. 业务级"账号不可用" → 503 + 语义码
 * 3. NEED_REAUTH → 422 + 引导前端重新 pairing
 * 4. RestrictionViolation（个人号调 Business 接口）→ 422
 * 5. 未捕获异常 → 500 + sanitized message
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'

import type { Logger } from '../observability/logger.js'

export class ProtocolError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export class AccountUnavailableError extends ProtocolError {
  constructor(accountId: string, reason: string, details?: Record<string, unknown>) {
    super(503, 'ACCOUNT_UNAVAILABLE', `account ${accountId} unavailable: ${reason}`, {
      accountId,
      reason,
      ...details
    })
  }
}

export class NeedReauthError extends ProtocolError {
  constructor(accountId: string, reason: string) {
    super(422, 'NEED_REAUTH', `account ${accountId} need re-auth: ${reason}`, { accountId, reason })
  }
}

export class NotBusinessAccountError extends ProtocolError {
  constructor(accountId: string) {
    super(422, 'NOT_BUSINESS_ACCOUNT', `account ${accountId} is not a Business account`, {
      accountId
    })
  }
}

export class AccountNotFoundError extends ProtocolError {
  constructor(accountId: string) {
    super(404, 'ACCOUNT_NOT_FOUND', `account ${accountId} not found in this worker`, { accountId })
  }
}

export class NotOwnerError extends ProtocolError {
  constructor(
    accountId: string,
    currentWorkerId: string,
    owner: { workerId: string | null; endpoint?: string | null }
  ) {
    super(409, 'NOT_OWNER', `account ${accountId} is not owned by this worker`, {
      accountId,
      currentWorkerId,
      ownerWorkerId: owner.workerId,
      ownerEndpoint: owner.endpoint ?? null
    })
  }
}

export class RateLimitedError extends ProtocolError {
  constructor(reason: string, retryAfterMs: number) {
    super(429, 'RATE_LIMITED', reason, { retryAfterMs })
  }
}

export function registerErrorHandler(app: FastifyInstance, logger: Logger): void {
  app.setErrorHandler(
    (err: FastifyError | ZodError | ProtocolError | Error, req: FastifyRequest, reply: FastifyReply) => {
      // zod 验证
      if (err instanceof ZodError) {
        reply.code(400).send({
          code: 'VALIDATION_ERROR',
          message: 'request body validation failed',
          details: err.flatten()
        })
        return
      }

      // 协议层显式错误
      if (err instanceof ProtocolError) {
        reply.code(err.httpStatus).send({
          code: err.code,
          message: err.message,
          details: err.details
        })
        return
      }

      // fastify 内置
      if ('statusCode' in err && typeof (err as FastifyError).statusCode === 'number') {
        const fe = err as FastifyError
        reply.code(fe.statusCode ?? 500).send({
          code: fe.code ?? 'FASTIFY_ERROR',
          message: fe.message
        })
        return
      }

      // 未捕获
      logger.error({ err, path: req.url, method: req.method }, 'unhandled error')
      reply.code(500).send({
        code: 'INTERNAL_ERROR',
        message: 'internal server error',
        requestId: req.id
      })
    }
  )

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ code: 'NOT_FOUND', message: 'route not found' })
  })
}
