# 测试环境部署与功能层联调方案

本文用于当前测试环境：协议层、Redis、Kafka 分三台服务器部署，并给功能层说明如何联调 HTTP、Kafka 和账号 owner 路由。

## 1. 总体拓扑

三台服务器用于联调：

```text
protocol-server  协议层 HTTP 服务
redis-server     协议层内部 Redis
kafka-server     Kafka 单 broker 测试环境
```

调用链：

```text
功能层
  ├─ HTTP -> protocol-server:8080
  └─ Kafka consumer -> kafka-server:9092

协议层
  ├─ Redis -> redis-server:6379
  └─ Kafka producer -> kafka-server:9092
```

边界约定：

- 功能层不直接读写协议层 Redis。
- 功能层通过 HTTP 调用协议原子能力。
- 功能层通过 Kafka 消费协议事件，维护自己的账号状态表和 owner cache。
- Kafka message key 固定为 `accountId`，同账号事件在同一 partition 内有序。

## 2. 服务器规划

| 服务器 | 建议规格 | 端口 | 用途 |
|---|---:|---|---|
| protocol-server | 2C8G 起步 | 8080 | 协议 HTTP、Swagger、metrics |
| redis-server | 2C4G / 2C8G | 6379 | Registry、owner、keys、限流 |
| kafka-server | 2C8G 起步 | 9092 | 测试 Kafka 单 broker |

安全组只开放内网：

| 来源 | 目标 | 端口 |
|---|---|---|
| 功能层服务器 | protocol-server | 8080 |
| protocol-server | redis-server | 6379 |
| protocol-server | kafka-server | 9092 |
| 功能层服务器 | kafka-server | 9092 |

Redis 和 Kafka 不要开放公网。

Kafka 集群模式还需要 Kafka broker 之间互通 `9092` 和 `9093`。`9093` 是 KRaft controller 通信端口，不给功能层和协议层使用。

如果要验证账号重启恢复和长期 creds 持久化，建议再加一台 MySQL 或使用 AWS RDS MySQL；三台最小联调环境也可以先 `MYSQL_ENABLED=false`，此时 L3 冷持久化不参与测试。

## 3. Redis 部署

在 `redis-server` 安装 Docker：

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
mkdir -p ~/redis/data
```

创建 `~/redis/docker-compose.yml`：

```yaml
services:
  redis:
    image: redis:7-alpine
    container_name: protocol-redis
    restart: always
    command:
      - redis-server
      - --appendonly
      - "yes"
      - --requirepass
      - "REPLACE_WITH_STRONG_PASSWORD"
      - --maxmemory
      - "2gb"
      - --maxmemory-policy
      - "noeviction"
    ports:
      - "6379:6379"
    volumes:
      - ./data:/data
```

启动：

```bash
cd ~/redis
sudo docker compose up -d
sudo docker logs -f protocol-redis
```

验证：

```bash
sudo docker exec -it protocol-redis redis-cli -a 'REPLACE_WITH_STRONG_PASSWORD' ping
```

返回：

```text
PONG
```

2C4G Redis 先设 `2gb`；2C8G Redis 可以改成 `5gb` 或 `6gb`。协议层配置：

```env
REDIS_URL=redis://:REPLACE_WITH_STRONG_PASSWORD@redis-server-private-ip:6379
REDIS_KEY_PREFIX=unsea:
```

功能层不需要 Redis 连接串。功能层如果要做 owner cache，使用功能层自己的 Redis 或数据库。

## 4. Kafka 单机测试部署

当前三台服务器只能部署 Kafka 单 broker，适合联调，不是高可用集群。

在 `kafka-server` 安装 Docker：

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
mkdir -p ~/kafka/data
```

创建 `~/kafka/docker-compose.yml`，把 `KAFKA_PRIVATE_IP` 替换成 Kafka 服务器内网 IP：

