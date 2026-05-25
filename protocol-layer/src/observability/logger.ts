/**
 * Pino 结构化日志。
 * 字段约定：
 *   accountId / workerId / nodeId — 必带，便于聚合
 *   evt — 事件类型
 *   semantic — § 4.4 语义错误码（PROXY_FAILED / RATE_LIMITED / NEED_REAUTH / RECONNECTING）
 */

import pino, { type Logger } from 'pino'

import type { Config } from '../config.js'

export function createLogger(config: Config): Logger {
  return pino({
    level: config.log.level,
    base: {
      nodeId: config.nodeId,
      workerId: config.workerId,
      role: config.role,
      env: config.env
    },
    transport: config.log.pretty
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' }
        }
      : undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: label => ({ level: label })
    }
  })
}

export type { Logger }
