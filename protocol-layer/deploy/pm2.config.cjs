/**
 * PM2 多进程配置 — 单节点 4 worker × 500 账号 = 2000 在线。
 *
 * 用法：
 *   1) 装 PM2：npm i -g pm2
 *   2) 启动：pm2 start deploy/pm2.config.cjs
 *   3) 看状态：pm2 status / pm2 logs --lines 200
 *   4) 优雅重启：pm2 reload all     # 滚动重启，不丢账号
 *   5) 完全停：pm2 delete all
 *
 * 设计：
 *   - 1 个 master 进程：仲裁 dead worker + failover，独立角色不持有账号
 *   - 4 个 worker 进程：每个 500 账号、1 核、1.5GB heap
 *   - master 用 LEADER 锁主备，多机部署时只有一个 master 在跑
 *   - worker 独立 HTTP 端口（8081-8084），业务侧通过 ownerEndpoint 直连
 *   - 节点对外暴露端口由前置负载均衡或服务发现处理（nginx / envoy / k8s svc）
 *
 * 4C8G 内存预算：
 *   master:  500 MB heap
 *   worker × 4: 1.5 GB × 4 = 6 GB
 *   OS + buffer: ~1 GB
 *   合计 ~7.5 GB，留 0.5 GB 余量
 */

const HOST = process.env.HTTP_HOST || '0.0.0.0'
const NODE_ID = process.env.NODE_ID || `node-${require('os').hostname()}`
const REGION = process.env.REGION || 'cn-east-1'
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const KAFKA_BROKERS = process.env.KAFKA_BROKERS || 'localhost:9092'

const sharedEnv = {
  NODE_ENV: 'production',
  HTTP_HOST: HOST,
  NODE_ID,
  REGION,
  REDIS_URL,
  KAFKA_BROKERS,
  // 4 worker × 500 账号 = 2000 在线
  MAX_ACCOUNTS_PER_WORKER: '500',
  // 重连风暴控制
  NODE_RECONNECT_PER_SEC: '20',
  RECONNECT_BURST: '40',
  // 业务节流（每 worker）
  WORKER_GROUP_OP_PER_SEC: '100',
  WORKER_GROUP_OP_BURST: '200',
  // 冷启动 4 × 25 / 15s = 6.7 acc/s 单节点上线，2000 账号大约 5 分钟到 ONLINE
  COLD_START_BATCH_SIZE: '25',
  COLD_START_INTERVAL_MS: '15000',
  // L1 缓存（每 worker）
  KEYS_L1_SIZE: '200000',
  CREDS_L1_SIZE: '50000',
  // 心跳事件默认关，节省 Kafka 流量；监控走 Prometheus 不走事件
  HEARTBEAT_EVENT_ENABLED: 'false',
  // 日志级别
  LOG_LEVEL: 'info',
  AUDIT_LOG_SAMPLE_RATE: '0.1' // 业务审计采样 10%，群操作量大时减压
}

module.exports = {
  apps: [
    {
      name: 'protocol-master',
      script: 'dist/protocol-layer/src/server.js',
      node_args: ['--enable-source-maps', '--max-old-space-size=512'],
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '60s',
      kill_timeout: 30_000,
      env: {
        ...sharedEnv,
        WORKER_ROLE: 'master',
        WORKER_ID: `${NODE_ID}-master`,
        HTTP_PORT: '8080'
      }
    },
    ...[1, 2, 3, 4].map(i => ({
      name: `protocol-worker-${i}`,
      script: 'dist/protocol-layer/src/server.js',
      node_args: ['--enable-source-maps', '--max-old-space-size=1536'],
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '60s',
      kill_timeout: 30_000,
      env: {
        ...sharedEnv,
        WORKER_ROLE: 'worker',
        WORKER_ID: `${NODE_ID}-w${i}`,
        HTTP_PORT: String(8080 + i),
        PUBLIC_ENDPOINT: `http://${HOST}:${8080 + i}`
      }
    }))
  ]
}
