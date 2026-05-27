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
MAX_ACCOUNTS_PER_WORKER=500
KEEPALIVE_INTERVAL_MS=30000
STALE_CHECK_INTERVAL_MS=5000
STALE_THRESHOLD_MS=35000
NODE_RECONNECT_PER_SEC=10
GLOBAL_RECONNECT_PER_SEC=50
ACCOUNT_RECONNECT_COOLDOWN_MS=60000
RECONNECT_BURST=20
WORKER_GROUP_OP_PER_SEC=10
WORKER_GROUP_OP_BURST=20
GROUP_ACCOUNT_LOCK_TTL_MS=30000
GROUP_ACCOUNT_BUSY_RETRY_MS=3000
WORKER_GROUP_BUSY_RETRY_MS=5000
HEARTBEAT_EVENT_ENABLED=false
HEARTBEAT_EVENT_INTERVAL_MS=300000
AUDIT_LOG_SUCCESS_ENABLED=true
AUDIT_LOG_SAMPLE_RATE=1
SLOW_OPERATION_MS=3000
COLD_START_BATCH_SIZE=50
COLD_START_INTERVAL_MS=30000
BAILEYS_SYNC_HISTORY=false
BAILEYS_INIT_QUERIES=false
BAILEYS_MARK_ONLINE=false
BAILEYS_EMIT_OWN_EVENTS=false
EVENT_BACKEND=kafka
EVENT_DLQ_DIR=/tmp/unsea-event-dlq
KAFKA_BROKERS=kafka:9092
KAFKA_TOPIC_ACCOUNT=protocol.account.events.v1
KAFKA_TOPIC_OWNER=protocol.owner.events.v1
KAFKA_TOPIC_MESSAGE=protocol.message.events.v1
KAFKA_TOPIC_GROUP=protocol.group.events.v1
KAFKA_TOPIC_PAIRING=protocol.pairing.events.v1
API_KEYS=replace-with-prod-key
```

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
| `API_KEYS` | 空 | 可选，逗号分隔；配置后所有 `/v1/*` 要求 `x-api-key` 或 `Authorization: Bearer` |
| `REDIS_URL` | redis://localhost:6379 | 含 cluster（逗号分隔多节点） |
| `REGISTRY_REDIS_URL` | 空 | Registry / owner / master lock 专用 Redis；空则复用 REDIS_URL |
| `KEYS_REDIS_URL` | 空 | Baileys keys 专用 Redis；账号量上来后必须拆出 |
| `RATELIMIT_REDIS_URL` | 空 | reconnect 和 group-op 限流专用 Redis |
| `RUNTIME_REDIS_URL` | 空 | proxy/runtime/device/browser display 专用 Redis |
| `ACCOUNT_RECONNECT_COOLDOWN_MS` | 60000 | 单账号重连冷却，防止换 IP / 异常状态重连风暴 |
| `RECONNECT_BURST` | 20 | 重连 token bucket 突发容量下限 |
| `WORKER_GROUP_OP_PER_SEC` | 10 | 单 worker 群写操作令牌速率 |
| `WORKER_GROUP_OP_BURST` | 20 | 单 worker 群写操作突发容量 |
| `GROUP_ACCOUNT_LOCK_TTL_MS` | 30000 | 单账号群写锁 TTL；partial 超时后保留到 TTL |
| `GROUP_ACCOUNT_BUSY_RETRY_MS` | 3000 | ACCOUNT_BUSY 建议重试间隔 |
| `WORKER_GROUP_BUSY_RETRY_MS` | 5000 | WORKER_BUSY 建议重试间隔 |
| `HEARTBEAT_EVENT_ENABLED` | false | 是否发布账号级 Kafka heartbeat；默认关闭避免大规模事件量 |
| `HEARTBEAT_EVENT_INTERVAL_MS` | 300000 | 账号级 Kafka heartbeat 间隔 |
| `AUDIT_LOG_SUCCESS_ENABLED` | true | 是否打印成功审计日志 |
| `AUDIT_LOG_SAMPLE_RATE` | 1 | 成功审计日志采样率，0-1 |
| `EVENT_BACKEND` | kafka | 事件后端，当前生产只支持 kafka |
| `EVENT_DLQ_DIR` | /tmp/unsea-event-dlq | 事件发布失败后的本地 DLQ jsonl 目录，生产建议挂持久卷 |
| `KAFKA_BROKERS` | localhost:9092 | Kafka/MSK broker，逗号分隔 |
| `KAFKA_CLIENT_ID` | protocol-layer | Kafka client id |
| `KAFKA_SSL` | false | MSK TLS listener 设为 true |
| `KAFKA_USERNAME` / `KAFKA_PASSWORD` | 空 | MSK SASL/SCRAM 时配置 |
| `KAFKA_SASL_MECHANISM` | scram-sha-512 | plain / scram-sha-256 / scram-sha-512 |
| `MYSQL_ENABLED` | false | 是否启用 L3 MySQL creds 持久化 |
| `MYSQL_CONNECTION_URI` | mysql://unsea:unsea@localhost:3306/unsea | MySQL 连接串 |
| `MAX_ACCOUNTS_PER_WORKER` | 400 | 单 worker 承载上限；4C8G 单机测试设为 500，4 worker 合计 2000 |
| `MAX_OLD_SPACE_MB` | 1280 | V8 堆上限 |

## 升级流程

1. fork Baileys 锁定 commit（详见 § 9 版本风险清单）
2. CI 跑 unit test + e2e
3. staging 环境跑 1k 账号 12h 长跑（[PHASE0-SOP.md](PHASE0-SOP.md)）
4. 灰度 1 个生产 worker 24h
5. 全量