```yaml
services:
  kafka:
    image: bitnami/kafka:3.7
    container_name: protocol-kafka
    restart: always
    ports:
      - "9092:9092"
      - "9093:9093"
    volumes:
      - ./data:/bitnami/kafka
    environment:
      KAFKA_ENABLE_KRAFT: "yes"
      KAFKA_CFG_NODE_ID: "1"
      KAFKA_CFG_PROCESS_ROLES: "broker,controller"
      KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: "1@KAFKA_PRIVATE_IP:9093"
      KAFKA_CFG_LISTENERS: "PLAINTEXT://:9092,CONTROLLER://:9093"
      KAFKA_CFG_ADVERTISED_LISTENERS: "PLAINTEXT://KAFKA_PRIVATE_IP:9092"
      KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP: "PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT"
      KAFKA_CFG_CONTROLLER_LISTENER_NAMES: "CONTROLLER"
      KAFKA_CFG_INTER_BROKER_LISTENER_NAME: "PLAINTEXT"
      KAFKA_CFG_AUTO_CREATE_TOPICS_ENABLE: "false"
      KAFKA_CFG_OFFSETS_TOPIC_REPLICATION_FACTOR: "1"
      KAFKA_CFG_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "1"
      KAFKA_CFG_TRANSACTION_STATE_LOG_MIN_ISR: "1"
```

启动：

```bash
cd ~/kafka
sudo docker compose up -d
sudo docker logs -f protocol-kafka
```

创建 topic：

```bash
sudo docker exec -it protocol-kafka kafka-topics.sh --bootstrap-server localhost:9092 --create --topic protocol.account.events.v1 --partitions 12 --replication-factor 1
sudo docker exec -it protocol-kafka kafka-topics.sh --bootstrap-server localhost:9092 --create --topic protocol.owner.events.v1 --partitions 12 --replication-factor 1
sudo docker exec -it protocol-kafka kafka-topics.sh --bootstrap-server localhost:9092 --create --topic protocol.message.events.v1 --partitions 12 --replication-factor 1
sudo docker exec -it protocol-kafka kafka-topics.sh --bootstrap-server localhost:9092 --create --topic protocol.group.events.v1 --partitions 12 --replication-factor 1
sudo docker exec -it protocol-kafka kafka-topics.sh --bootstrap-server localhost:9092 --create --topic protocol.pairing.events.v1 --partitions 12 --replication-factor 1
```

查看 topic：

```bash
sudo docker exec -it protocol-kafka kafka-topics.sh --bootstrap-server localhost:9092 --list
```

协议层配置：

```env
EVENT_BACKEND=kafka
KAFKA_BROKERS=kafka-server-private-ip:9092
KAFKA_SSL=false
KAFKA_CLIENT_ID=protocol-layer
KAFKA_TOPIC_ACCOUNT=protocol.account.events.v1
KAFKA_TOPIC_OWNER=protocol.owner.events.v1
KAFKA_TOPIC_MESSAGE=protocol.message.events.v1
KAFKA_TOPIC_GROUP=protocol.group.events.v1
KAFKA_TOPIC_PAIRING=protocol.pairing.events.v1
```

协议层 producer 禁止自动建 topic；5 个 topic 必须提前创建且名字必须和环境变量完全一致。发布失败会写本地文件 DLQ：`EVENT_DLQ_DIR/YYYY-MM-DD.jsonl`，生产需要给这个目录挂持久盘并做磁盘告警。

功能层 Kafka 配置：

```env
KAFKA_BROKERS=kafka-server-private-ip:9092
KAFKA_CONSUMER_GROUP=function-layer-staging
```

## 5. Kafka 集群型部署

真正集群型 Kafka 至少 3 台 Kafka 服务器：

```text
kafka-1 10.0.1.11
kafka-2 10.0.1.12
kafka-3 10.0.1.13
```

每台都运行 broker + controller。共同配置：

```yaml
KAFKA_ENABLE_KRAFT: "yes"
KAFKA_CFG_PROCESS_ROLES: "broker,controller"
KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: "1@10.0.1.11:9093,2@10.0.1.12:9093,3@10.0.1.13:9093"
KAFKA_CFG_LISTENERS: "PLAINTEXT://:9092,CONTROLLER://:9093"
KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP: "PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT"
KAFKA_CFG_CONTROLLER_LISTENER_NAMES: "CONTROLLER"
KAFKA_CFG_INTER_BROKER_LISTENER_NAME: "PLAINTEXT"
KAFKA_CFG_OFFSETS_TOPIC_REPLICATION_FACTOR: "3"
KAFKA_CFG_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "3"
KAFKA_CFG_TRANSACTION_STATE_LOG_MIN_ISR: "2"
```

每台不同：

```yaml
# kafka-1
KAFKA_CFG_NODE_ID: "1"
KAFKA_CFG_ADVERTISED_LISTENERS: "PLAINTEXT://10.0.1.11:9092"

# kafka-2
KAFKA_CFG_NODE_ID: "2"
KAFKA_CFG_ADVERTISED_LISTENERS: "PLAINTEXT://10.0.1.12:9092"

# kafka-3
KAFKA_CFG_NODE_ID: "3"
KAFKA_CFG_ADVERTISED_LISTENERS: "PLAINTEXT://10.0.1.13:9092"
```

