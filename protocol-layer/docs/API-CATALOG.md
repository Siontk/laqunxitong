# API 速查 — 业务侧按场景查

> 完整字段以 [`openapi/protocol-v1.yaml`](../../openapi/protocol-v1.yaml) 为准。
> Swagger UI: `http://{worker}:8080/docs`

## 通用三件套（业务侧约定动作）

```
下发任务前  ──> GET /v1/accounts/{id}/usability       看 canCreateGroup / canSendNewChat / blockedReason
找正确 worker ──> GET /v1/accounts/resolve/{id}        拿 ownerEndpoint，缓存 30-60s
订阅事件   ──> Kafka topics protocol.*.events.v1    key=accountId，消费账号/消息/群/owner 事件
```

错误码：
- `400 VALIDATION_ERROR` body schema 错
- `404 ACCOUNT_NOT_FOUND` 当前 worker 没该账号运行态 → 看 `/status` slotReleased?
- `409 NOT_OWNER` 改请求 `details.ownerEndpoint`
- `422 NEED_REAUTH` 必须重做 pairing
- `422 NOT_BUSINESS_ACCOUNT` 个人号调 Business 接口
- `429 RATE_LIMITED` 退避重试，看 `retryAfterMs`
- `503 ACCOUNT_UNAVAILABLE` 查 `/usability` 决定下一步

---

## 1. 账号登录 / 授权

### 1.1 首次绑定 — pairing code（推荐）

```http
POST /v1/auth/pairing-code
{
  "phone": "8617600627277",
  "customPairingCode": "12345678",
  "proxy": { "protocol": "socks5", "url": "socks5://...", "sessionId": "acc_001", "country": "US" }
}
→ 202 { accountId, pairingId, expiresAt }
```

后续：
- 用户在手机 WA "已登录设备 → 用手机号链接" 输入返回的 8 位 code
- `customPairingCode` 可选；不传时可用服务端环境变量 `PAIRING_DEFAULT_CODE` 固定，未配置才随机
- **90s 内不输** → 协议层自动释放 slot + 推 `pairing.failed{reason: user_timeout}`
- 成功 → 推 `pairing.completed` + `account.state_changed → ONLINE`
- 失败 → 看 `account.need_reauth` 或 `pairing.failed`

### 1.2 首次绑定 — QR 扫码

```http
POST /v1/auth/qrcode
{
  "proxy": { ...同上 }
}
→ 202 { accountId, qrSessionId }
```

后续：
- 业务侧订阅 `qr.code_generated` 事件拿 base64 QR
- 用户用手机 WA 扫码 — **180s 不扫** 自动释放
- 成功路径同 pairing code

### 1.3 导入 — Baileys 标准 JSON（推荐迁移用）

```http
POST /v1/accounts/import/baileys-json
{
  "accountId": "acc_001",         // 可选；不传协议层生成
  "json": { "creds": {...}, "keys": {...} },
  "deviceProfile": { "platform": "windows", "manufacturer": "Microsoft", "model": "Windows PC" },
  "browserDisplay": { "browserName": "Opera", "platform": "ios", "version": "17.5" },
  "proxy": {...},
  "autoOnline": true
}
→ 200 ImportResult { result, accountId, businessDetection, deviceProfile, ... }
```

### 1.4 导入 — params / six / legacy-json

| 路径 | 适用 |
|---|---|
| `POST /v1/accounts/import/params` | Apifox `paramsLogin` 全 30+ 字段 |
| `POST /v1/accounts/import/six` | Apifox `sixLogin` 六段（含 deviceIdentityKey 分身设备）|
| `POST /v1/accounts/import/legacy-json` | Apifox `jsonLogin` base64 旧 JSON |

导入、pairing、QR、online 请求都支持可选 `deviceProfile` 和 `browserDisplay`。`deviceProfile` 用于账号画像，`browserDisplay` 用于已关联设备展示名，例如 `Opera (iOS)`。

返回 ImportResult，`result` 可能是：
- `IMPORTED_ONLINE` 已上线
- `IMPORTED_OFFLINE` 已导入未上线
- `CONVERTED_FULL` / `CONVERTED_PARTIAL` 转换成功（含/缺 keys）
- `NEED_REAUTH` 材料不全
- `UNSUPPORTED_FORMAT` / `INVALID_CREDENTIAL` 格式错

### 1.5 批量导入（带冷启动节流）

```http
POST /v1/accounts/import/batch
{
  "items": [
    { "format": "baileys_json", "data": {...} },
    { "format": "params", "data": {...} },
    ...最多 500 个
  ],
  "autoOnline": true,
  "concurrency": 5,
  "coldStartBatchSize": 50,
  "coldStartBatchIntervalMs": 30000
}
→ 200 { total, succeeded, failed, results: [{ accountId, result, data: { routing: { ownerEndpoint } } }] }
```

