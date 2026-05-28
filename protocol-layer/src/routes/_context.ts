/**
 * Route 注册公共上下文。
 * 所有 routes/*.ts 通过此接口拿到核心依赖。
 */

import type { FastifyInstance } from 'fastify'

import type { Config } from '../config.js'
import type { Logger } from '../observability/logger.js'
import type { Metrics } from '../observability/metrics.js'
import type { EventPublisher } from '../events/publisher.js'
import type { OperationGate } from '../rate-limit/operation-gate.js'
import type { ReconnectGate } from '../rate-limit/reconnect-limiter.js'
import type { OnlineGate } from '../rate-limit/online-limiter.js'
import type { AccountManager } from '../worker/account-manager.js'
import type { Registry } from '../registry/registry.js'
import type { CredsStore } from '../store/creds-store.js'
import type { KeysStore } from '../store/keys-store.js'
import type { ProxyStore } from '../store/proxy-store.js'
import type { AccountRuntimeStore } from '../store/account-runtime-store.js'
import type { AccountBrowserDisplayStore, AccountDeviceStore } from '../store/account-device-store.js'

export interface RouteContext {
  config: Config
  logger: Logger
  metrics: Metrics
  publisher: EventPublisher
  operationGate: OperationGate
  reconnectGate: ReconnectGate
  onlineGate: OnlineGate
  accounts: AccountManager
  registry: Registry
  credsStore: CredsStore
  keysStore: KeysStore
  proxyStore: ProxyStore
  runtimeStore: AccountRuntimeStore
  deviceStore: AccountDeviceStore
  browserDisplayStore: AccountBrowserDisplayStore
}

export type RouteRegistrar = (app: FastifyInstance, ctx: RouteContext) => void | Promise<void>
