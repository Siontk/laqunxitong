# 百万级分片设计稿

> 目标：把 `accountId -> owner -> status` 做成稳定、可查询、可批量化的读模型。  
> 原则：**分片绑定账号，不绑定 worker；worker 只是承载层。**

## 1. 设计目标

1. 功能层能快速知道某个账号在哪个分片、属于哪个 owner worker、当前状态是什么。
2. 协议层继续做唯一权威：账号归属、上线/下线、状态机、failover。
3. 不让功能层扫 worker，不让协议层暴露内部运行态结构。
4. 账号规模提升到 100 万时，读写路径仍保持 O(1) 或按 shard O(1)。

## 2. 核心模型

### 2.1 三层概念

- `accountId`：业务唯一主键。
- `shardId`：稳定逻辑分片，按 `accountId` 计算。
- `ownerWorkerId`：当前真正持有 socket 的 worker。

### 2.2 关系

```text
accountId -> shardId -> route/status projection -> ownerWorkerId -> ownerEndpoint
```

说明：

- `shardId` 是**逻辑分片**，只用于路由、存储、批量查询。
- `ownerWorkerId` 是**运行归属**，只由协议层决定。
- 一个 shard 可以同时包含很多 worker 上的账号。
- worker 挂掉时，改的是账号归属，不是 shard 规则。

## 3. 分片规则

推荐固定为 4096 或 8192 个逻辑分片：

```ts
shardId = fnv1a(accountId) % SHARD_COUNT
```

要求：

- 稳定
- 计算便宜
- 便于批量分组
- 不跟 worker 数绑定

为什么不用 `worker 数` 当分片数：

- worker 会扩缩容，分片不能跟着漂。
- 50w 账号下，迁移 worker 不应重写整套索引。
- 功能层需要的是“稳定查找”，不是“当前有几个 worker”。

## 4. 两张投影表

协议层对外维护两张读模型：

### 4.1 路由投影

用于回答“账号现在归哪个 worker”：

```json
{
  "accountId": "acc_001",
  "shardId": 1234,
  "ownerWorkerId": "worker-a",
  "ownerEndpoint": "http://10.0.1.11:8080",
  "assigned": true,
  "version": 18,
  "updatedAt": "2026-05-25T12:00:00Z"
}
```

### 4.2 状态投影

用于回答“账号当前可不可以做事”：

```json
{
  "accountId": "acc_001",
  "shardId": 1234,
  "state": "ONLINE",
  "slotReleased": false,
  "blockedReason": null,
  "ownerWorkerId": "worker-a",
  "version": 87,
  "updatedAt": "2026-05-25T12:00:00Z"
}
```

建议再带：

- `evidence`
- `canSendText`
- `canCreateGroup`
- `canAddToGroup`
- `currentProxy`
- `deviceProfile`

## 5. 读写路径

### 5.1 写入路径

当发生这些动作时，协议层更新投影：

- `pairing completed`
- `import online`
- `account online`
- `account offline`
- `account logout`
- `account need_reauth`
- `failover reassign`
- `admin unassign`

写入顺序建议：

1. 先改内部权威状态。
2. 再写 route projection。
3. 再写 status projection。
4. 再发 `account.owner_*` / `account.state_changed` 事件。

### 5.2 读取路径

功能层读取顺序：

1. 本地 cache
2. 分片投影
3. `/v1/accounts/resolve/{accountId}`
4. `/v1/accounts/{accountId}/status`
5. `NOT_OWNER` 兜底纠偏

## 6. 推荐接口

### 6.1 单查

```http
GET /v1/accounts/resolve/{accountId}
GET /v1/accounts/{accountId}/status
```

### 6.2 批查

```http
POST /v1/accounts/resolve
POST /v1/accounts/status/batch
POST /v1/accounts/projection/batch
```

批查返回建议按 `shardId` 分组，避免功能层重复拆分：

```json
{
  "results": [
    {
      "accountId": "acc_001",
      "shardId": 1234,
      "ownerWorkerId": "worker-a",
      "ownerEndpoint": "http://10.0.1.11:8080",
      "state": "ONLINE",
      "version": 87
    }
  ]
}
```

## 7. 如果要落 Redis

如果功能层希望高频读取，建议协议层写一份**只读投影 Redis**，不是直接暴露内部 Registry。

推荐 key 形态：

```text
unsea:route:shard:{shardId}
unsea:status:shard:{shardId}
```

每个 shard 一张 hash：

- field = `accountId`
- value = route/status JSON

这样：

- 100 万账号分散到 4096/8192 个 hash
- 功能层按 `accountId -> shardId` 精准定位
- 批量任务可先按 `shardId` 分组，再按 `ownerEndpoint` 分组

不建议：

- 直接把内部 Registry key 给功能层读
- 用单一大 hash 扛全量账号
- 用 worker 维度做分片

## 8. 对当前实现的调整建议

### 8.1 先修掉全表扫

当前 `listAccountsOnWorker()` / `listAssignmentsOnWorker()` 还是扫 `registry:assign`，百万级下会成为热点。

应该改成反向索引：

```text
worker_accounts:{workerId} -> SET(accountId)
```

这样 failover 和 reconciler 都能 O(本 worker 账号数) 处理。

### 8.2 增加 shard 工具函数

协议层和功能层都用同一份 hash 函数：

```ts
shardId = fnv1a(accountId) % SHARD_COUNT
```

### 8.3 owner 事件继续保留

`account.owner_assigned`
`account.owner_changed`
`account.owner_unassigned`

这些事件仍然是功能层同步 cache 的主路径，Redis 只做兜底和批查。

## 9. 功能层应该怎么用

1. 功能层先算 `shardId`。
2. 按 `shardId` 去查 route/status 投影。
3. 拿到 `ownerEndpoint` 后只打 owner worker。
4. 收到 `NOT_OWNER` 时刷新一次缓存。
5. 订阅 owner 事件做增量更新。

这样功能层不需要知道：

- 当前有几个 worker
- worker 如何 failover
- worker 怎么换槽位

它只需要知道：

- 账号在哪个 shard
- 账号归哪个 owner
- 账号现在能不能做业务

## 10. 一句话结论

百万级的关键不是“多切几个 worker”，而是：

**把账号归属做成稳定逻辑分片，把状态做成可查询投影，把 worker 只保留为可变承载层。**

