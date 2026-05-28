# 业务层接入技术说明

> 联调步骤和 Kafka/HTTP 示例见 [`FUNCTION-INTEGRATION-PLAYBOOK.md`](FUNCTION-INTEGRATION-PLAYBOOK.md)。

## 目标

协议层只负责 WhatsApp 协议连接、账号状态、重连、分片 owner、轻量事件上报。业务层负责对象存储、任务编排、批量调度、业务重试、消息记录和风控策略。

单机 `2000` 容量按 **active online slot** 计算，不按历史导入账号数计算。

## 分层边界

业务层负责：

- 对象存储、CDN、签名 URL、媒体上传、压缩转码。
- 任务队列、批量群发、拉群任务编排、业务幂等。
- 消息发送记录、任务状态聚合、失败补偿。
- 账号分组、客户标签、业务规则。
- ownerEndpoint 缓存和直连 owner worker。

协议层负责：

- Baileys socket 生命周期。
- 账号导入、online、offline、logout。
- 消息、群、profile、business、channel 等协议动作。
- 状态机、NEED_REAUTH、STALE、重连。
- Registry owner 仲裁，保证同一 accountId 只由一个 worker 拉 socket。
- Kafka 事件上报和 Prometheus 指标。

## Owner 路由模型

协议层不做 worker 间请求代理。账号绑定、导入、online 时由协议层决定 owner，并通过响应和事件把 owner 信息给到功能层。

功能层维护 `accountId -> ownerEndpoint` 缓存，数据来源按优先级：

1. 登录 / 导入 / online 响应里的 `routing.ownerEndpoint`。
2. Kafka owner topic 事件：`account.owner_assigned`、`account.owner_changed`、`account.owner_unassigned`。
3. 纠偏接口：

```text
GET /v1/accounts/resolve/{accountId}
POST /v1/accounts/resolve
```

返回字段：

- `ownerWorkerId`: 当前账号归属 worker。
- `ownerEndpoint`: 业务层可直连地址，由 worker 的 `PUBLIC_ENDPOINT` 注册。
- `local`: 当前响应 worker 是否就是 owner。
- `assigned`: 账号是否已分配 owner。

普通协议请求如果返回 `409 NOT_OWNER`，业务层使用错误详情里的 `ownerEndpoint` 更新缓存并重试一次。不要每次业务操作都 resolve；resolve 只用于初始化、cache miss 和纠偏。

`account.owner_assigned.data.reason` 当前可能值：

- `pairing_code`: Pairing Code 首次授权分配。
- `qr`: 二维码首次授权分配。
- `import`: 导入账号时分配。
- `online`: 单账号 `/online` 触发分配。
- `batch_online`: 批量 `/online/batch` 触发分配。

## 导入与上线

单账号导入：

1. 业务层调用导入接口，带 `proxy`。
2. 协议层保存 creds/keys/proxy。
3. 协议层执行 `Registry.assign(accountId)`。
4. 如果当前 worker 是 owner 且 `autoOnline=true`，直接拉 socket。
5. 如果当前 worker 不是 owner，返回 `409 NOT_OWNER`，业务层改请求 `ownerEndpoint`。

导入请求可带 `deviceProfile`：

```json
{
  "platform": "macos",
  "manufacturer": "Apple",
  "model": "MacBook Pro",
  "osVersion": "14.4.1",
  "whatsappVersion": "2.24.10.79"
}
```

功能层如果要控制 WhatsApp 已关联设备里的展示名，请额外传 `browserDisplay`：

```json
{
  "browserName": "Opera",
  "platform": "ios",
  "version": "17.5"
}
```

`deviceProfile` 只做账号画像，`browserDisplay` 只做已关联设备展示。后者会映射到 Baileys browser tuple，显示成 `Opera (iOS)` 这类样式。

批量导入：

