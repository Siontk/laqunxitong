# 功能层联调手册

本文给功能层联调用，覆盖 HTTP 调用、Kafka 消费、owner 缓存、账号状态和异常处置。

## 1. 联调目标

功能层只调用统一协议入口和 Kafka 事件，不关心账号具体在哪台机器。

协议层负责：

- 登录 / 导入 / online / offline / logout
- owner 分配和 failover
- 消息、群、profile、business 等账号级原子能力
- 状态机和事件上报

功能层负责：

- 任务编排、批量拉群、业务重试
- 对象存储和媒体 URL
- owner cache、账号状态表、消息记录
- Kafka consumer group 和业务落库

## 2. 环境配置

协议层测试环境需要暴露：

```text
HTTP baseUrl: http://protocol-gateway:8080
Swagger:      http://protocol-gateway:8080/docs
Kafka:        KAFKA_BROKERS
API Key:      x-api-key 或 Authorization: Bearer
```

协议层核心环境变量：

```env
EVENT_BACKEND=kafka
KAFKA_BROKERS=b-1.xxx:9094,b-2.xxx:9094
KAFKA_CLIENT_ID=protocol-layer
KAFKA_SSL=true
KAFKA_TOPIC_ACCOUNT=protocol.account.events.v1
KAFKA_TOPIC_OWNER=protocol.owner.events.v1
KAFKA_TOPIC_MESSAGE=protocol.message.events.v1
KAFKA_TOPIC_GROUP=protocol.group.events.v1
KAFKA_TOPIC_PAIRING=protocol.pairing.events.v1
```

如果 MSK 使用 SASL/SCRAM：

```env
KAFKA_USERNAME=xxx
KAFKA_PASSWORD=xxx
KAFKA_SASL_MECHANISM=scram-sha-512
```

## 3. Kafka 对接

### 3.1 Topic

| Topic | 功能层消费目的 |
|---|---|
| `protocol.owner.events.v1` | 更新 `accountId -> ownerEndpoint` 缓存 |
| `protocol.account.events.v1` | 更新账号状态、风控状态、异常状态 |
| `protocol.message.events.v1` | 收消息、消息 ack、消息记录 |
| `protocol.group.events.v1` | 群成员变化、群信息变化 |
| `protocol.pairing.events.v1` | pairing code、QR、授权成功/失败 |

Kafka message key 固定为 `accountId`。功能层必须按 key 分区消费，保证同账号事件有序。

### 3.2 Envelope

所有事件外层结构一致：

```json
{
  "event": "account.owner_changed",
  "version": "v1",
  "accountId": "acc_001",
  "occurredAt": "2026-05-25T12:00:00.000Z",
  "workerId": "worker-002",
  "evidence": {
    "state": "ONLINE"
  },
  "data": {
    "accountId": "acc_001",
    "previousOwnerWorkerId": "worker-001",
    "ownerWorkerId": "worker-002",
    "ownerEndpoint": "http://10.0.1.13:8080",
    "reason": "failover",
    "changedAt": "2026-05-25T12:00:00.000Z"
  }
}
```

功能层处理规则：

- 用 `accountId + event + occurredAt` 做幂等。
- 同账号按 `occurredAt` 或业务侧递增版本做乱序保护。
- 消费失败不要丢，进入功能层自己的 DLQ。
- owner 事件优先级最高，影响后续 HTTP 直连地址。

### 3.3 Owner Cache 消费逻辑

消费 `protocol.owner.events.v1`：

```text
account.owner_assigned   set owner cache
account.owner_changed    update owner cache
account.owner_unassigned delete owner cache
```

建议缓存结构：

```json
{
  "accountId": "acc_001",
  "ownerWorkerId": "worker-002",
  "ownerEndpoint": "http://10.0.1.13:8080",
  "updatedAt": "2026-05-25T12:00:00.000Z"
}
```

### 3.4 Java Consumer 伪代码