集群 topic 建议：

```bash
kafka-topics.sh --bootstrap-server 10.0.1.11:9092 --create --topic protocol.account.events.v1 --partitions 24 --replication-factor 3
kafka-topics.sh --bootstrap-server 10.0.1.11:9092 --create --topic protocol.owner.events.v1 --partitions 24 --replication-factor 3
kafka-topics.sh --bootstrap-server 10.0.1.11:9092 --create --topic protocol.message.events.v1 --partitions 24 --replication-factor 3
kafka-topics.sh --bootstrap-server 10.0.1.11:9092 --create --topic protocol.group.events.v1 --partitions 24 --replication-factor 3
kafka-topics.sh --bootstrap-server 10.0.1.11:9092 --create --topic protocol.pairing.events.v1 --partitions 24 --replication-factor 3
```

协议层和功能层都配置：

```env
KAFKA_BROKERS=10.0.1.11:9092,10.0.1.12:9092,10.0.1.13:9092
```

生产建议直接使用 AWS MSK，减少自建 Kafka 运维成本。

## 6. 协议层部署

在 `protocol-server` 安装依赖：

```bash
sudo apt update
sudo apt install -y git curl nodejs npm
node -v
npm -v
```

如果系统 Node.js 低于 20，使用 NodeSource 安装 Node.js 20：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

拉代码并构建：

```bash
git clone https://github.com/Siontk/laqunxitong.git
cd laqunxitong/protocol-layer
npm install
npm run build
```

创建 `~/protocol.env`：

```env
NODE_ENV=staging
WORKER_ROLE=standalone
NODE_ID=protocol-node-1
WORKER_ID=worker-1
HTTP_HOST=0.0.0.0
HTTP_PORT=8080
PUBLIC_ENDPOINT=http://protocol-server-private-ip:8080
API_KEYS=REPLACE_WITH_API_KEY

REDIS_URL=redis://:REPLACE_WITH_STRONG_PASSWORD@redis-server-private-ip:6379
REDIS_KEY_PREFIX=unsea:

EVENT_BACKEND=kafka
EVENT_DLQ_DIR=/tmp/unsea-event-dlq
KAFKA_BROKERS=kafka-server-private-ip:9092
KAFKA_SSL=false
KAFKA_CLIENT_ID=protocol-layer
KAFKA_TOPIC_ACCOUNT=protocol.account.events.v1
KAFKA_TOPIC_OWNER=protocol.owner.events.v1
KAFKA_TOPIC_MESSAGE=protocol.message.events.v1
KAFKA_TOPIC_GROUP=protocol.group.events.v1
KAFKA_TOPIC_PAIRING=protocol.pairing.events.v1

MYSQL_ENABLED=false
# 如果启用 L3:
# MYSQL_CONNECTION_URI=mysql://unsea:password@mysql-server-private-ip:3306/unsea

MAX_ACCOUNTS_PER_WORKER=200
MAX_OLD_SPACE_MB=1536
KEEPALIVE_INTERVAL_MS=30000
STALE_CHECK_INTERVAL_MS=5000
STALE_THRESHOLD_MS=35000
NODE_RECONNECT_PER_SEC=5
GLOBAL_RECONNECT_PER_SEC=20
COLD_START_BATCH_SIZE=20
COLD_START_INTERVAL_MS=30000

BAILEYS_SYNC_HISTORY=false
BAILEYS_INIT_QUERIES=false
BAILEYS_MARK_ONLINE=false
BAILEYS_EMIT_OWN_EVENTS=false

LOG_LEVEL=info
LOG_PRETTY=false
```

`MYSQL_ENABLED=false` 只适合短期联调 HTTP/Kafka 流程。关闭 MySQL 时，账号重启恢复、长期 creds 备份、灾备验证不完整；正式测试建议接 AWS RDS MySQL，并且功能层不要读取协议层 MySQL。

启动：

```bash
cd ~/laqunxitong/protocol-layer
set -a
source ~/protocol.env
set +a
npm run start
```

建议后续用 `systemd` 托管：

```ini
[Unit]
Description=Protocol Layer
After=network.target

[Service]
WorkingDirectory=/home/ubuntu/laqunxitong/protocol-layer
EnvironmentFile=/home/ubuntu/protocol.env
ExecStart=/usr/bin/node --enable-source-maps --max-old-space-size=1536 dist/protocol-layer/src/server.js
Restart=always
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
```

