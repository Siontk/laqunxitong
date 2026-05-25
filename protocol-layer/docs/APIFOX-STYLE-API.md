# 协议层 API 文档（Apifox 风格）

本文给功能层联调使用。完整字段以 Swagger 为准：

```text
http://{protocol-host}:8080/docs
openapi/protocol-v1.yaml
```

## 通用规则

### Base URL

首次可请求统一入口：

```text
http://protocol-gateway:8080
```

拿到 owner 后，后续请求建议直连：

```text
{ownerEndpoint}
```

### Owner 路由

所有带 `accountId` 的协议动作，都应该请求该账号的 owner worker。

先查：

```http
GET /v1/accounts/resolve/{accountId}
```

如果请求打错 worker，会返回：

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

功能层处理：刷新 owner 缓存，对 `ownerEndpoint` 重试一次。

### 通用账号参数

| 参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| accountId | path/body/query | string | 是 | 协议层账号 ID |
| jid | path/body/query | string | 视接口 | WhatsApp JID |
| groupJid | path | string | 群接口必填 | 群 JID，格式如 `120363xxx@g.us` |

### 常见 JID

```text
个人：8613900000000@s.whatsapp.net
群组：120363000000000000@g.us
频道：120363xxx@newsletter
动态：status@broadcast
```

## 1. Owner 解析

### 1.1 查询单个账号 owner

**用途**：查询账号归属 worker，功能层拿 `ownerEndpoint` 后直连。

**请求方式**

```http
GET /v1/accounts/resolve/{accountId}
```

**Path 参数**

| 参数 | 类型 | 必填 | 示例 | 说明 |
|---|---|---|---|---|
| accountId | string | 是 | acc_001 | 账号 ID |

**响应示例**

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

### 1.2 批量查询账号 owner

**用途**：批量任务前按 ownerEndpoint 分组，减少请求打错 worker。

**请求方式**

```http
POST /v1/accounts/resolve
```

**Body 参数**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| accountIds | string[] | 是 | 最多 1000 个 |

**请求示例**

```json
{
  "accountIds": ["acc_001", "acc_002"]
}
```

**响应示例**

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

## 2. 授权与导入

### 2.1 获取 Pairing Code

**用途**：手机号首次绑定。

**请求方式**

```http
POST /v1/auth/pairing-code
```

**Body 参数**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| phone | string | 是 | 手机号，10-15 位数字 |
| clientRefId | string | 否 | 功能层自定义关联 ID |
| customPairingCode | string | 否 | 自定义 8 位 code；不传则使用服务端 `PAIRING_DEFAULT_CODE`，再没有才随机 |
| proxy | ProxyBinding | 是 | 代理绑定 |

**请求示例**

