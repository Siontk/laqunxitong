/**
 * AccountManager — 单 worker 内 accountId → 完整运行时上下文映射。
 *
 * 一个 worker 进程一个 AccountManager 实例，维护 300-400 账号。
 *
 * 职责：
 *   - 上线 / 下线 / logout
 *   - 维护状态机 + evidence
 *   - 接 Baileys connection.update / creds.update
 *   - 翻译 DisconnectReason 为 semantic
 *   - 委托 ReconnectController 做重连
 *   - 派发事件到 Kafka
 *   - 提供 sock 给 routes 调用（业务接口走这里取 sock）
 */

import { DisconnectReason, initAuthCreds, type WASocket } from 'baileys'
import { Boom } from '@hapi/boom'

import type { Config } from '../config.js'
import type { Logger } from '../observability/logger.js'
import type { Metrics } from '../observability/metrics.js'
import type { EventPublisher } from '../events/publisher.js'
import type { CredsStore } from '../store/creds-store.js'
import type { KeysStore } from '../store/keys-store.js'
import type { AccountRuntimeStore } from '../store/account-runtime-store.js'
import type { Registry } from '../registry/registry.js'
import { buildAuthState } from '../store/auth-state.js'
import type { ProxyBinding, BusinessDetection, AccountState, Evidence } from '../types/api.js'
import { createProxyAgents, destroyProxyAgents, type ProxyAgents } from '../proxy/agent-factory.js'
import { translateDisconnect } from '../error/semantic-codes.js'
import { createBaileysSocket } from './socket-factory.js'
import type { SocketBrowser } from './socket-browser.js'
import { StateMachine } from './state-machine.js'
import { ReconnectController, type ReconnectExecutor } from './reconnect.js'
import type { ReconnectGate } from '../rate-limit/reconnect-limiter.js'
import { attachEventBridge } from './event-bridge.js'
import { detectAccountType } from './business-detector.js'
import { AccountNotFoundError, ProtocolError } from '../error/error-handler.js'
import type { StaleObserver } from './stale-detector.js'

const ACTIVE_SLOT_STATES = new Set<AccountState>([
  'PAIRING',
  'VERIFYING',
  'ONLINE',
  'STALE',
  'RECONNECTING',
  'PROXY_FAILED',
  'RATE_LIMITED'
])

const TERMINAL_RECONNECT_STATES = new Set<AccountState>(['NEED_REAUTH', 'LOGGED_OUT', 'DEVICE_REMOVED'])

interface AccountContext {
  accountId: string
  phone?: string
  proxy: ProxyBinding
  proxyAgents: ProxyAgents | null
  sock: WASocket | null
  detachEventBridge: (() => void) | null
  state: StateMachine
  lastDateRecv: number
  lastPingAckAt: number
  wsOpenedAt: number
  detection: BusinessDetection | null
  vipHint?: boolean
  browser?: SocketBrowser
  pairingTimer: NodeJS.Timeout | null
}

export interface AccountManagerDeps {
  config: Config
  logger: Logger
  metrics: Metrics
  publisher: EventPublisher
  credsStore: CredsStore
  keysStore: KeysStore
  runtimeStore: AccountRuntimeStore
  registry: Registry
  gate: ReconnectGate
}

export class AccountManager implements ReconnectExecutor, StaleObserver {
  private accounts = new Map<string, AccountContext>()
  private reconnect: ReconnectController
  private logger: Logger

  constructor(private readonly deps: AccountManagerDeps) {
    this.logger = deps.logger
    this.reconnect = new ReconnectController(deps.gate, this, deps.logger, deps.metrics)
  }

  /** ───── 公开 API（routes 层调用） ───── */

