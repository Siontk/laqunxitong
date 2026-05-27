import type { Config } from '../config.js'
import type { Logger } from '../observability/logger.js'

type AuditFields = Record<string, unknown>

export function auditInfo(logger: Logger, action: string, fields: AuditFields = {}): void {
  logger.info({ audit: true, action, ...fields }, 'business audit')
}

export function auditWarn(logger: Logger, action: string, fields: AuditFields = {}): void {
  logger.warn({ audit: true, action, ...fields }, 'business audit')
}

export function auditInfoSampled(config: Config, logger: Logger, action: string, fields: AuditFields = {}): void {
  if (!config.log.auditSuccessEnabled) return
  if (config.log.auditSampleRate <= 0) return
  if (config.log.auditSampleRate < 1 && Math.random() > config.log.auditSampleRate) return
  auditInfo(logger, action, fields)
}

export function summarizeParticipantResults(results: Array<{ status?: unknown }>): {
  total: number
  okCount: number
  failCount: number
  statuses: Record<string, number>
} {
  const statuses: Record<string, number> = {}
  for (const r of results) {
    const status = String(r.status ?? 'UNKNOWN')
    statuses[status] = (statuses[status] ?? 0) + 1
  }
  const okCount = statuses.OK ?? 0
  return {
    total: results.length,
    okCount,
    failCount: results.length - okCount,
    statuses
  }
}