```java
while (true) {
  ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(500));
  for (ConsumerRecord<String, String> record : records) {
    String accountId = record.key();
    EventEnvelope event = parse(record.value());

    if (event.event.equals("account.owner_assigned")
        || event.event.equals("account.owner_changed")) {
      ownerCache.set(accountId, event.data.ownerEndpoint, event.data.ownerWorkerId);
    }

    if (event.event.equals("account.owner_unassigned")) {
      ownerCache.delete(accountId);
    }

    if (event.event.equals("account.state_changed")) {
      accountStateTable.upsert(accountId, event.data);
    }

    if (event.event.equals("message.received")) {
      messageTable.insertIdempotent(accountId, event.data);
    }
  }
  consumer.commitSync();
}
```

## 4. HTTP 调用规则

### 4.1 通用 Header

```http
x-api-key: {API_KEYS 中配置的 key}
content-type: application/json
```

或：

```http
Authorization: Bearer {apiKey}
```

### 4.2 Owner 路由规则

功能层调用账号级接口前：

1. 先查本地 owner cache。
2. cache miss 时调 `GET /v1/accounts/resolve/{accountId}`。
3. 拿到 `ownerEndpoint` 后直连 owner worker。
4. 如果返回 `409 NOT_OWNER`，用错误详情里的 `ownerEndpoint` 刷新缓存并重试一次。

不要每次都 resolve。批量任务只对 cache miss 的账号做 batch resolve。

### 4.3 NOT_OWNER 示例

```json
{
  "code": "NOT_OWNER",
  "message": "account acc_001 is not owned by this worker",
  "details": {
    "accountId": "acc_001",
    "currentWorkerId": "worker-001",
    "ownerWorkerId": "worker-002",
    "ownerEndpoint": "http://10.0.1.13:8080"
  }
}
```

功能层处理：

```text
ownerCache.set(accountId, details.ownerEndpoint)
retry once on details.ownerEndpoint
```

## 5. 账号接入流程

### 5.1 Pairing Code 登录

请求：

```http
POST /v1/auth/pairing-code
```

```json
{
  "phone": "8613800000000",
  "customPairingCode": "12345678",
  "proxy": {
    "protocol": "socks5",
    "url": "socks5://user:pass@host:1080",
    "sessionId": "acc_8613800000000",
    "country": "US"
  },
  "browserDisplay": {
    "browserName": "Opera",
    "platform": "ios",
    "version": "17.5"
  }
}
```

响应：

```json
{
  "accountId": "acc_8613800000000",
  "pairingId": "acc_8613800000000-1770000000000",
  "routing": {
    "ownerWorkerId": "worker-001",
    "ownerEndpoint": "http://10.0.1.12:8080",
    "currentWorkerId": "worker-001",
    "local": true
  },
  "expiresAt": "2026-05-25T12:01:00.000Z"
}
```

功能层后续消费：

- `pairing.code_generated`
- `pairing.completed`
- `account.state_changed`
- `account.owner_assigned`

### 5.2 导入账号并上线

```http
POST /v1/accounts/import/baileys-json
```

```json
{
  "accountId": "acc_001",
  "json": {
    "creds": {},
    "keys": {}
  },
  "proxy": {
    "protocol": "socks5",
    "url": "socks5://user:pass@host:1080",
    "sessionId": "acc_001",
    "country": "US"
  },
  "autoOnline": true
}
```

如果返回 `ASSIGNED_REMOTE`，按 `data.routing.ownerEndpoint` 补调：

```http
POST /v1/accounts/{accountId}/online
```

## 6. 发送消息

### 6.1 文本消息

```http
POST {ownerEndpoint}/v1/messages/text
```

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "text": "hello"
}
```

成功后功能层消费：

- `message.ack`
- 如果对方回复，消费 `message.received`

### 6.2 超链接消息

普通超链接可以直接走文本消息：

```http
POST {ownerEndpoint}/v1/messages/text
```

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "text": "https://example.com 活动链接"
}
```

如果功能层明确希望走“链接消息 / 预览”能力，用：

