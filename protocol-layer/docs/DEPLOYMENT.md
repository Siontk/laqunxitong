# 部署手册（DEPLOYMENT）

> 三台服务器测试环境和功能层联调方案见 [`TEST-ENV-DEPLOYMENT-INTEGRATION.md`](TEST-ENV-DEPLOYMENT-INTEGRATION.md)。

## 环境前置

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node.js | ≥ 20 LTS | 协议层运行时 |
| Redis | ≥ 7 | L2 keys + Registry + 令牌桶 |
| Kafka / AWS MSK | Kafka 3.x | 事件总线（按 accountId 分区、可重放） |
| MySQL | ≥ 8.0 | L3 creds 持久化（可选，建议生产开启） |
| Prometheus + Grafana | latest | 可观测性 |

## 本地开发

```bash
# 启动依赖
cd protocol-layer
docker compose -f deploy/docker-compose.yml up -d redis kafka mysql prometheus grafana

# 安装 + 启动 standalone（master+worker 同进程）
npm install
LOG_PRETTY=true LOG_LEVEL=debug npm run start:dev
```

访问：
- HTTP API: http://localhost:8080
- Swagger: http://localhost:8080/docs
- Metrics: http://localhost:8080/metrics
- Prometheus: http://localhost:9090
- Grafana: http://localhost:3000 (admin / admin)

## 角色模型

```
WORKER_ROLE=standalone   单进程 master + worker（本地开发）
WORKER_ROLE=master       仅 Registry 仲裁、failover；2 副本主备
WORKER_ROLE=worker       承载 socket；N 副本横向扩展
```

## 单机配置（4C8G / 2000 账号）

K8s StatefulSet `protocol-worker.replicas = 4`，每 pod：
- CPU 请求 300m / 上限 1500m
- 内存请求 1Gi / 上限 1.5Gi
- 最大账号数 500

总计：4 worker × 500 = **2000 账号 / 节点**。

环境变量推荐：
```env
NODE_ENV=production
WORKER_ROLE=worker
NODE_ID=node-a
WORKER_ID=node-a-w1
HTTP_HOST=0.0.0.0
HTTP_PORT=8081
PUBLIC_ENDPOINT=http://10.0.1.12:8081
API_KEYS=replace-with-prod-key

MAX_ACCOUNTS_PER_WORKER=500
MAX_OLD_SPACE_MB=1536
KEEPALIVE_INTERVAL_MS=20000
KEEPALIVE_JITTER_MIN_MS=15000
KEEPALIVE_JITTER_MAX_MS=20000
STALE_CHECK_INTERVAL_MS=5000
STALE_THRESHOLD_MS=35000

NODE_RECONNECT_PER_SEC=20
GLOBAL_RECONNECT_PER_SEC=100
ACCOUNT_RECONNECT_COOLDOWN_MS=60000
RECONNECT_BURST=40
WORKER_GROUP_OP_PER_SEC=100
WORKER_GROUP_OP_BURST=200
GROUP_ACCOUNT_LOCK_TTL_MS=90000
GROUP_ACCOUNT_BUSY_RETRY_MS=3000
WORKER_GROUP_BUSY_RETRY_MS=2000
NODE_ONLINE_PER_SEC=50
NODE_ONLINE_BURST=100
GLOBAL_ONLINE_PER_SEC=200
ACCOUNT_ONLINE_COOLDOWN_MS=5000
BATCH_ONLINE_MAX_SIZE=500
BATCH_ONLINE_WAIT_MS=60000

HEARTBEAT_EVENT_ENABLED=false
HEARTBEAT_EVENT_INTERVAL_MS=300000
AUDIT_LOG_SUCCESS_ENABLED=true
AUDIT_LOG_SAMPLE_RATE=0.1
SLOW_OPERATION_MS=3000
COLD_START_BATCH_SIZE=25
COLD_START_INTERVAL_MS=15000
KEYS_L1_SIZE=200000
CREDS_L1_SIZE=50000

BAILEYS_SYNC_HISTORY=false
BAILEYS_INIT_QUERIES=false
BAILEYS_MARK_ONLINE=false
BAILEYS_EMIT_OWN_EVENTS=false

REDIS_URL=redis://redis:6379
REGISTRY_REDIS_URL=redis://redis:6379
KEYS_REDIS_URL=redis://redis:6379
RATELIMIT_REDIS_URL=redis://redis:6379
RUNTIME_REDIS_URL=redis://redis:6379
REDIS_COMMAND_TIMEOUT_MS=5000
REDIS_MAX_RETRIES_PER_REQUEST=3
REDIS_MAX_OFFLINE_QUEUE_SIZE=1000
REDIS_CONNECT_TIMEOUT_MS=5000

MYSQL_ENABLED=true
MYSQL_CONNECTION_URI=mysql://unsea:unsea@mysql:3306/unsea
MYSQL_CONNECTION_LIMIT=8
MYSQL_MAX_IDLE=4
MYSQL_IDLE_TIMEOUT_MS=30000
MYSQL_CONNECT_TIMEOUT_MS=5000
MYSQL_SLOW_WRITE_MS=500

EVENT_BACKEND=kafka
EVENT_DLQ_DIR=/tmp/unsea-event-dlq
KAFKA_BROKERS=kafka:9092
KAFKA_CLIENT_ID=protocol-layer
KAFKA_MAX_INFLIGHT_MESSAGES=2000
KAFKA_TOPIC_ACCOUNT=protocol.account.events.v1
KAFKA_TOPIC_OWNER=protocol.owner.events.v1
KAFKA_TOPIC_MESSAGE=protocol.message.events.v1
KAFKA_TOPIC_GROUP=protocol.group.events.v1
KAFKA_TOPIC_PAIRING=protocol.pairing.events.v1
KAFKA_TOPIC_DLQ=protocol.dlq.v1
```

