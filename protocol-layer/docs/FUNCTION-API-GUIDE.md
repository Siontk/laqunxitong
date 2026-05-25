# 功能层 API 对接文档

本文给功能层/业务层联调用。协议层只做 WhatsApp 协议能力、账号 socket、状态、分片 owner；业务层负责对象存储、任务队列、业务重试和数据落库。

## 基础约定

### Base URL

首次可请求任意协议层入口：

```text
http://protocol-gateway:8080
```

拿到 owner 后，业务层应直连：

```text
{ownerEndpoint}
```

例如：

```text
http://10.0.1.13:8080
```

### Owner 规则

所有带 `accountId` 的协议动作都必须打到账号 owner worker。打错会返回：

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

业务层处理：刷新 owner 缓存，然后对 `ownerEndpoint` 重试一次。

### 容量规则

`MAX_ACCOUNTS_PER_WORKER=500` 表示单 worker 最多 500 个 active slot；单台 4C8G 测试目标是 4 个 worker 合计 2000 在线账号。

占位：`ONLINE / VERIFYING / RECONNECTING / STALE / PROXY_FAILED / RATE_LIMITED`

不占位：手动 `OFFLINE`、`NEED_REAUTH`、`LOGGED_OUT`、重连耗尽后的持续异常。

## 推荐调用流程

### 发送消息流程

1. `GET /v1/accounts/resolve/{accountId}` 获取 owner。
2. 调 `{ownerEndpoint}/v1/accounts/{accountId}/status` 确认 `state=ONLINE`。
3. 调 `{ownerEndpoint}/v1/messages/text` 或媒体消息接口。
4. 如果返回 `NOT_OWNER`，刷新 owner 后重试一次。
5. 如果 `slotReleased=true`，进入业务补偿。

### 导入账号流程

1. 调导入接口，带 `proxy`。
2. 如果返回 `IMPORTED_ONLINE`，等待事件或查 status。
3. 如果返回 `ASSIGNED_REMOTE`，按 `data.routing.ownerEndpoint` 补调 online。
4. 如果返回 `NOT_OWNER`，改请求 ownerEndpoint。
5. 如果后续状态 `NEED_REAUTH`，重新授权。

### 批量任务流程

1. `POST /v1/accounts/resolve` 批量解析 owner。
2. 按 `ownerEndpoint` 分组。
3. 每个 ownerEndpoint 控制并发。
4. 对 `NOT_OWNER` 做一次刷新重试。

## 1. Owner 解析

### 1.1 查询单个账号 owner

用途：判断账号当前属于哪个 worker，业务层后续直连 owner worker。

```http
GET /v1/accounts/resolve/{accountId}
```

示例：

```http
GET /v1/accounts/resolve/acc_001
```

响应：

```json
{
  "accountId": "acc_001",
  "assigned": true,
  "ownerWorkerId": "worker-002",
  "ownerEndpoint": "http://10.0.1.13:8080",
  "currentWorkerId": "worker-001",
  "local": false,
  "resolvedAt": "2026-05-19T10:00:00.000Z"
}
```

### 1.2 批量查询 owner

用途：批量任务前按 worker 分组，避免请求打错 worker。

```http
POST /v1/accounts/resolve
```

请求：

```json
{
  "accountIds": ["acc_001", "acc_002"]
}
```

响应：

```json
{
  "resolvedAt": "2026-05-19T10:00:00.000Z",
  "currentWorkerId": "worker-001",
  "results": [
    {
      "accountId": "acc_001",
      "assigned": true,
      "ownerWorkerId": "worker-002",
      "ownerEndpoint": "http://10.0.1.13:8080",
      "local": false
    }
  ]
}
```

## 2. 授权

### 2.1 获取 pairing code

用途：手机号首次绑定 WhatsApp 设备。

```http
POST /v1/auth/pairing-code
```

请求：

```json
{
  "phone": "8613800000000",
  "clientRefId": "biz-order-001",
  "customPairingCode": "12345678",
  "proxy": {
    "protocol": "socks5",
    "url": "socks5://user:pass@proxy.example.com:1080",
    "sessionId": "acc_8613800000000",
    "country": "US",
    "provider": "custom",
    "tier": "pairing",
    "stickyDurationSec": 600
  }
}
```