```json
{
  "phone": "8613800000000",
  "clientRefId": "biz-login-001",
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

固定验证码有两种方式：

| 方式 | 说明 |
|---|---|
| 请求传 `customPairingCode` | 单次请求固定，适合功能层按账号生成 |
| 环境变量 `PAIRING_DEFAULT_CODE=12345678` | 服务端默认固定码，功能层不传时自动使用 |

**响应示例**

```json
{
  "accountId": "acc_8613800000000",
  "pairingId": "acc_8613800000000-1779175200000",
  "expiresAt": "2026-05-19T10:01:00.000Z"
}
```

**注意事项**

- code 通过事件 `pairing.code_generated` 推送。
- 90 秒未上线会释放 active slot。

### 2.2 获取二维码

**用途**：扫码首次绑定。

**请求方式**

```http
POST /v1/auth/qrcode
```

**请求示例**

```json
{
  "clientRefId": "qr-001",
  "proxy": {
    "protocol": "socks5",
    "url": "socks5://user:pass@proxy.example.com:1080",
    "sessionId": "qr_001",
    "country": "US"
  }
}
```

**响应示例**

```json
{
  "accountId": "acc_qr_1779175200000_ab12cd",
  "qrSessionId": "acc_qr_1779175200000_ab12cd-1779175200000"
}
```

**注意事项**

- QR 内容通过事件推送。
- 180 秒未上线会释放 active slot。

### 2.3 导入 Baileys JSON

**用途**：导入已有 auth_state。

**请求方式**

```http
POST /v1/accounts/import/baileys-json
```

**请求示例**

```json
{
  "accountId": "acc_001",
  "json": {
    "creds": {
      "me": {
        "id": "8613800000000@s.whatsapp.net"
      }
    },
    "keys": {}
  },
  "deviceProfile": {
    "platform": "windows",
    "manufacturer": "Microsoft",
    "model": "Windows PC",
    "osVersion": "10.0.22631",
    "device": "desktop",
    "deviceUUID": "device-uuid-001",
    "phoneUUID": "phone-uuid-001",
    "whatsappVersion": "2.24.10.79"
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

**响应示例**

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
    "device": "desktop",
    "deviceUUID": "device-uuid-001",
    "phoneUUID": "phone-uuid-001",
    "whatsappVersion": "2.24.10.79",
    "wsDeviceId": null,
    "deviceCompanion": false,
    "note": null,
    "updatedAt": "2026-05-21T08:00:00.000Z"
  },
  "browserDisplay": {
    "accountId": "acc_001",
    "browserName": "Opera",
    "platform": "ios",
    "version": "17.5",
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

### 2.4 导入 Params

**用途**：导入全参数登录材料。

**请求方式**

```http
POST /v1/accounts/import/params
```

**请求示例**

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
    "osVersion": "14.4.1",
    "device": "MacBookPro18,3",
    "whatsappVersion": "2.24.10.79"
  },
  "browserDisplay": {
    "accountId": "acc_001",
    "browserName": "Opera",
    "platform": "ios",
    "version": "17.5",
    "updatedAt": "2026-05-21T08:00:00.000Z"
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

### 2.5 导入 Six

**用途**：导入 sixLogin 登录材料。

**请求方式**

```http
POST /v1/accounts/import/six
```

**请求示例**

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
    "manufacturer": "Ubuntu",
    "model": "Linux Desktop",
    "osVersion": "22.04.4",
    "deviceCompanion": true,
    "wsDeviceId": 20
  },
  "browserDisplay": {
    "accountId": "acc_001",
    "browserName": "Opera",
    "platform": "android",
    "version": "14",
    "updatedAt": "2026-05-21T08:00:00.000Z"
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

### 2.6 导入 Legacy JSON

**用途**：导入旧格式 base64 JSON。

**请求方式**

```http
POST /v1/accounts/import/legacy-json
```

**请求示例**

```json
{
  "accountJsonBase64": "eyJjcmVkcyI6e319",
  "deviceProfile": {
    "platform": "linux",
    "note": "legacy import metadata"
  },
  "browserDisplay": {
    "accountId": "acc_001",
    "browserName": "Chrome",
    "platform": "macos",
    "version": "14.4.1",
    "updatedAt": "2026-05-21T08:00:00.000Z"
  },
  "proxy": {
    "protocol": "socks5",
    "url": "socks5://user:pass@proxy.example.com:1080",
    "sessionId": "legacy_001",
    "country": "US"
  },
  "autoOnline": true
}
```

**设备字段说明**

`deviceProfile` 是账号设备元数据，功能层可选传入。`browserDisplay` 是关联设备展示信息，功能层可选传入。协议层会保存并在导入结果、状态查询、portable 导出中返回。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| platform | string | 否 | `windows` / `macos` / `linux` / `unknown` |
| manufacturer | string | 否 | 厂商，如 `Microsoft`、`Apple`、`Ubuntu` |
| model | string | 否 | 设备名，如 `Windows PC`、`MacBook Pro` |
| osVersion | string | 否 | 系统版本 |
| device | string | 否 | 设备代号 |
| deviceUUID | string | 否 | paramsLogin 里的设备 UUID |
| phoneUUID | string | 否 | paramsLogin/sixLogin 里的 phoneId/phoneUUID |
| whatsappVersion | string | 否 | WhatsApp 版本 |
| wsDeviceId | number | 否 | sixLogin 分身设备 ID |
| deviceCompanion | boolean | 否 | 是否分身/伴随设备 |

`browserDisplay` 字段说明：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| browserName | string | 是 | 浏览器名，如 `Opera`、`Chrome`、`Edge` |
| platform | string | 是 | `ios` / `android` / `windows` / `macos` / `linux` / `unknown` |
| version | string | 否 | 浏览器/设备版本 |

注意：`browserDisplay` 只控制 WhatsApp 已关联设备里的展示名，不等于真实内核，也不等于原生协议登录。

### 2.7 批量导入

**用途**：批量导入账号，支持冷启动节流。

**请求方式**

```http
POST /v1/accounts/import/batch
```

**请求示例**

```json
{
  "autoOnline": true,
  "concurrency": 5,
  "coldStartBatchSize": 50,
  "coldStartBatchIntervalMs": 30000,
  "items": [
    {
      "format": "baileys_json",
      "data": {
        "accountId": "acc_001",
        "json": {
          "creds": {},
          "keys": {}
        },
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

**响应示例**

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

**注意事项**

- `ASSIGNED_REMOTE` 表示已分配到远端 owner，功能层应按 `ownerEndpoint` 补调 online。

## 3. 账号生命周期

### 3.1 上线账号

**用途**：用已有 creds 建立 socket，不重新授权。

**请求方式**

```http
POST /v1/accounts/{accountId}/online
```

**请求示例**

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

**响应示例**

```json
{
  "accountId": "acc_001",
  "accepted": true,
  "ownerWorkerId": "worker-002"
}
```

### 3.2 手动离线

**用途**：断开 socket，保留 creds，不占 active slot。

**请求方式**

```http
POST /v1/accounts/{accountId}/offline
```

**响应示例**

```json
{
  "ok": true
}
```

### 3.3 Logout

**用途**：退出设备、删除 creds、解除 Registry 绑定。

**请求方式**

```http
POST /v1/accounts/{accountId}/logout
```

**响应示例**

```json
{
  "ok": true
}
```

## 4. 状态查询

### 4.1 查询完整状态

**用途**：查看账号状态、证据、Business 类型、slot 是否释放。

**请求方式**

```http
GET /v1/accounts/{accountId}/status
```

**响应示例：在线**

```json
{
  "accountId": "acc_001",
  "state": "ONLINE",
  "evidence": {
    "wsOpen": true,
    "connectionField": "open",
    "lastDateRecv": "2026-05-19T10:00:00.000Z",
    "lastPingAckAt": "2026-05-19T10:00:00.000Z",
    "ageMs": 100,
    "keepAliveIntervalMs": 30000
  },
  "accountType": "UNKNOWN",
  "deviceProfile": {
    "accountId": "acc_001",
    "platform": "macos",
    "source": "params_fields",
    "manufacturer": "Apple",
    "model": "MacBook Pro",
    "osVersion": "14.4.1",
    "device": "MacBookPro18,3",
    "deviceUUID": null,
    "phoneUUID": null,
    "whatsappVersion": "2.24.10.79",
    "wsDeviceId": null,
    "deviceCompanion": false,
    "note": "metadata only; does not change Baileys socket browser fingerprint",
    "updatedAt": "2026-05-21T08:00:00.000Z"
  },
  "workerId": "worker-002",
  "reportedAt": "2026-05-19T10:00:00.000Z"
}
```

**响应示例：已释放 slot**

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

### 4.2 轻量探活

**用途**：高频查询账号是否在线。

**请求方式**

```http
GET /v1/accounts/{accountId}/alive
```

**响应示例**

```json
{
  "online": true,
  "ageMs": 100,
  "reportedAt": "2026-05-19T10:00:00.000Z"
}
```

### 4.3 获取账号类型

**用途**：判断个人号、普通 Business、认证 Business。

**请求方式**

```http
GET /v1/accounts/{accountId}/type
```

**响应示例**

```json
{
  "accountType": "BUSINESS_STANDARD",
  "isBusiness": true,
  "isVerified": false,
  "platform": "unknown",
  "bizName": "Demo Shop",
  "verifiedName": null,
  "source": "pair_success",
  "detectedAt": "2026-05-19T10:00:00.000Z"
}
```

### 4.4 主动 Probe

**用途**：关键操作前主动探测 socket 是否可用。

**请求方式**

```http
POST /v1/accounts/{accountId}/probe
```

**响应示例**

```json
{
  "ackedAt": "2026-05-19T10:00:00.000Z",
  "rttMs": 80
}
```

### 4.5 检查手机号是否 WhatsApp 用户

**请求方式**

```http
POST /v1/accounts/check-whatsapp
```

**请求示例**

```json
{
  "accountId": "acc_001",
  "phones": ["8613900000000", "8613911111111"]
}
```

**响应示例**

```json
{
  "results": [
    {
      "phone": "8613900000000",
      "jid": "8613900000000@s.whatsapp.net",
      "exists": true
    }
  ]
}
```

## 5. 风控与可用性

### 5.1 综合可用性

**用途**：下发拉群、发消息任务前推荐先查。

**请求方式**

```http
GET /v1/accounts/{accountId}/usability
```

**响应示例**

```json
{
  "accountId": "acc_001",
  "canSendText": true,
  "canSendNewChat": true,
  "canCreateGroup": true,
  "canAddToGroup": true,
  "blockedReason": null,
  "blockedUntil": null,
  "checkedAt": "2026-05-19T10:00:00.000Z"
}
```

### 5.2 查询账号限制

**用途**：查询 reachoutTimelock 等限制状态。

**请求方式**

```http
GET /v1/accounts/{accountId}/restriction
```

### 5.3 查询消息配额

**用途**：查询新 chat 配额、capping 状态。

**请求方式**

```http
GET /v1/accounts/{accountId}/message-cap
```

## 6. 代理

### 6.1 绑定代理

**用途**：保存账号代理绑定。

**请求方式**

```http
POST /v1/accounts/{accountId}/proxy/bind
```

**请求示例**

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

**响应示例**

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

### 6.2 重新绑定代理 / 换 IP

**用途**：换 IP。协议层会重建 socket，成功后回到 ONLINE。

**请求方式**

```http
POST /v1/accounts/{accountId}/proxy/rebind
```

**注意事项**

- 换 IP 不需要重新授权。
- 换 IP 期间仍占 active slot。

### 6.3 查询代理

```http
GET /v1/accounts/{accountId}/proxy
```

### 6.4 删除代理

```http
DELETE /v1/accounts/{accountId}/proxy
```

## 7. 消息

### 7.1 发送文本消息

**请求方式**

```http
POST /v1/messages/text
```

**请求示例**

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "text": "hello"
}
```

**响应示例**

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

### 7.2 发送超链接消息

**用途**：发送带 URL 的文本，支持链接预览。

**请求方式**

```http
POST /v1/messages/link
```

**请求示例**

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "text": "打开这个链接 https://example.com",
  "generatePreview": true
}
```

**响应示例**

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

### 7.3 发送图片

```http
POST /v1/messages/image
```

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "image": {
    "url": "https://cdn.example.com/image.jpg",
    "mimetype": "image/jpeg"
  },
  "caption": "图片说明",
  "viewOnce": false
}
```

### 7.4 发送视频

```http
POST /v1/messages/video
```

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "video": {
    "url": "https://cdn.example.com/video.mp4",
    "mimetype": "video/mp4"
  },
  "caption": "视频说明"
}
```

### 7.5 发送音频

```http
POST /v1/messages/audio
```

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "audio": {
    "url": "https://cdn.example.com/audio.mp3",
    "mimetype": "audio/mpeg"
  },
  "ptt": false
}
```

