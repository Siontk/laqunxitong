# Swagger 联调说明

Swagger 源文件：

```text
openapi/protocol-v1.yaml
```

功能层按接口逐项对接时，优先看：

```text
protocol-layer/docs/APIFOX-STYLE-API.md
protocol-layer/docs/FUNCTION-API-GUIDE.md
```

协议层启动后访问：

```text
http://{protocol-host}:8080/docs
```

## 联调前配置

worker 需要设置可被业务层访问的地址：

```bash
PUBLIC_ENDPOINT=http://10.0.1.12:8080
```

Swagger 里的 `ownerEndpoint` 就来自这个配置。

## 核心联调顺序

### 1. 绑定代理

```http
POST /v1/accounts/{accountId}/proxy/bind
```

请求体示例：

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

### 2. 导入账号

```http
POST /v1/accounts/import/baileys-json
POST /v1/accounts/import/params
POST /v1/accounts/import/six
POST /v1/accounts/import/legacy-json
```

导入接口会保存 creds/keys/proxy，并分配 owner。

如果返回 `409 NOT_OWNER`：

```json
{
  "code": "NOT_OWNER",
  "details": {
    "accountId": "acc_001",
    "currentWorkerId": "worker-001",
    "ownerWorkerId": "worker-002",
    "ownerEndpoint": "http://10.0.1.13:8080"
  }
}
```

业务层应改请求 `ownerEndpoint`。

### 3. 查询 owner

单个账号：

```http
GET /v1/accounts/resolve/{accountId}
```

批量账号：

```http
POST /v1/accounts/resolve
```

请求体：

```json
{
  "accountIds": ["acc_001", "acc_002"]
}
```

响应示例：

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

### 4. 上线账号

```http
POST /v1/accounts/{accountId}/online
```

说明：

- 必须请求 owner worker。
- 可在 body 里带 `proxy`，不带则使用已绑定 proxy。
- 返回 `202` 表示开始上线，最终状态看事件或 status。

### 5. 查询状态

```http
GET /v1/accounts/{accountId}/status
GET /v1/accounts/{accountId}/alive
```

释放在线槽位后的响应会包含：

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
  }
}
```

### 6. 发送消息

文本：

```http
POST /v1/messages/text
```

请求体：

```json
{
  "accountId": "acc_001",
  "jid": "8613800000000@s.whatsapp.net",
  "text": "hello"
}
```

图片/视频/文档建议传 URL，由业务层负责对象存储：

```json
{
  "accountId": "acc_001",
  "jid": "8613800000000@s.whatsapp.net",
  "image": {
    "url": "https://cdn.example.com/a.jpg",
    "mimetype": "image/jpeg"
  },
  "caption": "hello"
}
```

协议层只负责读取 URL 并发送，不负责对象存储生命周期。

## 通用错误处理

### NOT_OWNER

含义：请求打到非 owner worker。

处理：

1. 读取 `details.ownerEndpoint`。
2. 刷新本地 owner 缓存。
3. 对 ownerEndpoint 重试一次。

### ACCOUNT_NOT_FOUND

含义：当前 owner worker 没有运行态 socket，可能账号已释放 slot。

处理：

1. 调 `/status` 查看是否 `slotReleased=true`。
2. 如果 `OFFLINE`，按业务策略重新 online。
3. 如果 `NEED_REAUTH`，重新授权。

### NEED_REAUTH

含义：creds 失效、设备被移除或被替换。

处理：

1. 停止业务任务。
2. 触发 pairing-code 或 QR。
3. 授权成功后重新 online。

## 容量联调关注点

`MAX_ACCOUNTS_PER_WORKER=500` 表示单 worker 最多 500 个 active slot；单台 4C8G 测试目标是 4 个 worker 合计 2000 在线账号。

占位：

- `ONLINE`
- `VERIFYING`
- `RECONNECTING`
- `STALE`
- 短期 `PROXY_FAILED / RATE_LIMITED`

不占位：

- 手动 `OFFLINE`
- `NEED_REAUTH`
- `LOGGED_OUT`
- 重连耗尽后的持续异常

## 批量导入结果

`POST /v1/accounts/import/batch` 的单项结果可能是：

- `IMPORTED_ONLINE`: 已在当前 owner 上线。
- `IMPORTED_OFFLINE`: 已导入但未上线。
- `ASSIGNED_REMOTE`: 已分配到远端 owner，业务层应按 `data.routing.ownerEndpoint` 补调 online。
- `INVALID_CREDENTIAL`: 参数无效。

示例：

```json
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
```
