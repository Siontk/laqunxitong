# Baileys 协议层接口封装与 2000 账号承载方案

更新时间：2026-05-18  
当前本地 Baileys 版本：`7.0.0-rc11`（**RC，未发布稳定版**）

> 版本风险：7.0.0-rc11 是预发布版本。生产使用必须：
> 1. fork 仓库并锁定到具体 commit（不要追踪 `next`/`rc` tag）。
> 2. 锁定 `whatsapp-rust-bridge@0.5.4` 的原生 prebuild 平台（Linux x64/arm64），自建镜像把 `.node` 文件预装好，避免线上 `npm install` 现编译。
> 3. 每次升级 RC 都要重跑 4.3 的状态机回归 + 第 6 节的指标基线。

## 1. 结论

> 业务目标：分阶段灌入账号，最终达到**百万级长在线 concurrent**。本文档 § 4-9 按"单机/小集群"维度写设计基线；**百万级扩展路径在 § 11**。

第一版可以先不 Go 化，继续用 Node + Baileys 做协议连接层。前提是协议节点只负责：

- 账号授权登录
- session 加载和保存
- WebSocket 在线保活
- 群组、消息、联系人等协议能力调用
- 状态事件上报

Java 业务服务负责：

- 拉群任务编排
- 账号分配
- IP 池/代理分配
- 任务队列
- 限流、重试、风控
- 后台、H5、子后台业务接口

如果之前 4C8G 单台实测可以承载 2000 个账号，说明在你们当前场景里账号事件量较低，Baileys 具备作为第一版协议层的可行性。但生产上不能把"能挂 2000"理解成"无条件稳定 2000"。需要按协议节点方式做进程隔离、代理绑定、关闭历史同步、重连限流和指标监控。

> 重要：之前的 2000 账号实测如果是在 Baileys 6.x 上做的，**必须在 7.0.0-rc11 重做基线**。7.x 的关键变化：
> - 引入 `whatsapp-rust-bridge`，把 noise/lt-hash/部分加密下沉到 Rust，V8 GC 压力下降但多了一段原生堆。
> - Signal 协议层仍在 JS（`libsignal`），每账号 session/sender-key 还是 Node 堆的大头。
> - 内存曲线、事件循环延迟、句柄占用与 6.x 都会有差异，不能直接外推。

## 2. 总体架构

```text
后台 / App / H5 / 子后台
        |
        v
Java 业务服务
        |
        | HTTP/gRPC/Kafka
        v
Node Baileys 协议节点集群
        |
        v
WhatsApp Web
```

协议节点内部：

```text
AccountManager
  - 管账号状态
  - 管账号归属进程
  - 管账号上线/下线

SocketManager
  - 每个账号一个 Baileys socket
  - 处理 pairing code / QR / session reconnect
  - 处理 515 restart required 自动重连

SessionStore
  - 保存 creds + keys
  - 不建议长期只放本地文件
  - keys 是高频小写（每条消息 ratchet 都会改 sender/receiver key、pre-key），
    Postgres 直接当 keys 存储会写放大严重，必须分层：
      L1 进程内 LRU：热路径读，命中即返回，不落网络
      L2 Redis：keys 主存储，单 key 一条 hash，TTL 兜底
      L3 Postgres / 对象存储：creds（auth state 主体）+ keys 周期快照（每 N 分钟或 N 条消息）
  - creds 变更立即落 L3；keys 变更先写 L1+L2，按时间窗合并刷 L3
  - 进程重启时从 L3 恢复 creds，从 L2 恢复 keys，缺失的从 L3 快照补

ProxyManager
  - 每个账号绑定独立 HTTP/SOCKS5 代理
  - pairing code、重连、拉群操作尽量使用同一个出口

OperationRouter
  - Java 调用协议节点时，根据 accountId 找到对应 socket
```

## 3. 需要重新封装的接口

不要照搬 Apifox 旧协议的参数结构。**Apifox 现有两套接口**已盘点清楚：

- **whatsapp protoadapter api**（`/api/*`）：业务侧门面，做控制端逻辑（qrId 管理、硬件信息保存、协议节点路由）
- **whatsapp-server**（`/ws/v1/*`）：协议层直连接口，path 用 `{key}=phone` 作 key

新方案保留业务语义，重写为统一的 `/v1/*` 接口集，accountId 取代 phone 作为 key（phone 作为别名兼容）。

### 3.1 账号、授权与导入（含 Apifox 三类登录）

| 接口 | 用途 | Apifox 现状 | Baileys 对应能力 | 优先级 |
|---|---|---|---|---|
| `POST /v1/auth/pairing-code` | 首次绑定取 8 位 pairing code（回调推送） | `/ws/v1/auth/paircode` | `sock.requestPairingCode(phone)` | P0 |
| `POST /v1/auth/qrcode` | 首次绑定取二维码（回调推送） | `/ws/v1/auth/qrcode` | 监听 `connection.update.qr` | P1 |
| `POST /v1/accounts/import/baileys-json` | 导入 Baileys 标准 JSON 上线 | 无 | `useMultiFileAuthState` + `makeWASocket` | P0 |
| `POST /v1/accounts/import/params` | **全参数登录**（移植自 `paramsLogin`） | `/api/login/paramsLogin` | Importer → Baileys creds | P0 |
| `POST /v1/accounts/import/six` | **六段参数登录**（移植自 `sixLogin`） | `/api/login/sixLogin` | Importer → Baileys creds | P0 |
| `POST /v1/accounts/import/legacy-json` | **旧 JSON 登录**（移植自 `jsonLogin`） | `/api/login/jsonLogin` | Importer → Baileys creds | P0 |
| `POST /v1/accounts/{id}/online` | 已有 creds 上线（重连入口） | 内部走 `/ws/v1/auth/login` | `makeWASocket` | P0 |
| `POST /v1/accounts/{id}/offline` | 主动下线，保留 creds | 无（业务侧 downline 服务） | `sock.end()` | P0 |
| `POST /v1/accounts/{id}/logout` | 退出并移除设备 | `/ws/v1/auth/remove/{key}` | `sock.logout()` | P0 |
| `GET /v1/accounts/{id}/status` | 完整状态 + evidence（见 § 4.7） | `/ws/v1/auth/status/{key}` | 自维护 | P0 |
| `GET /v1/accounts/{id}/online` | 轻量探活 | `/ws/v1/auth/check/{key}` | 自维护 | P0 |
| `GET /v1/accounts/{id}/type` | 账号类型 PERSONAL/BUSINESS_* | 无 | `creds.platform` + `creds.me.name` | P0 |
| `POST /v1/accounts/{id}/probe` | 关键操作前主动 ping | 无 | 主动 `<iq><ping/></iq>` | P0 |
| `POST /v1/accounts/check-whatsapp` | 手机号是否 WA 用户 | 无（仅 contacts/query） | `sock.onWhatsApp(phone)` | P1 |
| `POST /v1/accounts/{id}/proxy/bind` | 绑定/换 proxy session | 各登录接口里 socks5* 字段 | 自定义 ProxyManager | P0 |
| `GET /v1/accounts/{id}/export/baileys-json` | 导出 Baileys 标准 JSON | **无** | dump `creds + keys` | P0 |
| `GET /v1/accounts/{id}/export/portable` | 导出便携 JSON（含业务元数据） | 无 | dump + 包元数据 | P1 |
| `POST /v1/accounts/import/batch` | 批量导入（zip / JSON 数组） | 无 | 同上接口循环 | P1 |

**Apifox 三类登录的字段映射**（重要——决定 importer 怎么写）：

| 旧字段 | 来自接口 | 在 Baileys creds 里对应 | 备注 |
|---|---|---|---|
| `clientStaticPrivateKey` / `clientStaticPublicKey` | params / six | `creds.noiseKey.{private,public}` | base64 直接转 |
| `identityPrivateKey` / `identityPublicKey` | params / six | `creds.signedIdentityKey.{private,public}` | base64 直接转 |
| `signPreKeyID` / `signPreKeyPrivateKey` / `signPreKeyPublicKey` / `signPreKeySignature` | params | `creds.signedPreKey.{keyId,keyPair,signature}` | 仅 params 有 |
| `registrationID` | params | `creds.registrationId` | |
| `deviceIdentityKey` | six | `creds.account`（ADVSignedDeviceIdentity protobuf） | 关键字段，protobuf 解码 |
| `phoneId` | six | `creds.phoneId` | UUID |
| `deviceUUID` / `phoneUUID` | params | `creds.phoneId` / `creds.identityId` | 二选一 |
| `wsDeviceId` | six | `creds.advSecretKey` 关联，分身设备 ID（主设备=0） | |
| `wid` | params / six | `creds.me.id` = `${wid}@s.whatsapp.net` | |
| `vip` | params / six | 推断 `accountType = BUSINESS_*` 起始猜测 | 实际类型走 § 4.7.6 复核 |
| `accountJsonBase64` | jsonLogin | base64 解码 → 旧 JSON → 转 Baileys auth_state | 见 § 3.6 |
| `socksHost/Port/User/Pass` 或 `socks5` URL | 全部 | 协议层不存，转 ProxyManager | 现存 socks5 字符串改新 sessionId 形式（§ 4.6） |
| `qrId` | 全部 | 业务侧 `clientRefId`，不进协议层 | 仅用作回调路由 |
| `whatsappVersion` / `osVersion` / `manufacturer` 等硬件字段 | params | `creds.platform` + WASocket `browser` 字段 | 不全是必须 |

**导入结果枚举**（必须细分，业务侧根据结果决定下一步）：

```text
IMPORTED_ONLINE             导入成功 + 已上线 + 首次服务端 ack 已收到
IMPORTED_OFFLINE            导入成功 + creds 完好 + 尚未上线（等 Java 决定何时 online）
CONVERTED_FULL              旧格式完整转换，可直接 online
CONVERTED_PARTIAL           creds 转出但 keys 缺，可 online 但首次重连可能多耗时
NEED_REAUTH                 材料不足或失效，必须重新走 pairing/QR
UNSUPPORTED_FORMAT          格式无法识别
INVALID_CREDENTIAL          材料无效或服务端拒绝（如 401）
```

**事件回调**（异步推送，对应 Apifox "无返回数据，配对码数据将通过回调方式返回"）：

```text
pairing.code_generated      pairing code 已生成，业务侧推给前端
qr.code_generated           二维码已生成
pairing.completed           pairing 成功，账号已绑定
pairing.failed              失败（pairing code 过期 / 用户未确认）
```


### 3.2 消息

| 接口 | 用途 | Baileys 对应能力 | 优先级 |
|---|---|---|---|
| `POST /v1/messages/text` | 发送文本 | `sock.sendMessage(jid, { text })` | P1 |
| `POST /v1/messages/image` | 发送图片 | `sock.sendMessage(jid, { image, caption })` | P1 |
| `POST /v1/messages/audio` | 发送音频 | `sock.sendMessage(jid, { audio, mimetype, ptt })` | P2 |
| `POST /v1/messages/link` | 发送链接 | `sock.sendMessage(jid, { text })` | P2 |
| `POST /v1/messages/status` | 发送动态/状态 | `sendMessage` + `statusJidList` | P2 |
| `POST /v1/messages/download` | 下载媒体 | `downloadMediaMessage()` | P2 |
| `POST /v1/messages/reaction` | 消息表情反应 | `sendMessage(jid, { react })` | P2 |
| `POST /v1/messages/delete` | 删除消息 | `sendMessage(jid, { delete })` | P2 |

Apifox 里的 `messages/limit` 需要看具体 body。Baileys 没有同名能力，可能是旧协议特殊消息，建议单独评估。

### 3.3 群组和拉群

这是当前业务核心，必须优先封装。

| 接口 | 用途 | Baileys 对应能力 | 优先级 |
|---|---|---|---|
| `POST /v1/groups/create` | 创建群 | `sock.groupCreate(subject, participants)` | P0 |
| `POST /v1/groups/participants/add` | 拉人进群 | `sock.groupParticipantsUpdate(groupJid, participants, 'add')` | P0 |
| `POST /v1/groups/participants/remove` | 移除成员 | `sock.groupParticipantsUpdate(groupJid, participants, 'remove')` | P1 |
| `POST /v1/groups/participants/promote` | 设置管理员 | `sock.groupParticipantsUpdate(groupJid, participants, 'promote')` | P1 |
| `POST /v1/groups/participants/demote` | 取消管理员 | `sock.groupParticipantsUpdate(groupJid, participants, 'demote')` | P1 |
| `GET /v1/groups/{groupJid}/metadata` | 群详情 | `sock.groupMetadata(groupJid)` | P0 |
| `GET /v1/groups/{groupJid}/participants` | 群成员 | `groupMetadata().participants` | P0 |
| `GET /v1/groups/list` | 当前账号所有群 | `sock.groupFetchAllParticipating()` | P1 |
| `POST /v1/groups/name` | 设置群名 | `sock.groupUpdateSubject(groupJid, subject)` | P1 |
| `POST /v1/groups/description` | 设置群描述 | `sock.groupUpdateDescription(groupJid, description)` | P1 |
| `GET /v1/groups/invite-code` | 获取群邀请 code | `sock.groupInviteCode(groupJid)` | P1 |
| `POST /v1/groups/invite/revoke` | 重置邀请 code | `sock.groupRevokeInvite(groupJid)` | P2 |
| `POST /v1/groups/join` | 通过 code 进群 | `sock.groupAcceptInvite(inviteCode)` | P1 |
| `POST /v1/groups/leave` | 退群 | `sock.groupLeave(groupJid)` | P1 |
| `POST /v1/groups/picture` | 设置群头像 | `sock.updateProfilePicture(groupJid, image)` | P2 |
| `POST /v1/groups/announcement` | 仅管理员发言 | `sock.groupSettingUpdate(groupJid, 'announcement')` | P1 |
| `POST /v1/groups/not-announcement` | 允许成员发言 | `sock.groupSettingUpdate(groupJid, 'not_announcement')` | P1 |
| `POST /v1/groups/lock` | 锁定群信息编辑 | `sock.groupSettingUpdate(groupJid, 'locked')` | P1 |
| `POST /v1/groups/unlock` | 解除锁定 | `sock.groupSettingUpdate(groupJid, 'unlocked')` | P1 |
| `POST /v1/groups/member-add-mode` | 成员是否可加人 | `sock.groupMemberAddMode(groupJid, 'admin_add'/'all_member_add')` | P1 |
| `GET /v1/groups/pending` | 待审批成员 | `sock.groupRequestParticipantsList(groupJid)` | P2 |
| `POST /v1/groups/pending/approve` | 同意入群申请 | `sock.groupRequestParticipantsUpdate(groupJid, participants, 'approve')` | P2 |
| `POST /v1/groups/pending/reject` | 拒绝入群申请 | `sock.groupRequestParticipantsUpdate(groupJid, participants, 'reject')` | P2 |

拉群接口的返回值需要保留单成员状态：

```json
{
  "groupJid": "xxx@g.us",
  "results": [
    {
      "jid": "8613xxx@s.whatsapp.net",
      "status": "200",
      "reason": null
    }
  ]
}
```

Baileys 的 `groupParticipantsUpdate` 本身会返回每个成员的结果，适合直接封装。

### 3.4 联系人和聊天

| 接口 | 用途 | Baileys 对应能力 | 优先级 |
|---|---|---|---|
| `POST /v1/contacts/query` | 查询手机号 | `sock.onWhatsApp(phone)` | P1 |
| `POST /v1/contacts/add` | 添加/编辑联系人 | `sock.addOrEditContact(jid, contact)` | P2 |
| `POST /v1/contacts/remove` | 删除联系人 | `sock.removeContact(jid)` | P2 |
| `POST /v1/contacts/block` | 拉黑 | `sock.updateBlockStatus(jid, 'block')` | P2 |
| `POST /v1/contacts/unblock` | 取消拉黑 | `sock.updateBlockStatus(jid, 'unblock')` | P2 |
| `POST /v1/chats/mute` | 静音 | `sock.chatModify({ mute }, jid)` | P2 |
| `POST /v1/chats/clear` | 清空聊天 | `sock.chatModify({ clear }, jid)` | P2 |
| `POST /v1/chats/delete` | 删除会话 | `sock.chatModify({ delete: true }, jid)` | P2 |

