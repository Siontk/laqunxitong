# 容量规划（CAPACITY）

> 对齐《Baileys 协议层接口封装与 2000 账号承载方案》§ 11 阶段扩展。
> 默认配置（`src/config.ts`）已经按 **4C8G 单节点 × 2000 账号** 调好，
> 真要扩到 50w 级别再调环境变量。

## TL;DR — 4C8G 跑 2000 账号能不能扛？

**能扛**，前提是按下面这套部署：

| 项目 | 推荐 | 不达标后果 |
|------|------|-----------|
| 进程模型 | 4 进程 × 500 账号（PM2） | 1 进程 2000 账号 → event loop 卡死，500ms+ 延迟 |
| `--max-old-space-size` | 1536 (MB) | 默认 4GB → 4 进程 16GB 直接 OOM |
| `ulimit -n` | ≥ 131072 | 默认 1024，2000 socket × 3-4 fd → 半路掉线 |
| `net.ipv4.ip_local_port_range` | 10000-65535 | 默认 ~28k 端口，SOCKS5 连接耗尽 |
| Redis 独立部署 | 必须 | 同机部署 Redis 抢 CPU + GC |
| Kafka 独立部署 | 必须 | 同上 |

参考 [`deploy/pm2.config.cjs`](../deploy/pm2.config.cjs) 一键启动。

## 业务强度对照表（4C8G × 2000 账号）

竞品 benchmark：**1000 账号 × 100 群 × 100 人 / 18 min ≈ 200 group ops/s**。

| 场景 | 单 worker 需求 | 4 worker 合计 | 当前配置上限 | 结论 |
|------|---------------|---------------|------------|------|
| 稳态挂机（15-20s 随机 keepalive + 偶发消息） | 10 ops/s | 40 ops/s | 100×4=400 | ✅ 富裕 |
| 每账号 1msg/min 主动发消息 | 8 msg/s | 33 msg/s | Kafka producer 不是瓶颈 | ✅ |
| 每账号 1msg/s 持续发 | 500 msg/s | 2000 msg/s | libsignal CPU 边缘 | ⚠️ 监控 event loop lag |
| **拉群 竞品级**（500 acc × 100 群 / worker） | 100 ops/s | **400 ops/s** | `workerGroupOpPerSec=100` × 4 = 400 | ✅ 卡上限，刚好 |
| 拉群 2 倍竞品强度 | 200 ops/s | 800 ops/s | ❌ 需要 8 节点 | 加节点 |

预估**完成 200 群 × 100 人的全流程**：
- 单账号串行 200 个 `group.create`，每个含 100 人 ≈ 3-5 秒 RTT + libsignal 加密
- 单账号 ≈ 600-1000 秒 ≈ 10-17 分钟
- 所有 2000 账号并行：受 `workerGroupOpPerSec=100` 限流，**总耗时 ≈ 单账号耗时**（因为 4 worker × 100 ops/s = 400 ops/s 足够覆盖 2000 账号 × 0.2 ops/s）
- **预计 12-18 分钟可完成**，与竞品 1000 账号 × 18 分钟持平或更好（账号翻倍但耗时不变，因为 token 桶留有 burst）

## 系统调优（部署前必须做）

```bash
# /etc/security/limits.d/99-protocol.conf
*  soft  nofile  131072
*  hard  nofile  131072
*  soft  nproc   65536
*  hard  nproc   65536

# /etc/sysctl.d/99-protocol.conf
net.ipv4.ip_local_port_range = 10000 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 60
net.core.somaxconn = 4096
net.core.netdev_max_backlog = 16384
fs.file-max = 1000000
vm.overcommit_memory = 1

# 应用
sudo sysctl -p /etc/sysctl.d/99-protocol.conf
```

启动：

```bash
pm2 start deploy/pm2.config.cjs
pm2 status
pm2 logs --lines 100
```

## 单 worker 容量基线

