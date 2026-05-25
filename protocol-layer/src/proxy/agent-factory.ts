/**
 * Proxy Agent 工厂。
 *
 * 关键点（§ 4.2、4.6）：
 *   - `agent` 用于 ws / `fetchAgent` 用于媒体 HTTP，**必须都传**
 *   - 同一 sessionId 的 agent 必须每次重新构造（不能复用旧实例）
 *   - 出现 PROXY_FAILED 时由业务层调 /proxy/rebind 触发重新构造
 */

import type { Agent } from 'http'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

import type { ProxyBinding } from '../types/api.js'
import { resolveProxyUrl } from './url-builder.js'

export interface ProxyAgents {
  /** WebSocket 通道 */
  agent: Agent
  /** 媒体 HTTP fetch 通道（应与 ws 出口同一供应商，避免风控） */
  fetchAgent: Agent
  /** 元信息，便于事件上报 */
  meta: {
    sessionId: string
    country: string
    asn?: string
    protocol: 'socks5' | 'http'
  }
}

export function createProxyAgents(binding: ProxyBinding): ProxyAgents {
  const resolved = resolveProxyUrl(binding)

  let agent: Agent
  let fetchAgent: Agent
  if (resolved.protocol === 'socks5') {
    agent = new SocksProxyAgent(resolved.url) as unknown as Agent
    fetchAgent = new SocksProxyAgent(resolved.url) as unknown as Agent
  } else {
    agent = new HttpsProxyAgent(resolved.url) as unknown as Agent
    fetchAgent = new HttpsProxyAgent(resolved.url) as unknown as Agent
  }
  return {
    agent,
    fetchAgent,
    meta: {
      sessionId: resolved.sessionId,
      country: resolved.country,
      asn: resolved.asn,
      protocol: resolved.protocol
    }
  }
}

/**
 * 销毁 agent（重连前清理）。
 * Node 的 http.Agent 没有显式销毁 API；通过 destroy 关闭底层连接池。
 */
export function destroyProxyAgents(agents: ProxyAgents): void {
  try {
    ;(agents.agent as Agent & { destroy?: () => void }).destroy?.()
    ;(agents.fetchAgent as Agent & { destroy?: () => void }).destroy?.()
  } catch {
    // ignore
  }
}