### 3.5 用户资料和频道

| 接口 | 用途 | Baileys 对应能力 | 优先级 |
|---|---|---|---|
| `POST /v1/profile/name` | 设置昵称 | `sock.updateProfileName(name)` | P2 |
| `POST /v1/profile/status` | 设置签名 | `sock.updateProfileStatus(status)` | P2 |
| `POST /v1/profile/picture` | 设置头像 | `sock.updateProfilePicture(jid, image)` | P2 |
| `POST /v1/profile/picture/remove` | 移除头像 | `sock.removeProfilePicture(jid)` | P2 |
| `GET /v1/profile/picture` | 获取头像 URL | `sock.profilePictureUrl(jid)` | P2 |
| `POST /v1/channels/follow` | 订阅频道 | `sock.newsletterFollow(jid)` | P3 |
| `POST /v1/channels/unfollow` | 取消订阅 | `sock.newsletterUnfollow(jid)` | P3 |
| `GET /v1/channels/messages` | 频道消息 | `sock.newsletterFetchMessages(jid, count, since, after)` | P3 |
| `POST /v1/channels/reaction` | 频道反应 | `sock.newsletterReactMessage(jid, serverId, reaction)` | P3 |

### 3.6 JSON 导入/导出与 legacy 转换器

百万账号、跨集群迁移、人工排查时**必须有完整的导出/导入闭环**。Apifox 现状只有导入（三类登录），**没有导出**——这是新方案必补的。

#### 3.6.1 标准 Baileys auth_state JSON（导入导出主格式）

直接 dump Baileys 内部 `creds` + `keys`，扔进任何 Baileys 实例即可登录，**不依赖业务上下文**。

```json
{
  "schema": "baileys.auth_state.v1",
  "creds": {
    "noiseKey": { "private": "<b64>", "public": "<b64>" },
    "signedIdentityKey": { "private": "<b64>", "public": "<b64>" },
    "signedPreKey": {
      "keyPair": { "private": "<b64>", "public": "<b64>" },
      "signature": "<b64>",
      "keyId": 1
    },
    "registrationId": 12345,
    "advSecretKey": "<b64>",
    "nextPreKeyId": 31,
    "firstUnuploadedPreKeyId": 31,
    "accountSettings": { ... },
    "deviceId": "<id>",
    "phoneId": "<uuid>",
    "identityId": "<b64>",
    "registered": true,
    "backupToken": "<b64>",
    "me": { "id": "8617600627277@s.whatsapp.net", "name": "Acme Co", "lid": "..." },
    "account": "<ADVSignedDeviceIdentity protobuf b64>",
    "signalIdentities": [ ... ],
    "platform": "smba",
    "lastAccountSyncTimestamp": 1715000000,
    "myAppStateKeyId": "<b64>"
  },
  "keys": {
    "pre-key": { "1": "<b64>", "2": "<b64>", ... },
    "session": { "<addr>": "<b64>", ... },
    "sender-key": { ... },
    "app-state-sync-key": { ... },
    "app-state-sync-version": { ... },
    "sender-key-memory": { ... }
  }
}
```

#### 3.6.2 便携 JSON（含业务元数据，推荐外发格式）

在 baileys 之外包业务侧信息，方便跨集群迁移和审计：

```json
{
  "schema": "unsea.portable.v1",
  "exportedAt": "2026-05-18T10:00:00Z",
  "baileys": { "creds": { ... }, "keys": { ... } },
  "account": {
    "phone": "8617600627277",
    "jid": "8617600627277@s.whatsapp.net",
    "accountType": "BUSINESS_STANDARD",
    "platform": "smba",
    "verifiedName": null,
    "pushName": "Acme Co",
    "pairedAt": "2026-05-12T08:11:02Z"
  },
  "proxy": {
    "sessionId": "acc_001",
    "country": "US",
    "asn": "AS7922",
    "tier": "standard"
  },
  "legacy": {
    "qrId": "1001",          // 兼容 Apifox 业务侧 ID
    "ipManageId": "..."       // 兼容 malaixiya IpManage 引用
  }
}
```

#### 3.6.3 三类 legacy 登录的转换器

Apifox 现有的 `paramsLogin`、`sixLogin`、`jsonLogin` 必须有**纯函数转换器**把字段映射到 Baileys auth_state。新方案 importer 必备：

| 转换器 | 输入字段（必需） | 输出 | 失败情形 |
|---|---|---|---|
| `convertParamsToBaileys` | clientStatic{Private,Public}Key、identity{Private,Public}Key、signPreKey{ID,PrivateKey,PublicKey,Signature}、registrationID、phoneUUID/deviceUUID、wid | `creds`（无 keys） | 缺 signPreKey 系列 → NEED_REAUTH |
| `convertSixToBaileys` | clientStatic{Private,Public}Key、identity{Private,Public}Key、**deviceIdentityKey**、phoneId、wid | `creds`（无 signedPreKey，需 baileys 在 online 时重新生成） | deviceIdentityKey 解码失败 → INVALID_CREDENTIAL |
| `convertLegacyJsonToBaileys` | `accountJsonBase64` decode 后的旧 JSON 结构 | 完整 `creds + keys` | JSON 字段名不对应 → UNSUPPORTED_FORMAT |

转换器输出必须**带版本号**，且必须**纯函数**（无副作用、可测试）。每个转换器配 unit test：

```text
src/importers/
  params.ts        convertParamsToBaileys(input) → BaileysAuthState
  six.ts           convertSixToBaileys(input) → BaileysAuthState
  legacy-json.ts   convertLegacyJsonToBaileys(input) → BaileysAuthState
  index.ts         统一 importer 入口，按格式调度
  __tests__/       每种格式至少 10 个真实 fixture
```

#### 3.6.4 导入与导出接口

```text
POST /v1/accounts/import/baileys-json     Body: { json, proxy?, autoOnline }
POST /v1/accounts/import/params           Body: { ...Apifox paramsLogin 全字段, proxy }
POST /v1/accounts/import/six              Body: { ...Apifox sixLogin 全字段, proxy }
POST /v1/accounts/import/legacy-json      Body: { accountJsonBase64, proxy }
POST /v1/accounts/import/batch            Body: { items: [...], autoOnline }

GET  /v1/accounts/{id}/export/baileys-json
GET  /v1/accounts/{id}/export/portable
POST /v1/accounts/export/batch            Body: { accountIds[], format }
                                          → 流式返回 zip
```

**导入接口的统一响应**：

```json
{
  "result": "IMPORTED_ONLINE",       // 枚举见 § 3.1
  "accountId": "acc_001",
  "phone": "8617600627277",
  "jid": "8617600627277@s.whatsapp.net",
  "accountType": "BUSINESS_STANDARD",
  "warnings": [ "missing pre-keys, will regenerate on first online" ],
  "evidence": { ... },               // 同 § 4.7
  "convertedFrom": "six"
}
```

### 3.7 账号风控查询（Apifox 和 malaixiya 都没有，必须新建）

这是**拉群业务最常被忽视的失败原因**：账号还在线、但 WA 服务端已经把它标为限制状态。详见 § 4.7.6（如果有）和 Baileys 源码 [socket.ts:1117](Baileys-master_协议/src/Socket/socket.ts)、[State.ts:50](Baileys-master_协议/src/Types/State.ts)、[decode-wa-message.ts:86](Baileys-master_协议/src/Utils/decode-wa-message.ts)。

| 接口 | 用途 | Baileys 对应能力 | 优先级 |
|---|---|---|---|
| `GET /v1/accounts/{id}/restriction` | 查 reachoutTimelock 状态 | `fetchAccountReachoutTimelock()` | P0 |
| `GET /v1/accounts/{id}/message-cap` | 查新 chat 配额（拉群配额） | `fetchNewChatMessageCap()` | P0 |
| `GET /v1/accounts/{id}/usability` | 业务可用性综合判定（融合上面两个 + § 4.7 状态） | 协议层聚合 | P0 |

#### 3.7.1 `restriction` 响应

```json
{
  "accountId": "acc_001",
  "isActive": true,
  "restrictedUntil": "2026-05-18T18:00:00Z",
  "enforcementType": "BIZ_QUALITY",
  "raw": { ... },                  // 原始 ReachoutTimelockState
  "fetchedAt": "2026-05-18T10:23:47Z"
}
```

`enforcementType` 枚举（14 种 `BIZ_COMMERCE_VIOLATION_*` + `BIZ_QUALITY` / `WEB_COMPANION_ONLY` / `DEFAULT`，详见 [State.ts:56](Baileys-master_协议/src/Types/State.ts)）。

#### 3.7.2 `message-cap` 响应

```json
{
  "accountId": "acc_001",
  "totalQuota": 1000,
  "usedQuota": 856,
  "remaining": 144,
  "cycleStart": "2026-05-18T00:00:00Z",
  "cycleEnd": "2026-05-19T00:00:00Z",
  "cappingStatus": "SECOND_WARNING",  // NONE / FIRST_WARNING / SECOND_WARNING / CAPPED
  "fetchedAt": "2026-05-18T10:23:47Z"
}
```

#### 3.7.3 `usability` 综合响应（业务侧调一个就够）

```json
{
  "accountId": "acc_001",
  "state": "ONLINE",
  "canSendText": true,
  "canSendNewChat": false,
  "canCreateGroup": false,
  "canAddToGroup": false,
  "canSendMedia": true,
  "canFollowChannel": true,
  "blockedReason": "REACHOUT_TIMELOCK",   // null / REACHOUT_TIMELOCK / NEW_CHAT_CAPPED / RATE_LIMITED / OFFLINE
  "blockedUntil": "2026-05-18T18:00:00Z",
  "restriction": { ... },                  // 同 3.7.1
  "messageCap": { ... },                   // 同 3.7.2
  "evidence": { ... }                      // 同 § 4.7
}
```

**业务下发任务前必读 `usability`**，并按 `canCreateGroup` / `canAddToGroup` 决定是否派任务。

### 3.8 流量计费与代理监控（IP 流量计费场景）

IP 是按流量计费，所以**流量本身是头号成本**，必须有专门接口让业务侧能查、能限。

| 接口 | 用途 | 优先级 |
|---|---|---|
| `GET /v1/accounts/{id}/traffic` | 单账号近 24h / 7d / 30d 流量统计 | P0 |
| `GET /v1/proxy/sessions/{sessionId}/traffic` | 单 session（含跨账号共享）流量 | P0 |
| `GET /v1/proxy/billing/summary` | 全局流量计费总览（按 region / tier / 时间窗） | P0 |
| `GET /v1/proxy/billing/by-account` | 账号维度排行（找流量大户） | P1 |
| `POST /v1/accounts/{id}/traffic/limit` | 设置账号流量上限（超限自动 OFFLINE） | P1 |
| `GET /v1/proxy/sessions/list` | 当前活跃 session 列表（含 IP、地理、活动账号数） | P1 |
| `POST /v1/proxy/sessions/{sessionId}/disable` | 紧急下线某 session（出问题时止血） | P1 |

字段建议：

```json
{
  "accountId": "acc_001",
  "windowSec": 86400,
  "bytesIn": 12345678,
  "bytesOut": 9876543,
  "totalBytes": 22222221,
  "reconnectCount": 142,
  "mediaDownloadBytes": 0,
  "estimatedCostUSD": 0.11,            // 按当前单价估算
  "asOf": "..."
}
```

### 3.9 事件订阅协议（统一对外推送）

协议层 → 业务层 / Java 的所有异步事件统一通过 Kafka topic 推送。**事件 schema 必须稳定，且 payload 必带 evidence/occurredAt**。

| 事件 | 频率 | 关键字段 | 触发场景 |
|---|---|---|---|
| `account.state_changed` | 每次状态变迁 | from, to, evidence, errorCode, semantic | § 4.4 状态变化 |
| `account.heartbeat` | 稳态每 30s | state, evidence | 心跳上报 |
| `account.online_changed` | ONLINE ↔ 非 ONLINE | online, transitionedAt, reason | 在线变化 |
| `account.stale_detected` | STALE 触发时 | lastDateRecv, ageMs | § 4.7 STALE |
| `account.need_reauth` | 必触发 | reason, lastSeenAt | § 4.4 NEED_REAUTH |
| `account.type_detected` | 首次 pairing 或类型变更 | accountType, platform, verifiedName | § 4.7.6 |
| `account.proxy_failed` | 代理失败 | proxySessionId, failureCount, reason | § 4.6 |
| `account.proxy_rotated` | IP 实际变化 | newIp, country, asn | § 4.6 |
| `account.rate_limited` | 限流 | retryAfterMs, raw | § 4.4 RATE_LIMITED |
| `account.restricted` | 风控变化 | isActive, restrictedUntil, enforcementType | § 3.7.1 |
| `account.new_chat_capping` | 配额变化 | cappingStatus, remaining, cycleEnd | § 3.7.2 |
| `pairing.code_generated` | pairing code 生成 | code, qrId, expiresAt | § 3.1 |
| `qr.code_generated` | 二维码生成 | qrBase64, qrId, expiresAt | § 3.1 |
| `pairing.completed` | pairing 成功 | accountId, accountType, platform | § 3.1 |
| `pairing.failed` | pairing 失败 | reason | § 3.1 |
| `message.received` | 收消息 | jid, messageId, type, content | 业务侧入消息 |
| `message.ack` | 消息 ack | messageId, status (sent/delivered/read), at | 业务侧追踪 |
| `group.participant_changed` | 群成员变更 | groupJid, action, participants | 群被动事件 |
| `group.metadata_updated` | 群信息变更 | groupJid, changes | 群被动事件 |

**每条事件的 payload 通用包装**：

```json
{
  "event": "account.state_changed",
  "version": "v1",
  "accountId": "acc_001",
  "occurredAt": "2026-05-18T10:23:47.046Z",
  "workerId": "node-3.worker-2",
  "evidence": { ... },
  "data": { ... }                  // 事件特定字段
}
```

Kafka topic 命名建议：`protocol.{domain}.events.v1`，message key 固定使用 `accountId`，保证同账号事件落到同一 partition。

## 4. 4C8G 单机 2000 账号怎么做

既然已有测试证明 4C8G 可以挂 2000 个号，建议按“可生产化”的方式固化这个能力，而不是单进程硬塞 2000。

### 4.1 单机进程模型

推荐两套方案，**4C8G 默认走方案 A**，4C16G 才考虑方案 B：

方案 A（4C8G，稳健，推荐）：

```text
4C8G 单机，5-6 个 worker
  protocol-worker-1: 300-400 个账号
  protocol-worker-2: 300-400 个账号
  protocol-worker-3: 300-400 个账号
  protocol-worker-4: 300-400 个账号
  protocol-worker-5: 300-400 个账号
  （可选 6）
```

方案 B（4C16G，激进，需压测验证）：

```text
4C16G 单机，4 个 worker
  protocol-worker-1: 500 个账号
  protocol-worker-2: 500 个账号
  protocol-worker-3: 500 个账号
  protocol-worker-4: 500 个账号
```

不推荐 4C8G + 4 worker × 500 这个原计划——单进程 RSS 接近 1.5G 时，4 个 worker + Rust bridge 原生堆 + ws 缓冲 + 系统占用，8G 机器冗余只剩 1-1.5G，遇到 GC 抖动或瞬时拉群高峰就会 OOM。

不要一个 Node 进程挂满 2000。原因：

- 单进程 GC 抖动会影响全部账号
- 单进程崩溃会掉全部账号
- 单进程重连风暴难控
- 单进程 libsignal 操作串行化，2000 账号同时 ratchet 会卡事件循环
- 多进程更容易按 CPU 核心隔离

进程间不要共享 socket。Java 或本机 Router 维护：

```text
accountId -> nodeId -> workerId
```

### 4.2 Baileys 必须关闭的高成本行为

Baileys 默认配置偏向完整 Web 客户端，不适合 2000 账号保活。协议节点应使用轻量配置：