保存为 `/etc/systemd/system/protocol-layer.service` 后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now protocol-layer
sudo journalctl -u protocol-layer -f
```

验证：

```bash
curl http://protocol-server-private-ip:8080/healthz
curl http://protocol-server-private-ip:8080/readyz
curl http://protocol-server-private-ip:8080/docs
```

## 7. 功能层联调方式

功能层需要拿到：

```text
PROTOCOL_BASE_URL=http://protocol-server-private-ip:8080
PROTOCOL_API_KEY=REPLACE_WITH_API_KEY
KAFKA_BROKERS=kafka-server-private-ip:9092
KAFKA_TOPICS=protocol.owner.events.v1,protocol.account.events.v1,protocol.message.events.v1,protocol.group.events.v1,protocol.pairing.events.v1
```

HTTP 通用 header：

```http
x-api-key: REPLACE_WITH_API_KEY
content-type: application/json
```

功能层调用流程：

1. 登录、导入、online 先调用协议 HTTP。
2. 从 HTTP 响应里的 `routing.ownerEndpoint` 写入功能层 owner cache。
3. 同时消费 `protocol.owner.events.v1`，持续更新 owner cache。
4. 下发发消息、群操作等账号级动作时，先查功能层 owner cache。
5. cache miss 调 `GET /v1/accounts/resolve/{accountId}`。
6. 拿到 `ownerEndpoint` 后直连 owner。
7. 如果返回 `409 NOT_OWNER`，按错误详情刷新 owner cache 并重试一次。

## 8. 功能层 Kafka 消费

功能层至少消费这些 topic：

| Topic | 必须消费 | 用途 |
|---|---|---|
| `protocol.owner.events.v1` | 是 | 更新账号 owner cache |
| `protocol.account.events.v1` | 是 | 更新账号状态和异常 |
| `protocol.message.events.v1` | 按业务 | 收消息、消息 ack |
| `protocol.group.events.v1` | 按业务 | 群事件 |
| `protocol.pairing.events.v1` | 是 | pairing code、授权结果 |

事件 envelope：

```json
{
  "eventId": "acc_001:account.owner_assigned:m4abc123:k9x7p2la",
  "event": "account.owner_assigned",
  "version": "v1",
  "accountId": "acc_001",
  "occurredAt": "2026-05-26T10:00:00.000Z",
  "workerId": "worker-1",
  "data": {
    "accountId": "acc_001",
    "ownerWorkerId": "worker-1",
    "ownerEndpoint": "http://protocol-server-private-ip:8080",
    "assignedAt": "2026-05-26T10:00:00.000Z"
  }
}
```

消费规则：

- consumer group 使用功能层自己的名字，例如 `function-layer-staging`。
- 优先用 `eventId` 做幂等；如果旧事件没有 `eventId`，再用 `accountId + event + occurredAt` 兜底。
- owner 事件先处理，避免后续 HTTP 打错 worker。
- 消费失败进入功能层自己的 DLQ，不要无限阻塞主消费。
- 功能层不要依赖 Kafka offset 作为业务唯一 ID。

Java 伪代码：

```java
for (ConsumerRecord<String, String> record : records) {
  String accountId = record.key();
  EventEnvelope event = objectMapper.readValue(record.value(), EventEnvelope.class);

  if (event.event.equals("account.owner_assigned")
      || event.event.equals("account.owner_changed")) {
    ownerCache.set(accountId, event.data.ownerEndpoint, event.data.ownerWorkerId);
  }

  if (event.event.equals("account.owner_unassigned")) {
    ownerCache.delete(accountId);
  }

  if (event.event.equals("account.state_changed")
      || event.event.equals("account.need_reauth")) {
    accountStateTable.upsert(accountId, event.data);
  }

  if (event.event.equals("message.received")
      || event.event.equals("message.ack")) {
    messageTable.insertIdempotent(accountId, event.data);
  }
}
consumer.commitSync();
```

## 9. HTTP 联调示例

Pairing Code：

```bash
curl -X POST http://protocol-server-private-ip:8080/v1/auth/pairing-code \
  -H 'content-type: application/json' \
  -H 'x-api-key: REPLACE_WITH_API_KEY' \
  -d '{
    "phone": "8613800000000",
    "customPairingCode": "12345678",
    "proxy": {
      "protocol": "socks5",
      "url": "socks5://user:pass@proxy-host:1080",
      "sessionId": "acc_8613800000000",
      "country": "US"
    },
    "browserDisplay": {
      "browserName": "Opera",
      "platform": "ios",
      "version": "17.5"
    }
  }'
