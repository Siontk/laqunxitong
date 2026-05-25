/**
 * Socket 工厂 — 创建 Baileys WASocket，注入 proxy / store / Baileys 配置。
 *
 * 配置原则（§ 4.2）：
 *   - syncFullHistory = false
 *   - markOnlineOnConnect = false
 *   - fireInitQueries = false（业务侧不依赖 app-state 同步则关）
 *   - emitOwnEvents = false
 *   - keepAliveIntervalMs = 30_000
 *   - agent + fetchAgent 必须都传
 *   - **不要写 printQRInTerminal**（7.x 已废弃）
 */

import makeWASocket, { type WASocket, type AuthenticationState } from 'baileys'

import type { Config } from '../config.js'
import type { ProxyAgents } from '../proxy/agent-factory.js'
import type { Logger } from '../observability/logger.js'
import { browserFromConfig, type SocketBrowser } from './socket-browser.js'

export interface SocketFactoryInput {
  accountId: string
  auth: AuthenticationState
  proxy: ProxyAgents
  config: Config
  logger: Logger
  browser?: SocketBrowser
}

export function createBaileysSocket(input: SocketFactoryInput): WASocket {
  const { config, proxy, logger } = input
  const browser = input.browser ?? browserFromConfig(config)

  return makeWASocket({
    auth: input.auth,
    logger: logger.child({ accountId: input.accountId }) as never,
    agent: proxy.agent as never,
    fetchAgent: proxy.fetchAgent as never,
    markOnlineOnConnect: config.baileys.markOnlineOnConnect,
    syncFullHistory: config.baileys.syncFullHistory,
    fireInitQueries: config.baileys.fireInitQueries,
    shouldSyncHistoryMessage: () => false,
    emitOwnEvents: config.baileys.emitOwnEvents,
    connectTimeoutMs: config.baileys.connectTimeoutMs,
    defaultQueryTimeoutMs: config.baileys.defaultQueryTimeoutMs,
    keepAliveIntervalMs: config.worker.keepAliveIntervalMs,
    browser
  })
}