`customPairingCode` 可选，必须是 8 位字母数字。不传时协议层会优先使用服务端环境变量 `PAIRING_DEFAULT_CODE`，未配置才随机生成。

响应：

```json
{
  "accountId": "acc_8613800000000",
  "pairingId": "acc_8613800000000-1779175200000",
  "expiresAt": "2026-05-19T10:01:00.000Z"
}
```

说明：pairing code 会通过事件 `pairing.code_generated` 推送。90 秒未 ONLINE 会释放 slot。

### 2.2 获取二维码

用途：二维码扫码绑定。

```http
POST /v1/auth/qrcode
```

请求：

```json
{
  "clientRefId": "qr-session-001",
  "proxy": {
    "protocol": "socks5",
    "url": "socks5://user:pass@proxy.example.com:1080",
    "sessionId": "qr_001",
    "country": "US"
  }
}
```

响应：

```json
{
  "accountId": "acc_qr_1779175200000_ab12cd",
  "qrSessionId": "acc_qr_1779175200000_ab12cd-1779175200000"
}
```

说明：二维码通过事件推送。180 秒未 ONLINE 会释放 slot。

## 3. 导入账号

### 3.1 导入 Baileys JSON

用途：导入已有 Baileys auth_state。

```http
POST /v1/accounts/import/baileys-json
```

请求：

```json
{
  "accountId": "acc_001",
  "json": {
    "creds": {
      "me": { "id": "8613800000000@s.whatsapp.net" }
    },
    "keys": {}
  },
  "deviceProfile": {
    "platform": "windows",
    "manufacturer": "Microsoft",
    "model": "Windows PC",
    "osVersion": "10.0.22631"
  },
  "proxy": {
    "protocol": "socks5",
    "url": "socks5://user:pass@proxy.example.com:1080",
    "sessionId": "acc_001",
    "country": "US"
  },
  "autoOnline": true
}
```

响应：

```json
{
  "result": "IMPORTED_ONLINE",
  "accountId": "acc_001",
  "phone": "8613800000000",
  "jid": "8613800000000@s.whatsapp.net",
  "accountType": "UNKNOWN",
  "convertedFrom": "baileys_json",
  "deviceProfile": {
    "accountId": "acc_001",
    "platform": "windows",
    "source": "import_body",
    "manufacturer": "Microsoft",
    "model": "Windows PC",
    "osVersion": "10.0.22631",
    "deviceCompanion": false,
    "updatedAt": "2026-05-21T08:00:00.000Z"
  },
  "warnings": [],
  "routing": {
    "ownerWorkerId": "worker-002",
    "ownerEndpoint": "http://10.0.1.13:8080",
    "currentWorkerId": "worker-002",
    "local": true
  }
}
```

### 3.2 导入 params

用途：导入全参数登录数据。

```http
POST /v1/accounts/import/params
```

请求字段较多，核心必填：

```json
{
  "wid": "8613800000000",
  "clientStaticPrivateKey": "base64...",
  "clientStaticPublicKey": "base64...",
  "identityPrivateKey": "base64...",
  "identityPublicKey": "base64...",
  "registrationID": 12345,
  "signPreKeyID": 1,
  "signPreKeyPrivateKey": "base64...",
  "signPreKeyPublicKey": "base64...",
  "signPreKeySignature": "base64...",
  "vip": false,
  "deviceProfile": {
    "platform": "macos",
    "manufacturer": "Apple",
    "model": "MacBook Pro",
    "osVersion": "14.4.1"
  },
  "proxy": {
    "protocol": "socks5",
    "url": "socks5://user:pass@proxy.example.com:1080",
    "sessionId": "acc_8613800000000",
    "country": "US"
  },
  "autoOnline": true
}
```

响应同 `ImportResult`。

### 3.3 导入 six

用途：导入六段参数登录数据。

```http
POST /v1/accounts/import/six
```

请求核心字段：

```json
{
  "wid": "8613800000000",
  "clientStaticPrivateKey": "base64...",
  "clientStaticPublicKey": "base64...",
  "identityPrivateKey": "base64...",
  "identityPublicKey": "base64...",
  "deviceIdentityKey": "base64...",
  "wsDeviceId": 0,
  "deviceProfile": {
    "platform": "linux",
    "wsDeviceId": 0,
    "deviceCompanion": false
  },
  "proxy": {
    "protocol": "socks5",
    "url": "socks5://user:pass@proxy.example.com:1080",
    "sessionId": "acc_8613800000000",
    "country": "US"
  },
  "autoOnline": true
}
```