```

解析 owner：

```bash
curl http://protocol-server-private-ip:8080/v1/accounts/resolve/acc_8613800000000 \
  -H 'x-api-key: REPLACE_WITH_API_KEY'
```

发文本：

```bash
curl -X POST http://owner-endpoint/v1/messages/text \
  -H 'content-type: application/json' \
  -H 'x-api-key: REPLACE_WITH_API_KEY' \
  -d '{
    "accountId": "acc_8613800000000",
    "jid": "8613900000000@s.whatsapp.net",
    "text": "hello"
  }'
```

发链接：

```bash
curl -X POST http://owner-endpoint/v1/messages/link \
  -H 'content-type: application/json' \
  -H 'x-api-key: REPLACE_WITH_API_KEY' \
  -d '{
    "accountId": "acc_8613800000000",
    "jid": "8613900000000@s.whatsapp.net",
    "text": "https://example.com",
    "generatePreview": true
  }'
```

添加群成员：

```bash
curl -X POST http://owner-endpoint/v1/groups/120xxx@g.us/participants/add \
  -H 'content-type: application/json' \
  -H 'x-api-key: REPLACE_WITH_API_KEY' \
  -d '{
    "accountId": "acc_8613800000000",
    "participants": ["8613900000000@s.whatsapp.net"]
  }'
```

## 10. Redis 联调边界

功能层不需要连协议 Redis。

协议 Redis 保存的是协议内部数据：

- `accountId -> ownerWorkerId`
- worker heartbeat / load
- Baileys creds
- Baileys keys
- runtime state
- device profile / browser display
- reconnect token bucket
- group-op account lock / worker token bucket
- reconnect account cooldown / global bucket / worker bucket
- proxy binding

账号级 Kafka heartbeat 默认关闭，避免大规模事件量。联调时如需验证状态流，可设置
`HEARTBEAT_EVENT_ENABLED=true`，建议 `HEARTBEAT_EVENT_INTERVAL_MS>=300000`。

这些 key schema 属于协议层内部实现，后续为了百万账号会继续分片和改结构。功能层直接读取会导致强耦合，也可能读到 failover 过程中的中间状态。

功能层需要的数据通过两条路拿：

```text
HTTP:  /v1/accounts/resolve/{accountId}
Kafka: protocol.owner.events.v1 / protocol.account.events.v1
```

功能层自己的 owner cache 可以放在功能层 Redis：

```text
biz:protocol-owner:{accountId} -> ownerEndpoint
biz:account-state:{accountId}  -> ONLINE / OFFLINE / NEED_REAUTH / PROXY_FAILED
```

## 11. 联调验收

按顺序验收：

1. `protocol-server /healthz` 返回 200。
2. `protocol-server /readyz` 返回 200。
3. 协议层日志里 Kafka producer 启动成功。
4. 功能层能消费 5 个 Kafka topic。
5. 调 Pairing Code 后功能层收到 `pairing.code_generated`；如果调 QR 登录，则收到 `qr.code_generated`。
6. 授权成功后功能层收到 `account.owner_assigned` 和 `account.state_changed`。
7. 功能层 owner cache 能写入 `accountId -> ownerEndpoint`。
8. 功能层用 ownerEndpoint 调发消息接口成功。
9. 故意打错 endpoint 时能处理 `409 NOT_OWNER` 并重试一次。
10. NEED_REAUTH 时功能层能暂停任务；彻底放弃账号时调用 `POST /v1/admin/unassign`。

## 12. 当前测试环境容量建议

2C8G 单台协议服务器先按保守参数跑：

```env
MAX_ACCOUNTS_PER_WORKER=200
NODE_RECONNECT_PER_SEC=5
GLOBAL_RECONNECT_PER_SEC=20
COLD_START_BATCH_SIZE=20
```

联调稳定后再逐步提高到 300-500 在线。不要一开始直接按 2000 在线压测；2000 在线需要 4C8G 且多 worker 参数调优。

## 13. 后续生产升级

当前三台服务器是联调环境。生产建议演进：

1. Redis 换 ElastiCache Redis Cluster。
2. Kafka 换 AWS MSK 三 broker 起步。
3. 协议层拆 master / worker，多台横向扩展。
4. 增加 RDS MySQL 做长期 creds 持久化。
5. 增加 Prometheus / Grafana / CloudWatch 告警。
6. owner、account state、message event 按 accountId 分区扩容。