```ts
const sock = makeWASocket({
  auth,
  logger,
  agent: proxyAgent,          // WebSocket 走代理
  fetchAgent: proxyAgent,     // 媒体上传/下载走同一个出口
  markOnlineOnConnect: false,
  syncFullHistory: false,
  fireInitQueries: false,     // 见下方注意事项
  shouldSyncHistoryMessage: () => false,
  emitOwnEvents: false,
  connectTimeoutMs: 30_000,
  defaultQueryTimeoutMs: 60_000,
  keepAliveIntervalMs: 30_000,
  browser: Browsers.macOS('Chrome')
})
```

注意：

- 不要写 `printQRInTerminal`：该字段在 7.x 已被废弃（源码标注 `@deprecated This feature has been removed`），写了不报错但完全无效。需要 QR 走 `connection.update.qr` 事件订阅。
- `syncFullHistory: false`：不要同步全量历史。
- `shouldSyncHistoryMessage: () => false`：不要处理历史同步消息。
- `markOnlineOnConnect: false`：不要每次连接都主动标记在线。
- `fireInitQueries: false`：关掉后 **app-state 同步不会跑**，业务上层拿不到 chats/contacts/隐私设置/push name 的初始快照。如果业务依赖这些，要么打开，要么显式按需调用相关接口补齐。强烈建议先开着压测，确认瓶颈再考虑关。
- `emitOwnEvents: false`：减少自己发消息带来的事件回流。
- `agent` 和 `fetchAgent` 都要传：前者是 ws 通道（`SocketConfig.agent`），后者是媒体 fetch 通道。只传一个会导致媒体出口和 ws 出口不一致，触发风控。

### 4.3 授权 vs 重连：两个根本不同的流程

这是一切动态 IP / 集群漂移 / 进程重启设计的前提。**必须搞清楚两者区别**，否则架构会做错。

| 维度 | 授权（pairing/login） | 重连（reconnect） |
|---|---|---|
| 中文叫法 | 登录、配对、绑定 | 上线、断线重连 |
| 触发场景 | 第一次绑定设备 / 被服务端踢后重新绑定 | ws 断开、IP 切换、节点漂移、进程重启 |
| 是否需要手机端配合 | 是（输 pairing code 或扫码） | 否，全自动 |
| 耗时 | 30-60s 起，依赖用户操作 | 200ms-2s |
| 协议层接口 | `requestPairingCode` / QR | 用本地 creds 直接 `makeWASocket` |
| 是否消耗 IP 池"pairing 池" | 是 | 否 |
| 失败后果 | 账号无法上线 | 自动退避重试 |

**关键事实：换 IP 不需要重新授权。**

WA 的认证模型是**设备身份**，不是 IP 身份。pairing 一次性给设备发放 noiseKey / signedIdentityKey / registrationId / advSecretKey 等 creds，之后所有连接靠 Noise handshake 用 noiseKey 私钥签名向服务端证明"还是同一台设备"。服务端**不检查源 IP**。

```text
任何一次重连的流程：
  1. TCP 接通（IP 可以是任意一个动态住宅 IP）
  2. Noise handshake：本地 noiseKey 签 challenge → 发给服务端
  3. 服务端凭 noiseKey 公钥识别"已登记设备"
  4. 接受连接、恢复 session
  全程不需要 pairing code、不需要手机端确认、不需要 QR
```

工程含义：

- **creds 在 = 号在，creds 丢 = 号死**。session 存储是命门，必须做版本号 + 校验和 + 多副本。
- **业务侧只关心两个事件**：`connection.update: open` → 可用；`connection.update: close, statusCode=401` → 触发 `NEED_REAUTH`。
- **IP 切换、节点漂移、进程重启、worker crash，全部走重连，不走授权**。这也是为什么动态住宅 IP 可以撑 2000 账号的根本前提。
- **集群部署 = creds 必须跨节点可访问**。账号从 node A 漂到 node B 时，node B 用同一份 creds 重连即可，不需要任何用户操作。

什么情况才真正会被踢回授权流程，见 4.4 状态机里 `NEED_REAUTH` 的触发条件。

### 4.4 账号状态机

每个账号必须有明确状态。不要只用 `online/offline`：

```text
IMPORTED          已导入 creds，尚未发起上线
PAIRING           正在等待 pairing code / QR 扫码完成
ONLINE            ws 在线，可接收业务调用
OFFLINE           主动下线，creds 完好，可重新上线
RECONNECTING      ws 断开，自动重连中（计划性 IP 轮换 / 瞬时抖动）
PROXY_FAILED      代理连续失败，等待 Java 重新分配
LOGIN_FAILED      pairing 流程失败（pairing code 过期、用户未确认）
RATE_LIMITED      被 WA 服务端限流，冷却中
NEED_REAUTH       creds 已失效，必须重新走 pairing/QR 才能上线
LOGGED_OUT        用户主动 logout 或服务端踢下线
DEVICE_REMOVED    设备已被移除（手机端"已登录设备"里删除）
```

`NEED_REAUTH` 是新增的关键状态，必须独立出来，**不要和 OFFLINE 混用**。两者业务处理完全不同：

```text
OFFLINE         → 协议层自动可重连，无需用户介入
NEED_REAUTH     → 必须 Java 通知前端，前端引导用户重新做 pairing
```

#### `NEED_REAUTH` 的触发条件（必须落库 + 推事件给 Java）

| 触发信号 | Baileys 表现 | 是否必然 NEED_REAUTH |
|---|---|---|
| `connection.update: close, statusCode=401, reason=loggedOut` | DisconnectReason.loggedOut | 是 |
| `connection.update: close, statusCode=401, reason=device_removed` | 同上 | 是 |
| `connection.update: close, statusCode=401, reason=multideviceMismatch` | DisconnectReason.multideviceMismatch | 是 |
| Noise handshake 失败 / creds 解析失败 / advSecretKey 校验失败 | 启动即报错，无法建立 ws | 是 |
| `connection.update: close, statusCode=403, reason=forbidden` | DisconnectReason.forbidden | 是（多数情况账号已废） |
| `connection.update: close, statusCode=500, reason=badSession` | DisconnectReason.badSession | 是 |
| pairing code 过期 / 用户超时未确认 | pairing 流程超时 | 否（这是 LOGIN_FAILED，可重试 pairing） |

#### 不能进 `NEED_REAUTH` 的常见误判

下面这些场景容易被新手代码误判为"需要重新授权"，**实际上只是普通重连**：

| 信号 | 实际含义 | 正确处理 |
|---|---|---|
| `515 restart required` | 授权后服务端要求重启 socket 一次 | 立即重连 |
| `428 connection closed` | 服务端主动关连接 | 退避后重连 |
| `408 timeout` | keepalive 超时 | 退避后重连 |
| proxy auth failed / proxy timeout | 代理问题，与 WA 无关 | 上报 Java，等代理恢复或换 IP，**creds 不动** |
| TCP RST / ECONNRESET | 网络抖动 | 立即重连 |
| 动态 IP 到期 ws 被代理 kill | 10-15 分钟周期事件 | 立即重连（详见 § 10） |

判断口诀：

```text
ws 断了 + creds 还在 + 错误码不是 401/403/badSession → 重连
ws 断了 + 401 / 403 / badSession                       → NEED_REAUTH
启动时 creds 校验失败                                   → NEED_REAUTH
其他一切                                                → 重连或代理问题，不要碰 creds
```

#### 状态转换图

```text
              import creds
                   |
                   v
              [IMPORTED]
                   |
        online() 调用
                   |
                   v
            [PAIRING] ----login_failed----> [LOGIN_FAILED]
                   |                            |
        ws connected                         retry pairing
                   |
                   v
              [ONLINE] <----ws ok------- [RECONNECTING]
              |  |  |  ^                       ^
              |  |  |  | ws drop               |
              |  |  |  | (普通错误)             |
              |  |  |  +-----------------------+
              |  |  |
              |  |  +-- proxy timeout x3 --> [PROXY_FAILED] --java rebind--> [RECONNECTING]
              |  |
              |  +----- 429/限流 ----------> [RATE_LIMITED] --cooldown----> [RECONNECTING]
              |
              +-------- 401/403/badSession --> [NEED_REAUTH]
                        logout()  ----------> [LOGGED_OUT]
                        device removed -----> [DEVICE_REMOVED]

[NEED_REAUTH] --user 重新 pairing--> [PAIRING]
[LOGGED_OUT]  --user 重新 pairing--> [PAIRING]
[DEVICE_REMOVED] --账号基本作废，人工 review--
```

#### 协议层必须上报的事件（给 Java）

```text
account.state_changed     { accountId, from, to, reason, errorCode, occurredAt }
account.need_reauth       { accountId, reason, lastSeenAt }   // NEED_REAUTH 触发时单独再推一次，优先级最高
account.proxy_failed      { accountId, proxyId, failureCount }
account.rate_limited      { accountId, retryAfterMs }
```

Java 收到 `account.need_reauth` 后：

1. 立即标记账号状态，停止派发任何任务给该账号
2. 把 creds 移到归档表（不要直接删，方便排查）
3. 通知运营/前端，引导用户重新做 pairing
4. **绝不在协议层自动尝试重新授权**——pairing 需要手机端配合，自动重试只会浪费 pairing 池 IP 和触发风控

### 4.5 重连策略

重连必须先**分类**再退避，不能所有断开都套同一个退避表。结合 4.3、4.4 和动态住宅 IP（10-15 分钟时效）的现实，重连分三类：

#### 类型 A：计划性 IP 轮换（最常见，每账号每 10-15 分钟一次）

特征：
- 距离上次"IP 实际切换时间"接近一个轮换周期（10-15 分钟）
- 错误通常是 ws 被代理 kill / ECONNRESET / 408 keepalive timeout
- creds 完好，proxy session 完好

处理：
```text
立即重连，无退避
不计入"重连失败"指标
不进入退避表
状态：ONLINE → RECONNECTING → ONLINE（瞬时）
```

#### 类型 B：意外断开

特征：515 restart / 428 / 网络抖动 / 非周期性 TCP RST。

退避：

```text
第一次：5s
第二次：30s
第三次：2min
第四次：10min
之后：进入冷却（PROXY_FAILED 或 RATE_LIMITED），等待 Java 调度
```

注意：`515 restart required` 是授权握手后的正常流程，**立即重连，不计入退避计数**。

#### 类型 C：终态错误，不重连

直接进 NEED_REAUTH / LOGGED_OUT / DEVICE_REMOVED：

```text
401 loggedOut
401 device_removed
401 multideviceMismatch
403 forbidden
500 badSession
creds 校验失败
```

`proxy auth failed` 不属于这类，归到 PROXY_FAILED 等 Java 重新分配代理，不动 creds。

#### 重连风暴限流

2000 账号 × 每 10-15 分钟一次轮换 ≈ **2.2-3.3 次/秒平均**，瞬时峰值可能 50-200 次/秒。必须做：

```text
节点级令牌桶：每秒最多放 10 个账号上线
全局令牌桶：每秒最多放 50 个账号上线
sessionId 创建时人为加 0-900s 偏移，让 2000 个账号的"10-15 分钟周期"错峰
冷启动 / 节点扩容：分批 50 个 + 30s 健康检查间隔
```

### 4.6 代理策略

实际环境是**动态住宅 IP，时效 10-15 分钟**。这与"长期 IP 绑定"完全不同，必须按动态池设计。

正式环境不能依赖整机 VPN，必须账号级代理：

```text
account A -> session A（10-15 分钟轮换 IP，country/ASN 钉死）
account B -> session B
```

核心原则（动态住宅场景）：

- **绑定的不是 IP，是 proxy session ID**。session ID 持久绑定账号一辈子；IP 由代理商每 10-15 分钟轮换一次，协议层不关心。
- **换 IP 不需要重新授权**（见 4.3）。creds 在，noiseKey 在，任何 IP 都能 Noise handshake 上线。
- **country / ASN / 城市必须钉死**。换 IP 没事，跨国家、跨 ASN 会被风控盯上。代理 URL 的 country/region/asn 参数必须固定。
- **pairing 阶段必须用长 sticky IP**（30 分钟以上，最好 1-6h）。pairing 流程经常 > 10 分钟，10-15 分钟时效的 IP 会在 pairing 中途切换，直接打废新号。建议新号头 72 小时全程走"长 sticky pairing 池"，养号期再转入 10-15 分钟动态池。
- 代理失败时协议层只上报，不要自己乱切。Java 负责 session 分配、冷却、绑定、替换。

代理配置需要进入账号上线请求。协议层接收的是**完整代理 URL**，session ID 由 Java 拼好：

```json
{
  "accountId": "acc_001",
  "phone": "8617600627277",
  "proxy": {
    "type": "socks5",
    "url": "socks5://brd-customer-XXX-zone-residential-session-acc_001-country-us:PASS@proxy.example.com:22225",
    "sessionId": "acc_001",
    "country": "US",
    "asn": "AS7922",
    "stickyDurationSec": 600
  }
}
```

协议层职责：

- 根据 `proxy.url` 构造 `agent` 和 `fetchAgent`，传入 `makeWASocket`
- 每次 ws 重连重新构造 agent（不要复用旧 agent 实例，避免连接复用导致 IP 没切到）
- 探测出口 IP 变化时打点上报 `proxyRotated` 事件，写入 `lastRotatedAt`
- 不自己决定何时换 session，全由 Java 调度

#### 账号 ↔ 代理 session 数据模型

```text
account_proxy_binding
  account_id (PK)
  proxy_session_id         // 持久绑定，例如 "acc_001"
  proxy_provider           // bright_data / smartproxy / iproyal / ...
  proxy_url_template       // 含 {sessionId} 占位
  country / region / asn   // 长期不变
  tier                     // pairing(长 sticky) / standard(10-15 分钟)
  bound_at, last_rotated_at, status
```

#### 与 4.5 重连策略的衔接

10-15 分钟 IP 轮换 = ws 大概率每 10-15 分钟被代理 kill 一次。这是**计划性事件**，按 4.5 类型 A 处理：

- 立即重连，无退避
- creds 不动
- session ID 不变
- 不触发 NEED_REAUTH（除非 WA 那边因为风控发了 401，那种是终态错误，走 4.5 类型 C）

### 4.7 账号状态检测与账号类型识别

**核心要求：状态必须确定。不允许"假在线"。** 业务层任何时刻都要能从协议层拿到**带证据时间戳**的状态，按 freshness 自己判断是否信任。

#### 4.7.1 "假在线"问题与三层证据模型

"假在线"具体指四种情况，**单独看 `ws.readyState === OPEN` 全都骗得过**：

1. ws 还 OPEN，但物理 TCP 已死（半开连接，Linux 上可以挂几十秒到几分钟才超时）
2. ws 还 OPEN，代理端已断（IP 轮换发生在协议层观察不到的位置）
3. ws OPEN 且收发还能跑，但 WA 服务端已经标记账号离线（多设备同步出问题、限流静默）
4. worker 进程刚恢复，本地状态显示 ONLINE，但底层 ws 实际还在重建

要消除假在线，必须采用**三层证据**叠加判定：

| 证据层 | 含义 | 取证方式 | 时效要求 |
|---|---|---|---|
| L1 SOCKET_OPEN | ws 句柄打开 | `ws.readyState === OPEN` | 即时 |
| L2 PROTOCOL_ALIVE | 最近从服务端收到任意帧（消息、ack、ping ack） | Baileys 内部 `lastDateRecv` | ≤ keepAliveIntervalMs + 5s |
| L3 SERVER_CONFIRMED | 服务端在最近一次 ping 中明确回复了 ack | 主动 ping 计数器 | ≤ 2 × keepAliveIntervalMs |

**真在线 ONLINE 必须同时满足 L1+L2+L3**。任意一层证据过期或不存在，状态都不是 ONLINE。

Baileys 已经内置了 L2/L3 机制（[`src/Socket/socket.ts:688-718`](Baileys-master_协议/src/Socket/socket.ts) `startKeepAliveRequest`）：

```text
每 keepAliveIntervalMs 触发一次：
  if (now - lastDateRecv > keepAliveIntervalMs + 5000) {
    主动 end()，发出 DisconnectReason.connectionLost
  } else {
    发 <iq type=get xmlns=w:p><ping/></iq>，等服务端 ack（ack 到了会更新 lastDateRecv）
  }
```