`HTTP_HOST` 是监听地址，可以是 `0.0.0.0`；`PUBLIC_ENDPOINT` 必须是功能层能访问的真实内网 IP、域名或负载均衡地址，不能写 `0.0.0.0`。如果用 PM2 单机 4 worker，建议每个 worker 暴露独立端口 `8081-8084`，并分别注册对应 `PUBLIC_ENDPOINT`。

单账号 `/online` 只适合少量操作；2000 账号批量恢复必须走 `POST /v1/accounts/online/batch`。该接口会按 owner 分桶，本 worker 账号进入 OnlineGate，远端 owner 账号通过响应里的 `remote[]` 返回给功能层再分发。

## 集群部署

### Secret

```yaml
apiVersion: v1
kind: Secret
metadata: { name: protocol-secrets }
stringData:
  redis_url: "redis://redis-master.redis.svc:6379"
  kafka_brokers: "b-1.protocol-msk.kafka.ap-southeast-1.amazonaws.com:9094,b-2.protocol-msk.kafka.ap-southeast-1.amazonaws.com:9094"
  mysql_url: "mysql://unsea:***@mysql.db.svc:3306/unsea"
```

### 应用

```bash
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/hpa.yaml
kubectl apply -f deploy/k8s/prometheus-rules.yaml
```

### 滚动升级

```bash
# Worker 滚动（一次 1 个，等待 readyz）
kubectl set image statefulset/protocol-worker worker=unsea/protocol-layer:0.2.0
```

Worker 受 SIGTERM 时优雅退出（注销 Registry + 关 ws），Registry master 会触发 failover 把账号迁到其他 worker。账号迁移**不需要重新授权**——只是换 worker，creds 不动（§ 4.3）。

## 配置 Reference