### 7.6 发送文档

```http
POST /v1/messages/document
```

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "document": {
    "url": "https://cdn.example.com/file.pdf"
  },
  "fileName": "file.pdf",
  "mimetype": "application/pdf",
  "caption": "文档"
}
```

### 7.7 发送位置

```http
POST /v1/messages/location
```

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "degreesLatitude": 31.2304,
  "degreesLongitude": 121.4737,
  "name": "上海",
  "address": "Shanghai"
}
```

### 7.8 发送名片

```http
POST /v1/messages/contact-card
```

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "contacts": [
    {
      "displayName": "Tom",
      "vcard": "BEGIN:VCARD\nVERSION:3.0\nFN:Tom\nTEL:+8613900000000\nEND:VCARD"
    }
  ]
}
```

### 7.9 消息表情反应

```http
POST /v1/messages/reaction
```

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "targetKey": {
    "remoteJid": "8613900000000@s.whatsapp.net",
    "fromMe": false,
    "id": "MSG_ID"
  },
  "reaction": "👍"
}
```

### 7.10 撤回消息

```http
POST /v1/messages/delete
```

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "targetKey": {
    "remoteJid": "8613900000000@s.whatsapp.net",
    "fromMe": true,
    "id": "MSG_ID"
  },
  "forEveryone": true
}
```

### 7.11 转发消息

```http
POST /v1/messages/forward
```

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "sourceMessage": {},
  "forceForward": false
}
```