也就是说：**只要把 `keepAliveIntervalMs` 设短（推荐 30s），Baileys 自己就会在 35s 内识别物理死连接并主动关闭**。我们要做的不是再造一个心跳，而是把 `lastDateRecv` 这个时间戳暴露给 worker 层，作为 L2/L3 的证据时间戳。

#### 4.7.2 状态定义（互斥、穷举、可证明）

每个账号在任意时刻**必须**处于以下一个状态。每个状态有：进入条件、证据、退出条件、对业务可见性。

| 状态 | 进入条件（必要 + 充分） | 证据时戳 | 业务可下发任务 |
|---|---|---|---|
| `NEW` | 账号刚创建，未导入 creds | — | 否 |
| `IMPORTED` | creds 已写入，从未 online 过 | `credsImportedAt` | 否 |
| `PAIRING` | `requestPairingCode` 已发出，未收到 `pair-success` | `pairingStartedAt` | 否 |
| `VERIFYING` | ws 建立完成，但**还未收到第一次服务端 ack**（pair-success 后或重连后的临界期） | `wsOpenedAt` | 否 |
| `ONLINE` | L1+L2+L3 全部成立：ws.OPEN && `connection==='open'` && `now - lastDateRecv ≤ 35s` && 最近 ping 已被 ack | `lastDateRecv` + `lastPingAckAt` | **是** |
| `STALE` | ws.OPEN 但 `now - lastDateRecv > 35s`（半开嫌疑，正在强制重连） | `staleDetectedAt` | 否 |
| `OFFLINE` | 收到 `connection.update: close` 且 statusCode 不在终态码（非 401/403/badSession），creds 完好 | `lastDisconnectAt` + `lastDisconnectCode` | 否 |
| `RECONNECTING` | 在退避/重连队列中，未触发终态错误 | `nextReconnectAt` | 否 |
| `PROXY_FAILED` | 连续 3 次代理失败 | `proxyFailedAt` | 否 |
| `RATE_LIMITED` | 收到 429 / 服务端限流信号 | `rateLimitedUntil` | 否 |
| `NEED_REAUTH` | 收到 4.4 终态错误信号之一，creds 已失效 | `reauthRequiredAt` + `reauthReason` | 否 |
| `LOGGED_OUT` | 主动 `sock.logout()` 成功 | `loggedOutAt` | 否 |
| `DEVICE_REMOVED` | 收到 `device_removed`（手机端被踢） | `deviceRemovedAt` | 否 |

关键设计：

- **`VERIFYING` 是必须的过渡状态**。ws 建立完成不等于真在线——必须等到第一个服务端 ack 到达（lastDateRecv 被更新）才能进 ONLINE。在 VERIFYING 期，对 Java 报的是"未确定"，业务层不应下发任务。
- **`STALE` 是必须的兜底状态**。当 L2 证据过期但 ws 还没关闭时，account 进入 STALE 并立即触发关闭重连，不要让 ONLINE 继续假阳性。
- **`OFFLINE` 和 `NEED_REAUTH` 必须分开**。前者可重连，后者必须人工/前端重新 pairing。这是业务侧最容易出错的地方（详见 4.4）。

#### 4.7.3 状态转换与判定算法

worker 内每账号维护一个状态机，**每个状态变迁必须有触发事件，禁止靠定时轮询"猜状态"**：

```text
事件源：
  - Baileys 事件：connection.update / creds.update / messages.upsert / ...
  - worker 自己：keepAliveTick（每 5s 跑一次健康检查）
  - 外部：online / offline / logout / proxy-rebind 命令

伪代码：
on connection.update({ connection, lastDisconnect, qr }):
  if (connection === 'open')          → 进 VERIFYING（等首个 lastDateRecv 更新）
  if (connection === 'close') {
    code = lastDisconnect.error.output.statusCode
    if (code in [401-loggedOut, 401-deviceRemoved, 401-multideviceMismatch,
                 403-forbidden, 500-badSession])              → NEED_REAUTH / LOGGED_OUT / DEVICE_REMOVED
    else if (code === 515)                                     → 立即重连（不退避）
    else if (code === DisconnectReason.connectionLost)         → 走重连
    else                                                       → OFFLINE，触发退避
  }

on keepAliveTick（每 5s）:
  // 进 ONLINE 的临门一脚
  if (state === VERIFYING && lastDateRecv > wsOpenedAt && lastPingAckAt fresh)
                                                              → ONLINE
  // STALE 兜底
  if (state === ONLINE && now - lastDateRecv > 35s)            → STALE → force end() → RECONNECTING
  // 心跳上报
  pushHeartbeat({ accountId, state, lastDateRecv, ... })
```

**注意**：
- 进 ONLINE 的判定**必须**包含"lastDateRecv 更新过"这个证据，单纯收到 `connection: 'open'` 不够（Noise 握手刚完成时还没有任何业务帧）。
- STALE 触发时**立即 force end，不要等下一个 keepAlive tick**，避免业务层在那 5s 内派任务。

#### 4.7.4 状态上报：每条状态必须带证据时戳

协议层向 Registry / Java 推送的所有状态消息**必须包含证据**：

```json
{
  "accountId": "acc_001",
  "state": "ONLINE",
  "evidence": {
    "wsOpen": true,
    "lastDateRecv": "2026-05-18T10:23:45.812Z",
    "lastPingAckAt": "2026-05-18T10:23:30.104Z",
    "ageMs": 1234,
    "keepAliveIntervalMs": 30000
  },
  "reportedAt": "2026-05-18T10:23:47.046Z",
  "workerId": "node-3.worker-2"
}
```

Java 收到后**必须**：

1. 比较 `reportedAt - evidence.lastDateRecv`，超过 `2 × keepAliveIntervalMs` 视为不可信，按 OFFLINE 处理
2. 如果 `evidence.lastDateRecv` 比库里旧记录还旧，丢弃（防止乱序）
3. 永远不能用"上次 ONLINE 上报 10 分钟前"当成"现在 ONLINE"，状态有时效

心跳频率：

```text
状态稳定时（ONLINE/OFFLINE/NEED_REAUTH）：每 30s 推一次
状态变迁时：立即推
worker 进程退出前：批量推一次 OFFLINE（带 graceful 标志）
worker crash 兜底：Registry 检测心跳超时 60s 直接标记 UNKNOWN，由调度服务接管
```

`UNKNOWN` 不是账号自身的状态，而是**业务侧的视图**——表示协议层失联，业务层不应信任最近一次状态。

#### 4.7.5 keepAlive 参数推荐

```ts
makeWASocket({
  ...
  keepAliveIntervalMs: 30_000,  // 30s ping 一次；Baileys 在 35s 内识别物理死连
  connectTimeoutMs: 30_000,
  defaultQueryTimeoutMs: 60_000,
})
```

```text
2000 账号 × keepAlive 30s = 67 pings/s 总量（across cluster）
2000 账号 × keepAlive 15s = 133 pings/s
2000 账号 × keepAlive 60s = 33 pings/s，但检测延迟最长 65s
推荐 30s：稳态流量适中，假在线检测窗口 ≤ 35s
```

如果业务侧确实需要"5s 内确定在线"这种 SLA，可以**仅对关键操作前**做主动探测：

```text
在业务层下发"拉群/加人"等高价值任务前：
  调用 GET /v1/accounts/{id}/probe
  协议层主动发一个 <iq><ping/></iq>，等服务端 ack
  ack 在 3s 内到达 → 确认 ONLINE，下发任务
  3s 未到 → 标 STALE，重连后再说

不要默认对所有账号做高频主动探测，2000 账号撑不住。
```

#### 4.7.6 账号类型识别（personal / business）

WA Business 用户用的是不同的手机端 App。Baileys 在 **pairing 成功**那一刻就能确定账号类型，**不需要每次重连都查**。

识别信号（按可靠度从高到低）：

| 信号 | 来源 | 含义 | 可靠度 |
|---|---|---|---|
| `creds.platform` | pair-success 的 `<platform name="...">` 节点（[validate-connection.ts:239](Baileys-master_协议/src/Utils/validate-connection.ts)） | `android`/`iphone`/`web` = 个人；`smba` = Business Android；`smbi` = Business iPhone | 高 |
| `creds.me.name`（== bizName） | pair-success 的 `<biz name="...">` 节点（[validate-connection.ts:172](Baileys-master_协议/src/Utils/validate-connection.ts)） | 存在即是 Business | 高 |
| `getBusinessProfile(selfJid)` 非空 | `sock.getBusinessProfile()` 主动查询 | Business 才有 profile | 中（一次性兜底） |
| `verifiedName` | `creds.me.verifiedName` | 仅 Business 且 WA 官方认证过 | 高（用于判 verified 子档） |

判定算法：

```text
首次 pairing 成功的 pair-success 处理完之后：
  if (creds.me.name 非空 || creds.platform 以 smb 开头)
    if (creds.me.verifiedName 非空) → BUSINESS_VERIFIED
    else                              → BUSINESS_STANDARD
  else
    → PERSONAL

  写入 account_type 字段（带 detectedAt 时戳和 detectedBy 来源）
  推送 account.type_detected 事件
  以后所有重连不再重新识别

仅在以下情况重新识别：
  - 收到 NEED_REAUTH 之后重新 pairing
  - 显式调用 POST /v1/accounts/{id}/type/refresh（运维兜底）
```

账号类型枚举：

```text
PERSONAL              个人 WA
BUSINESS_STANDARD     WA Business（未官方认证）
BUSINESS_VERIFIED     WA Business 且 verifiedName 存在（绿色认证勾）
```

**为什么不需要每次都查**：WA 不允许账号在 personal/business 间无感切换。用户必须卸载 WA 装 WA Business（或反向），重新登录会触发新的 pair-success，那时我们重新探测就够了。如果一个 ONLINE 账号"突然变 Business"是不可能的，除非 creds 已失效——那时已经走 NEED_REAUTH 流程，下一轮 pairing 会重新识别。

#### 4.7.7 状态查询 API

`GET /v1/accounts/{accountId}/status` 返回完整状态 + 证据：

```json
{
  "accountId": "acc_001",
  "phone": "8617600627277",
  "jid": "8617600627277@s.whatsapp.net",
  "lid": "1234567890@lid",

  "state": "ONLINE",
  "evidence": {
    "wsOpen": true,
    "connectionField": "open",
    "lastDateRecv": "2026-05-18T10:23:45.812Z",
    "lastPingAckAt": "2026-05-18T10:23:30.104Z",
    "ageMs": 1234,
    "keepAliveIntervalMs": 30000
  },
  "needReauth": false,
  "reauthReason": null,

  "accountType": "BUSINESS_STANDARD",
  "accountTypeDetectedAt": "2026-05-12T08:11:02Z",
  "platform": "smba",
  "verifiedName": null,
  "pushName": "Acme Co",

  "currentProxy": {
    "sessionId": "acc_001",
    "country": "US",
    "asn": "AS7922",
    "lastRotatedAt": "2026-05-18T10:18:00Z"
  },

  "metrics": {
    "reconnectCount24h": 142,
    "staleEvents24h": 3,
    "lastDisconnectCode": null,
    "lastDisconnectReason": null
  },

  "workerId": "node-3.worker-2",
  "reportedAt": "2026-05-18T10:23:47.046Z"
}
```

精简接口（高频调用用）：

```text
GET /v1/accounts/{id}/online
  → { "online": true, "ageMs": 1234, "reportedAt": "..." }

GET /v1/accounts/{id}/type
  → { "accountType": "BUSINESS_STANDARD", "detectedAt": "..." }

POST /v1/accounts/{id}/probe
  → 主动 ping 一次，3s 内拿到 ack 返回 200，否则返回 503
  仅业务侧关键操作前调用
```

#### 4.7.8 推送事件

```text
account.state_changed     必推。每次状态变迁，带 evidence
                          { accountId, from, to, evidence, occurredAt }

account.heartbeat         稳态每 30s 推一次，带 evidence 时戳
                          { accountId, state, evidence, reportedAt }

account.need_reauth       必推。NEED_REAUTH 触发时高优先级
                          { accountId, reason, lastSeenAt }

account.type_detected     首次 pairing 或类型变更时推
                          { accountId, accountType, platform, verifiedName, detectedAt }

account.online_changed    ONLINE ↔ 非 ONLINE 翻转时推（业务订阅在线变化用）
                          { accountId, online, transitionedAt, reason }

account.stale_detected    STALE 触发时推（用于监控/告警，业务可忽略）
                          { accountId, lastDateRecv, ageMs, detectedAt }
```

#### 4.7.9 反模式（禁止）

以下做法在本项目里**明确禁止**：

1. ❌ 仅靠 `ws.readyState === OPEN` 判定 ONLINE
2. ❌ 业务层自己维护"在线缓存"超过 60s 不刷新
3. ❌ 状态上报不带证据时戳
4. ❌ 把 OFFLINE 和 NEED_REAUTH 合并成 "不在线" 一个状态
5. ❌ 在 VERIFYING 期间允许业务层下发任务
6. ❌ STALE 不触发立即重连，等下一个 tick
7. ❌ 每次上线都重新调用 `getBusinessProfile` 判账号类型
8. ❌ 对所有账号开启 5s 高频主动探测

### 4.8 重连调优与协议层 / 业务层职责划分

> 本节是 §4.3-§4.5 的实施补充。**核心目标：协议层瘦，业务层胖**——所有与"决策、调度、限流、聚合"相关的逻辑放到 Java 业务层，协议层只做 socket 生命周期 + 错误码翻译 + evidence 上报。

#### 4.8.1 职责划分总表

下面这张表是新方案落地时**最容易扯皮的边界**，提前定死。

| 能力 | 协议层（Node Baileys worker） | 业务层（Java + Registry） |
|---|---|---|
| **ws 建立 / Noise handshake** | ✓ | ✗ |
| **socket-level keepalive（ping/pong）** | ✓（Baileys 内置） | ✗ |
| **lastDateRecv 跟踪** | ✓ | ✗ |
| **STALE 判定（半开 ws）** | ✓ 在 worker 内立即触发重连 | ✗ |
| **同 worker、瞬时断开的立即重连** | ✓（类型 A 计划性轮换） | ✗ |
| **退避重连（5s→30s→2m→10m）** | ✓ 在 worker 内执行 | ✗ |
| **错误码翻译（DisconnectReason → semantic）** | ✓ 必做，产出 `PROXY_FAILED / RATE_LIMITED / NEED_REAUTH / RECONNECTING` | ✗ |
| **代理 agent 构造（socks-proxy-agent）** | ✓ 用业务侧给的 sessionId 拼 URL | ✗ |
| **NEED_REAUTH 判定 + 上报** | ✓ 仅判定与上报 | 接收事件，**业务层决定下一步**（通知用户、移到归档、重新 pairing） |
| **跨 worker 漂移决策** | ✗ 协议层只能在自己 worker 内重连 | ✓ Registry 仲裁 accountId → workerId |
| **跨节点 / 跨 region 漂移决策** | ✗ | ✓ 全局调度服务 |
| **代理 session 分配 / 冷却 / 替换** | ✗ 只接收已分配的 session | ✓ ProxyAllocator 服务 |
| **批量 reauth 队列管理** | ✗ | ✓ 风控波时由业务层批量调度 |
| **重连令牌桶（节点级 + 全局级）** | ✗ 协议层只查桶不维护 | ✓ Redis cluster 维护，业务层聚合 |
| **重连优先级（VIP 账号 / 付费账号优先）** | ✗ | ✓ Registry 优先级队列 |
| **冷启动 / 节点扩容时的分批上线节奏** | ✗ worker 只接命令 | ✓ 业务层按 50/批 + 30s 健康检查发起 online |
| **跨账号风控关联（同 IP 多账号同时 401）** | ✗ 单账号视角不感知 | ✓ 业务层聚合告警 |
| **指标上报（RSS、heap、event loop lag、reconnect/s）** | ✓ Prometheus `/metrics` | 业务层不用做，监控系统消费 |
| **审计日志（每次状态变迁、重连尝试）** | ✓ 写本地结构化日志 + push 到日志总线 | ✗ 业务层从总线消费 |
| **业务任务编排（拉群、加人节奏）** | ✗ | ✓ Java 业务层 |
| **`usability` 综合判定（state + restriction + cap）** | ✓ 协议层聚合三件套返回 | 调用方 |
| **NEED_REAUTH 后是否自动发起 pairing** | **✗ 协议层绝不主动发起** | ✓ 必须由业务层 / 用户触发 |

