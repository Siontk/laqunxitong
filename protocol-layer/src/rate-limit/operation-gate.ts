import { randomUUID } from 'node:crypto'

import type { Config } from '../config.js'
import { ProtocolError } from '../error/error-handler.js'
import type { EventPublisher } from '../events/publisher.js'
import type { Logger } from '../observability/logger.js'
import type { Metrics } from '../observability/metrics.js'
import type { RedisClient } from '../store/adapters/redis.js'
import { TokenBucket } from './token-bucket.js'

const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

export class AccountBusyError extends ProtocolError {
  constructor(accountId: string, retryAfterMs: number) {
    super(429, 'ACCOUNT_BUSY', `account ${accountId} has group operation in progress`, {
      accountId,
      retryAfterMs,
      reason: 'group_operation_in_progress'
    })
  }
}

export class WorkerBusyError extends ProtocolError {
  constructor(workerId: string, retryAfterMs: number) {
    super(429, 'WORKER_BUSY', `worker ${workerId} group operation limit reached`, {
      workerId,
      retryAfterMs,
      reason: 'worker_group_operation_limited'
    })
  }
}

interface GateHoldResult<T> {
  value: T
  holdLockUntilTtl?: boolean
}

export interface OperationGateDeps {
  redis: RedisClient
  config: Config
  logger: Logger
  metrics: Metrics
  publisher: EventPublisher
}

export class OperationGate {
  private workerGroupBucket: TokenBucket

  constructor(private readonly deps: OperationGateDeps) {
    this.workerGroupBucket = new TokenBucket(deps.redis, `${deps.config.redis.keyPrefix}rl:groupop:worker`, {
      ratePerSec: deps.config.rateLimit.workerGroupOpPerSec,
      capacity: deps.config.rateLimit.workerGroupOpBurst
    })
  }

  async runGroup<T>(
    accountId: string,
    operation: string,
    fn: () => Promise<T | GateHoldResult<T>>
  ): Promise<T> {
    const lockKey = `${this.deps.config.redis.keyPrefix}lock:groupop:account:${accountId}`
    const lockValue = randomUUID()
    const lockOk = await this.deps.redis.set(
      lockKey,
      lockValue,
      'PX',
      this.deps.config.rateLimit.groupAccountLockTtlMs,
      'NX'
    )
    if (lockOk !== 'OK') {
      await this.publishBusy('account.group_busy', accountId, {
        operation,
        retryAfterMs: this.deps.config.rateLimit.groupAccountBusyRetryMs,
        reason: 'account_group_operation_in_progress'
      })
      this.deps.logger.warn(
        { audit: true, action: 'groupop.account_busy', accountId, operation, retryAfterMs: this.deps.config.rateLimit.groupAccountBusyRetryMs },
        'business audit'
      )
      throw new AccountBusyError(accountId, this.deps.config.rateLimit.groupAccountBusyRetryMs)
    }

    let releaseLock = true
    try {
      const workerOk = await this.workerGroupBucket.take(this.deps.config.workerId)
      if (!workerOk.allowed) {
        await this.publishBusy('account.worker_busy', accountId, {
          operation,
          workerId: this.deps.config.workerId,
          retryAfterMs: this.deps.config.rateLimit.workerGroupBusyRetryMs,
          reason: 'worker_group_operation_limited'
        })
        this.deps.logger.warn(
          {
            audit: true,
            action: 'groupop.worker_busy',
            accountId,
            operation,
            workerId: this.deps.config.workerId,
            retryAfterMs: this.deps.config.rateLimit.workerGroupBusyRetryMs
          },
          'business audit'
        )
        throw new WorkerBusyError(this.deps.config.workerId, this.deps.config.rateLimit.workerGroupBusyRetryMs)
      }

      const started = Date.now()
      this.deps.metrics.groupOpInflight.inc()
      let outcome: 'success' | 'partial' | 'error' = 'success'
      try {
        const result = await fn()
        if (isGateHoldResult(result)) {
          // holdLockUntilTtl=true 通常是 participant add 超时 → 算 partial
          if (result.holdLockUntilTtl) outcome = 'partial'
          releaseLock = !result.holdLockUntilTtl
          if (result.holdLockUntilTtl) {
            this.deps.logger.warn(
              {
                audit: true,
                action: 'groupop.lock_held_until_ttl',
                accountId,
                operation,
                ttlMs: this.deps.config.rateLimit.groupAccountLockTtlMs
              },
              'business audit'
            )
          }
          return result.value
        }
        return result
      } catch (err) {
        outcome = 'error'
        throw err
      } finally {
        const elapsedMs = Date.now() - started
        this.deps.metrics.groupOpInflight.dec()
        this.deps.metrics.groupOpDurationSec.observe(
          { operation, result: outcome },
          elapsedMs / 1000
        )
        if (elapsedMs >= this.deps.config.log.slowOperationMs) {
          this.deps.logger.warn(
            { audit: true, action: 'groupop.slow', accountId, operation, elapsedMs, outcome },
            'business audit'
          )
        }
      }
    } finally {
      if (releaseLock) {
        await this.deps.redis.eval(RELEASE_LOCK_LUA, 1, lockKey, lockValue).catch(err => {
          this.deps.logger.warn({ err, accountId, operation }, 'group operation lock release failed')
        })
      }
    }
  }

  private async publishBusy(event: 'account.group_busy' | 'account.worker_busy', accountId: string, data: Record<string, unknown>): Promise<void> {
    await this.deps.publisher.publish(event, accountId, {
      accountId,
      cooldownUntil: new Date(Date.now() + Number(data.retryAfterMs ?? 0)).toISOString(),
      ...data
    }).catch(err => {
      this.deps.logger.warn({ err, event, accountId }, 'busy event publish failed')
    })
  }
}

function isGateHoldResult<T>(value: T | GateHoldResult<T>): value is GateHoldResult<T> {
  return !!value && typeof value === 'object' && 'value' in value
}
