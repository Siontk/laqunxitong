# 存储设计 & 风险分析

> 配套阅读：[CAPACITY.md](CAPACITY.md)、[MILLION-SCALE-SHARDING.md](MILLION-SCALE-SHARDING.md)
> 本文回答："2000 账号同时上线、跑各类业务"时存储层压力多大、哪里会先崩。

## 一、数据库分层

```
       ┌──────────────────────────────────────────┐
 写    │  L1 进程内存（MemoryStoreAdapter / LRU）  │  纳秒级，宕机即失
       │     creds 50k 条 / keys 200k 条           │
       └─────────────────┬────────────────────────┘
                         │ miss
       ┌─────────────────▼────────────────────────┐
 写    │  L2 Redis（4 个独立实例）                  │  毫秒级
       │   - registry  (Cluster hash tag {registry})│
       │   - keys      (creds + signal keys 主存)  │
       │   - rateLimit (令牌桶)                     │
       │   - runtime   (账号状态 + proxy + device)  │
       └─────────────────┬────────────────────────┘
                         │ miss / 异步快照
       ┌─────────────────▼────────────────────────┐
 异步  │  L3 MySQL (只 creds, 可选)                 │  10ms-100ms
       │   - 每 worker pool: 8 conn (default)      │
       │   - 长期持久 + 跨 region 备份               │
       └──────────────────────────────────────────┘
```

### 各层职责

| 层 | 存什么 | 读延迟 | 写延迟 | 失效后果 |
|---|---|---|---|---|
| L1 | creds + 热 keys | < 1μs | < 1μs | 进程下次重启回热 |
| L2 keys | creds + signal keys 主存 | 0.5-2ms | 0.5-2ms | **每条消息加解密**走这里。挂了 = 业务全停 |
| L2 registry | accountId → workerId 路由 | 0.5-2ms | 0.5-2ms | 路由迷失，新请求拿不到 owner |
| L2 rateLimit | 令牌桶 | 0.5-2ms | 0.5-2ms | 限流失效，业务侧可能击穿 |
| L2 runtime | 账号状态快照 + 代理绑定 | 0.5-2ms | 0.5-2ms | 重启后 reconciler 拉不起来 |
| L3 MySQL | creds 长期备份 | 5-50ms | 5-50ms | 异步写，挂了不阻塞业务，但灾难恢复时丢 |

**Signal keys 故意不进 L3** — 写放大太大（每条消息 ratchet 都触发写），关系库扛不住。L2 + 周期对象存储 snapshot 是正解。

## 二、"2000 同时上线"的存储热点剖析

时间点 T=0，业务侧调 `POST /v1/accounts/online/batch` 一次提交 2000 个 accountId。

### 每账号上线触发的 IO

```
[Step 1] OnlineGate.waitOnline(accountId)            → rateLimit Redis 3 次 EVAL（账号/节点/全局桶）
[Step 2] proxyStore.get(accountId)                    → runtime Redis 1 次 GET
[Step 3] credsStore.load(accountId)                  → keys Redis 1 次 GET（L1 miss 时）
         （openSocket 内复用，已修：不再重复 load）
[Step 4] Baileys 内部 keys.get('pre-key', [...])     → keys Redis 1-3 次 MGET（每次 ~ 20 ids）
[Step 5] Noise 握手完成 → creds.update                → keys Redis 1 次 SET (creds)
                                                       + MySQL 1 次异步 INSERT/UPDATE
[Step 6] Baileys upload pre-keys                     → keys Redis 1 次 MSET（10-50 个 keys）
[Step 7] 状态机 VERIFYING → ONLINE                    → runtime Redis 1 次 SET
                                                       + Kafka 1 次 publish
```

### 集中爆发负载（2000 账号在 ~ 40s 内通过 gate 全部启动）

| Redis 实例 | 操作 | 单账号次数 | 2000 账号合计 | 集中在 40-60s 内 | 峰值 ops/s |
|------------|------|----------|--------------|----------------|----------|
| rateLimit | EVAL（token bucket） | 3 | 6,000 | yes | **150** |
| runtime | GET (proxy) + SET (state) | 2-3 | 4,000-6,000 | yes | **100-150** |
| keys | GET (creds) | 1 | 2,000 | yes | **50** |
| keys | MGET (pre-keys) | 2-3 | 4,000-6,000 | yes | **100-150** |
| keys | SET (creds) | 1 | 2,000 | 分布 60-90s | **30** |
| keys | MSET (new keys) | 1 | 2,000 (×20 fields) | 分布 60-90s | **30** |

