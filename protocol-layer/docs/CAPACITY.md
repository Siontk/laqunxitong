# 容量规划（CAPACITY）

> 对齐《Baileys 协议层接口封装与 2000 账号承载方案》§ 11 阶段扩展。

## 单 worker 容量基线

| 指标 | 阈值 | 含义 |
|---|---|---|
| 账号数 | 300-400 | 单 worker 推荐；上限 500，超过启用新 worker |
| RSS | < 1.2 GB | 接近时告警，> 1.4 GB OOM 边缘 |
| heap | < 1280 MB | `--max-old-space-size=1280` |
| event loop lag P95 | < 200ms | 超过说明 GC / CPU 紧张 |
| 文件句柄 | ulimit -n ≥ 100000 | ws + agent + log |

## 单机部署（4C8G）

```
4 worker × 500 账号 = 2000 账号（当前测试目标）
5 worker × 400 账号 = 2000 账号（更保守，单进程余量更大）
```

4 worker × 500 必须经过真实长稳跑确认 RSS、heap、event loop lag 和重连风暴指标达标；如果单进程 RSS 逼近 1.4GB，回退到 5 worker × 400。

## 集群分阶段扩容

> 百万级分片思路见 [`MILLION-SCALE-SHARDING.md`](MILLION-SCALE-SHARDING.md)。

| 阶段 | concurrent | 节点数 (4C8G) | Redis | Kafka | L3 DB |
|---|---|---|---|---|---|
| Phase 0 | ≤ 1k | 1 | 单实例 | 单 broker / MSK Serverless | 单实例 |
| Phase 1 | 1 万 | 5-7 | 3 主 3 从 cluster | 3 broker | 主从 |
| Phase 2 | 10 万 | 50-70 | **分 cluster**：keys / Registry / 限流 | MSK Provisioned，多 topic 分区 | 分库分表 |
| Phase 3 | 50 万 | 250-350 多 region | 每 region 一套 keys cluster | MSK Provisioned + 跨区复制 | MySQL/RDS cluster + 异步复制 |
| Phase 4 | 100 万 | 600-700 多 region IDC | Redis enterprise / KeyDB cluster | 多 Kafka 集群 + MirrorMaker | MySQL 分片 + 对象存储归档 |

## 重连风暴

每账号每 10-15 分钟 IP 轮换一次 → 平均重连 QPS：

| 阶段 | 平均 reconnect/s | 峰值 reconnect/s | 节点桶 | 全局桶 |
|---|---|---|---|---|
| Phase 1 | 11-17 | 500 | 10/s | 100/s |
| Phase 2 | 110-170 | 5000 | 10/s | 200/s |
| Phase 3 | 550-830 | 25000 | 5/s | 500/s |
| Phase 4 | 1100-1700 | 50000+ | 5/s | 500/s（多分片） |

**关键**：sessionId 创建时随机加 0-900s 偏移，让 2000 账号的"10-15 分钟周期"错峰。

## 内存预算（单 worker, 500 账号）

```
基础 Node 进程         150 MB
Baileys + libsignal    ~250 MB
500 账号 creds + keys  ~250 MB（L1 内存）
ws / TCP 缓冲          ~125 MB
Rust bridge 原生堆     ~150 MB（不在 V8 heap）
event loop / GC 余量   ~150 MB
─────────────────────────────────
合计                   ~1.1 GB（留 0.4 GB 给突发）
```

## 流量估算（动态住宅 IP 按流量计费）

| 账号画像 | 每账号每日 | 100 万账号每月（30 天） |
|---|---|---|
| 纯挂机长在线 | 0.5-2 MB | 15-60 TB |
| 养号 + 轻度发消息 | 2-8 MB | 60-240 TB |
| 拉群业务（无媒体） | 5-20 MB | 150-600 TB |
| 含媒体 | 30-200 MB | 900-6000 TB |

按 $5/GB（中量企业价）：
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
```

## 关键开关与默认值

| 开关 | 推荐 | 影响 |
|---|---|---|
| `syncFullHistory` | false | 关掉，历史同步是最大流量来源 |
| `fireInitQueries` | false | 关掉省流量；如业务依赖 app-state 同步则需开 |
| `markOnlineOnConnect` | false | 减少不必要 presence 协议 |
| `emitOwnEvents` | false | 减少自己发消息的事件回流 |
| `keepAliveIntervalMs` | 30000 | 物理死连检测 35s 内 |

## Plan B 红线（何时不该再用 Baileys）

满足任一条件立即评估替代：

1. concurrent > 30 万持续 30 天，且 NEED_REAUTH > 0.5%/天
2. libsignal JS GC pause > 500ms 频繁
3. Rust bridge native crash 无法定位
4. Baileys 上游 N 周未跟进 WA 协议变更
5. IP 供应商无法 sustain 单 region 10 万+ session

**Phase 3 启动前**必须做 Plan B 调研。