最后一条要再强调一次：**协议层永远不主动发起 pairing**。
- 自动 pairing 会消耗 pairing 池 IP
- 失败一次就给账号风控加一笔记录
- 用户在手机端没确认时 pairing 会等到超时
- 风控波时大量自动 pairing = 二次封号

#### 4.8.2 重连调优参数（按规模分档）

参数按 concurrent 在线数分档，避免一套参数从 1k 跑到 1M。

| 参数 | 1k-1万 | 1-10万 | 10-100万 |
|---|---|---|---|
| `keepAliveIntervalMs` | 30_000 | 30_000 | 30_000（不动） |
| 类型 A 立即重连前的延迟 jitter | 0-500ms | 0-2s | 0-5s |
| 类型 B 退避表 | 5s→30s→2m→10m | 同 | 同 |
| 同 worker 最大并发重连 | 20/s | 10/s | 5/s |
| 节点级令牌桶 | 50/s | 30/s | 10/s |
| 全局令牌桶 | 100/s | 200/s | 500/s |
| sessionId 创建偏移（错峰） | 0-300s | 0-600s | 0-900s |
| 冷启动每批账号数 | 100 | 50 | 30 |
| 冷启动批间隔 | 10s | 30s | 60s |
| STALE 判定窗口（now - lastDateRecv） | 35s | 35s | 35s（不动） |
| `connectTimeoutMs` | 30_000 | 30_000 | 30_000 |
| `defaultQueryTimeoutMs` | 60_000 | 60_000 | 60_000 |

调参原则：
- **keepAlive 不要动**。35s STALE 窗口是物理死连检测下限。
- **令牌桶按规模放大**，因为基数变大、绝对重连数也变大。
- **冷启动越慢越好**。Phase 4 时 100 账号/批 + 60s 间隔意味着 1k 账号要 10 分钟才能全部上线——这是必要的代价。

#### 4.8.3 协议层应该削减的负担

下面这些事看起来"协议层做更方便"，但**必须搬到业务层**，避免协议层过载。

| 现状 / 直觉 | 问题 | 应搬到 |
|---|---|---|
| 协议层维护"今日掉线次数" + 决定何时换代理 | 每个账号都要查 DB，状态散乱 | 业务层（Redis 全局视图） |
| 协议层周期性 fetchReachoutTimelock 自动刷新 | 2000+ 账号每分钟自动调一遍 = 浪费流量 + 暴露行为模式 | 业务侧任务前按需查（§3.7） |
| 协议层维护"账号优先级" | 跨 worker 视图缺失，无法做全局优先 | Registry |
| 协议层做"批量上线"调度 | worker 自己不知道整体节奏 | 业务层节流后逐个调 `/online` |
| 协议层缓存所有联系人/会话 | 内存暴涨，跨节点不一致 | 不缓存或最小缓存，按需查 |
| 协议层做"消息持久化" | 不是协议层的事 | 业务层消费 `message.received` 后自己存 |
| 协议层做"重发失败消息" | 协议层无法判定业务侧重发策略 | 业务层重试 |
| 协议层维护"用户在线时长" | 业务统计指标 | 业务层从心跳事件聚合 |

#### 4.8.4 业务层应该补强的能力

下面是业务层为了让协议层"瘦"必须自己实现的能力。malaixiya 现状大部分缺失，是 § 10.5 第三步的核心工作量。

1. **Registry 服务**（强一致）
   - 维护 `accountId → workerId → nodeId` 映射
   - worker 启动 / 退出时增删
   - Redis 或 etcd 实现，watcher 推送变更
   - 提供 `lookup(accountId) → workerEndpoint` 接口
   - 业务侧每次调协议层接口都先走 Registry 找 worker

2. **ProxyAllocator 服务**
   - 维护 `account_proxy_binding` 表（§4.6）
   - 接收协议层 `account.proxy_failed` 事件
   - 决定换不换 session、换哪个 country/asn
   - 维护 IP 健康度（基于 401/403/超时比例）
   - 流量配额（按 § 3.8）

3. **重连调度器**
   - 接收协议层 `account.state_changed` 事件
   - 决定何时调 `/v1/accounts/{id}/online`（节流 + 优先级）
   - 维护节点级 + 全局令牌桶
   - 冷启动分批上线

4. **批量 reauth 队列**
   - 接收 `account.need_reauth` 事件
   - 不自动发 pairing
   - 通知运营前端 / 用户
   - 维护"重新授权工单"状态

5. **风控波处置**
   - 同时收到 N 个 `account.restricted` / `account.new_chat_capping=CAPPED` 事件时
   - 暂停同 country / 同 ASN / 同账号组的下发
   - 通知运营介入
   - 不让协议层做"自动应对"

6. **业务可用性聚合**
   - 调 `/v1/accounts/{id}/usability` 前先看本地缓存
   - 缓存 60s 内不重复调（减少协议层和 WA 的查询压力）
   - 任务下发链路上**只看 usability，不看 raw state**

#### 4.8.5 协议层 → 业务层的事件契约（强制）

为了让业务层能做上面这些事，协议层必须**保证**下列事件**及时、准确、不漏**：

| 事件 | 触发延迟（SLO） | 不允许丢失 |
|---|---|---|
| `account.state_changed` | < 100ms | 是 |
| `account.need_reauth` | < 200ms | 是（关键事件，必须有重试 / DLQ） |
| `account.restricted` | < 500ms | 是 |
| `account.new_chat_capping` | < 500ms | 是 |
| `account.proxy_failed` | < 1s | 是 |
| `account.proxy_rotated` | < 2s | 否（best-effort） |
| `account.heartbeat` | 每 30s 一次 | 否（缺失即视为 worker 异常） |
| `message.received` | < 500ms | 是（业务侧入库） |

实现要点：
- 关键事件（need_reauth / restricted / proxy_failed / message.received）走 Kafka，producer `acks=all`，消费侧按 offset / 幂等键确认
- 账号级 heartbeat 默认关闭或低频发布；worker 健康由 Registry heartbeat 判断
- 所有事件必须带 `occurredAt` 和 `workerId`，业务层用于乱序检测和归因

#### 4.8.6 调优 checklist（上线前必查）

```text
□ keepAliveIntervalMs = 30_000（默认值，不动）
□ syncFullHistory = false
□ fireInitQueries = false（除非业务依赖 chats/contacts 初始快照）
□ shouldSyncHistoryMessage = () => false
□ markOnlineOnConnect = false
□ emitOwnEvents = false
□ agent 和 fetchAgent 都已设置且使用同一个 sessionId
□ printQRInTerminal 已删除（7.x 已废弃）
□ STALE 检测在 worker 内每 5s 跑一次，触发立即重连
□ 类型 A/B/C 重连分类已实现，每类有独立指标
□ 节点级 + 全局级令牌桶已接 Redis
□ sessionId 创建带 0-900s jitter
□ NEED_REAUTH 不在协议层自动发 pairing
□ 所有上报事件带 evidence + occurredAt + workerId
□ Prometheus /metrics 暴露：reconnect_count / stale_count / event_loop_lag / rss_bytes
□ 关键事件走 Kafka，账号级 heartbeat 默认关闭或低频发布
```

## 5. Baileys 是否可以做到 2000 账号能力

Baileys 本身是“单账号 socket 库”，不是“多账号协议集群框架”。所以答案是：

```text
协议能力：可以
多账号管理：需要我们自己封装
2000 账号单机承载：可做，但要按轻量配置和多进程模型落地
```

Baileys 已具备：

- pairing code 登录
- QR 登录
- session 重连
- WebSocket 保活
- 发送消息
- 媒体上传/下载
- 群创建
- 添加/删除群成员
- 群管理
- 频道/newsletter
- 联系人查询
- 头像、资料、隐私相关操作

Baileys 不直接提供：

- 多账号调度
- 账号级代理池管理
- 账号分片
- 任务队列
- 统一状态上报
- 全参/六段/旧 JSON 转换成新 session 的完整能力
- 2000 账号压测和自愈框架

这些需要我们在协议节点外层实现。

## 6. 生产指标

4C8G 单机挂 2000 号，至少要监控：

```text
进程 RSS 内存
Node heap used
RSS - heapUsed（近似反映 Rust bridge 原生堆 + ws/媒体缓冲）
事件循环延迟 event loop lag
WebSocket 在线数
每分钟重连数
每分钟 401/403/428/515 数量
每分钟 prekey upload 数量
代理失败数
拉群成功率
单账号操作频率
队列积压
文件句柄数量
TCP 连接数量
SessionStore L1 命中率 / L2 写 QPS / L3 快照延迟
```

建议阈值（对应 4.1 方案 A，4C8G）：

```text
单进程账号数：300-400
单进程 RSS：不超过 1.2G
整机内存：不超过 65%（留 OOM 余量给 Rust 原生堆和媒体上传缓冲）
event loop lag：P95 不超过 200ms
重连队列：按账号分散，禁止瞬时全量重连
单账号每分钟操作上限：拉群 ≤ 3 次、发消息 ≤ 20 条（生产风控阈，按账号画像再细分）
```

系统参数也要调整：

```text
ulimit -n 至少 100000
日志异步写，避免同步刷盘
session 存储不要每次事件都全量写（按 4.1 SessionStore 分层）
Node 进程加内存上限：--max-old-space-size=1280（配合 1.2G RSS 阈值）
Rust bridge 原生堆不计入 V8 heap，监控时单独看 RSS - heapUsed
```

## 7. 第一版实施顺序

### 阶段 1：协议节点最小闭环

必须先实现：

```text
RequestPairingCode
OnlineAccount
OfflineAccount
LogoutAccount
GetAccountStatus
ImportBaileysJson
BindProxy
```

目标：账号能授权、能重连、能稳定在线。

### 阶段 2：拉群核心能力

实现：

```text
CreateGroup
AddGroupParticipants
RemoveGroupParticipants
GetGroupMetadata
GetGroupParticipants
GetInviteCode
SetGroupName
SetGroupDescription
```

目标：Java 业务可以通过协议节点完成完整拉群链路。

### 阶段 3：2000 账号压测

压测分三档：

```text
500 在线账号
1000 在线账号
2000 在线账号
```

每档观察：

```text
空闲保活 12 小时
代理随机失败
批量重连
每分钟少量拉群操作
session 重启恢复
```

### 阶段 4：补全 Apifox 能力

再补：

```text
消息发送
图片/音频
聊天静音/删除
联系人
频道
头像资料
```

## 8. 当前建议

短期不要上 Go，先把 Node + Baileys 协议节点封标准：

```text
Java 业务服务 -> 标准协议 API -> Node Baileys worker
```

接口和状态模型要按未来可替换设计。后面如果 Node 单机成本太高，再把协议 worker 替换成 Go，不影响 Java 业务层。

当前优先级：

```text
P0：账号授权、上线、下线、状态、代理绑定、session 存储
P0：建群、拉人、查群成员、查群状态
P1：群管理、邀请链接、退群、审批
P2：消息、联系人、头像、聊天操作
P3：频道、动态、扩展能力
```

## 9. 版本与依赖管理（风险清单）

| 风险 | 现状 | 缓解 |
|---|---|---|
| Baileys 7.0.0-rc11 是 RC | 上游可能 breaking change | fork + 锁 commit；不追 `next` tag；升级走灰度 |
| `whatsapp-rust-bridge` 是原生模块 | 需要 prebuild，跨平台部署 | 锁 0.5.4，在 CI 里预装 `.node` 进基础镜像；不允许线上 `npm install` |
| `libsignal` 仍是 JS 实现 | 2000 账号下是内存/CPU 大头 | 监控 RSS - heapUsed + event loop lag；超阈值降级单进程账号数 |
| Node ≥ 20 强制 | 基础镜像必须升级 | 锁 Node 20 LTS 具体小版本 |
| `fireInitQueries: false` 影响 app-state | 业务层可能拿不到联系人/会话快照 | 默认开启，压测后再决定能否关；关掉的话业务接口要按需补查 |
| `printQRInTerminal` 已废弃 | 旧示例代码会误导 | 配置里删除，QR 走 `connection.update.qr` |
| session keys 写放大 | 单条消息触发多次写 | 强制走 L1+L2+L3 分层（见 2 节 SessionStore） |
| 2000 账号基线是 6.x 测的 | 7.x 行为不同 | 上线前必须在 7.0.0-rc11 重测 500/1000/2000 三档 |

升级流程（每次 Baileys RC 更新）：

```text
1. fork 同步 + 跑单元测试
2. 在 staging 跑 500 账号 12 小时保活
3. 灰度 1 个生产 worker（300 账号）观察 24 小时
4. 指标无回归再全量
5. 升级窗口避开拉群高峰
```

## 10. 现状对照：malaixiya 重连机制的问题与迁移路径

新方案不是凭空设计，而是要替换/演进现有 malaixiya 的重连逻辑。本节对照现状代码，明确哪些保留、哪些重写、迁移顺序。

### 10.1 现有两套重连逻辑梳理

#### 10.1.1 通用协议账号自动重连

入口：`unsea-receive-service/.../NatsServerListener.java::lostline()` (line 829)，重登在 `sendSmsLoginEvent()` (line 1341)。

```text
协议层 → Kafka 发掉线事件 type=101
  ↓
lostline() 按 offLineType 分流：
  -2 / -4 / -5 / -6 / -9 / -10   → byCategoryUpline 队列，记录后自动上线
  239                              → ACCOUNT_UNBIND 队列（视为解绑）
  其他                             → DEFAULT_AUTO_UPLINE 默认队列，走自动上线
  ↓
sendSmsLoginEvent(account):
  - 查账号绑定的 Kafka 节点（RequestNatsUsableDataByAccount）
  - 查 http token（RequestHttpTokenByAccount）
  - 查当前代理（getCurrentIpManageId → RequestProxyByProtocol.requestIpManage）
  - 如果 redis key today_offline_account:{phone} 存在 或 当前代理拿不到
    → RequestProxyByProtocol.requestProxy(pid) 重取代理
    → addUsedIpManageId(用过的)
    → setCurrentIpManageId(新分配的)
  - 发 SMS_LOGIN_EVENT_TYPE_1 到协议节点
```

切 IP 触发：`unsea-stat1-standalone/.../TodayOfflineAccountTask.java` (line 40)，每 30s 扫 `t_ws_lostline_data`，3 分钟内同账号掉线 ≥ 3 次 → 写 redis `today_offline_account:{phone}` (TTL 3min) → 下次 `sendSmsLoginEvent` 强制换代理。

#### 10.1.2 超链账号掉线重登

入口：`HyperlinkTaskController.addLostLineTask` → `HyperlinkLostLineService.handleLostLine()` (line 83)。任务表 `t_hyperlink_lost_line_task`。

```text
定时任务每 60s：
  查 status=0 的任务（已 redis 锁的跳过）
  processNum >= 3 → 关闭（status=-1）
  其余进入 handleLostLineNext：
    强制下线 → 等下线成功事件（onDownLineSuccess） → state=1
    一键上线（oneKeyUplineAccountManage）
    上线成功事件（onUpLineSuccess） → 发超链测试消息校验
    校验 200 → status=1（成功结束）
    超过 3 次 → status=-1 + 清账号当前代理缓存
  Redis 上下文 key：unsea:stat1:lostLine:{phone}，承载状态机
```

### 10.2 总体策略推荐：协议层 clean slate + 业务层增量演进

**直接给结论：协议层 100% 重写（用 Baileys 全新做 Node worker），业务层（Java unsea-* 服务）70% 复用 + 30% 重写。**

#### 为什么不"全部保留"

如果继续用现有协议层，强行让它适配 Baileys 模型：