### 7.12 标记已读

```http
POST /v1/messages/read
```

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

### 7.13 输入状态

```http
POST /v1/messages/typing
```

```json
{
  "accountId": "acc_001",
  "jid": "8613900000000@s.whatsapp.net",
  "state": "composing",
  "durationSec": 5
}
```

### 7.14 下载媒体

```http
POST /v1/messages/{messageId}/download
```

```json
{
  "accountId": "acc_001",
  "message": {},
  "returnAs": "base64"
}
```

### 7.15 发送动态 Status

```http
POST /v1/messages/status
```

```json
{
  "accountId": "acc_001",
  "content": {
    "text": "hello status"
  },
  "statusJidList": [
    "8613900000000@s.whatsapp.net"
  ]
}
```

## 8. 群组

### 8.1 创建群

**用途**：创建群并添加初始成员。

**请求方式**

```http
POST /v1/groups/create
```

**请求示例**

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

**响应示例**

```json
{
  "groupJid": "120363000000000000@g.us",
  "results": {
    "groupJid": "120363000000000000@g.us",
    "results": [
      {
        "jid": "8613900000000@s.whatsapp.net",
        "status": "200"
      }
    ]
  }
}
```

### 8.2 添加群成员

**用途**：拉人进群。

**请求方式**

```http
POST /v1/groups/{groupJid}/participants/add
```

