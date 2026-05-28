# 单节点测试环境运维手册

> 测试环境：1 台服务器 + 1 台 Kafka + 1 台 Redis（无副本，无 HA）
> 本文回答"单点架构下哪些隐患做了加固，运维要怎么应对"。

## 一、单点环境的根本限制

| 组件 | 单点风险 | 协议层加固 |
|------|---------|-----------|
| **Redis** | 实例挂 = 全部账号无法发消息 | 客户端超时 + 重试 + offline queue 上限，挂掉时业务路径 fail-fast 不卡 |
| **Kafka** | broker 挂 = 事件全进 DLQ | producer inflight 上限 + DLQ 本地兜底，broker 恢复后回放 |
| **协议层进程** | Node 进程崩 = 当前连接全断 | PM2 autorestart + graceful drain + 进程 metric |

**真要 HA 必须加副本**，单点架构只能"挂得慢一点 + 看得见"。下面是我们做到的事。

## 二、协议层加固清单（已落地）

### 1. Redis 客户端容错

```bash
# 默认值，按需调
REDIS_COMMAND_TIMEOUT_MS=5000        # 单条命令超时 5s，Redis 慢命令 fail-fast
REDIS_MAX_RETRIES_PER_REQUEST=3      # 失败重试 3 次后 reject
REDIS_MAX_OFFLINE_QUEUE_SIZE=1000    # Redis 挂时本地堆积上限，防 Node OOM
REDIS_CONNECT_TIMEOUT_MS=5000        # 连接握手超时
```

**行为**：
- Redis 挂 → 命令在 1000 队列里堆积，超过后旧的被截断
- Redis 命令慢 → 5s 后 reject，业务路径 throw → fastify 返 500，业务侧重试
- Redis 主从切换 → 自动重连并 resend 命令（READONLY 错误自愈）

**监控**：`unsea_redis_client_error_total{instance}` rate 持续 > 1/s 视为 Redis 不稳。

### 2. Kafka producer 容错

```bash
KAFKA_MAX_INFLIGHT_MESSAGES=2000     # 未 ack 上限，超过后直接走 DLQ
EVENT_DLQ_DIR=/tmp/unsea-event-dlq   # 本地 jsonl 文件
```

**行为**：
- Kafka 挂 → producer 3 次重试 → 写本地 DLQ jsonl
- 业务侧调用 `publish()` **永远不会 throw**（DLQ 兜底）
- inflight > 2000 → 新事件**不进 producer 队列**，直接 DLQ，防 OOM
- Kafka 恢复后用运维脚本回放 DLQ（见下文）

**监控**：
- `unsea_kafka_producer_inflight` > 500 持续 30s 警告
- `unsea_events_publish_errors_total{reason="dlq"}` rate > 10/s 严重

### 3. 进程崩溃 graceful drain

```bash
# uncaughtException / unhandledRejection 不立刻 exit
# 给 10s 让 in-flight 请求处理完，readyz 立即返 503 阻止新流量
```

**行为**：
1. uncaught 错误 → 标记 `isShuttingDown=true` → `/readyz` 返 503
2. 等 10s（让 in-flight 业务完成）
3. shutdown 序列：staleDetector / reconciler / master / app / publisher / Redis quit
4. exit(1) → PM2 / systemd 拉起新进程

**注意**：极少数 V8 内部 panic 会绕过这套，直接 SIGABRT。靠 PM2 autorestart 兜底。

### 4. libsignal 错误可见性

```promql
# 协议层捕获的 libsignal 类错误
unsea_libsignal_error_total{kind="decrypt|encrypt|handshake|unknown"}
```

通常应该是 0；非 0 持续出现说明 creds/keys 漂移，需要排查单账号是否要 NEED_REAUTH。

### 5. 代理失败计数

```promql
unsea_proxy_failed_total                    # 累计代理失败
rate(unsea_proxy_failed_total[5m])          # 每秒代理失败率
```

> 10% 总连接的失败率持续 → 代理供应商质量问题。

## 三、单点环境推荐部署

### Docker Compose（一台机器装全套）

```yaml
# deploy/docker-compose.yml 已经齐全：
#   - redis: 单实例
#   - kafka: 单 broker (KRaft mode)
#   - protocol-layer: standalone（单进程跑 master + worker）

docker compose -f deploy/docker-compose.yml up -d
docker compose logs -f protocol-layer
```

### PM2（推荐 — 4 worker 进程并发）

```bash
# 即使在单机也用 4 worker，对齐 4 核 CPU
pm2 start deploy/pm2.config.cjs
pm2 logs --lines 200
```

### 资源监控

```bash
# 进程
pm2 status
pm2 monit          # 实时 CPU / memory / event loop

# Redis
redis-cli info clients
redis-cli info stats | grep -E 'instantaneous|connected_clients'
redis-cli --latency

# Kafka
docker exec kafka kafka-consumer-groups --bootstrap-server localhost:9092 --list
docker exec kafka kafka-topics --describe --bootstrap-server localhost:9092

# 协议层 metric
curl http://localhost:8081/metrics | grep -E 'redis_client_error|kafka_producer_inflight|uncaught_error|libsignal_error'
```

## 四、单点故障应急处置

### Redis 重启

```bash
# 1. 提前确认账号状态导出（可选）
curl http://localhost:8081/v1/accounts/{id}/export/baileys-json > backup.json

# 2. 重启 Redis（数据丢失！测试环境可接受，生产必须 AOF/RDB）
systemctl restart redis

# 3. 协议层会自动重连，但因为 Redis 数据丢失，账号需要重新 pairing
# 4. 监控
watch -n 1 'curl -s http://localhost:8081/metrics | grep redis_client_error'
```