  /** 上线（已有 creds），ws connect 异步发生，事件回调由 event-bridge 推 */
  async online(accountId: string, proxy: ProxyBinding, vipHint?: boolean, browser?: SocketBrowser): Promise<void> {
    let ctx = this.accounts.get(accountId)
    if (!ctx) {
      // 如果 store 里已经有 creds（导入 / reconciler adopt / 重启恢复），
      // 起点为 OFFLINE（"有身份但当前不在线"）；
      // 否则是全新账号（pairing/QR 首次绑定），起点为 IMPORTED。
      const hasCreds = await this.deps.credsStore.has(accountId)
      const initialState: AccountState = hasCreds ? 'OFFLINE' : 'IMPORTED'
      ctx = this.createContext(accountId, proxy, vipHint, initialState, browser)
    } else {
      // 已存在：更新代理绑定，准备重建
      ctx.proxy = proxy
      if (browser) ctx.browser = browser
    }
    await this.deps.runtimeStore.clear(accountId)
    await this.openSocket(ctx)
  }

  /** 主动下线，保留 creds */
  async offline(accountId: string): Promise<void> {
    const ctx = this.requireCtx(accountId)
    this.reconnect.cancel(accountId)
    if (ctx.sock) {
      try {
        ctx.sock.end(undefined)
      } catch (e) {
        this.logger.debug({ e, accountId }, 'sock.end err')
      }
    }
    this.publishStateChange(ctx, 'OFFLINE', 'manual_offline')
    this.cleanupSocket(ctx)
    await this.deps.runtimeStore.mark(accountId, 'OFFLINE', true, 'manual_offline')
    this.deps.metrics.accountsByState.dec({ state: 'OFFLINE' })
    this.deps.metrics.slotReleasedTotal?.inc({ reason: 'manual' })
    this.accounts.delete(accountId)
    this.deps.metrics.accountsTotal.set(this.activeSize())
    // 注意：offline **不** 调 registry.releaseSlot()。
    // 原因：offline 保留 assign 绑定（账号还属于本 worker），后续 online 通过
    // Registry.assign 走 existing 路径**不 +1**。如果这里 -1，online 时不补，
    // Registry load 会持续偏低 1 直到下一次硬同步（最长 1 小时）。
    // load 偏高的代价（worker 心跳的温和覆盖）远小于偏低的代价（master 误判超分配）。
    // 真正的"账号已废"场景（NEED_REAUTH / 重连耗尽 / logout）才会 releaseSlot / unassign。
  }

  /** logout：远端踢自己 */
  async logout(accountId: string): Promise<void> {
    const ctx = this.requireCtx(accountId)
    if (ctx.sock) {
      try {
        await ctx.sock.logout()
      } catch (e) {
        this.logger.warn({ e, accountId }, 'logout error')
      }
    }
    this.reconnect.cancel(accountId)
    this.publishStateChange(ctx, 'LOGGED_OUT', 'logout')
    this.cleanupSocket(ctx)
    await this.deps.runtimeStore.mark(accountId, 'LOGGED_OUT', true, 'logout')
    this.deps.metrics.accountsByState.dec({ state: 'LOGGED_OUT' })
    this.deps.metrics.slotReleasedTotal?.inc({ reason: 'logout' })
    await this.deps.credsStore.delete(accountId)
    this.accounts.delete(accountId)
    this.deps.metrics.accountsTotal.set(this.activeSize())
    // logout 还要解除 Registry 的 accountId → workerId 绑定（账号已废）
    await this.deps.registry.unassign(accountId)
  }

  /** 重新分配代理 session */
  async rebindProxy(accountId: string, proxy: ProxyBinding): Promise<void> {
    const ctx = this.requireCtx(accountId)
    ctx.proxy = proxy
    if (ctx.sock) {
      try {
        ctx.sock.end(new Boom('proxy rebind', { statusCode: DisconnectReason.connectionLost }))
      } catch (e) {
        this.logger.debug({ e, accountId }, 'sock.end on rebind err')
      }
    }
    // 上层会通过 close 事件触发 reconnect.schedule
  }

  async requestReconnect(accountId: string, reason: string, proxy?: ProxyBinding): Promise<{
    state: AccountState
    alreadyInFlight: boolean
  }> {
    const ctx = this.requireCtx(accountId)
    if (TERMINAL_RECONNECT_STATES.has(ctx.state.state)) {
      throw new ProtocolError(422, 'NEED_REAUTH', `account ${accountId} cannot reconnect from ${ctx.state.state}`, {
        accountId,
        state: ctx.state.state,
        reason: 'terminal_state'
      })
    }

    if (proxy) ctx.proxy = proxy
    const alreadyInFlight = ctx.state.state === 'RECONNECTING'
    if (!alreadyInFlight) {
      this.publishStateChange(ctx, 'RECONNECTING', `manual_reconnect:${reason}`)
    }
    await this.openSocket(ctx)
    return {
      state: ctx.state.state,
      alreadyInFlight
    }
  }