`result=ASSIGNED_REMOTE` 时业务侧按 `data.routing.ownerEndpoint` 分组后补调 `/online`。

---

## 2. 账号生命周期

```http
POST /v1/accounts/{id}/online   { proxy?: {...} }    # 用已存 creds 上线（autoOnline 漏的补做）
POST /v1/accounts/{id}/offline                       # 主动下线（保留 creds）
POST /v1/accounts/{id}/logout                        # 远端踢设备 + 删 creds
```

**换 IP 不需要 logout/online**，调 `/proxy/rebind` 即可。

---

## 3. 状态查询

| 路径 | 何时用 | 返回关键字段 |
|---|---|---|
| `GET /v1/accounts/{id}/status` | 完整诊断 | state + evidence + business + deviceProfile + currentProxy + metrics |
| `GET /v1/accounts/{id}/alive` | 高频探活 | online + ageMs |
| `GET /v1/accounts/{id}/type` | 判 Business | accountType / isBusiness / isVerified / bizName / source |
| `POST /v1/accounts/{id}/probe` | 关键操作前 | rttMs（3s 不 ack 返 503） |
| `POST /v1/accounts/check-whatsapp` | 批量手机号查 WA 用户 | results[] |
| `GET /v1/accounts/resolve/{id}` | 解析 owner worker | ownerWorkerId / ownerEndpoint |

### 状态机 13 态

```
NEW → IMPORTED → PAIRING → VERIFYING → ONLINE
                                ↓
                       STALE ──> RECONNECTING
                                ↓
   OFFLINE / PROXY_FAILED / RATE_LIMITED / NEED_REAUTH / LOGGED_OUT / DEVICE_REMOVED
```

业务侧只需关心：
- `ONLINE` 可派任务
- `NEED_REAUTH` 需重 pairing（看 `account.need_reauth` 事件）
- 其他状态都是过渡 / 终态，看 evidence 和 reason

---

## 4. 风控查询（拉群必查）

### 4.1 综合可用性（推荐入口）

```http
GET /v1/accounts/{id}/usability
→ {
  state: "ONLINE",
  canSendText: true, canSendNewChat: false, canCreateGroup: false, canAddToGroup: false,
  canSendMedia: true, canFollowChannel: true,
  blockedReason: "REACHOUT_TIMELOCK" | "NEW_CHAT_CAPPED" | "RATE_LIMITED" | "OFFLINE" | "NEED_REAUTH" | null,
  blockedUntil: "2026-05-18T18:00:00Z",
  restriction: {...}, messageCap: {...}, evidence: {...}
}
```

### 4.2 单独查 reachoutTimelock

```http
GET /v1/accounts/{id}/restriction
→ { isActive, restrictedUntil, enforcementType: "BIZ_QUALITY" | "BIZ_COMMERCE_VIOLATION_*" | ... }
```

### 4.3 单独查新 chat 配额

```http
GET /v1/accounts/{id}/message-cap
→ { totalQuota, usedQuota, remaining, cycleEnd, cappingStatus: "NONE"|"FIRST_WARNING"|"SECOND_WARNING"|"CAPPED" }
```

---

## 5. 代理（动态住宅 10-15min sticky）

```http
POST /v1/accounts/{id}/proxy/bind                    # 业务侧 ProxyAllocator 给 session
POST /v1/accounts/{id}/proxy/rebind                  # PROXY_FAILED 处理（触发 worker 重建 socket）
GET  /v1/accounts/{id}/proxy                         # 查当前绑定
```

ProxyBinding 字段：
```json
{
  "protocol": "socks5",
  "url": "socks5://brd-customer-XXX-zone-residential-session-{sessionId}-country-{country}:PASS@proxy.example.com:22225",
  "sessionId": "acc_001",
  "country": "US",
  "asn": "AS7922",
  "tier": "standard",
  "stickyDurationSec": 600
}
```

**绑定的是 sessionId 不是 IP**。IP 由代理商每 10-15min 轮换，协议层重连，业务无感。

---

## 6. 拉群（业务核心）

### 6.1 建群 + 拉人

```http
POST /v1/groups/create
{
  "accountId": "acc_001",
  "subject": "群名",
  "participants": ["918094787585", "914745668568"]
}
→ { groupJid, results: { groupJid, results: [{ jid, status: "200"|"403"|"408"|"409"|"419"|"500" }] } }
```

```http
POST /v1/groups/{groupJid}/participants/add
{ "accountId": "acc_001", "participants": ["918..."] }
→ [{ jid, status, content }]
```