**合计峰值 ~ 500 ops/s（每个 Redis 实例独立切分）。**

### Redis 单实例理论上限

| 单 Redis 实例（4C8G） | 数值 |
|---|---|
| GET/SET ops/s | 80,000-120,000 |
| MGET/MSET (10-20 fields) ops/s | 30,000-50,000 |
| EVAL（轻量 Lua） | 30,000-60,000 |

**结论：4 个独立 Redis 各承担 50-150 峰值 ops/s，离上限 100-1000 倍距离。Redis 不是瓶颈。**

### MySQL（L3 异步写）

```
2000 账号 × creds.update INSERT/UPDATE = 2000 个 INSERT 集中在 60-90s
4 worker × 8 connection = 32 并发 connection
每 connection ~ 60 个 INSERT，每个 ~ 5ms → 单 connection ~ 300ms 处理完
所有 connection 并行 → 总耗时 < 1s
```

**MySQL 不是瓶颈**。开启 binlog + 行级复制后写延迟 ~ 5-15ms，pool=8 仍够。

**但要注意**：如果你的 MySQL 在远端（跨 region），`connectTimeout=5s` 偏短，配 30s 更稳。

### 真正的瓶颈：Node 单进程 libsignal CPU

```
Noise 握手 = X3DH + Double Ratchet init = ~ 20-50ms CPU（Rust binding）
单 worker 500 账号上线 = 500 × 30ms = 15s 纯 CPU 在单核串行（Node 单线程）
4 worker × 15s 并行 → 仍是 15s 端到端 CPU 时间
```

**这就是为什么必须有 `OnlineGate`**：
- `nodeOnlinePerSec=50` → 2000 账号 40s 通过 gate
- 期间 libsignal 平均 25/s 跨 4 worker = 6.25/s/worker = 1 个握手 / 160ms
- event loop lag 保持在 < 50ms，业务不卡

**没有 OnlineGate 时**：业务方一波打 2000 并发 → Node event loop 卡死 5-30s，期间所有现有账号心跳失败，连锁触发 STALE → 雪崩。

## 三、2000 同时上线的端到端 SLA 预估

| 阶段 | 耗时 |
|------|------|
| HTTP 路由 + parse | < 50ms |
| Registry lookupBatch (2000) | ~ 5ms（hmget 单次） |
| 按 owner 分桶 | < 10ms |
| OnlineGate 排队（50/s） | 40s |
| 单账号 Noise 握手 + WA 接受 | 500ms-2s |
| credsStore.save + runtimeStore.mark | < 10ms |
| Kafka publish state_changed | < 20ms |
| **端到端**（从 batch 调用到全部 ONLINE）| **~ 60-90s** |

**对比竞品 2 分钟 baseline → 我们快 30-50%**。

## 四、还有哪些隐患

按严重度排：

### 🔴 P0 隐患（必须监控）

| # | 隐患 | 触发条件 | 后果 | 缓解 |
|---|------|---------|------|-----|
| 1 | Redis 单点 | keys Redis 实例挂 | 全部账号无法读 signal keys，发不出消息 | Redis Sentinel/Cluster 主从切换；2 节点起步 |
| 2 | Kafka 单 broker | broker 重启 | publish 进 DLQ 累积，业务侧拿不到事件 | MSK 3 broker 起步，配 `acks=all` + idempotent |
| 3 | 代理供应商限速 | 单 IP 2000 握手触发 anti-abuse | WA 返 403/408 大批 | sessionId 错峰 + 多 sticky session |
| 4 | WhatsApp 服务端限速 | 短时大量 group.create | 单号被 reachoutTimelock | 业务侧分摊节奏，看 `/usability` 判可派性 |
| 5 | libsignal Rust 崩溃 | 极少数 corrupted creds | worker 进程退出 | PM2 autorestart + reconciler 接管 |

### 🟡 P1 隐患（条件性触发）