`deviceProfile` 是可选设备元数据。`browserDisplay` 是可选关联设备展示信息，功能层如果要显示 WhatsApp 已关联设备里的浏览器名，请传这个字段。

### 3.4 批量导入

用途：一次导入多个账号。结果可能分布在多个 owner worker。

```http
POST /v1/accounts/import/batch
```

请求：

```json
{
  "autoOnline": true,
  "concurrency": 5,
  "items": [
    {
      "format": "baileys_json",
      "data": {
        "accountId": "acc_001",
        "json": { "creds": {}, "keys": {} },
        "proxy": {
          "protocol": "socks5",
          "url": "socks5://user:pass@proxy.example.com:1080",
          "sessionId": "acc_001",
          "country": "US"
        },
        "autoOnline": true
      }
    }
  ]
}
```

响应：

```json
{
  "total": 1,
  "succeeded": 1,
  "failed": 0,
  "results": [
    {
      "accountId": "acc_001",
      "result": "ASSIGNED_REMOTE",
      "data": {
        "accountId": "acc_001",
        "result": "IMPORTED_OFFLINE",
        "routing": {
          "ownerWorkerId": "worker-002",
          "ownerEndpoint": "http://10.0.1.13:8080",
          "currentWorkerId": "worker-001",
          "local": false
        }
      }
    }
  ]
}
```

`ASSIGNED_REMOTE` 表示账号已保存并分配到远端 owner，业务层按 `ownerEndpoint` 补调 online。

## 4. 生命周期

### 4.1 上线账号

用途：已有 creds 重新建立 socket，不重新授权。

```http
POST /v1/accounts/{accountId}/online
```

请求可为空；如果要覆盖代理，可传：

```json
{
  "proxy": {
    "protocol": "socks5",
    "url": "socks5://user:pass@proxy.example.com:1080",
    "sessionId": "acc_001",
    "country": "US"
  }
}
```

响应：

```json
{
  "accountId": "acc_001",
  "accepted": true,
  "ownerWorkerId": "worker-002"
}
```

### 4.2 手动离线

用途：主动断开 socket，保留 creds，不占 active slot。

```http
POST /v1/accounts/{accountId}/offline
```

响应：

```json
{ "ok": true }
```

### 4.3 logout

用途：退出并移除设备，删除 creds，解除 Registry 绑定。

```http
POST /v1/accounts/{accountId}/logout
```

响应：

```json
{ "ok": true }
```

## 5. 状态查询

### 5.1 完整状态

用途：查看账号是否在线、是否释放 slot、是否需要重新授权。

```http
GET /v1/accounts/{accountId}/status
```

响应：

```json
{
  "accountId": "acc_001",
  "state": "ONLINE",
  "evidence": {
    "wsOpen": true,
    "connectionField": "open",
    "lastDateRecv": "2026-05-19T10:00:00.000Z",
    "lastPingAckAt": "2026-05-19T10:00:00.000Z",
    "ageMs": 120,
    "keepAliveIntervalMs": 30000
  },
  "accountType": "UNKNOWN",
  "deviceProfile": {
    "accountId": "acc_001",
    "platform": "windows",
    "source": "import_body",
    "manufacturer": "Microsoft",
    "model": "Windows PC",
    "deviceCompanion": false,
    "updatedAt": "2026-05-21T08:00:00.000Z"
  },
  "workerId": "worker-002",
  "reportedAt": "2026-05-19T10:00:00.000Z"
}
```

释放 slot 的示例：

```json
{
  "accountId": "acc_001",
  "state": "NEED_REAUTH",
  "evidence": {
    "wsOpen": false,
    "connectionField": "close",
    "slotReleased": true,
    "reason": "logged out",
    "updatedAt": "2026-05-19T10:00:00.000Z"
  },
  "workerId": "worker-002"
}
```

### 5.2 轻量探活

用途：高频查询在线状态。

```http
GET /v1/accounts/{accountId}/alive
```

响应：

```json
{
  "online": true,
  "ageMs": 100,
  "reportedAt": "2026-05-19T10:00:00.000Z"
}
```

### 5.3 主动 probe