| 指标 | 阈值 | 含义 |
|---|---|---|
| 账号数 | 500（生产实际跑） | 上限不要超过 600，超就分 worker |
| RSS | < 1.6 GB | 接近 1.8 GB 告警，2.0 GB OOM |
| heap | < 1.5 GB | `--max-old-space-size=1536` |
| event loop lag P95 | < 50 ms | 超 100ms 说明 CPU/GC 紧张 |
| 文件句柄 | `ulimit -n ≥ 131072` | ws + agent + log + Redis + Kafka |
| group_op_inflight | < 50 | 持续 > 100 说明 token 桶限流过严 |

## 集群分阶段扩容

> 百万级分片思路见 [`MILLION-SCALE-SHARDING.md`](MILLION-SCALE-SHARDING.md)。

| 阶段 | concurrent | 节点数 (4C8G) | Redis | Kafka | L3 DB |
|---|---|---|---|---|---|
| Phase 0 | ≤ 2k | 1 | 单实例 | 单 broker / MSK Serverless | 可选 |
| Phase 1 | 1 万 | 5-7 | 3 主 3 从 cluster | 3 broker | 主从 |
| Phase 2 | 10 万 | 50-70 | **分 cluster**：keys / Registry / 限流 | MSK Provisioned，多 topic 分区 | 分库分表 |
| Phase 3 | 50 万 | 250-350 多 region | 每 region 一套 keys cluster | MSK Provisioned + 跨区复制 | MySQL/RDS cluster + 异步复制 |
| Phase 4 | 100 万 | 600-700 多 region IDC | Redis enterprise / KeyDB cluster | 多 Kafka 集群 + MirrorMaker | MySQL 分片 + 对象存储归档 |

## 重连风暴

每账号每 10-15 分钟 IP 轮换一次 → 平均重连 QPS：

| 阶段 | 平均 reconnect/s | 峰值 reconnect/s | 节点桶 | 全局桶 |
|---|---|---|---|---|
| Phase 0（2000） | 2-3 | 50 | 20/s | 100/s |
| Phase 1（1万） | 11-17 | 500 | 20/s | 200/s |
| Phase 2（10万） | 110-170 | 5000 | 10/s | 500/s |
| Phase 3（50万） | 550-830 | 25000 | 5/s | 1000/s（多分片） |
| Phase 4（100万） | 1100-1700 | 50000+ | 5/s | 2000/s（多分片） |

**关键**：sessionId 创建时随机加 0-900s 偏移，让 2000 账号的"10-15 分钟周期"错峰。

## 内存预算（单 worker, 500 账号）

```
基础 Node 进程         150 MB
Baileys + libsignal    ~250 MB
500 账号 creds + keys  ~300 MB（L1 + Redis 双层）
ws / TCP 缓冲          ~150 MB
Rust bridge 原生堆     ~150 MB（不在 V8 heap）
event loop / GC 余量   ~200 MB
─────────────────────────────────
合计                   ~1.2 GB（留 0.3 GB 突发空间）
```

4 worker × 1.5 GB = 6 GB；master + OS + buffer ≈ 1.5 GB；8 GB 节点留 0.5 GB 余量。

## 压测

```bash
# 1. 启协议层（standalone 模式，本地 mock 不接 WhatsApp）
pm2 start deploy/pm2.config.cjs

# 2. 模拟竞品 benchmark
node scripts/loadtest-group-throughput.mjs \
  --accounts 1000 --groups 100 --people 100 \
  --endpoint http://localhost:8081 --concurrency 50

# 3. 看实时 metric
curl http://localhost:8081/metrics | grep -E 'group_op_(duration|inflight)'
curl http://localhost:8081/metrics | grep -E 'event_loop_lag'
```

期望结果（4C8G × PM2 4 worker）：
- 总耗时 ≤ 18 min（持平竞品）
- p95 group.create ≤ 5s
- p99 ≤ 10s
- 错误率 < 1%（不含 WA 限制类）