  /** 触发主动 probe（关键操作前用） */
  async probe(accountId: string, timeoutMs: number = 3000): Promise<{ rttMs: number }> {
    const ctx = this.requireCtx(accountId)
    if (!ctx.sock) throw new AccountNotFoundError(accountId)
    const start = Date.now()
    // Baileys 没暴露公开 ping API，借助 sendPresenceUpdate 作为流量探针
    await Promise.race([
      ctx.sock.sendPresenceUpdate('available'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), timeoutMs))
    ])
    return { rttMs: Date.now() - start }
  }

  /**
   * 给 pairing/QR 流程武装一个超时定时器。
   *
   * 业务方调 /v1/auth/pairing-code 或 /v1/auth/qrcode 后，会拉起空 creds 的 socket
   * 并等用户输入 code / 扫码。如果 timeoutMs 内未 ONLINE，认为 pairing 失败：
   *   - 释放运行槽位（不占容量）
   *   - 推 pairing.failed 事件（reason=user_timeout）
   *   - 把 Registry assign 解除（账号根本没绑成功）
   */
  armPairingTimeout(accountId: string, timeoutMs: number = 90_000): void {
    const ctx = this.accounts.get(accountId)
    if (!ctx) return
    if (ctx.pairingTimer) clearTimeout(ctx.pairingTimer)
    ctx.pairingTimer = setTimeout(() => {
      this.handlePairingTimeout(accountId).catch(err =>
        this.logger.error({ err, accountId }, 'pairing timeout handler failed')
      )
    }, timeoutMs)
    ctx.pairingTimer.unref?.()
    this.logger.info({ accountId, timeoutMs }, 'pairing timeout armed')
  }

  private async handlePairingTimeout(accountId: string): Promise<void> {
    const ctx = this.accounts.get(accountId)
    if (!ctx) return
    // 如果已经 ONLINE 了，timeout 不该再触发（cleanup 会清 timer）；保险判一下
    if (ctx.state.state === 'ONLINE') {
      ctx.pairingTimer = null
      return
    }

    this.logger.warn({ accountId, state: ctx.state.state }, 'pairing timeout — releasing slot')
    await this.deps.publisher.publish('pairing.failed', accountId, {
      reason: 'user_timeout',
      failedAt: new Date().toISOString()
    })
    // 释放运行槽位 + 解除 Registry 绑定（账号没绑成功）
    this.publishStateChange(ctx, 'OFFLINE', 'pairing_timeout')
    await this.releaseRuntimeSlot(ctx, 'OFFLINE', 'pairing_timeout')
    // unassign 默认 releaseSlot=true：把 pairing 时 assign +1 抵消掉
    // (releaseRuntimeSlot 已不再调 registry.releaseSlot，所以这里默认 true 不会双减)
    await this.deps.registry.unassign(accountId)
  }

  getSocket(accountId: string): WASocket {
    const ctx = this.requireCtx(accountId)
    if (!ctx.sock) throw new AccountNotFoundError(accountId)
    return ctx.sock
  }

  getEvidence(accountId: string): Evidence {
    const ctx = this.requireCtx(accountId)
    const lastRecv = ctx.lastDateRecv
    return {
      wsOpen: ctx.sock != null,
      connectionField: 'open' as 'open' | 'close' | 'connecting',
      lastDateRecv: new Date(lastRecv || Date.now()).toISOString(),
      lastPingAckAt: new Date(ctx.lastPingAckAt || Date.now()).toISOString(),
      ageMs: Date.now() - (lastRecv || Date.now()),
      keepAliveIntervalMs: this.deps.config.worker.keepAliveIntervalMs
    }
  }

  getState(accountId: string): AccountState {
    return this.requireCtx(accountId).state.state
  }

  getDetection(accountId: string): BusinessDetection | null {
    return this.requireCtx(accountId).detection
  }

  listAccounts(): string[] {
    return [...this.accounts.keys()]
  }

  size(): number {
    return this.accounts.size
  }

  /** 真正占 worker 在线容量的账号数。2000 容量按这个口径计算。 */
  activeSize(): number {
    let count = 0
    for (const ctx of this.accounts.values()) {
      if (ACTIVE_SLOT_STATES.has(ctx.state.state) || ctx.sock) count++
    }
    return count
  }

  /** ───── ReconnectExecutor ───── */
  async doReconnect(accountId: string): Promise<void> {
    const ctx = this.requireCtx(accountId)
    this.publishStateChange(ctx, 'RECONNECTING', 'reconnect_executor')
    await this.openSocket(ctx)
  }

  async onReconnectExhausted(accountId: string, _type: 'A' | 'B' | 'C', reason: string): Promise<void> {
    const ctx = this.accounts.get(accountId)
    if (!ctx) return
    await this.releaseRuntimeSlot(ctx, ctx.state.state, `reconnect_exhausted:${reason}`)
  }

  /** ───── StaleObserver ───── */
  getOnlineLastRecvMap(): Map<string, number> {
    const result = new Map<string, number>()
    for (const [id, ctx] of this.accounts) {
      if (ctx.state.state === 'ONLINE') {
        result.set(id, ctx.lastDateRecv || Date.now())
      }
    }
    return result
  }

  async markStaleAndReconnect(accountId: string, _ageMs: number): Promise<void> {
    const ctx = this.accounts.get(accountId)
    if (!ctx) return
    this.publishStateChange(ctx, 'STALE', 'half_open_ws')
    if (ctx.sock) {
      try {
        ctx.sock.end(new Boom('stale', { statusCode: DisconnectReason.connectionLost }))
      } catch (_e) {
        // ignore
      }
    }
    // 直接调度立即重连（类型 A）
    this.reconnect.schedule(accountId, 'A', 'stale')
  }

  /** ───── 内部 ───── */

  private createContext(
    accountId: string,
    proxy: ProxyBinding,
    vipHint?: boolean,
    initialState: AccountState = 'IMPORTED',
    browser?: SocketBrowser
  ): AccountContext {
    const ctx: AccountContext = {
      accountId,
      proxy,
      proxyAgents: null,
      sock: null,
      detachEventBridge: null,
      state: new StateMachine(accountId, initialState),
      lastDateRecv: 0,
      lastPingAckAt: 0,
      wsOpenedAt: 0,
      detection: null,
      vipHint,
      browser,
      pairingTimer: null
    }
    this.accounts.set(accountId, ctx)
    this.deps.metrics.accountsByState.inc({ state: initialState })
    this.deps.metrics.accountsTotal.set(this.activeSize())
    return ctx
  }

  private requireCtx(accountId: string): AccountContext {
    const ctx = this.accounts.get(accountId)
    if (!ctx) throw new AccountNotFoundError(accountId)
    return ctx
  }

  private async openSocket(ctx: AccountContext): Promise<void> {
    // 清旧 sock
    this.cleanupSocket(ctx)

    // 构造 proxy agent（每次都新构造，避免连接池复用导致 IP 没切到）
    ctx.proxyAgents = createProxyAgents(ctx.proxy)

    // 准备 auth state
    const credsLoaded = (await this.deps.credsStore.load(ctx.accountId)) ?? initAuthCreds()
    const { state, saveCreds } = await buildAuthState(
      ctx.accountId,
      this.deps.credsStore,
      this.deps.keysStore,
      this.deps.logger,
      { creds: credsLoaded as Parameters<typeof buildAuthState>[4] extends infer A
          ? A extends { creds?: infer C }
            ? C
            : never
          : never }
    )

    // 构造 socket
    const sock = createBaileysSocket({
      accountId: ctx.accountId,
      auth: state,
      proxy: ctx.proxyAgents,
      config: this.deps.config,
      logger: this.deps.logger,
      browser: ctx.browser
    })
    ctx.sock = sock
    ctx.wsOpenedAt = Date.now()
    this.publishStateChange(ctx, 'VERIFYING', 'ws_open')

    // 接 Baileys 内部事件 → Kafka
    ctx.detachEventBridge = attachEventBridge(
      sock,
      {
        accountId: ctx.accountId,
        getEvidence: () => this.getEvidence(ctx.accountId),
        getBusinessDetection: () => ctx.detection
      },
      this.deps.publisher,
      this.logger,
      this.deps.metrics
    )

    // 接 creds.update 持久化
    sock.ev.on('creds.update', () => {
      saveCreds().catch(err =>
        this.logger.error({ err, accountId: ctx.accountId }, 'saveCreds failed')
      )
    })

    // 接 connection.update 做状态机
    sock.ev.on('connection.update', update => {
      this.handleConnectionUpdate(ctx, update).catch(err =>
        this.logger.error({ err, accountId: ctx.accountId }, 'handleConnectionUpdate failed')
      )
    })
  }

  private async handleConnectionUpdate(
    ctx: AccountContext,
    update: { connection?: string; lastDisconnect?: { error?: unknown }; qr?: string }
  ): Promise<void> {
    // 更新 lastDateRecv（任何 update 都说明 ws 还活）
    ctx.lastDateRecv = Date.now()
    ctx.lastPingAckAt = Date.now()

    if (update.connection === 'open') {
      // 检测账号类型（首次 online 或重新刷新）
      const detection = await detectAccountType(
        {
          creds: ctx.sock?.authState?.creds ?? {},
          fallbackSocket: ctx.sock!,
          vipHint: ctx.vipHint
        },
        this.logger
      )
      ctx.detection = detection
      if (detection.source !== 'unknown') {
        await this.deps.publisher.publish('account.type_detected', ctx.accountId, { detection })
      }

      this.publishStateChange(ctx, 'ONLINE', 'ws_open_confirmed')
      // pairing 成功，清掉 pairing 超时定时器
      if (ctx.pairingTimer) {
        clearTimeout(ctx.pairingTimer)
        ctx.pairingTimer = null
        await this.deps.publisher.publish('pairing.completed', ctx.accountId, {
          phone: (ctx.sock?.authState?.creds?.me?.id ?? '').split('@')[0],
          jid: ctx.sock?.authState?.creds?.me?.id,
          detection: ctx.detection,
          ownerWorkerId: this.deps.config.workerId,
          ownerEndpoint: this.deps.config.http.publicEndpoint ?? null,
          completedAt: new Date().toISOString()
        })
      }
      await this.deps.publisher.publish('account.online_changed', ctx.accountId, {
        online: true,
        transitionedAt: new Date().toISOString(),
        reason: 'ws_open'
      })
      this.reconnect.onSuccess(ctx.accountId)
    }

    if (update.connection === 'close') {
      const error = update.lastDisconnect?.error as Boom | undefined
      const statusCode = error?.output?.statusCode
      const reason = error?.message ?? 'unknown'
      const translation = translateDisconnect(statusCode, reason)

      this.deps.metrics.disconnectTotal.inc({
        semantic: translation.semantic,
        code: String(translation.rawCode ?? 'unknown')
      })
      if (translation.rawCode) {
        this.deps.metrics.waErrorTotal.inc({ code: String(translation.rawCode) })
      }

      if (translation.needReauth) {
        this.publishStateChange(ctx, 'NEED_REAUTH', reason, translation)
        await this.deps.publisher.publish('account.need_reauth', ctx.accountId, {
          reason,
          ownerWorkerId: this.deps.config.workerId,
          ownerEndpoint: this.deps.config.http.publicEndpoint ?? null,
          lastSeenAt: new Date(ctx.lastDateRecv).toISOString()
        })
        await this.releaseRuntimeSlot(ctx, 'NEED_REAUTH', reason)
        return
      }

      if (translation.reconnectClass === 'A') {
        this.publishStateChange(ctx, 'RECONNECTING', `class_A:${reason}`, translation)
        this.reconnect.schedule(ctx.accountId, 'A', `class_A:${reason}`)
      } else if (translation.reconnectClass === 'B') {
        const target = translation.semantic === 'PROXY_FAILED' ? 'PROXY_FAILED' : 'OFFLINE'
        this.publishStateChange(ctx, target, `class_B:${reason}`, translation)
        const scheduled = this.reconnect.schedule(ctx.accountId, 'B', `class_B:${reason}`)
        if (!scheduled.willReconnect) {
          await this.releaseRuntimeSlot(ctx, target, `reconnect_cooldown:${reason}`)
        }
      } else {
        // class C 已在 needReauth 分支处理
        this.publishStateChange(ctx, 'OFFLINE', reason, translation)
      }
    }
  }

  private publishStateChange(
    ctx: AccountContext,
    target: AccountState,
    reason: string,
    detail?: { rawCode?: number | null; rawReason?: string | null; semantic?: string }
  ): void {
    const fromState = ctx.state.state
    try {
      const t = ctx.state.transitionTo(target, reason, {
        rawCode: detail?.rawCode ?? undefined,
        rawReason: detail?.rawReason ?? undefined,
        semantic: detail?.semantic
      })
      if (!t) return
      this.deps.metrics.accountsByState.inc({ state: target })
      this.deps.metrics.accountsByState.dec({ state: fromState })
      this.deps.metrics.accountsTotal.set(this.activeSize())
      this.logger.info(
        {
          audit: true,
          action: 'account.state_changed',
          accountId: ctx.accountId,
          from: fromState,
          to: target,
          reason,
          semantic: detail?.semantic ?? null,
          rawCode: detail?.rawCode ?? null
        },
        'business audit'
      )
      this.deps.publisher.publish('account.state_changed', ctx.accountId, t, this.getEvidence(ctx.accountId))
    } catch (err) {
      this.logger.warn({ err, accountId: ctx.accountId, from: fromState, to: target }, 'invalid state transition')
    }
  }

  private cleanupSocket(ctx: AccountContext): void {
    if (ctx.detachEventBridge) {
      try {
        ctx.detachEventBridge()
      } catch {
        // ignore
      }
      ctx.detachEventBridge = null
    }
    if (ctx.proxyAgents) {
      destroyProxyAgents(ctx.proxyAgents)
      ctx.proxyAgents = null
    }
    if (ctx.pairingTimer) {
      clearTimeout(ctx.pairingTimer)
      ctx.pairingTimer = null
    }
    ctx.sock = null
  }

  private async releaseRuntimeSlot(ctx: AccountContext, state: AccountState, reason: string): Promise<void> {
    this.reconnect.cancel(ctx.accountId)
    this.cleanupSocket(ctx)
    await this.deps.runtimeStore.mark(ctx.accountId, state, true, reason)
    // 当前状态 dec，避免删账号后 accountsByState 长期偏高
    this.deps.metrics.accountsByState.dec({ state: ctx.state.state })
    this.deps.metrics.slotReleasedTotal?.inc({ reason: reasonBucket(reason) })
    this.accounts.delete(ctx.accountId)
    this.deps.metrics.accountsTotal.set(this.activeSize())
    // 注意：这里**不**调 registry.releaseSlot()。
    // releaseRuntimeSlot 只释放 worker 内存运行槽，但 Registry assign 绑定可能仍在
    //（业务侧可能未来重新 online / 重新 pairing 走原 accountId）。
    // 立即 -1 会让"恢复路径"（Registry.assign existing 不 +1）造成 load 偏低。
    // 由心跳的硬同步（每小时 force=true）兜底纠正即可。
    // 真正释放 load 由 unassign / logout / handlePairingTimeout 主动触发。
    this.logger.info({ accountId: ctx.accountId, state: ctx.state.state, reason }, 'runtime slot released')
  }
}

/** 把 free-form reason 归类成几档 label，避免 Prometheus cardinality 爆炸 */
function reasonBucket(reason: string): string {
  if (reason.startsWith('reconnect_')) return 'reconnect_exhausted'
  if (reason.includes('NEED_REAUTH') || reason.includes('logged') || reason.includes('device')) return 'need_reauth'
  if (reason.includes('logout')) return 'logout'
  if (reason.includes('manual')) return 'manual'
  return 'other'
}