| # | 隐患 | 触发条件 | 后果 | 缓解 |
|---|------|---------|------|-----|
| 6 | L3 MySQL pool 耗尽 | 全节点同时大量 saveCreds | promise 队列积压 → heap 增长 | 当前默认 8 conn × 4 worker = 32，够；超大批用 batch route 节奏化 |
| 7 | Kafka producer queue 内存膨胀 | publisher 内部 buffer 累积 | heap 飙升 → GC pause | LZ4 压缩已开；监控 `producer.queue_size` |
| 8 | L2 Redis EVAL CPU 集中 | 大量 token 桶 + Lua 脚本 | Redis CPU 卡 60-70% | rateLimit 独立 Redis 实例（已分） |
| 9 | reconnect 风暴 | 一波代理失败 → 2000 同时重连 | 重新打满 OnlineGate-like 路径 | 已有 reconnect-limiter 三层桶 |
| 10 | 业务侧不消费 Kafka | message.received topic 积压 | broker 磁盘满 | 配 retention + lag 告警 |

### 🟢 P2 隐患（远期）

| # | 隐患 | 触发条件 | 缓解 |
|---|------|---------|-----|
| 11 | accountId hash 不均 | 某 worker 持续偏多账号 | Phase 1+ 走 consistent hashing |
| 12 | Pre-key 耗尽 | 高消息量账号 ratchet 用完 | Baileys 自动 upload 新批，监控 `pre_key_count` |
| 13 | L1 内存碎片 | 长时间运行 LRU 淘汰开销 | 每 24h 滚动重启 worker，无感切换 |
| 14 | 时钟漂移 | NTP 失同步 | chrony + 监控 `time_offset` |

## 五、关键 metric 报警阈值

```promql
# 上线节奏正常
unsea_online_inflight                     < 50   持续 30s
rate(unsea_online_total{result="ok"}[1m]) > 0    （batch 模式期间）

# 节流正常工作
rate(unsea_online_total{result="rejected"}[1m]) / rate(unsea_online_total[1m]) < 0.5

# 数据层延迟
histogram_quantile(0.95, rate(unsea_creds_store_ops_total[5m])) < 0.005
unsea_l1_hit_ratio{store="keys"} > 0.7

# Redis CPU
redis_cpu_user_seconds_total rate < 0.7   （单 instance < 70% 单核）

# MySQL
mysql_global_status_threads_running < 50
mysql_innodb_log_lsn_lag < 1000000
```

## 六、批量上线接口使用示例

```bash
# 主动下线后批量重新上线 2000 个
curl -X POST http://node-a:8081/v1/accounts/online/batch \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: xxx' \
  -d '{
    "items": [
      { "accountId": "acc_001" },
      { "accountId": "acc_002" },
      ...
      { "accountId": "acc_500" }
    ],
    "maxWaitMs": 90000
  }'

# 响应
{
  "requestedAt": "2026-05-28T10:00:00.000Z",
  "elapsedMs": 62315,
  "summary": {
    "requested": 500,
    "local": 480,
    "remote": 20,
    "accepted": 478,
    "timeout": 2,
    "proxyRequired": 0,
    "error": 0
  },
  "results": [...],
  "remote": [
    {
      "accountId": "acc_remote_1",
      "ownerWorkerId": "node-b-w2",
      "ownerEndpoint": "http://10.0.1.13:8082",
      "note": "redispatch to ownerEndpoint"
    }
  ]
}
```

**业务侧**：把 `remote` 部分按 `ownerEndpoint` 分组后再次调 batch 接口，递归直到全部 local。

## 七、为什么不直接接 L3 PostgreSQL/MongoDB

- **PostgreSQL**：写入性能比 MySQL 略低，但有 JSONB 索引优势。当前 MySQL 8.0 的 JSON 索引已经够用。
- **MongoDB**：BSON 存 creds 直接，但跨 region 多写复杂度高，且文档型一致性不够强。
- **Redis 持久化**：开 AOF + RDB 配合 Redis Cluster 副本，已经是事实上的 L3，故 MySQL 只是冷备。

如果未来上 100w 级 + 跨 region：
- L3 改 TiDB / CockroachDB（强一致 + 自动分片）
- 或者 Cassandra（最终一致 + 横向扩展）
- 当前 4C8G × 2000 用 MySQL 足够，**不要过早优化**。
