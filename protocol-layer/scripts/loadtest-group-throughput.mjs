#!/usr/bin/env node
/**
 * 本地压测脚本 — 模拟竞品 benchmark：1000 账号 × 100 群 × 100 人
 *
 * 注意：
 *   - 这个脚本走真实 HTTP 接口，不会自动 mock Baileys socket
 *   - 运行前必须准备已导入、已在线、可建群的测试账号
 *   - 如果账号不存在或不在线，会测到 ACCOUNT_NOT_FOUND / NOT_OWNER / PROXY_REQUIRED 等错误
 *   - 真实 SLA 必须连 WA 测试账号才能验；本脚本主要用于观察 HTTP 并发、group-op 限流和指标
 *
 * 用法：
 *   1) 先把协议层启动（standalone 模式）
 *      WORKER_ROLE=standalone REDIS_URL=redis://localhost:6379 \
 *      KAFKA_BROKERS=localhost:9092 node dist/protocol-layer/src/server.js &
 *   2) 跑压测：
 *      node scripts/loadtest-group-throughput.mjs --accounts 1000 --groups 100 --people 100
 *
 * 输出关键指标：
 *   - throughput (groups/sec, adds/sec)
 *   - p50/p95/p99 latency
 *   - error rate by code
 *   - 总耗时 vs 竞品 18 min baseline
 */

import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'

const { values: opts } = parseArgs({
  options: {
    accounts: { type: 'string', default: '1000' },
    groups: { type: 'string', default: '100' },
    people: { type: 'string', default: '100' },
    endpoint: { type: 'string', default: 'http://localhost:8080' },
    apiKey: { type: 'string', default: '' },
    concurrency: { type: 'string', default: '50' }, // 全局并发 HTTP 数（多账号共用）
    mode: { type: 'string', default: 'mock' } // 'mock' / 'real'
  }
})

const ACCOUNTS = Number(opts.accounts)
const GROUPS_PER_ACC = Number(opts.groups)
const PEOPLE_PER_GROUP = Number(opts.people)
const BASE_URL = opts.endpoint
const CONCURRENCY = Number(opts.concurrency)
const API_KEY = opts.apiKey
const TOTAL_OPS = ACCOUNTS * GROUPS_PER_ACC

console.log('═══════════════════════════════════════════════════════════')
console.log(`  loadtest: ${ACCOUNTS} 账号 × ${GROUPS_PER_ACC} 群 × ${PEOPLE_PER_GROUP} 人`)
console.log(`  总操作数: ${TOTAL_OPS}（仅 group.create，不含 add）`)
console.log(`  竞品 baseline: 1000 × 100 × 100 / 18min`)
console.log(`  并发: ${CONCURRENCY}`)
console.log(`  endpoint: ${BASE_URL}`)
console.log('═══════════════════════════════════════════════════════════\n')

// ─── HTTP 客户端 ───
const headers = { 'Content-Type': 'application/json' }
if (API_KEY) headers['x-api-key'] = API_KEY

async function httpPost(path, body) {
  const t0 = performance.now()
  let status = 0
  let errorCode = null
  try {
    const res = await fetch(BASE_URL + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
    status = res.status
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      try { errorCode = JSON.parse(text).code ?? `HTTP_${status}` } catch { errorCode = `HTTP_${status}` }
    }
  } catch (err) {
    errorCode = `EXCEPTION:${err.code ?? err.name ?? 'unknown'}`
  }
  return { ms: performance.now() - t0, status, errorCode }
}

// ─── 假手机号 / accountId ───
function genAccountId(i) { return `loadtest_acc_${String(i).padStart(6, '0')}` }
function genParticipant(idx) { return `1${String(2000000000000 + idx).slice(-12)}` }