- `sendSmsLoginEvent` 这种"每次掉线都重走 SMS 授权"的反模式无法兼容 Baileys creds 持久化模型
- `offLineType` 神秘整数码会反复牵扯整个调用链，每加一种新错误都得改 N 处
- 旧协议假设"业务层主动 down/up"，Baileys 假设"socket 层自动 reconnect"，两套生命周期硬合在一起一定打架
- 结果：每个新功能都要绕过历史包袱写一层 adapter，老的 bug 没解，新的 bug 不断

**结论：不行。**

#### 为什么不"全部丢弃"

如果连带 Java 业务层一起重写：

- Kafka 总线、token/proxy 查询微服务、IpManage 表、审计表、运营接口——这些**和重连模型无关**的代码占比超过 70%，重写零收益、纯粹增加工期
- 数据迁移、灰度兼容、运营接口契约变更，每一项都是工程灾难
- 估算工期至少翻 3 倍，且回归风险极高

**结论：不行。**

#### 为什么是 hybrid

协议层和业务层是**两个不同的工程问题**：

- 协议层管 ws socket 生命周期、creds、重连、加解密——这部分模型必须按 Baileys 重新建立，旧代码没有任何可复用的设计
- 业务层管账号、任务、IP 池、审计、运营——这部分大量逻辑是业务无关的"管账号 / 派任务 / 记日志"，本来就和具体协议解耦良好

把边界划在"协议层 ↔ Kafka 消息总线"这个接缝处，**协议层重写、业务层增量演进**，是工程最优解。

### 10.3 完整决策表：复用 / 改造 / 丢弃 三档分类

下表覆盖 malaixiya 重连相关的全部主要模块。**改造复用**指保留代码结构和数据模型，按新方案改少量字段或调用方；**丢弃重写**指彻底删除，按新方案重新设计。

| # | 模块 / 机制 | 分类 | 处理动作 | 对应新方案 |
|---|---|---|---|---|
| **A. 完全复用（不动）** ||||
| 1 | Kafka 消息总线（topic、subject 命名规范） | 完全复用 | 不动 | § 2 总体架构 |
| 2 | `RequestNatsUsableDataByAccount` / `RequestHttpTokenByAccount` / `RequestProxyByProtocol` 查询微服务 | 完全复用 | 不动，调用方改成 Registry | § 2 |
| 3 | 超链业务校验本身（`buildValidBean` / `sendSslk`） | 完全复用 | 业务校验逻辑不变 | § 10.5 第二步 |
| 4 | 账号管理表 / 运营接口 / 后台 UI | 完全复用 | 仅加字段，不改 API | § 10.3 改造复用 ↓ |
| 5 | 现有 Apifox 旧接口的"业务语义"（拉群、加人、查群） | 完全复用 | 语义保留，参数结构按 § 3 重新封装 | § 3 |
| **B. 改造复用（保留结构，按新方案改字段/调用方）** ||||
| 6 | IpManage 表 | 改造复用 | 新增字段：`proxy_session_id`、`tier(pairing/standard)`、`country`、`asn`、`stickyDurationSec` | § 4.6 |
| 7 | 账号管理表 | 改造复用 | 新增字段：`account_type`、`account_type_detected_at`、`platform`、`verified_name`、`worker_id`、`last_evidence_at`、`last_disconnect_semantic` | § 4.7 |
| 8 | 审计表 `t_ws_lostline_data` | 改造复用 | 留痕用；新增 `semantic`、`evidence`、`raw_code`、`raw_reason` 字段；不再驱动重登 | § 10.4 错误码映射 |
| 9 | 审计表 `t_hyperlink_lost_line_task` | 改造复用 | 改语义为"长时间不可用工单"，`processNum` 改为最终兜底重试计数；不再做"先下线再上线" | § 10.5 第二步 |
| 10 | `HyperlinkTaskController` 入口路由 | 改造复用 | URL 保留，内部实现重写：等协议层报 ONLINE + evidence 新鲜 → 再发校验 | § 10.5 第二步 |
| 11 | 事件驱动模型（Kafka push 掉线 type=101） | 改造复用 | topic 名保留兼容，payload 改用语义码 + evidence，不再用 offLineType 整数 | § 10.4 |
| 12 | 任务表"最大重试 + status 流转"模式 | 改造复用 | 模式保留，重试次数按错误类型分级（A 立即/B 退避/C 不重试） | § 4.5 |
| 13 | Redis cache 思路 | 改造复用 | key 模型重写，由 Registry 维护权威状态；Redis 只做读写缓存，不再承载"上下文"语义 | § 4.7 + Registry |
| 14 | 任务表 schema（DDL 模式） | 改造复用 | 表结构保留，按新方案加 evidence 字段 | § 4.7 |
| **C. 完全丢弃（按新方案重写）** ||||
| 15 | 整个旧协议层（Apifox 协议 / unsea-protocol）| **丢弃重写** | 100% 删除，用 Baileys 7.0.0-rc11 全新写 Node worker | § 4 全部 |
| 16 | `sendSmsLoginEvent` 走 SMS_LOGIN_EVENT 重新授权链路 | **丢弃重写** | Baileys 重连用本地 creds，绝不调 pairing/SMS；只有 `NEED_REAUTH` 才走授权 | § 4.3 |
| 17 | `lostline()` 中 offLineType 整数分流 | **丢弃重写** | 协议层在源头翻译为语义码（PROXY_FAILED / RATE_LIMITED / NEED_REAUTH / RECONNECTING ...），业务层只看语义码 | § 10.4 |
| 18 | `TodayOfflineAccountTask` "3min/3次"作为换 IP 主路径触发器 | **丢弃重写** | 换 IP 由协议层错误码直接驱动；3min/3次降级为兜底告警 | § 4.6 |
| 19 | `HyperlinkLostLineService.handleLostLine` 先下线再上线 | **丢弃重写** | 反模式，强制下线会打断协议层自动重连。改为：协议层自动重连成功 → ONLINE + evidence 新鲜 → 发校验消息 | § 10.5 第二步 |
| 20 | Redis key `unsea:stat1:lostLine:{phone}` 单上下文 | **丢弃重写** | Registry 仲裁 `accountId → workerId` 单一归属；单 worker 内串行化状态机 | § 10.5 第三步 |
| 21 | 固定 3 次重试无退避策略 | **丢弃重写** | § 4.5 三类（A 立即 / B 5s→30s→2min→10min / C 不重试） | § 4.5 |
| 22 | 多实例定时任务无分布式锁 | **丢弃重写** | 所有定时扫描类任务加 `SETNX` + Registry 仲裁 | § 10.5 第三步 |

#### 工作量估算

| 层 | 重写比例 | 备注 |
|---|---|---|
| 协议层（Node Baileys worker） | 100% 重写 | 旧协议层完全废弃，新协议节点用本文档 § 3 + § 4 设计 |
| Java 业务层（unsea-* 全部服务） | 约 30% 重写 | 主要是上述决策表 C 档 7 项；其余 70% 保留 |
| 数据库 schema | 0 张表重建 + 3-5 张表加字段 + 1 张新表（`account_proxy_binding`） | 加字段为主，不需要数据迁移工具 |
| 接口契约（对前端/运营） | 0% 破坏 | 运营和后台接口语义全部保留 |

### 10.4 错误码映射：现状 → 新方案

malaixiya 用 `offLineType` 整数码做分流，新方案要把这套整数码翻译成新状态机。先把现状的 offLineType 含义和新状态机做映射表（业务侧迁移参考）：

| 现 offLineType | malaixiya 当前处理 | 新方案目标状态 | 重连策略 |
|---|---|---|---|
| -2 / -4 / -5 / -6 / -10 | byCategoryUpline 重新上线 | OFFLINE / RECONNECTING | § 4.5 类型 B 退避 |
| -9 | 同上（注释里看出曾考虑作为 ACCOUNT_EXCEPTION） | RATE_LIMITED 或 PROXY_FAILED（需要协议层细化） | 走 Java 调度 |
| 239 | ACCOUNT_UNBIND 解绑 | NEED_REAUTH / DEVICE_REMOVED | § 4.5 类型 C 不重试 |
| 其他 | DEFAULT_AUTO_UPLINE 默认自动上线 | OFFLINE → RECONNECTING（按 Baileys 实际 statusCode 细化） | § 4.5 类型 A/B |

**新协议层必须做的事**：把 Baileys 的 `DisconnectReason` + `lastDisconnect.error.output.statusCode` 翻译成统一的语义码（建议字符串枚举，不要再用神秘整数），同时附带原始 `code` 和 `reason` 给 Java，便于排查：

```json
{
  "accountId": "acc_001",
  "semantic": "PROXY_FAILED",          // 新方案统一枚举
  "rawCode": 408,
  "rawReason": "Connection terminated",
  "evidence": { ... },
  "occurredAt": "..."
}
```

### 10.5 迁移路径（建议四步）

#### 第一步：协议层接管"立即重连"，业务层退出 socket 级重连

- malaixiya `lostline()` 收到 type=101 之后，**不要立即调 sendSmsLoginEvent**
- 改为：协议层（新 Node Baileys worker）自己按 § 4.5 类型 A/B 重连
- 业务层只在收到协议层推送的"终态事件"（NEED_REAUTH / PROXY_FAILED / RATE_LIMITED）时才介入
- `t_ws_lostline_data` 保留作为审计表，但不再驱动重登

预期收益：减少 90% 以上的"经业务层重登"次数，IP 切换不需要重新跑 pairing/SMS。

#### 第二步：废弃超链"先下线再上线"

- `HyperlinkLostLineService.handleLostLine` 中 `强制下线 → 等下线成功 → 一键上线` 这条链路在 Baileys 时代是反模式
- 新方案：协议层自己重连，业务层只在重连失败（NEED_REAUTH / 累计退避 > 阈值）时介入
- 超链校验保留——但触发点改为"协议层上报 ONLINE 且 evidence 新鲜"之后才发校验消息
- `t_hyperlink_lost_line_task` 保留为"账号长时间不可用的工单表"，processNum 仍可作为兜底重试计数

#### 第三步：分布式锁 + Registry 仲裁

- 定时任务全部加 Redis `SETNX` 锁，避免多实例并发
- 引入 Registry 服务（参考 § 2 架构图的 OperationRouter）作为唯一权威：
  - `accountId → workerId` 在 Registry 写
  - 任何"重新分配代理"、"账号漂移"操作必须经 Registry
  - Redis key `unsea:stat1:lostLine:{phone}` 改为 Registry 内部状态，对外只暴露状态查询接口

#### 第四步：切 IP 由错误类型驱动，不由"3 分钟 3 次"驱动

- 协议层错误分类（§ 4.6）：
  - `PROXY_FAILED`（代理超时/auth 失败）→ Java 立即换 session IP
  - `RATE_LIMITED` → 冷却，不换 IP
  - `NEED_REAUTH` → 不换 IP，标记账号待人工
  - `connectionLost`（lastDateRecv 超时）→ 用同一 sessionId 重试，IP 由代理商自然轮换
- 废弃 `TodayOfflineAccountTask` 的 "3min/3 次"逻辑作为主路径，仅保留为**兜底告警**——如果协议层错误分类没识别到，但短时多次掉线仍触发，说明协议层错误码翻译有 bug，告警而不是直接换 IP

## 11. 阶段性扩展：从 1 万到 100 万 concurrent

> 业务目标：分阶段灌入账号，最终达到**百万级长在线 concurrent**。
> 现实判断：百万 concurrent 在 Baileys 上**没有公开案例**，新方案要分阶段灌、每阶段验证再扩，不能直接按 100 万设计。

### 11.1 阶段规划（按 concurrent 在线数划档）

| 阶段 | 在线 concurrent | 累计注册 | 性质 | 工期估 |
|---|---|---|---|---|
| Phase 0 | ≤ 1k | - | 内部验证，Baileys 7.x + Rust bridge 稳定性、creds 持久化、IP 轮换闭环 | 1-2 月 |
| Phase 1 | 1 万 | 1-3 万 | 单 region、单 Kafka 集群、单 Redis cluster；§ 4 设计直接放大 5 倍 | 1 月 |
| Phase 2 | 10 万 | 10-30 万 | 必须引入 Registry、分片、冷热分层；Kafka topic/partition 分流 | 2-3 月 |
| Phase 3 | 50 万 | 50-150 万 | 多 region、跨机房 creds 复制、多供应商 IP 池、Redis cluster 多分片 | 3-4 月 |
| Phase 4 | 100 万 | 100-300 万 | 高风险区，必须有 Plan B 替代方案；评估自研协议或商业 WA Business API 混合 | 6 月+ |

每阶段进入前必须满足"准入条件"，否则不进下一阶段：

```text
准入条件（每阶段都跑一遍）：
  1. 上一阶段连续 14 天可用性 ≥ 99.5%
  2. 平均掉线率 ≤ 0.5%/天
  3. 重连成功率 ≥ 95%
  4. NEED_REAUTH 比例 ≤ 0.1%/天
  5. IP 供应商有声明能 sustain 下一阶段 session 量
  6. 成本预算审批通过
```

### 11.2 每阶段架构和容量

#### Phase 1：1 万 concurrent

- **节点**：5-7 台 4C8G，每台 5-6 worker × 300-400 账号 ≈ 1500-2000/台
- **Kafka**：单集群足够，按 § 2 总线
- **Redis**：单 cluster（3 主 3 从），承担 L2 keys + 重连令牌桶 + Registry 状态
- **PG**：单实例 + 备库，存 creds（10k × 100KB ≈ 1GB，毫无压力）
- **IP**：10k × 平均 3 账号共享 ≈ **3.3k session**，月成本 $7k 量级
- **重连**：均速 11-17 次/s，瞬时峰值估 500 次/s，单 Redis 令牌桶 OK
- **风险**：低，本质就是 § 4 设计直接放大 5 倍

#### Phase 2：10 万 concurrent

- **节点**：50-70 台 4C8G。开始要按"机柜/可用区"分组部署
- **Kafka**：单集群开始成为瓶颈，按 topic/partition 分流并扩 broker
- **Redis**：必须分 cluster——**1 套 keys cluster + 1 套 Registry cluster + 1 套限流 cluster**。不能再合一个
- **PG**：creds 表 ~10GB，PG 主从足够；keys 全量在 Redis，每天数十亿次写
- **存储分层**：开始引入**冷热分层**——长期 OFFLINE 账号 creds 推到对象存储，激活时拉回
- **IP**：33k session × $2 ≈ **$66k/月**
- **重连**：均速 110-170 次/s，峰值 5k 次/s。**令牌桶必须分片**：按 accountId hash 路由到不同 Redis 节点的桶
- **新增能力**：Registry（accountId → workerId 仲裁）必须独立部署，可用 etcd 或 Redis + Lua 实现
- **风险**：中。最大挑战是 Redis keys 写放大——必须按 § 2 SessionStore 三层做严格批写
- **关键决策点**：是否上 region 分片（如果账号有明显地理分布）

#### Phase 3：50 万 concurrent

- **节点**：250-350 台。**必须多 region 部署**（按账号 country/ASN 就近落地）
- **跨 region**：creds 通过对象存储跨 region 异步复制（账号漂移时只需从对象存储拉回）
- **消息总线**：Kafka 多集群 + cross-region MirrorMaker
- **Redis**：keys cluster 分多套（按 region），单套 Redis cluster 撑不动 500 亿次/天的 ratchet 写
- **PG**：creds 表分库分表（按 accountId hash），单库 < 50GB
- **审计**：MySQL/PG 撑不住高频写，迁 **ClickHouse**（重连事件、状态变迁、proxy rotation 全部走 CH）
- **IP**：**166k session × $2 = $330k/月**。开始多供应商混合（单一供应商可能没有这个 session 量级）
- **重连**：均速 550-830 次/s，峰值 25k 次/s
- **风险**：高。
  - libsignal JS 在百万级密钥同步下未公开验证
  - 单一 IP 供应商封号波会同时影响数万账号
  - 跨 region 漂移导致的 IP geo 变化，对账号风控敏感
- **关键决策点**：是否要部分账号切换到自研 Rust/Go 协议层（用 Baileys 做参考实现）

#### Phase 4：100 万 concurrent