**请求示例**

```json
{
  "accountId": "acc_001",
  "participants": [
    "8613900000000@s.whatsapp.net"
  ]
}
```

**响应示例**

```json
{
  "groupJid": "120363000000000000@g.us",
  "results": [
    {
      "jid": "8613900000000@s.whatsapp.net",
      "status": "200"
    }
  ]
}
```

### 8.3 移除群成员

```http
POST /v1/groups/{groupJid}/participants/remove
```

```json
{
  "accountId": "acc_001",
  "participants": [
    "8613900000000@s.whatsapp.net"
  ]
}
```

### 8.4 设置群管理员

**用途**：提升成员为管理员。

```http
POST /v1/groups/{groupJid}/participants/promote
```

```json
{
  "accountId": "acc_001",
  "participants": [
    "8613900000000@s.whatsapp.net"
  ]
}
```

### 8.5 取消群管理员

```http
POST /v1/groups/{groupJid}/participants/demote
```

```json
{
  "accountId": "acc_001",
  "participants": [
    "8613900000000@s.whatsapp.net"
  ]
}
```

### 8.6 获取群信息

```http
GET /v1/groups/{groupJid}/metadata?accountId=acc_001
```

### 8.7 获取群成员

```http
GET /v1/groups/{groupJid}/participants?accountId=acc_001
```

**响应示例**

```json
[
  {
    "id": "8613900000000@s.whatsapp.net",
    "admin": "admin"
  }
]
```

### 8.8 获取账号所有群聊

```http
GET /v1/accounts/{accountId}/groups
```

**响应示例**

```json
{
  "total": 1,
  "groups": [
    {
      "groupJid": "120363000000000000@g.us",
      "subject": "测试群",
      "size": 10,
      "owner": "8613800000000@s.whatsapp.net",
      "isAdmin": true,
      "announce": false,
      "creation": 1779175200
    }
  ]
}
```

### 8.9 设置群名称

```http
POST /v1/groups/{groupJid}/subject
```

```json
{
  "accountId": "acc_001",
  "subject": "新的群名"
}
```

### 8.10 设置群描述

```http
POST /v1/groups/{groupJid}/description
```

```json
{
  "accountId": "acc_001",
  "description": "这是新的群描述"
}
```

### 8.11 设置群头像