## 关键开关与默认值

| 开关 | 推荐 | 影响 |
|---|---|---|
| `MAX_ACCOUNTS_PER_WORKER` | 500 | 单进程上限 |
| `WORKER_GROUP_OP_PER_SEC` | 100 | 拉群吞吐天花板（per worker） |
| `WORKER_GROUP_OP_BURST` | 200 | token 桶突发 |
| `COLD_START_BATCH_SIZE` | 25 | 单 worker 每轮上线数 |
| `COLD_START_INTERVAL_MS` | 15000 | 上线轮间隔 |
| `NODE_RECONNECT_PER_SEC` | 20 | 单节点重连预算 |
| `KEYS_L1_SIZE` | 200000 | L1 keys 缓存条数 |
| `CREDS_L1_SIZE` | 50000 | L1 creds 缓存条数 |
| `HEARTBEAT_EVENT_ENABLED` | false | 关掉省 Kafka 流量；监控走 metric |
| `AUDIT_LOG_SAMPLE_RATE` | 0.1 | 业务审计采样 10%，群操作量大时减压 |
| `MAX_OLD_SPACE_MB` | 1536 | V8 heap 上限 |

## 流量估算（动态住宅 IP 按流量计费）

| 账号画像 | 每账号每日 | 100 万账号每月（30 天） |
|---|---|---|
| 纯挂机长在线 | 0.5-2 MB | 15-60 TB |
| 养号 + 轻度发消息 | 2-8 MB | 60-240 TB |
| 拉群业务（无媒体） | 5-20 MB | 150-600 TB |
| 含媒体 | 30-200 MB | 900-6000 TB |

按 $5/GB（中量企业价）：
- Phase 0（2000 / 拉群） ≈ $300 / 月
- Phase 1（1万 / 拉群） ≈ $1.5k / 月
- Phase 2（10万 / 拉群） ≈ $15k / 月
- Phase 3（50万 / 拉群） ≈ $75k / 月
- Phase 4（100万 / 拉群） ≈ $150k / 月

## 准入条件（每阶段进入下一档前必满足）

```
✓ 上一阶段连续 14 天可用性 ≥ 99.5%
✓ 平均掉线率 ≤ 0.5%/天
✓ 重连成功率 ≥ 95%
✓ NEED_REAUTH 比例 ≤ 0.1%/天
✓ IP 供应商可 sustain 下一阶段流量
✓ 成本预算审批通过
✓ event_loop_lag p95 < 50ms（持续 1 周）
✓ group.create p95 < 5s（持续 1 周）
```

## 何时必须加节点（告警阈值）

任一指标稳定超过阈值 5min 就该扩：

| 指标 | 阈值 | 含义 |
|------|------|------|
| `unsea_event_loop_lag_seconds` | > 0.1 | Node 跑不动了 |
| `unsea_group_op_inflight` | > 100（单 worker） | token 桶不够大或业务压顶 |
| `unsea_group_op_duration_seconds` p95 | > 10s | WA 端慢 / libsignal CPU 饱和 |
| `process_resident_memory_bytes` | > 1.8 GB（单 worker） | OOM 边缘 |
| `nodejs_heap_size_used_bytes / total` | > 0.85 | GC 压力大 |
| `unsea_accounts_by_state{state="RECONNECTING"}` | > 100 持续 | 网络/代理问题 |
| `unsea_reconnect_duration_seconds` p95 | > 30s | 重连排队 |

## Plan B 红线（何时不该再用 Baileys）

满足任一条件立即评估替代：

1. concurrent > 30 万持续 30 天，且 NEED_REAUTH > 0.5%/天
2. libsignal JS GC pause > 500ms 频繁
3. Rust bridge native crash 无法定位
4. Baileys 上游 N 周未跟进 WA 协议变更
5. IP 供应商无法 sustain 单 region 10 万+ session

**Phase 3 启动前**必须做 Plan B 调研。