- 当前 worker 是 owner：返回 `IMPORTED_ONLINE` 或 `IMPORTED_OFFLINE`。
- 当前 worker 不是 owner：返回 `ASSIGNED_REMOTE`，`data.routing.ownerEndpoint` 里有目标地址。
- 业务层可按 `ownerEndpoint` 分组后补调 `/v1/accounts/{accountId}/online`。

### 批量上线

大批量账号恢复、主动下线后重新拉起、测试环境 2000 账号上线，不要并发打单账号 `/online`，统一调用：

```text
POST /v1/accounts/online/batch
```

请求示例：

```json
{
  "items": [
    { "accountId": "acc_001" },
    { "accountId": "acc_002" }
  ],
  "maxWaitMs": 60000
}
```

协议层处理语义：

- 单次最多 `BATCH_ONLINE_MAX_SIZE`，默认 500。
- 协议层先批量查 owner；当前 worker owner 的账号进入 OnlineGate 排队上线。
- 已归属其他 worker 的账号不会由当前 worker 转发，响应放到 `remote[]`。
- 未分配 owner 的账号会由协议层 assign；如果 assign 到其他 worker，也放到 `remote[]`。
- `results[].result=accepted` 只表示已发起上线，最终是否 ONLINE 以 `account.state_changed` 为准。

业务层处理 `remote[]`：

1. 按 `remote[].ownerEndpoint` 分组。
2. 对每个非空 endpoint 调 `POST {ownerEndpoint}/v1/accounts/online/batch`。
3. 如果 `ownerEndpoint=null`，先调 `GET /v1/accounts/resolve/{accountId}` 纠偏；仍为空则延迟重试。
4. 递归处理新的 `remote[]`，直到全部变成 owner 本地结果。

单账号 `/online` 命中 OnlineGate 会返回 `429 ONLINE_LIMITED`，`details.reason` 可能是 `account_online_cooldown`、`node_online_limited`、`global_online_limited`。批量场景应改用 `/online/batch`，不要在业务层用高并发重试冲击协议层。

### 批量下线

功能层需要暂停一批账号、维护窗口释放在线容量时，调用：

```text
POST /v1/accounts/offline/batch
```

批量下线只断开 socket 并释放 worker runtime slot，不做 logout，不删除 creds/keys/proxy，不解除 Registry owner 绑定。后续再次 online/batch online 不需要重新授权。

请求示例：

```json
{
  "accountIds": ["acc_001", "acc_002"],
  "reason": "task_pause",
  "maxWaitMs": 30000
}
```

业务层处理：

1. `offline` 和 `already_offline` 都展示为离线。
2. `remote[]` 按 `ownerEndpoint` 分组后调用 `POST {ownerEndpoint}/v1/accounts/offline/batch`。
3. `not_found` 表示 Registry 没有 owner，可按业务展示未知或离线。
4. 需要恢复时调用 `/v1/accounts/online/batch`。

## 在线容量口径

占 active slot 的状态：

- `PAIRING`
- `VERIFYING`
- `ONLINE`
- `STALE`
- `RECONNECTING`
- `PROXY_FAILED`
- `RATE_LIMITED`

释放 worker runtime active slot 的状态：

- 手动 `OFFLINE`
- `NEED_REAUTH`
- `LOGGED_OUT`
- 重连退避耗尽后的持续异常

worker 心跳上报 `activeSize()`，Registry 分配容量按 `registry:load` 判断。异常账号进入 `slotReleased=true` 后不再占 worker 内存运行槽；如果业务侧确认彻底放弃账号，应调用 `/v1/admin/unassign` 让 Registry load 立即下降，否则等每小时硬同步纠正。

### Registry load 一致性

容量计数 (`registry:load` hash) 用三条规则维持：

- `Registry.assign` / `reassign`：分配成功后 `HINCRBY +1`（用 MULTI + 分布式锁防并发超容量）
- `releaseRuntimeSlot`：账号 offline / NEED_REAUTH / 重连耗尽时只释放 worker 内存运行槽，标记 `slotReleased=true`，**不再直接 `HINCRBY -1`**
- `Registry.unassign`：业务侧或运维确认彻底放弃账号时，解除 owner 绑定并释放 Registry load
- worker 心跳：默认"温和覆盖" `max(本地 activeSize, Redis 现值)`，让 load 只增不减；每小时一次 `force=true` 做硬同步纠正长期累计漂移