所有配置项见 [`src/config.ts`](../src/config.ts)。常用环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WORKER_ROLE` | standalone | master / worker / standalone |
| `NODE_ID` | random | 节点唯一标识 |
| `WORKER_ID` | random | worker 唯一标识 |
| `HTTP_PORT` | 8080 | HTTP 端口 |
| `PUBLIC_ENDPOINT` | 空 | 功能层直连 worker 的地址；生产必须配置真实可访问地址，不可为 `0.0.0.0` |
| `API_KEYS` | 空 | 可选，逗号分隔；配置后所有 `/v1/*` 要求 `x-api-key` 或 `Authorization: Bearer` |
| `REDIS_URL` | redis://localhost:6379 | 含 cluster（逗号分隔多节点） |
| `REGISTRY_REDIS_URL` | 空 | Registry / owner / master lock 专用 Redis；空则复用 REDIS_URL |
| `KEYS_REDIS_URL` | 空 | Baileys keys 专用 Redis；账号量上来后必须拆出 |
| `RATELIMIT_REDIS_URL` | 空 | reconnect 和 group-op 限流专用 Redis |
| `RUNTIME_REDIS_URL` | 空 | proxy/runtime/device/browser display 专用 Redis |
| `REDIS_COMMAND_TIMEOUT_MS` | 5000 | Redis 单条命令超时，避免慢 Redis 拖死 HTTP 请求 |
| `REDIS_MAX_RETRIES_PER_REQUEST` | 3 | Redis 单命令最大重试次数 |
| `REDIS_MAX_OFFLINE_QUEUE_SIZE` | 1000 | Redis 断连时本地 offline queue 上限，超限记录错误 |
| `REDIS_CONNECT_TIMEOUT_MS` | 5000 | Redis 建连超时 |
| `KEEPALIVE_INTERVAL_MS` | 20000 | 账号 socket keepalive 默认值；启用 jitter 时作为兜底 |
| `KEEPALIVE_JITTER_MIN_MS` | 15000 | 每个账号实际 keepalive 的最小值 |
| `KEEPALIVE_JITTER_MAX_MS` | 20000 | 每个账号实际 keepalive 的最大值；按 accountId 稳定打散 |
| `STALE_CHECK_INTERVAL_MS` | 5000 | STALE 扫描间隔 |
| `STALE_THRESHOLD_MS` | 35000 | 超过该时间无 socket 活跃则判 STALE 并触发重连 |
| `NODE_RECONNECT_PER_SEC` | 20 | 单节点重连令牌速率 |
| `GLOBAL_RECONNECT_PER_SEC` | 100 | 集群级重连令牌速率 |
| `ACCOUNT_RECONNECT_COOLDOWN_MS` | 60000 | 单账号重连冷却，防止换 IP / 异常状态重连风暴 |
| `RECONNECT_BURST` | 40 | 重连 token bucket 突发容量下限 |
| `WORKER_GROUP_OP_PER_SEC` | 100 | 单 worker 群写操作令牌速率 |
| `WORKER_GROUP_OP_BURST` | 200 | 单 worker 群写操作突发容量 |
| `GROUP_ACCOUNT_LOCK_TTL_MS` | 90000 | 单账号群写锁 TTL；partial 超时后保留到 TTL |
| `GROUP_ACCOUNT_BUSY_RETRY_MS` | 3000 | ACCOUNT_BUSY 建议重试间隔 |
| `WORKER_GROUP_BUSY_RETRY_MS` | 2000 | WORKER_BUSY 建议重试间隔 |
| `NODE_ONLINE_PER_SEC` | 50 | 单节点上线令牌速率，批量上线和单 `/online` 共用 |
| `NODE_ONLINE_BURST` | 100 | 单节点上线突发容量 |
| `GLOBAL_ONLINE_PER_SEC` | 200 | 集群级上线令牌速率 |
| `ACCOUNT_ONLINE_COOLDOWN_MS` | 5000 | 单账号上线冷却，防重复拉起 |
| `BATCH_ONLINE_MAX_SIZE` | 500 | `/v1/accounts/online/batch` 单次最大账号数 |
| `BATCH_ONLINE_WAIT_MS` | 60000 | 批量上线中单账号等待上线令牌的最长时间 |
| `HEARTBEAT_EVENT_ENABLED` | false | 是否发布账号级 Kafka heartbeat；默认关闭避免大规模事件量 |
| `HEARTBEAT_EVENT_INTERVAL_MS` | 300000 | 账号级 Kafka heartbeat 间隔 |
| `AUDIT_LOG_SUCCESS_ENABLED` | true | 是否打印成功审计日志 |
| `AUDIT_LOG_SAMPLE_RATE` | 1 | 成功审计日志采样率，0-1 |
| `EVENT_BACKEND` | kafka | 事件后端，当前生产只支持 kafka |
| `EVENT_DLQ_DIR` | /tmp/unsea-event-dlq | 事件发布失败后的本地 DLQ jsonl 目录，生产建议挂持久卷 |
| `KAFKA_BROKERS` | localhost:9092 | Kafka/MSK broker，逗号分隔 |
| `KAFKA_CLIENT_ID` | protocol-layer | Kafka client id |
| `KAFKA_MAX_INFLIGHT_MESSAGES` | 2000 | producer 未 ack 消息上限，超过直接写本地 DLQ 防 OOM |
| `KAFKA_SSL` | false | MSK TLS listener 设为 true |
| `KAFKA_USERNAME` / `KAFKA_PASSWORD` | 空 | MSK SASL/SCRAM 时配置 |
| `KAFKA_SASL_MECHANISM` | scram-sha-512 | plain / scram-sha-256 / scram-sha-512 |
| `MYSQL_ENABLED` | false | 是否启用 L3 MySQL creds 持久化 |
| `MYSQL_CONNECTION_URI` | mysql://unsea:unsea@localhost:3306/unsea | MySQL 连接串 |
| `MYSQL_CONNECTION_LIMIT` | 8 | 每个 worker 的 MySQL 连接池上限 |
| `MYSQL_MAX_IDLE` | 4 | 每个 worker 的 MySQL 空闲连接上限 |
| `MYSQL_IDLE_TIMEOUT_MS` | 30000 | MySQL 空闲连接回收时间 |
| `MYSQL_CONNECT_TIMEOUT_MS` | 5000 | MySQL 建连超时 |
| `MYSQL_SLOW_WRITE_MS` | 500 | 预留慢写阈值，后续用于 L3 写入告警 |
| `MAX_ACCOUNTS_PER_WORKER` | 400 | 单 worker 承载上限；4C8G 单机测试设为 500，4 worker 合计 2000 |
| `MAX_OLD_SPACE_MB` | 1280 | V8 堆上限 |

## 升级流程

1. fork Baileys 锁定 commit（详见 § 9 版本风险清单）
2. CI 跑 unit test + e2e
3. staging 环境跑 1k 账号 12h 长跑（[PHASE0-SOP.md](PHASE0-SOP.md)）
4. 灰度 1 个生产 worker 24h
5. 全量