// ─── 单账号工作流：串行创建 N 个群 ───
async function runAccount(accountId, latencies, errors) {
  for (let g = 0; g < GROUPS_PER_ACC; g++) {
    const participants = []
    for (let p = 0; p < PEOPLE_PER_GROUP - 1; p++) {
      participants.push(genParticipant((g * PEOPLE_PER_GROUP) + p))
    }
    const r = await httpPost('/v1/groups/create', {
      accountId,
      subject: `loadtest-${accountId}-${g}`,
      participants
    })
    latencies.push(r.ms)
    if (r.errorCode) {
      errors.set(r.errorCode, (errors.get(r.errorCode) ?? 0) + 1)
    }
  }
}

// ─── 并发调度 ───
async function pool(jobs, concurrency) {
  const queue = jobs.slice()
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const fn = queue.shift()
      if (fn) await fn()
    }
  })
  await Promise.all(workers)
}

// ─── 实时进度 ───
const startedAt = Date.now()
let opsDone = 0
const progressTimer = setInterval(() => {
  const elapsedSec = (Date.now() - startedAt) / 1000
  const rate = opsDone / elapsedSec
  const eta = rate > 0 ? (TOTAL_OPS - opsDone) / rate : Infinity
  process.stdout.write(
    `\r  [${(opsDone / TOTAL_OPS * 100).toFixed(1)}%] ` +
    `done=${opsDone}/${TOTAL_OPS}, ` +
    `elapsed=${elapsedSec.toFixed(0)}s, ` +
    `rate=${rate.toFixed(1)} ops/s, ` +
    `eta=${Number.isFinite(eta) ? eta.toFixed(0) + 's' : '?'}      `
  )
}, 1000)

// ─── 主流程 ───
const latencies = []
const errors = new Map()

// 包装：每个账号是一个 job，pool 控制并发账号数
const jobs = []
for (let i = 0; i < ACCOUNTS; i++) {
  const accountId = genAccountId(i)
  jobs.push(async () => {
    await runAccount(accountId, latencies, errors)
    opsDone += GROUPS_PER_ACC
  })
}

await pool(jobs, CONCURRENCY)
clearInterval(progressTimer)
process.stdout.write('\n')

// ─── 统计 ───
const totalMs = Date.now() - startedAt
latencies.sort((a, b) => a - b)
const p = q => latencies[Math.floor(q * latencies.length)] ?? 0
const totalOps = latencies.length
const successOps = totalOps - [...errors.values()].reduce((a, b) => a + b, 0)

console.log('\n═══════════════════════════════════════════════════════════')
console.log('  压测结果')
console.log('═══════════════════════════════════════════════════════════')
console.log(`  总耗时:   ${(totalMs / 1000).toFixed(1)} s  (${(totalMs / 60_000).toFixed(2)} min)`)
console.log(`  总操作:   ${totalOps}`)
console.log(`  成功:     ${successOps}  (${(successOps / totalOps * 100).toFixed(2)}%)`)
console.log(`  失败:     ${totalOps - successOps}`)
console.log(`  吞吐:     ${(successOps / (totalMs / 1000)).toFixed(1)} ops/s`)
console.log()
console.log('  Latency (ms):')
console.log(`    p50  = ${p(0.5).toFixed(0)}`)
console.log(`    p90  = ${p(0.9).toFixed(0)}`)
console.log(`    p95  = ${p(0.95).toFixed(0)}`)
console.log(`    p99  = ${p(0.99).toFixed(0)}`)
console.log(`    max  = ${p(1).toFixed(0)}`)
console.log()
if (errors.size > 0) {
  console.log('  错误码分布:')
  for (const [code, n] of [...errors.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${code.padEnd(30)} ${n}  (${(n / totalOps * 100).toFixed(2)}%)`)
  }
}
console.log('═══════════════════════════════════════════════════════════')
console.log()
console.log('  竞品 baseline (1000 × 100 × 100):  18 min')
console.log(`  本次结果换算成 baseline 体量:       ${(totalMs * 1000 * 100 / (totalOps * 60_000)).toFixed(2)} min`)
console.log()
console.log('  采集 Prometheus 指标:')
console.log(`    curl ${BASE_URL.replace(/:8080.*$/, '')}:8080/metrics | grep -E 'group_op_duration|group_op_inflight'`)
console.log()