```http
POST {ownerEndpoint}/v1/messages/link
```

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "text": "https://example.com 活动链接",
  "generatePreview": true
}
```

预览由 WhatsApp/Baileys 侧生成；功能层不要把大媒体塞进协议层，媒体建议用业务层对象存储 URL。

### 6.3 媒体消息

```http
POST {ownerEndpoint}/v1/messages/image
POST {ownerEndpoint}/v1/messages/video
POST {ownerEndpoint}/v1/messages/audio
POST {ownerEndpoint}/v1/messages/document
```

功能层优先传 URL，不要传大 base64。

## 7. 群操作

所有群操作都要先定位 ownerEndpoint。

| 能力 | 接口 |
|---|---|
| 创建群 | `POST /v1/groups/create` |
| 添加群成员 | `POST /v1/groups/{groupJid}/participants/add` |
| 移除群成员 | `POST /v1/groups/{groupJid}/participants/remove` |
| 设置管理员 | `POST /v1/groups/{groupJid}/participants/promote` |
| 取消管理员 | `POST /v1/groups/{groupJid}/participants/demote` |
| 获取群信息 | `GET /v1/groups/{groupJid}/metadata?accountId=...` |
| 获取所有群 | `GET /v1/accounts/{accountId}/groups` |
| 获取群成员 | `GET /v1/groups/{groupJid}/participants?accountId=...` |
| 设置群公告 / 仅管理员发言 | `POST /v1/groups/{groupJid}/settings/announcement` |
| 设置群描述 | `POST /v1/groups/{groupJid}/description` |
| 获取群二维码 | `GET /v1/groups/{groupJid}/invite-code?accountId=...` |
| 根据 code 进群 | `POST /v1/groups/join` |
| 根据群链接进群 | `POST /v1/groups/join`，功能层从链接里解析 inviteCode |
| 退出群 | `POST /v1/groups/{groupJid}/leave` |

添加群成员示例：

```http
POST {ownerEndpoint}/v1/groups/{groupJid}/participants/add
```

```json
{
  "accountId": "acc_001",
  "participants": [
    "8613900000000@s.whatsapp.net"
  ]
}
```

## 8. 状态和异常

### 8.1 状态查询

```http
GET {ownerEndpoint}/v1/accounts/{accountId}/status
GET {ownerEndpoint}/v1/accounts/{accountId}/alive
GET {ownerEndpoint}/v1/accounts/{accountId}/usability
```

业务下发任务前建议先查 `/usability`。

### 8.2 NEED_REAUTH

Kafka 事件：

```text
protocol.account.events.v1 -> account.need_reauth
```

功能层处理：

- 暂停该账号所有任务。
- 如果继续使用账号，发起 pairing/QR 重新授权。
- 如果彻底放弃账号，调用：

```http
POST /v1/admin/unassign
```

```json
{
  "accountId": "acc_001",
  "releaseSlot": true
}
```

### 8.3 手动离线

```http
POST {ownerEndpoint}/v1/accounts/{accountId}/offline
```

手动离线释放 runtime slot，但保留 owner 绑定和 creds。

### 8.4 换 IP

换 IP 不要 logout，调用：

```http
POST {ownerEndpoint}/v1/accounts/{accountId}/proxy/rebind
```

协议层会关闭旧 socket 并重连到 online。

## 9. 批量任务建议

流程：

1. 功能层拿任务账号列表。
2. 从 owner cache 取 ownerEndpoint。
3. 对 cache miss 的账号调用 `POST /v1/accounts/resolve`。
4. 按 `ownerEndpoint` 分组。
5. 每个 ownerEndpoint 限制并发。
6. 对 `NOT_OWNER` 只重试一次。
7. 任务结果由功能层落库，协议层只返回单次协议动作结果。

建议初始并发：

```text
单 worker 同时发消息: 20-50
单 worker 同时拉群/加人: 5-10
单账号串行化群操作，避免同号并发打爆
```

## 10. 联调 Checklist

- [ ] 协议层 `/readyz` 返回 200。
- [ ] 功能层能消费 5 个 Kafka topic。
- [ ] pairing-code 能收到 `pairing.code_generated` 和 `pairing.completed`。
- [ ] online 后能收到 `account.state_changed ONLINE`。
- [ ] 功能层 owner cache 能被 `account.owner_assigned` 写入。
- [ ] 故意打错 worker 能收到 `409 NOT_OWNER` 并重试成功。
- [ ] 发送文本能收到 `message.ack`。
- [ ] 收到外部消息能消费 `message.received`。
- [ ] 手动 offline 后 status 显示 `OFFLINE / slotReleased=true`。
- [ ] NEED_REAUTH 后功能层能暂停任务并决定是否 unassign。