用途：关键操作前主动探测 socket 是否能响应。

```http
POST /v1/accounts/{accountId}/probe
```

响应：

```json
{
  "ackedAt": "2026-05-19T10:00:00.000Z",
  "rttMs": 80
}
```

## 6. 代理

### 6.1 绑定代理

用途：保存账号当前 proxy binding。

```http
POST /v1/accounts/{accountId}/proxy/bind
```

请求：

```json
{
  "protocol": "socks5",
  "url": "socks5://user:pass@proxy.example.com:1080",
  "sessionId": "acc_001",
  "country": "US",
  "provider": "custom",
  "tier": "standard",
  "stickyDurationSec": 600
}
```

响应：

```json
{
  "ok": true,
  "accountId": "acc_001",
  "binding": {
    "protocol": "socks5",
    "url": "socks5://user:pass@proxy.example.com:1080",
    "sessionId": "acc_001",
    "country": "US",
    "boundAt": "2026-05-19T10:00:00.000Z",
    "status": "active"
  }
}
```

### 6.2 切换代理

用途：换 IP。协议层会重建 socket，成功后回到 ONLINE。换 IP 期间仍占 active slot。

```http
POST /v1/accounts/{accountId}/proxy/rebind
```

请求同 bind。

### 6.3 查询代理

```http
GET /v1/accounts/{accountId}/proxy
```

## 7. 消息

### 7.1 发文本

用途：发送普通文本消息。

```http
POST /v1/messages/text
```

请求：

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "text": "hello"
}
```

响应：

```json
{
  "messageId": "ABCD1234",
  "key": {
    "remoteJid": "8613900000000@s.whatsapp.net",
    "fromMe": true,
    "id": "ABCD1234"
  },
  "timestamp": 1779175200,
  "status": "pending"
}
```

### 7.2 发图片

用途：发送图片。建议业务层先上传对象存储，把 URL 给协议层。

```http
POST /v1/messages/image
```

请求：

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "image": {
    "url": "https://cdn.example.com/image.jpg",
    "mimetype": "image/jpeg"
  },
  "caption": "hello"
}
```

### 7.3 发视频

```http
POST /v1/messages/video
```

请求：

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "video": {
    "url": "https://cdn.example.com/video.mp4",
    "mimetype": "video/mp4"
  },
  "caption": "video"
}
```

### 7.4 发文档

```http
POST /v1/messages/document
```

请求：

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "document": {
    "url": "https://cdn.example.com/file.pdf"
  },
  "fileName": "file.pdf",
  "mimetype": "application/pdf"
}
```

### 7.5 标记已读

```http
POST /v1/messages/read
```

请求：

```json
{
  "accountId": "acc_001",
  "keys": [
    {
      "remoteJid": "8613900000000@s.whatsapp.net",
      "fromMe": false,
      "id": "MSG_ID"
    }
  ]
}
```

### 7.6 输入状态

```http
POST /v1/messages/typing
```

