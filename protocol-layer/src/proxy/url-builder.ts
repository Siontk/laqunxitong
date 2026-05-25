/**
 * Proxy URL 构造器。
 *
 * 输入：业务层传 ProxyBinding（含 sessionId / country / asn / 完整 url 模板）
 * 输出：实际可用的代理 URL，session 参数已替换
 *
 * 设计原则（§ 4.6）：
 *   - 绑定的是 sessionId，不是 IP
 *   - country / asn 必须钉死
 *   - 不同供应商 URL 模板不同（Bright Data / Smartproxy / IPRoyal / 自建）
 */

import type { ProxyBinding } from '../types/api.js'

export interface ResolvedProxy {
  protocol: 'socks5' | 'http'
  url: string
  sessionId: string
  country: string
  asn?: string
}

export function resolveProxyUrl(binding: ProxyBinding): ResolvedProxy {
  // ProxyBinding.url 是模板，可能含 {sessionId} / {country} 占位
  let url = binding.url
  url = url.replace(/\{sessionId\}/g, binding.sessionId)
  url = url.replace(/\{country\}/g, binding.country)
  if (binding.region) url = url.replace(/\{region\}/g, binding.region)
  if (binding.asn) url = url.replace(/\{asn\}/g, binding.asn)
  return {
    protocol: binding.protocol,
    url,
    sessionId: binding.sessionId,
    country: binding.country,
    asn: binding.asn ?? undefined
  }
}