**per-participant status 码**：
- `200` 成功
- `403` 对方隐私阻止（"who can add me" 设置）
- `408` 超时
- `409` 已在群
- `419` 群满
- `500` 服务端错误

### 6.2 群管理

| 业务 | 路径 |
|---|---|
| 改群名 | `POST /v1/groups/{jid}/subject` |
| 改群描述 | `POST /v1/groups/{jid}/description` |
| 改群头像 | `POST /v1/groups/{jid}/picture` |
| 升/降管理员 | `POST /v1/groups/{jid}/participants/{promote,demote}` |
| 移除成员 | `POST /v1/groups/{jid}/participants/remove` |
| 设仅管理员发言 | `POST /v1/groups/{jid}/settings/announcement` `{mode: "announcement"\|"not_announcement"}` |
| 锁/解锁群信息 | `POST /v1/groups/{jid}/settings/locked` `{mode: "locked"\|"unlocked"}` |
| 成员是否可拉人 | `POST /v1/groups/{jid}/settings/member-add-mode` `{mode: "admin_add"\|"all_member_add"}` |
| 入群审批开关 | `POST /v1/groups/{jid}/settings/join-approval` `{mode: "on"\|"off"}` |

### 6.3 邀请 code

```http
GET  /v1/groups/{jid}/invite-code         → { inviteCode, inviteUrl }
POST /v1/groups/{jid}/invite/revoke       → { 新 inviteCode }
POST /v1/groups/join                      → { groupJid, joined }
   { accountId, inviteCode }
```

### 6.4 入群审批

```http
GET  /v1/groups/{jid}/pending             → { pending: [{ jid, requestedAt }] }
POST /v1/groups/{jid}/pending/approve     → [{ jid, status }]
POST /v1/groups/{jid}/pending/reject      → [{ jid, status }]
```

### 6.5 查询

```http
GET  /v1/groups/{jid}/metadata             → 群详情
GET  /v1/groups/{jid}/participants         → 成员列表
GET  /v1/accounts/{id}/groups              → 账号所有群
POST /v1/groups/{jid}/leave                → 退群
```

---

## 7. 消息

### 7.1 发送

| 类型 | 路径 | body 关键字段 |
|---|---|---|
| 文本 | `POST /v1/messages/text` | text |
| 图片 | `POST /v1/messages/image` | image: {url\|base64}, caption?, viewOnce? |
| 视频 | `POST /v1/messages/video` | video, caption?, gifPlayback? |
| 音频 / 语音 | `POST /v1/messages/audio` | audio, ptt?, mimetype? |
| 文档 | `POST /v1/messages/document` | document, fileName, mimetype, caption? |
| 位置 | `POST /v1/messages/location` | degreesLatitude, degreesLongitude, name?, address? |
| 名片 | `POST /v1/messages/contact-card` | contacts: [{displayName, vcard}] |
| 链接 | `POST /v1/messages/link` | text, generatePreview? |
| 表情反应 | `POST /v1/messages/reaction` | targetKey, reaction（空串=移除）|
| 撤回 | `POST /v1/messages/delete` | targetKey, forEveryone? |
| 转发 | `POST /v1/messages/forward` | sourceMessage（完整 message 对象）|
| 动态 | `POST /v1/messages/status` | content (text/image/video), statusJidList[] |
| 已读 | `POST /v1/messages/read` | keys: [MessageKey] |
| 输入中 | `POST /v1/messages/typing` | jid, state: composing\|recording\|paused, durationSec |

媒体输入：
```json
"image": { "url": "https://cdn.../a.jpg", "mimetype": "image/jpeg" }
// 或
"image": { "base64": "...", "mimetype": "image/jpeg" }
```

**业务侧约定**：能用 url 就不要 base64（base64 让 Kafka 和 HTTP body 膨胀 33%）。

### 7.2 媒体下载

```http
POST /v1/messages/{messageId}/download
{
  "accountId": "acc_001",
  "message": { ...完整 WA message 对象，从 message.received 事件 payload 直接传 },
  "returnAs": "url" | "base64" | "stream"
}
→ { mimetype, sizeBytes, base64?, url? }
```

- `returnAs: "url"` 推荐生产用（协议层 S3 缓存返 signed URL）
- 必须传完整 message 对象，仅传 key 无法解密

---

## 8. 联系人与会话

```http
POST /v1/contacts/{jid}/save              # 添加/编辑联系人
DELETE /v1/contacts/{jid}                  # 删除
POST /v1/contacts/{jid}/block              # 拉黑
POST /v1/contacts/{jid}/unblock            # 取消拉黑

POST /v1/chats/{jid}/mute                  # 静音
POST /v1/chats/{jid}/clear                 # 清空聊天
POST /v1/chats/{jid}/delete                # 删除会话
POST /v1/chats/{jid}/archive               # 归档
POST /v1/chats/{jid}/pin                   # 置顶
POST /v1/chats/{jid}/mark-read             # 标记已读
```