- **节点**：600-700 台。多 region、多 IDC
- **IP**：**333k session × $2 = $666k/月，约 $8M/年**。**IP 成本是头号支出**
- **重连**：均速 1100-1700 次/s，峰值估 5 万次/s
- **存储**：creds 100GB+，keys 1TB+
- **带宽**：1M ws × 平均 1KB/s ≈ 1GB/s，按公网带宽计成本不可忽略
- **运维**：600+ 节点不再是手工 ops，必须 K8s + 完整 SLI/SLO + 自动愈合
- **风险**：极高
  - **Baileys 在这个规模没有公开案例**——所有性能数字是外推估算
  - 任何一次 WA 风控策略变更可能同时影响 10%+ 账号，需要批量 reauth 通道
  - 单个 IP 供应商不可能独家承担，必须 3+ 供应商混合
- **必要的 Plan B**：见 § 11.5

### 11.3 跨阶段必备能力（从 Phase 2 开始就要做）

无论目标规模多大，下面这些能力在百万级路径上**必不可少**，必须在 Phase 2 就开建：

#### 11.3.1 一致性 hash 分片

```text
accountId → murmurhash3 → 虚拟节点环 → 物理 worker
  - 虚拟节点数 = 物理 worker 数 × 100（平滑扩容）
  - region/country 作为二级 key（保证 IP 出口和账号 country 一致）
  - Registry 持久化整个映射表，worker 启动时拉取
```

扩容/缩容时只迁移受影响的虚拟节点，账号漂移走 § 4.3 重连流程，**不需要重新授权**。

#### 11.3.2 冷热分层

```text
HOT     ws 在线 + creds 在内存 + keys 在 Redis
WARM    最近 24h 内 OFFLINE + creds 在 Redis + keys 在 Redis（可降级到磁盘）
COLD    > 7 天 OFFLINE + creds 在对象存储 + keys 已 archive
        重新激活前必须先 rehydrate
```

冷热判定由 Registry 维护，每天跑一次 demotion 任务。**百万级如果不分层，内存和 Redis 成本会失控。**

#### 11.3.3 存储拆分（按数据特征选型）

| 数据类型 | 写频率 | 大小 | 推荐存储 | 备注 |
|---|---|---|---|---|
| creds（auth state 主体） | 极低（pairing/版本升级时） | ~100KB/账号 | PG 分库分表 + 对象存储归档 | 主备 + 跨 region 复制 |
| Signal keys（sender/receiver/prekey） | 极高（每条消息多次写） | ~5-50KB/账号 | Redis cluster（分片） | TTL + 周期 snapshot 到对象存储 |
| 账号状态 / 路由 | 中（每次状态变迁） | < 1KB | Registry（etcd 或 Redis + Lua） | 必须强一致 |
| 审计 / 事件 / 指标 | 极高 | 不定 | ClickHouse / Loki | 不进 PG |
| IP 池 / 绑定关系 | 低 | < 1KB | PG | 主路径 |

百万级如果还把 keys 放 PG，写放大会直接打爆数据库。

#### 11.3.4 重连风暴限流的分布式实现

单 Redis 桶在 Phase 3+ 撑不住。必须：

```text
全局令牌桶：分 N 个分片，按 accountId hash 路由
  shard_count = max(8, 节点数 / 50)
  每分片独立 Redis（或 Redis cluster 槽）
  Registry 聚合各分片的桶余量做全局限速决策

节点级：本地令牌桶 + 1s 同步给中央
账号级：sessionId hash 错峰，spread 0-900s 偏移避免 10-15min 周期对齐
```

#### 11.3.5 批量 reauth 通道

百万级时，任何一次 WA 风控波都可能同时让数千~数万账号进 NEED_REAUTH。必须提前建：

```text
- NEED_REAUTH 不在协议层自动处理（§ 4.4 已写）
- Java 端建独立"批量 reauth 队列"，按 country/ASN/批次分组
- 关联运营前端：批量给用户推送"需要重新绑定"通知
- pairing 池资源在 Phase 3+ 必须扩到能 sustain 每天数万次 pairing
- 风控波时**禁止自动批量发起 pairing**——会触发更重的封号
```

### 11.4 真实成本模型（参考估算）

按当前 IP 单价 $2/月（动态住宅，10-15min sticky）和云服务器 $300/月（4C8G）估算：

| 阶段 | concurrent | 节点 | IP/月 | 服务器/月 | 存储+带宽/月 | 月成本估算 |
|---|---|---|---|---|---|---|
| Phase 1 | 1 万 | 7 | $7k | $2k | $1k | **~$10k** |
| Phase 2 | 10 万 | 70 | $66k | $21k | $8k | **~$95k** |
| Phase 3 | 50 万 | 350 | $330k | $105k | $40k | **~$475k** |
| Phase 4 | 100 万 | 700 | $666k | $210k | $80k | **~$960k** ≈ $1M/月 |

> 数字是参考量级，实际取决于供应商谈判、自建机房 vs 云、region 分布。
> **IP 成本在 Phase 2+ 是头号支出**，超过服务器，是规模化的主要瓶颈。
> Phase 4 年运营成本约 $12M，账号 LTV 必须能覆盖才能继续。

### 11.5 红线与 Plan B

#### 何时不能再用 Baileys

满足以下任一条件，必须立即评估替代方案，**不要硬撑**：

1. concurrent 超过 30 万且持续 30 天，且 NEED_REAUTH 比例 > 0.5%/天
2. libsignal JS 单 worker 内存压力导致频繁 GC pause > 500ms
3. Rust bridge 出现无法定位的 native crash（dump 抓不到、跨平台行为不一致）
4. WA 协议在某次更新后 Baileys 上游 N 周未跟进，社区无 fix 时间表
5. IP 供应商无法 sustain 单 region 10 万+ session

#### Plan B 选项

| 选项 | 适用 | 工期 | 风险 |
|---|---|---|---|
| **自研 Rust 协议层** | 长期主路径，replace Baileys 的协议解析层 | 6-12 月 | 高（需要团队有 Rust + 加密协议经验） |
| **WA Business Cloud API（官方）** | 高价值账号、不需要"操作其他账号"的场景 | 1-2 月集成 | 低（官方 API），但有费用 + 功能受限（拉群能力可能受限） |
| **多协议混合** | 重要账号走官方 API + 养号/批量走 Baileys | 2-3 月 | 中 |
| **下调 concurrent 目标** | 重新评估业务必要性，分批轮换在线 | 0 月 | 业务侧改造 |

#### 何时启动 Plan B 调研

**Phase 3 启动前**就要做 Plan B 调研，不能等 Phase 4 出问题再说。
百万级如果硬撑 Baileys，单一架构失败的后果是"几十万账号同时不可用、几个月内修不好"，业务无法承受。

### 11.6 §1 结论的修订

原 § 1 结论是按"4C8G/2000 账号"写的，分阶段灌入百万级后，结论应修订为：

```text
- Phase 0-1（≤ 1 万 concurrent）：Node + Baileys 直接可用，§ 4 设计成立
- Phase 2（10 万 concurrent）：Node + Baileys 可用，但必须按 § 11.3 引入 Registry / 分片 / 冷热分层 / 存储拆分
- Phase 3（50 万 concurrent）：Node + Baileys 仍是主路径，但必须并行启动 Plan B 调研
- Phase 4（100 万 concurrent）：Baileys 单一架构风险过高，必须有 Plan B 兜底
- 不论哪个阶段，§ 4.3 / 4.4 / 4.5 / 4.6 / 4.7 的状态机和重连模型不变
```

## 附录 A：Baileys 接口实现清单（开发任务跟踪表）

> 共 **86 个接口** + **19 个事件**。**P0 共 36 个**（最小可用闭环）。
> 每条标 Baileys 调用 / 优先级 / 状态。用作开发跟踪表，逐条 check off。

### A.1 授权与导入（P0，9 个）

| # | 接口 | Baileys 调用 | P | 状态 | 负责人 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `POST /v1/auth/pairing-code` | `sock.requestPairingCode(phone)` ([socket.ts:758](Baileys-master_协议/src/Socket/socket.ts)) | P0 | ☐ |  | 异步，code 通过 `pairing.code_generated` 回调 |
| 2 | `POST /v1/auth/qrcode` | 监听 `connection.update.qr` | P0 | ☐ |  | QR 通过 `qr.code_generated` 回调 |
| 3 | `POST /v1/accounts/import/baileys-json` | `useMultiFileAuthState` + `makeWASocket` | P0 | ☐ |  | 标准格式直接用 |
| 4 | `POST /v1/accounts/import/params` | `convertParamsToBaileys` + `makeWASocket` | P0 | ☐ |  | 移植 Apifox `paramsLogin`，30+ 字段 |
| 5 | `POST /v1/accounts/import/six` | `convertSixToBaileys` + `makeWASocket` | P0 | ☐ |  | 移植 Apifox `sixLogin`，要解码 `deviceIdentityKey` protobuf |
| 6 | `POST /v1/accounts/import/legacy-json` | `convertLegacyJsonToBaileys` + `makeWASocket` | P0 | ☐ |  | 移植 Apifox `jsonLogin`，输入 base64 |
| 7 | `POST /v1/accounts/import/batch` | 批量调 3-6 | P1 | ☐ |  | 百万级必备 |
| 8 | `GET /v1/accounts/{id}/export/baileys-json` | dump `authState.creds + keys` | P0 | ☐ |  | **Apifox 现在没有，必新建** |
| 9 | `GET /v1/accounts/{id}/export/portable` | dump + 包业务元数据 | P1 | ☐ |  | 跨集群迁移用 |

### A.2 账号生命周期（P0，3 个）

| # | 接口 | Baileys 调用 | P | 状态 | 负责人 | 备注 |
|---|---|---|---|---|---|---|
| 10 | `POST /v1/accounts/{id}/online` | `makeWASocket({ auth, agent, fetchAgent, ... })` | P0 | ☐ |  | 配置见 § 4.2 |
| 11 | `POST /v1/accounts/{id}/offline` | `sock.end(undefined)` | P0 | ☐ |  | 保留 creds |
| 12 | `POST /v1/accounts/{id}/logout` | `sock.logout()` | P0 | ☐ |  | 远端移除设备 |

### A.3 账号状态查询（P0，5 个）

| # | 接口 | Baileys 调用 / 来源 | P | 状态 | 负责人 | 备注 |
|---|---|---|---|---|---|---|
| 13 | `GET /v1/accounts/{id}/status` | 协议层自维护 + `lastDateRecv` ([socket.ts:585](Baileys-master_协议/src/Socket/socket.ts)) | P0 | ☐ |  | 完整 status + evidence |
| 14 | `GET /v1/accounts/{id}/online` | 同上，仅返子集 | P0 | ☐ |  | 轻量探活 |
| 15 | `GET /v1/accounts/{id}/type` | `creds.platform` + `creds.me.name` + 兜底 `sock.getBusinessProfile(selfJid)` ([chats.ts:464](Baileys-master_协议/src/Socket/chats.ts)) | P0 | ☐ |  | pairing 时定型，重连不变 |
| 16 | `POST /v1/accounts/{id}/probe` | 主动 `<iq><ping/></iq>`，3s 内拿 ack | P0 | ☐ |  | 关键操作前确认在线 |
| 17 | `POST /v1/accounts/check-whatsapp` | `sock.onWhatsApp(phone)` ([socket.ts:321](Baileys-master_协议/src/Socket/socket.ts)) | P1 | ☐ |  | 批量手机号查 WA 用户 |

### A.4 账号风控查询（P0，3 个，Apifox 没有）

| # | 接口 | Baileys 调用 | P | 状态 | 负责人 | 备注 |
|---|---|---|---|---|---|---|
| 18 | `GET /v1/accounts/{id}/restriction` | `sock.fetchAccountReachoutTimelock()` ([socket.ts:1117](Baileys-master_协议/src/Socket/socket.ts)) | P0 | ☐ |  | 14 种 enforcementType |
| 19 | `GET /v1/accounts/{id}/message-cap` | `sock.fetchNewChatMessageCap()` ([socket.ts:1139](Baileys-master_协议/src/Socket/socket.ts)) | P0 | ☐ |  | 拉群配额 |
| 20 | `GET /v1/accounts/{id}/usability` | 聚合 13 + 18 + 19 | P0 | ☐ |  | 业务侧调一个就够 |

### A.5 群组（P0/P1/P2，22 个，拉群业务核心）

| # | 接口 | Baileys 调用 | P | 状态 | 负责人 | 备注 |
|---|---|---|---|---|---|---|
| 21 | `POST /v1/groups/create` | `sock.groupCreate(subject, participants)` | P0 | ☐ |  |  |
| 22 | `POST /v1/groups/{jid}/participants/add` | `sock.groupParticipantsUpdate(jid, p, 'add')` | P0 | ☐ |  | 返回 per-participant status |
| 23 | `POST /v1/groups/{jid}/participants/remove` | `sock.groupParticipantsUpdate(jid, p, 'remove')` | P1 | ☐ |  |  |
| 24 | `POST /v1/groups/{jid}/participants/promote` | `sock.groupParticipantsUpdate(jid, p, 'promote')` | P1 | ☐ |  | 设管理员 |
| 25 | `POST /v1/groups/{jid}/participants/demote` | `sock.groupParticipantsUpdate(jid, p, 'demote')` | P1 | ☐ |  | 取消管理员 |
| 26 | `GET /v1/groups/{jid}/metadata` | `sock.groupMetadata(jid)` | P0 | ☐ |  |  |
| 27 | `GET /v1/groups/{jid}/participants` | `groupMetadata().participants` | P0 | ☐ |  |  |
| 28 | `GET /v1/accounts/{id}/groups` | `sock.groupFetchAllParticipating()` | P1 | ☐ |  | 全部群列表 |
| 29 | `POST /v1/groups/{jid}/subject` | `sock.groupUpdateSubject(jid, name)` | P1 | ☐ |  |  |
| 30 | `POST /v1/groups/{jid}/description` | `sock.groupUpdateDescription(jid, desc)` | P1 | ☐ |  |  |
| 31 | `POST /v1/groups/{jid}/picture` | `sock.updateProfilePicture(jid, image)` | P2 | ☐ |  |  |
| 32 | `GET /v1/groups/{jid}/invite-code` | `sock.groupInviteCode(jid)` | P1 | ☐ |  |  |
| 33 | `POST /v1/groups/{jid}/invite/revoke` | `sock.groupRevokeInvite(jid)` | P2 | ☐ |  |  |
| 34 | `POST /v1/groups/join` | `sock.groupAcceptInvite(code)` | P1 | ☐ |  | 通过 code 进群 |
| 35 | `POST /v1/groups/{jid}/leave` | `sock.groupLeave(jid)` | P1 | ☐ |  |  |
| 36 | `POST /v1/groups/{jid}/settings/announcement` | `sock.groupSettingUpdate(jid, 'announcement'\|'not_announcement')` | P1 | ☐ |  | 仅管理员发言 |
| 37 | `POST /v1/groups/{jid}/settings/locked` | `sock.groupSettingUpdate(jid, 'locked'\|'unlocked')` | P1 | ☐ |  | 锁群信息 |
| 38 | `POST /v1/groups/{jid}/settings/member-add-mode` | `sock.groupMemberAddMode(jid, 'admin_add'\|'all_member_add')` | P1 | ☐ |  | 成员是否可加人 |
| 39 | `POST /v1/groups/{jid}/settings/join-approval` | `sock.groupJoinApprovalMode(jid, 'on'\|'off')` | P2 | ☐ |  | 入群审批开关 |
| 40 | `GET /v1/groups/{jid}/pending` | `sock.groupRequestParticipantsList(jid)` | P2 | ☐ |  | 待审批 |
| 41 | `POST /v1/groups/{jid}/pending/approve` | `sock.groupRequestParticipantsUpdate(jid, p, 'approve')` | P2 | ☐ |  |  |
| 42 | `POST /v1/groups/{jid}/pending/reject` | `sock.groupRequestParticipantsUpdate(jid, p, 'reject')` | P2 | ☐ |  |  |

### A.6 消息（P1/P2，15 个）