```http
POST /v1/groups/{groupJid}/picture
```

```json
{
  "accountId": "acc_001",
  "image": {
    "url": "https://cdn.example.com/group.jpg"
  }
}
```

### 8.12 获取群邀请 code / 群链接 / 群二维码内容

**用途**：获取群邀请 code 和邀请链接。若功能层要展示“群二维码”，用 `inviteUrl` 自己生成二维码图片。

```http
GET /v1/groups/{groupJid}/invite-code?accountId=acc_001
```

**响应示例**

```json
{
  "groupJid": "120363000000000000@g.us",
  "inviteCode": "AbCdEfGhIjK123456",
  "inviteUrl": "https://chat.whatsapp.com/AbCdEfGhIjK123456"
}
```

### 8.13 重置群邀请链接

```http
POST /v1/groups/{groupJid}/invite/revoke
```

```json
{
  "accountId": "acc_001"
}
```

**响应示例**

```json
{
  "groupJid": "120363000000000000@g.us",
  "inviteCode": "NewInviteCode",
  "inviteUrl": "https://chat.whatsapp.com/NewInviteCode"
}
```

### 8.14 根据群链接 / code 进群

**用途**：通过群邀请 code 加入群。完整链接取最后一段作为 `inviteCode`。

```http
POST /v1/groups/join
```

**请求示例**

```json
{
  "accountId": "acc_001",
  "inviteCode": "AbCdEfGhIjK123456"
}
```

**响应示例**

```json
{
  "groupJid": "120363000000000000@g.us",
  "joined": true
}
```

### 8.15 退出群组

```http
POST /v1/groups/{groupJid}/leave
```

```json
{
  "accountId": "acc_001"
}
```

### 8.16 设置群公告模式

**用途**：设置仅管理员发言或恢复所有成员发言。

```http
POST /v1/groups/{groupJid}/settings/announcement
```

仅管理员发言：

```json
{
  "accountId": "acc_001",
  "mode": "announcement"
}
```

所有成员发言：

```json
{
  "accountId": "acc_001",
  "mode": "not_announcement"
}
```

### 8.17 设置群资料是否锁定

```http
POST /v1/groups/{groupJid}/settings/locked
```

```json
{
  "accountId": "acc_001",
  "mode": "locked"
}
```

### 8.18 设置成员加人模式

```http
POST /v1/groups/{groupJid}/settings/member-add-mode
```

```json
{
  "accountId": "acc_001",
  "mode": "admin_add"
}
```

`mode` 可选：

```text
admin_add
all_member_add
```

### 8.19 设置入群审批

```http
POST /v1/groups/{groupJid}/settings/join-approval
```

```json
{
  "accountId": "acc_001",
  "mode": "on"
}
```

### 8.20 获取待审批列表

```http
GET /v1/groups/{groupJid}/pending?accountId=acc_001
```

### 8.21 批准入群

```http
POST /v1/groups/{groupJid}/pending/approve
```

```json
{
  "accountId": "acc_001",
  "participants": [
    "8613900000000@s.whatsapp.net"
  ]
}
```

### 8.22 拒绝入群

```http
POST /v1/groups/{groupJid}/pending/reject
```

```json
{
  "accountId": "acc_001",
  "participants": [
    "8613900000000@s.whatsapp.net"
  ]
}
```

## 9. 联系人与聊天

### 9.1 保存联系人

```http
POST /v1/contacts/{jid}/save
```

```json
{
  "accountId": "acc_001",
  "name": "Tom"
}
```

### 9.2 删除联系人

```http
DELETE /v1/contacts/{jid}
```

```json
{
  "accountId": "acc_001"
}
```

### 9.3 拉黑联系人

```http
POST /v1/contacts/{jid}/block
```

```json
{
  "accountId": "acc_001"
}
```

### 9.4 取消拉黑

```http
POST /v1/contacts/{jid}/unblock
```

```json
{
  "accountId": "acc_001"
}
```

### 9.5 聊天操作