`slotReleased=true` 只表示账号不再占 worker 内存运行槽，不等价于 Registry load 已经减少。业务层不要直接改 Registry load；如果观察到 `currentLoad` 与真实 activeSize 长期不一致，可以等下一次硬同步（1 小时内）或由运维调用 `/v1/admin/sync-load`。

## 换 IP 与异常

换 IP 是计划内重连：

```text
proxy/rebind -> close socket -> RECONNECTING/VERIFYING -> ONLINE
```

换 IP 期间仍占 active slot，避免在线号换 IP 时被新账号抢占位置。

异常处理：

- 短期网络异常、STALE、临时代理失败：先占位重连。
- 进入重连 cooldown 或重连耗尽：释放 active slot，记录 `slotReleased=true`。
- `NEED_REAUTH`：立即释放 worker runtime slot，业务层决定下一步：
  - 会继续使用这个账号：重新 pairing/QR，成功后再 online，保留原 owner 绑定。
  - 彻底放弃这个账号：主动调用 `POST /v1/admin/unassign { "accountId": "...", "releaseSlot": true }`，释放 Registry load；否则要等每小时硬同步纠正 load。

## 状态查询

```text
GET /v1/accounts/{accountId}/status
GET /v1/accounts/{accountId}/alive
```

释放 slot 后，账号不在 worker 内存运行态里，但 runtime 状态仍保存在 Redis。业务层可看到：

- `state`
- `evidence.slotReleased`
- `evidence.reason`
- `evidence.updatedAt`

## 业务层推荐调用流程

发送消息：

1. 从缓存取 `ownerEndpoint`。
2. 没缓存则调 `/v1/accounts/resolve/{accountId}`，或等待 owner 事件补齐缓存。
3. 请求 `{ownerEndpoint}/v1/messages/text`。
4. 如果返回 `409 NOT_OWNER`，刷新 owner 后重试一次。
5. 如果返回 `ACCOUNT_NOT_FOUND / NEED_REAUTH / slotReleased=true`，进入业务补偿。

导入账号：

1. 调导入接口。
2. 如果成功在线，等待 `account.state_changed ONLINE`。
3. 如果 `ASSIGNED_REMOTE` 或 `NOT_OWNER`，按 ownerEndpoint 调 online。
4. 如果 `NEED_REAUTH`，走 pairing/QR。

批量任务：

1. 优先使用功能层 owner cache。
2. 对 cache miss 的账号批量 resolve。
3. 按 ownerEndpoint 分组。
4. 每个 ownerEndpoint 控制并发，避免单 worker 被业务侧瞬时打满。
5. 对 `NOT_OWNER` 做一次刷新重试。

批量上线任务：

1. 按 `BATCH_ONLINE_MAX_SIZE` 切批，默认每批 500。
2. 第一批可以打任意协议入口；协议层返回当前 worker 本地处理结果和 `remote[]`。
3. 功能层按 `remote[].ownerEndpoint` 二次分发，不需要自己计算账号在哪个 worker。
4. `accepted` 后等待 `account.state_changed ONLINE`；`timeout` 按 `retryAfterMs` 或业务退避重试；`proxy_required` 先补代理。

## 部署要求

每个 worker 必须配置业务层可访问的 `PUBLIC_ENDPOINT`：

```bash
PUBLIC_ENDPOINT=http://10.0.1.12:8080
WORKER_ROLE=worker
WORKER_ID=worker-001
MAX_ACCOUNTS_PER_WORKER=500
```

不要把 `PUBLIC_ENDPOINT` 配成 `0.0.0.0`。`0.0.0.0` 只能用于 listen，不能用于业务层直连。