---

## 9. 自己的资料

```http
POST   /v1/profile/name                    { name }
POST   /v1/profile/status                  { status }     # 签名
POST   /v1/profile/picture                 { image }       # 头像
DELETE /v1/profile/picture                                 # 删头像

GET    /v1/profile/{jid}/picture-url?accountId=...&type=preview|image
```

---

## 10. Business 资料（仅 Business 号）

```http
# 判他人是否 Business（profile==null 即个人号）
GET  /v1/profile/business/{jid}?accountId=...
→ { jid, isBusiness, profile: { description, website, email, address, category, businessHours } | null }

# 更新自己 Business profile（个人号调返 422 NOT_BUSINESS_ACCOUNT）
POST /v1/profile/business/update           { accountId, description?, category?, email?, ... }

# catalog
GET  /v1/business/catalog?accountId=...&jid=...&limit=20&cursor=...
→ { products: [...], nextCursor }

# 商品 CRUD
POST /v1/business/product                  { accountId, action: "create"|"update"|"delete", product?, productIds? }
```

---

## 11. 频道 newsletter

```http
POST /v1/channels/follow                   { accountId, jid }
POST /v1/channels/unfollow                 { accountId, jid }
GET  /v1/channels/{jid}/messages?accountId=...&count=50&since=0&after=0
POST /v1/channels/{jid}/reaction           { accountId, serverId, reaction }
```

---

## 12. 导出（迁移 / 备份）

```http
GET  /v1/accounts/{id}/export/baileys-json    # 完整 creds + keys
GET  /v1/accounts/{id}/export/creds-json      # 竞品兼容平铺 creds，不含 keys
GET  /v1/accounts/{id}/export/portable        # 含 proxy 元数据 + accountType + deviceProfile
POST /v1/accounts/export/batch                # 批量
   { accountIds: [...], format: "baileys-json"|"portable"|"creds-json", concurrency: 5 }
```

---

## 13. 事件订阅（Kafka）

Kafka message key 固定为 `accountId`，同账号事件在同一 partition 内有序。

| Topic | 事件 |
|---|---|
| `protocol.account.events.v1` | account.* 状态/风控事件 |
| `protocol.owner.events.v1` | account.owner_assigned / changed / unassigned |
| `protocol.message.events.v1` | message.received / message.ack |
| `protocol.group.events.v1` | group.participant_changed / metadata_updated |
| `protocol.pairing.events.v1` | pairing.* / qr.* |

| 事件 | 业务侧用法 |
|---|---|
| `account.state_changed` | 状态机驱动业务侧账号管理 |
| `account.heartbeat` | 30s 心跳，检测 worker 健康 |
| `account.online_changed` | ONLINE 翻转，刷新业务侧 owner 缓存 |
| `account.stale_detected` | 监控告警 |
| `account.need_reauth` | 触发重新 pairing 工单 |
| `account.type_detected` | 写库 accountType |
| `account.proxy_failed` | 触发 ProxyAllocator 换 session |
| `account.proxy_rotated` | 信息（IP 实际变化）|
| `account.rate_limited` | 暂停下发任务 |
| `account.restricted` | 暂停下发任务到 restrictedUntil |
| `account.new_chat_capping` | CAPPED 时停拉群 |
| `account.owner_assigned` | 写入功能层 owner cache |
| `account.owner_changed` | 更新功能层 owner cache，failover 后重点消费 |
| `account.owner_unassigned` | 清理功能层 owner cache |
| `pairing.code_generated` | 推前端给用户看 |
| `qr.code_generated` | 同上 |
| `pairing.completed` | 标记账号已就绪 |
| `pairing.failed` | 通知前端重试 |
| `message.received` | **业务主入口**，所有收到消息从这里来 |
| `message.ack` | 跟踪自己发的消息 |
| `group.participant_changed` | 群成员动态 |
| `group.metadata_updated` | 群信息变更 |

每条事件 payload 都带 `evidence + occurredAt + workerId`，便于业务侧乱序检测。

---

## 14. 运维接口（仅内网，业务勿用）

```http
POST /v1/admin/sync-load                   # 手动硬同步 Registry load（troubleshoot 用）
GET  /v1/admin/workers?includeDead=false   # 列 worker 集群
GET  /v1/admin/dead-workers?thresholdMs=60000
GET  /v1/admin/accounts                    # 本 worker 账号视图
POST /v1/admin/unassign                    # 兜底解除 Registry 绑定
```