| 功能 | 接口 |
|---|---|
| 静音 | `POST /v1/chats/{jid}/mute` |
| 清空 | `POST /v1/chats/{jid}/clear` |
| 删除 | `POST /v1/chats/{jid}/delete` |
| 归档 | `POST /v1/chats/{jid}/archive` |
| 置顶 | `POST /v1/chats/{jid}/pin` |
| 标记已读 | `POST /v1/chats/{jid}/mark-read` |

请求体统一：

```json
{
  "accountId": "acc_001"
}
```

## 10. 个人资料

### 10.1 修改昵称

```http
POST /v1/profile/name
```

```json
{
  "accountId": "acc_001",
  "name": "New Name"
}
```

### 10.2 修改签名

```http
POST /v1/profile/status
```

```json
{
  "accountId": "acc_001",
  "status": "hello"
}
```

### 10.3 修改头像

```http
POST /v1/profile/picture
```

```json
{
  "accountId": "acc_001",
  "image": {
    "url": "https://cdn.example.com/avatar.jpg"
  }
}
```

### 10.4 删除头像

```http
DELETE /v1/profile/picture
```

```json
{
  "accountId": "acc_001"
}
```

### 10.5 查询头像 URL

```http
GET /v1/profile/{jid}/picture-url?accountId=acc_001
```

## 11. Business

### 11.1 查询 Business Profile

```http
GET /v1/profile/business/{jid}?accountId=acc_001
```

**用途**：判断目标是否 Business 号，获取 profile。

### 11.2 更新自己的 Business Profile

```http
POST /v1/profile/business/update
```

```json
{
  "accountId": "acc_001",
  "description": "店铺描述",
  "category": "Retail",
  "email": "shop@example.com",
  "website": ["https://example.com"],
  "address": "Shanghai"
}
```

### 11.3 查询商品目录

```http
GET /v1/business/catalog?accountId=acc_001&jid=8613900000000@s.whatsapp.net&limit=20
```

### 11.4 商品创建 / 更新 / 删除

```http
POST /v1/business/product
```

创建：

```json
{
  "accountId": "acc_001",
  "action": "create",
  "product": {
    "name": "商品名",
    "description": "商品描述",
    "priceAmount1000": 9990,
    "currency": "USD"
  }
}
```

删除：

```json
{
  "accountId": "acc_001",
  "action": "delete",
  "productIds": ["product_id"]
}
```

## 12. 频道 Newsletter

### 12.1 关注频道

```http
POST /v1/channels/follow
```

```json
{
  "accountId": "acc_001",
  "jid": "120363xxx@newsletter"
}
```

### 12.2 取消关注频道

```http
POST /v1/channels/unfollow
```

```json
{
  "accountId": "acc_001",
  "jid": "120363xxx@newsletter"
}
```

### 12.3 拉取频道消息

```http
GET /v1/channels/{jid}/messages?accountId=acc_001&count=50
```

### 12.4 频道消息反应

```http
POST /v1/channels/{jid}/reaction
```

```json
{
  "accountId": "acc_001",
  "serverId": "123456",
  "reaction": "👍"
}
```

## 13. 导出

### 13.1 导出 Baileys JSON

```http
GET /v1/accounts/{accountId}/export/baileys-json
```

用途：完整迁移 / 备份账号，返回 `schema + creds + keys`。这是协议层推荐的完整导出格式。

响应示例：

```json
{
  "schema": "baileys.auth_state.v1",
  "creds": {
    "me": {
      "id": "919378147380:10@s.whatsapp.net",
      "lid": "189022232154352:10@lid",
      "name": "hy"
    },
    "platform": "smbi",
    "registered": true
  },
  "keys": {
    "pre-key": {},
    "session": {},
    "sender-key": {},
    "sender-key-memory": {},
    "app-state-sync-key": {},
    "app-state-sync-version": {}
  }
}
```

### 13.2 导出竞品兼容平铺 creds JSON

```http
GET /v1/accounts/{accountId}/export/creds-json
```

用途：兼容竞品导出的账号 JSON，顶层直接是 `me`、`Phone`、`account`、`noiseKey`、`signedPreKey`、`registrationId` 等 creds 字段，不带外层 `schema/creds/keys`。

注意：此格式不包含 Signal keys，适合功能层联调、格式兼容、人工核对；完整迁移优先用 `baileys-json` 或 `portable`。

响应示例：