| # | 接口 | Baileys 调用 | P | 状态 | 负责人 | 备注 |
|---|---|---|---|---|---|---|
| 43 | `POST /v1/messages/text` | `sock.sendMessage(jid, { text })` | P1 | ☐ |  |  |
| 44 | `POST /v1/messages/image` | `sock.sendMessage(jid, { image, caption })` | P1 | ☐ |  |  |
| 45 | `POST /v1/messages/audio` | `sock.sendMessage(jid, { audio, mimetype, ptt })` | P2 | ☐ |  |  |
| 46 | `POST /v1/messages/video` | `sock.sendMessage(jid, { video, caption })` | P2 | ☐ |  |  |
| 47 | `POST /v1/messages/document` | `sock.sendMessage(jid, { document, mimetype, fileName })` | P2 | ☐ |  |  |
| 48 | `POST /v1/messages/location` | `sock.sendMessage(jid, { location })` | P2 | ☐ |  |  |
| 49 | `POST /v1/messages/contact-card` | `sock.sendMessage(jid, { contacts })` | P2 | ☐ |  |  |
| 50 | `POST /v1/messages/link` | `sock.sendMessage(jid, { text })` + linkPreview | P2 | ☐ |  | 带预览 |
| 51 | `POST /v1/messages/reaction` | `sock.sendMessage(jid, { react: { text, key } })` | P2 | ☐ |  |  |
| 52 | `POST /v1/messages/delete` | `sock.sendMessage(jid, { delete: key })` | P2 | ☐ |  | 撤回 |
| 53 | `POST /v1/messages/forward` | `sock.sendMessage(jid, { forward: msg })` | P2 | ☐ |  |  |
| 54 | `POST /v1/messages/read` | `sock.readMessages([key])` ([messages-send.ts:228](Baileys-master_协议/src/Socket/messages-send.ts)) | P2 | ☐ |  |  |
| 55 | `POST /v1/messages/typing` | `sock.sendPresenceUpdate('composing', jid)` ([chats.ts:800](Baileys-master_协议/src/Socket/chats.ts)) | P2 | ☐ |  | 输入中 |
| 56 | `POST /v1/messages/{id}/download` | `downloadMediaMessage(msg, 'buffer')` | P2 | ☐ |  | 按需下载省流量 |
| 57 | `POST /v1/messages/status` | `sock.sendMessage('status@broadcast', content, { statusJidList })` | P2 | ☐ |  | 动态 |

### A.7 联系人与聊天（P2，10 个）

| # | 接口 | Baileys 调用 | P | 状态 | 负责人 | 备注 |
|---|---|---|---|---|---|---|
| 58 | `POST /v1/contacts/{jid}/save` | `sock.addOrEditContact(jid, contact)` ([chats.ts:1071](Baileys-master_协议/src/Socket/chats.ts)) | P2 | ☐ |  |  |
| 59 | `DELETE /v1/contacts/{jid}` | `sock.removeContact(jid)` ([chats.ts:1083](Baileys-master_协议/src/Socket/chats.ts)) | P2 | ☐ |  |  |
| 60 | `POST /v1/contacts/{jid}/block` | `sock.updateBlockStatus(jid, 'block')` ([chats.ts:400](Baileys-master_协议/src/Socket/chats.ts)) | P2 | ☐ |  |  |
| 61 | `POST /v1/contacts/{jid}/unblock` | `sock.updateBlockStatus(jid, 'unblock')` | P2 | ☐ |  |  |
| 62 | `POST /v1/chats/{jid}/mute` | `sock.chatModify({ mute }, jid)` | P2 | ☐ |  |  |
| 63 | `POST /v1/chats/{jid}/clear` | `sock.chatModify({ clear }, jid)` | P2 | ☐ |  |  |
| 64 | `POST /v1/chats/{jid}/delete` | `sock.chatModify({ delete: true }, jid)` | P2 | ☐ |  |  |
| 65 | `POST /v1/chats/{jid}/archive` | `sock.chatModify({ archive }, jid)` | P2 | ☐ |  |  |
| 66 | `POST /v1/chats/{jid}/pin` | `sock.chatModify({ pin }, jid)` | P2 | ☐ |  |  |
| 67 | `POST /v1/chats/{jid}/mark-read` | `sock.chatModify({ markRead }, jid)` | P2 | ☐ |  |  |

### A.8 资料（P2，5 个）

| # | 接口 | Baileys 调用 | P | 状态 | 负责人 | 备注 |
|---|---|---|---|---|---|---|
| 68 | `POST /v1/profile/name` | `sock.updateProfileName(name)` ([chats.ts:382](Baileys-master_协议/src/Socket/chats.ts)) | P2 | ☐ |  |  |
| 69 | `POST /v1/profile/status` | `sock.updateProfileStatus(status)` ([chats.ts:364](Baileys-master_协议/src/Socket/chats.ts)) | P2 | ☐ |  | 签名 |
| 70 | `POST /v1/profile/picture` | `sock.updateProfilePicture(selfJid, image)` ([chats.ts:300](Baileys-master_协议/src/Socket/chats.ts)) | P2 | ☐ |  | 头像 |
| 71 | `DELETE /v1/profile/picture` | `sock.removeProfilePicture(selfJid)` ([chats.ts:338](Baileys-master_协议/src/Socket/chats.ts)) | P2 | ☐ |  |  |
| 72 | `GET /v1/profile/{jid}/picture-url` | `sock.profilePictureUrl(jid, 'image'\|'preview')` ([chats.ts:738](Baileys-master_协议/src/Socket/chats.ts)) | P2 | ☐ |  |  |

### A.9 Business 资料（P3，4 个，仅 Business 号）

| # | 接口 | Baileys 调用 | P | 状态 | 负责人 | 备注 |
|---|---|---|---|---|---|---|
| 73 | `GET /v1/profile/business/{jid}` | `sock.getBusinessProfile(jid)` ([chats.ts:464](Baileys-master_协议/src/Socket/chats.ts)) | P3 | ☐ |  |  |
| 74 | `POST /v1/profile/business/update` | `sock.updateBussinesProfile(...)` ([business.ts:20](Baileys-master_协议/src/Socket/business.ts)) | P3 | ☐ |  |  |
| 75 | `GET /v1/business/catalog` | `sock.getCatalog({ jid, limit, cursor })` | P3 | ☐ |  |  |
| 76 | `POST /v1/business/product` | `sock.productCreate / productUpdate / productDelete` | P3 | ☐ |  |  |

### A.10 频道 newsletter（P3，4 个）

| # | 接口 | Baileys 调用 | P | 状态 | 负责人 | 备注 |
|---|---|---|---|---|---|---|
| 77 | `POST /v1/channels/follow` | `sock.newsletterFollow(jid)` | P3 | ☐ |  |  |
| 78 | `POST /v1/channels/unfollow` | `sock.newsletterUnfollow(jid)` | P3 | ☐ |  |  |
| 79 | `GET /v1/channels/{jid}/messages` | `sock.newsletterFetchMessages(jid, count, since, after)` | P3 | ☐ |  |  |
| 80 | `POST /v1/channels/{jid}/reaction` | `sock.newsletterReactMessage(jid, serverId, reaction)` | P3 | ☐ |  |  |

### A.11 代理（P0，3 个，Baileys 配置项不是 API）

| # | 接口 | 实现要点 | P | 状态 | 负责人 | 备注 |
|---|---|---|---|---|---|---|
| 81 | `POST /v1/accounts/{id}/proxy/bind` | 自定义 ProxyManager + `socks-proxy-agent`/`https-proxy-agent`，传 `makeWASocket({ agent, fetchAgent })` | P0 | ☐ |  | `agent` 和 `fetchAgent` 必须都传 |
| 82 | `POST /v1/accounts/{id}/proxy/rebind` | 重建 socket，agent 新构造（**不要复用旧 agent 实例**） | P0 | ☐ |  | 详见 § 4.6 |
| 83 | `GET /v1/accounts/{id}/proxy` | 自维护元数据 | P0 | ☐ |  | session ID + country + asn |

### A.12 协议层 → 业务层事件（P0，订阅与转发）

#### 协议层订阅的 Baileys 内部事件

| Baileys 事件 | 转发为业务事件 | 状态 | 备注 |
|---|---|---|---|
| `connection.update` | `account.state_changed` / `qr.code_generated` / `account.restricted` | ☐ | 含 reachoutTimeLock 推送 |
| `creds.update` | （内部持久化到 SessionStore） | ☐ | 不直接对外 |
| `messages.upsert` | `message.received` | ☐ |  |
| `messages.update` | `message.ack` | ☐ | 含撤回 |
| `message-receipt.update` | `message.ack` | ☐ | 已读/已送达 |
| `messages.reaction` | `message.received`（子类型 reaction） | ☐ |  |
| `groups.update` | `group.metadata_updated` | ☐ |  |
| `group-participants.update` | `group.participant_changed` | ☐ |  |
| `contacts.update` / `contacts.upsert` | （业务侧按需订阅） | ☐ |  |
| `chats.update` / `chats.upsert` / `chats.delete` | （业务侧按需订阅） | ☐ |  |
| `presence.update` | （业务侧按需订阅） | ☐ |  |
| `blocklist.set` / `blocklist.update` | （业务侧按需订阅） | ☐ |  |
| `call` | （业务侧按需订阅） | ☐ |  |
| `message-capping.update` | `account.new_chat_capping` | ☐ | § 3.7.2 |
| `newsletter.update` | （业务侧按需订阅） | ☐ |  |

#### 协议层自己发出的业务事件（Kafka topic `protocol.*.events.v1`，19 个）

| # | 事件 | 域 | 状态 | 备注 |
|---|---|---|---|---|
| E1 | `account.state_changed` | 状态机 | ☐ | 必推，带 evidence |
| E2 | `account.heartbeat` | 状态机 | ☐ | 稳态 30s |
| E3 | `account.online_changed` | 状态机 | ☐ | ONLINE ↔ 非 ONLINE 翻转 |
| E4 | `account.stale_detected` | 状态机 | ☐ | 半开 ws 兜底 |
| E5 | `account.need_reauth` | 状态机 | ☐ | 必推，高优先级 |
| E6 | `account.type_detected` | 类型 | ☐ | 首次 pairing 后 |
| E7 | `account.proxy_failed` | 代理 | ☐ |  |
| E8 | `account.proxy_rotated` | 代理 | ☐ | IP 实际变化时 |
| E9 | `account.rate_limited` | 风控 | ☐ |  |
| E10 | `account.restricted` | 风控 | ☐ | reachoutTimelock |
| E11 | `account.new_chat_capping` | 风控 | ☐ | 拉群配额 |
| E12 | `pairing.code_generated` | 授权 | ☐ |  |
| E13 | `qr.code_generated` | 授权 | ☐ |  |
| E14 | `pairing.completed` | 授权 | ☐ |  |
| E15 | `pairing.failed` | 授权 | ☐ |  |
| E16 | `message.received` | 消息 | ☐ |  |
| E17 | `message.ack` | 消息 | ☐ | 含撤回 |
| E18 | `group.participant_changed` | 群 | ☐ |  |
| E19 | `group.metadata_updated` | 群 | ☐ |  |

### A.13 不需要 Baileys 的接口（Java 业务层做，本清单仅列举供参考）

```text
✗ IP 池管理（ip-pool CRUD、流量统计、计费）
✗ 流量计费查询 / 上限设置
✗ 账号分组 / 标签 / 风险标记
✗ 任务编排（拉群任务、超链任务、动态发布）
✗ 转发统计 / 报表
✗ 后台 / H5 / 子后台 UI 接口
✗ 用户登录 / 权限 / 审计
✗ Registry / Router（accountId → workerId）
✗ 分布式锁 / 限流令牌桶
```

### A.14 实现优先级总览

| 优先级 | 数量 | 内容 | 阶段对应 |
|---|---|---|---|
| **P0**（最小可用闭环） | **36** | 授权导入 6 + 导出 1 + 生命周期 3 + 状态 4 + 风控 3 + 代理 3 + 拉群核心 5 + 事件 11 | Phase 0-1 |
| P1 | 21 | 群管理扩展、消息文本/图片、退群/进群、批量、check-whatsapp | Phase 1-2 |
| P2 | 22 | 媒体类消息、聊天操作、个人资料 | Phase 2+ |
| P3 | 8 | Business catalog、频道 newsletter | Phase 3+ |
| **接口合计** | **86** |  |  |
| **事件合计** | 19 |  |  |

**P0 36 个 = 第一版上线必备**。建议按 § 7 阶段实施顺序在 Phase 0-1 内完成。

## 附录 B：协议层待做清单（Backlog）

> 落地范围之外、但已识别的待办项。按"什么时候做"分组。

### B.1 Phase 1 前补完

| # | 项 | 负责方 | 现状 |
|---|---|---|---|
| 1 | Baileys 真实 protobuf 解码（`importers/six.ts` 的 `deviceIdentityKey`） | 协议层 | **已完成** — 接通 `proto.ADVSignedDeviceIdentity.decode` |
| 2 | 独立 ProxyStore（Redis 主存 + L1 缓存），独立于 CredsStore | 协议层 | **已完成** — `src/store/proxy-store.ts` |
| 3 | `routes/messages.ts /download` 接 Baileys `downloadMediaMessage`，支持 base64/stream 返回 | 协议层 | **已完成** — 业务侧传完整 message 对象，url 返回需要配 S3/OSS |
| 4 | `routes/import.ts /batch` 并发实现（带冷启动批次节流） | 协议层 | **已完成** — 默认 50 个/批 间隔 30s，concurrency 可配 |
| 5 | `routes/export.ts` 完整 keys dump（KeysStore scanAll） | 协议层 | **已完成** — Redis SCAN + MGET，按 type 分组 |

### B.2 Phase 1 期间做

| # | 项 | 负责方 |
|---|---|---|
| 6 | 媒体存储后端接 S3/OSS/R2（`config.media.storageBackend`），`/download returnAs=url` 返回 signed URL | 协议层 |
| 7 | Java 业务层 SDK 生成（OpenAPI → openapi-generator → Java client + Spring Web/WebFlux），统一 DTO | **业务/app 团队** |
| 8 | `routes/contacts.ts` 联系人同步入口（chatModify 完整选项） | 协议层 |
| 9 | KeysStore 周期 snapshot 到对象存储（崩溃恢复用） | 协议层 |
| 10 | PG L3 真实启用 + 跨 region 异步复制配置 | 协议层 + DBA |
| 11 | 完整 e2e 测试套件（1 个真实账号 pairing → online → group create → send → restriction） | 协议层 |

### B.3 Phase 2 前补完

| # | 项 | 负责方 |
|---|---|---|
| 12 | Registry 主备 leader election 改用 etcd（替代 Redis 锁，强一致更可靠） | 协议层 |
| 13 | Redis 拆为 keys cluster / Registry cluster / 限流 cluster 三套独立 | 协议层 + Ops |
| 14 | 冷热分层（HOT/WARM/COLD）+ 长期 OFFLINE 账号归档到对象存储 | 协议层 |
| 15 | 一致性 hash 分片（accountId → 虚拟节点环 → worker），平滑扩缩容 | 协议层 |
| 16 | KeysStore 按 region 分 Redis cluster | 协议层 + Ops |
| 17 | 审计事件迁 ClickHouse | 协议层 + DBA |

### B.4 长期 / Phase 3+

| # | 项 |
|---|---|
| 18 | Plan B 调研：自研 Rust 协议层 / WA Business Cloud API 混合 |
| 19 | 批量 reauth 通道（业务层做）+ 风控波处置 SOP |
| 20 | 多供应商 IP 池切换（按 region/ASN 智能选） |
| 21 | 协议层 SDK 给 PoC/工具用（Python / Go thin client，仅 HTTP 封装） |

### B.5 SDK 说明

| 客户端 | 现状 | 何时做 |
|---|---|---|
| TypeScript types | **已生成** — `openapi/generated/types.ts` + `aliases.ts` | 已可用 |
| Java SDK（业务层主用） | OpenAPI spec 完整，**待业务/app 团队跑 openapi-generator 生成** | Phase 1 之前 |
| Python / Go thin client | 未做 | Phase 3+，工具/PoC 需要时再说 |

**所有 SDK 由 OpenAPI spec 一键生成，protocol-layer 不维护**。spec 更新后跑 `openapi/regenerate-types.sh`，业务侧重生 SDK 即可。