**Redis 持久化**（强烈推荐即使测试环境也开）：

```redis
# /etc/redis/redis.conf
appendonly yes
appendfsync everysec
save 900 1
save 300 10
save 60 10000
```

### Kafka 重启

```bash
# 1. 重启
docker restart kafka

# 2. 协议层会自动检测 isReady=false，readyz 返 503
# 3. 期间所有事件进 /tmp/unsea-event-dlq/{yyyy-mm-dd}.jsonl
# 4. Kafka 恢复后运维回放：
ls /tmp/unsea-event-dlq/

# 回放脚本（手写一个最简单的）
node -e '
  const fs = require("fs");
  const { Kafka } = require("kafkajs");
  const lines = fs.readFileSync("/tmp/unsea-event-dlq/2026-05-28.jsonl", "utf8").trim().split("\n");
  const kafka = new Kafka({ brokers: ["localhost:9092"], clientId: "dlq-replay" });
  const producer = kafka.producer({ idempotent: true });
  (async () => {
    await producer.connect();
    for (const line of lines) {
      const { envelope } = JSON.parse(line);
      const topic = "protocol." + envelope.event.split(".")[0] + ".events.v1";
      await producer.send({ topic, messages: [{ key: envelope.accountId, value: JSON.stringify(envelope) }] });
    }
    await producer.disconnect();
    console.log("replayed", lines.length);
  })();
'
```

### 协议层进程崩溃

```bash
# PM2 自动重启
pm2 status                # 看 restart 次数
pm2 logs protocol-worker-1 --err --lines 200

# 进程频繁重启（> 5 次/分钟）
# 关掉 autorestart，手动排查
pm2 stop protocol-worker-1

# 看 uncaughtException 来源
grep 'uncaughtException\|fatal' /var/log/pm2/*.log | tail -100
```

## 五、关键告警阈值

| metric | 阈值 | 严重度 | 含义 |
|--------|------|------|------|
| `unsea_redis_client_error_total` rate | > 1/s × 1min | 严重 | Redis 不稳 |
| `unsea_kafka_producer_inflight` | > 500 × 30s | 警告 | Kafka 慢或挂 |
| `unsea_kafka_producer_inflight` | > 1500 × 1min | 严重 | Kafka 卡死边缘 |
| `unsea_events_publish_errors_total{reason="dlq"}` rate | > 1/s | 警告 | 事件丢失，需要回放 DLQ |
| `unsea_uncaught_error_total` | 任何非零 | 严重 | 进程级 bug 暴露 |
| `unsea_libsignal_error_total` rate | > 0.1/s | 警告 | creds 漂移 |
| `unsea_proxy_failed_total` rate | > 1/s × 5min | 警告 | 代理供应商问题 |
| `unsea_event_loop_lag_seconds` | > 0.1 | 警告 | Node 跑不动 |
| `process_resident_memory_bytes` | > 1.8 GB | 警告 | 单进程接近 OOM |
| `unsea_l1_hit_ratio{store="keys"}` | < 0.5 持续 5min | 警告 | L2 Redis 压力大或 L1 太小 |

## 六、调参对照表

| 场景 | 调什么 |
|------|--------|
| Redis 慢命令拖延 | 减 `REDIS_COMMAND_TIMEOUT_MS` 到 3000 |
| Redis 内存吃紧 | 减 `KEYS_L1_SIZE` 到 100000 |
| Kafka 经常 inflight 高 | 减事件量：`HEARTBEAT_EVENT_ENABLED=false` + `AUDIT_LOG_SAMPLE_RATE=0.05` |
| 拉群业务慢 | 加 `WORKER_GROUP_OP_PER_SEC=150` 试试 |
| 上线慢 | 加 `NODE_ONLINE_PER_SEC=80` 试试，但要看 event_loop_lag |
| 单进程 OOM | 减 `MAX_ACCOUNTS_PER_WORKER` 到 400 |
| Node uncaught 频繁 | 看日志，**别盲目重启** — uncaught 一定是代码 bug |

## 七、压测路径

```bash
# 1. 启所有依赖
docker compose up -d redis kafka

# 2. 启协议层 4 worker
pm2 start deploy/pm2.config.cjs

# 3. 看 metric 基线
curl -s http://localhost:8081/metrics | grep -E '(redis|kafka|online|group_op)_' | sort

# 4. 跑批量上线压测
node scripts/loadtest-group-throughput.mjs \
  --accounts 500 --groups 5 --people 10 \
  --endpoint http://localhost:8081 \
  --concurrency 30

# 5. 期间用 metric 校验：
#    - online_inflight 应该 < 50
#    - redis_client_error_total 不增
#    - kafka_producer_inflight < 200
#    - event_loop_lag_seconds < 0.05
```

## 八、生产升级路径

| 需求 | 升级动作 |
|------|---------|
| Redis HA | 加 1 个从节点 + Sentinel；客户端配 Sentinel URL |
| Redis 横向 | 上 Redis Cluster（key 已经带 `{registry}` hash tag） |
| Kafka HA | 3 broker + replication-factor=3 + min.insync.replicas=2 |
| 协议层 HA | 加 2 个节点，前置 Nginx/Envoy 按 ownerEndpoint 分流（资料已在事件里） |
| 跨 region | 加 Phase 2/3 配置，详见 [MILLION-SCALE-SHARDING.md](MILLION-SCALE-SHARDING.md) |

升级**不需要改代码**，全部走环境变量 + 部署配置。