```json
{
  "me": {
    "id": "919378147380:10@s.whatsapp.net",
    "lid": "189022232154352:10@lid",
    "name": "hy"
  },
  "Phone": "919378147380",
  "account": {
    "details": "CODJ96gEEJmYktAGGAEgACgA",
    "deviceSignature": "BWz8mJtgHKbrjKYU8b4aZjMW2KU1yp8v7jwNdpf/FpUzNET8H7kMjyMZg3qgJEtISDAkBQ4/cmfp77eFk6iahA=="
  },
  "noiseKey": {
    "public": {
      "type": "Buffer",
      "data": "ASw5B7yXPhS1vb3SgW23OVDtHsyE8d/DUKhcjXpnkFQ="
    },
    "private": {
      "type": "Buffer",
      "data": "yKEq+JO87H1zjG6L57nEA2k48W3SIMcaDv8Cq8qTX1s="
    }
  },
  "platform": "smbi",
  "registered": true,
  "advSecretKey": "LCXU1IC7HtquRkLpCIClCEoufll8PEZAr7+n5PH0KbI=",
  "registrationId": 1063438482
}
```

### 13.3 导出 Portable

```http
GET /v1/accounts/{accountId}/export/portable
```

返回包含 `baileys`、`account`、`proxy`、`legacy`，并额外带 `deviceProfile`、`browserDisplay`。功能层可用它做账号设备筛选、迁移导出和联调核对。

### 13.4 批量导出

```http
POST /v1/accounts/export/batch
```

```json
{
  "accountIds": ["acc_001", "acc_002"],
  "format": "creds-json",
  "concurrency": 5
}
```

`format` 可选：

| 值 | 用途 |
|---|---|
| `baileys-json` | 完整导出 `schema + creds + keys` |
| `portable` | 完整导出并带 `account/proxy/deviceProfile/browserDisplay` |
| `creds-json` | 竞品兼容平铺 creds JSON，不扫 keys，批量导出更轻 |

## 14. 运维接口

运维接口仅内网使用，不建议功能层日常调用。

### 14.1 强制同步 Registry Load

```http
POST /v1/admin/sync-load
```

### 14.2 查询 Worker 列表

```http
GET /v1/admin/workers?includeDead=false
```

### 14.3 查询当前 Worker 账号视图

```http
GET /v1/admin/accounts
```

### 14.4 查询 Dead Worker

```http
GET /v1/admin/dead-workers?thresholdMs=60000
```

### 14.5 手动 Unassign

```http
POST /v1/admin/unassign
```

```json
{
  "accountId": "acc_001",
  "releaseSlot": true
}
```

如果业务侧收到 `account.need_reauth` 后确认彻底放弃账号，调用此接口并保持 `releaseSlot=true`，用于解除 owner 绑定并释放 Registry load。只有确认该账号的 Registry load 已经被其它流程扣过时，才传 `releaseSlot=false`。

## 15. 常见错误码

| HTTP | code | 含义 | 功能层处理 |
|---|---|---|---|
| 400 | VALIDATION_ERROR | 参数错误 | 修正请求 |
| 404 | ACCOUNT_NOT_FOUND | owner worker 没有运行态 socket | 查 status，必要时 online |
| 409 | NOT_OWNER | 打错 worker | 刷新 owner 后重试一次 |
| 422 | NEED_REAUTH | 需要重新授权 | 停任务，重新 pairing/QR |
| 422 | NOT_BUSINESS_ACCOUNT | 个人号调用 Business 接口 | 先查账号类型 |
| 429 | RATE_LIMITED | 限流 | 退避重试 |
| 503 | PROBE_TIMEOUT | 探活超时 | 查状态、换号或稍后重试 |

## 16. 事件

功能层消费 NATS：

```text
unsea.v1.events.>
```

常用事件：

| 事件 | 说明 |
|---|---|
| account.state_changed | 账号状态变更 |
| account.online_changed | 在线状态变更 |
| account.need_reauth | 需要重新授权 |
| account.type_detected | 账号类型识别 |
| message.received | 收到消息 |
| pairing.code_generated | pairing code 生成 |
| pairing.completed | 授权完成 |
| pairing.failed | 授权失败或超时 |