请求：

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "state": "composing",
  "durationSec": 5
}
```

## 8. 群组

### 8.1 建群

```http
POST /v1/groups/create
```

请求：

```json
{
  "accountId": "acc_001",
  "subject": "测试群",
  "participants": [
    "8613900000000@s.whatsapp.net",
    "8613911111111@s.whatsapp.net"
  ]
}
```

响应：

```json
{
  "groupJid": "120363000000000000@g.us",
  "results": {
    "groupJid": "120363000000000000@g.us",
    "results": []
  }
}
```

### 8.2 拉人进群

```http
POST /v1/groups/{groupJid}/participants/add
```

请求：

```json
{
  "accountId": "acc_001",
  "participants": [
    "8613900000000@s.whatsapp.net"
  ]
}
```

### 8.3 查询群信息

```http
GET /v1/groups/{groupJid}/metadata?accountId=acc_001
```

### 8.4 修改群名

```http
POST /v1/groups/{groupJid}/subject
```

请求：

```json
{
  "accountId": "acc_001",
  "subject": "新群名"
}
```

## 9. 风控与可用性

### 9.1 综合可用性

用途：业务下发拉群/发消息任务前推荐先查。

```http
GET /v1/accounts/{accountId}/usability
```

响应示例：

```json
{
  "accountId": "acc_001",
  "canSendMessage": true,
  "canCreateGroup": true,
  "canAddToGroup": true,
  "blockedReason": null,
  "checkedAt": "2026-05-19T10:00:00.000Z"
}
```

### 9.2 查询 restriction

```http
GET /v1/accounts/{accountId}/restriction
```

用途：查询 reachoutTimelock，例如账号被限制几小时。

### 9.3 查询 message cap

```http
GET /v1/accounts/{accountId}/message-cap
```

用途：查询新 chat/发送配额状态。

## 10. 联系人与资料

### 10.1 保存联系人

```http
POST /v1/contacts/{jid}/save
```

请求：

```json
{
  "accountId": "acc_001",
  "name": "Tom"
}
```

### 10.2 拉黑联系人

```http
POST /v1/contacts/{jid}/block
```

请求：

```json
{
  "accountId": "acc_001"
}
```

### 10.3 修改昵称

```http
POST /v1/profile/name
```

请求：

```json
{
  "accountId": "acc_001",
  "name": "New Name"
}
```

### 10.4 查询头像

```http
GET /v1/profile/{jid}/picture-url?accountId=acc_001
```

## 11. Business 与频道

### 11.1 查询 Business profile

```http
GET /v1/profile/business/{jid}?accountId=acc_001
```

用途：判断目标 jid 是否 Business 号。

### 11.2 查询商品目录

```http
GET /v1/business/catalog?accountId=acc_001&jid=8613900000000@s.whatsapp.net&limit=20
```

### 11.3 关注频道

```http
POST /v1/channels/follow
```

请求：

```json
{
  "accountId": "acc_001",
  "jid": "120363xxx@newsletter"
}
```

## 12. 导出

### 12.1 导出 Baileys JSON

```http
GET /v1/accounts/{accountId}/export/baileys-json
```

用途：备份或迁移账号 auth_state。

### 12.2 导出竞品兼容 creds JSON

```http
GET /v1/accounts/{accountId}/export/creds-json
```

用途：给功能层做格式兼容和联调核对，返回平铺 creds JSON，顶层包含 `me`、`Phone`、`account`、`noiseKey`、`signedPreKey` 等字段，不含 keys。

### 12.3 导出 portable

```http
GET /v1/accounts/{accountId}/export/portable
```

用途：导出带账号元信息、proxy 元信息、`deviceProfile` 和 `browserDisplay` 的便携结构。

## 13. 运维接口

运维接口仅内网或 ops 使用，不给普通功能流调用。

### 13.1 同步 load

```http
POST /v1/admin/sync-load
```

用途：强制把当前 worker 的 `activeSize` 覆盖到 Registry load。

### 13.2 列 worker

```http
GET /v1/admin/workers?includeDead=false
```

### 13.3 手动 unassign

```http
POST /v1/admin/unassign
```

请求：

```json
{
  "accountId": "acc_001",
  "releaseSlot": true
}
```

说明：如果业务侧收到 `account.need_reauth` 后确认彻底放弃账号，调用此接口并保持 `releaseSlot=true`，用于解除 owner 绑定并释放 Registry load。只有确认该账号的 Registry load 已经被其它流程扣过时，才传 `releaseSlot=false`。

## 14. 常见错误码

| HTTP | code | 含义 | 功能层处理 |
|---|---|---|---|
| 400 | VALIDATION_ERROR | 请求参数不合法 | 修请求参数 |
| 404 | ACCOUNT_NOT_FOUND | owner worker 没有运行态 socket | 查 status，必要时重新 online |
| 409 | NOT_OWNER | 请求打到非 owner worker | 刷新 owner 后重试一次 |
| 422 | NEED_REAUTH | 账号需要重新授权 | 停任务，重新 pairing/QR |
| 422 | NOT_BUSINESS_ACCOUNT | 个人号调用 Business 接口 | 先查 account type |
| 429 | RATE_LIMITED | 协议层限流 | 退避重试 |
| 503 | PROBE_TIMEOUT | 主动 probe 超时 | 换号/稍后重试/查状态 |

## 15. 事件

功能层应消费 NATS：

```text
unsea.v1.events.>
```

重点事件：

- `account.state_changed`
- `account.online_changed`
- `account.need_reauth`
- `account.type_detected`
- `message.received`
- `pairing.code_generated`
- `pairing.completed`
- `pairing.failed`
