# Phase 0 验证 SOP — 1k 账号 12 小时长跑

> 目标：在生产架构上跑通 1k 长在线账号 12 小时，**全部 SLO 通过**才能进入 Phase 1。

## 准入条件

- [ ] 协议层全部 P0 接口（36 个）实现 + 单测通过
- [ ] importer 单测通过（params/six/legacy-json）
- [ ] OpenAPI 类型生成无错（`bash openapi/regenerate-types.sh`）
- [ ] 镜像 build 成功 + 本地 docker-compose 拉起
- [ ] Prometheus dashboard 数据正常

## 准备

### 账号

```
- 1000 个真实 WhatsApp 账号（Baileys-json 格式 / params / six 任意混合）
- 至少 100 个 BUSINESS_STANDARD（用于 business 接口验证）
- 至少 50 个 BUSINESS_VERIFIED（验证类型识别）
```

### 代理

```
- 1000 个 proxy session ID（动态住宅 10-15 分钟 sticky）
- 同 country / 同 ASN（避免 geo 跳变干扰）
- 月流量预算 ≥ 5 TB
```

### 集群

```
2 台 4C8G：
  - 节点 1：master(主) + 4 worker = 2000 账号上限
  - 节点 2：master(备) + 4 worker = 2000 账号上限（实际用 1000 + buffer）

依赖：
  - Redis 单实例（< 4GB）
  - NATS JetStream
  - PostgreSQL（启用 L3）
```

## 12 小时长跑步骤

### T+0：账号灌入（30 分钟）

```bash
# 分批导入 + autoOnline=true
# 节奏：50 账号/批，间隔 30s → 1000 账号 ≈ 10 分钟
for i in $(seq 1 20); do
  curl -X POST http://lb/v1/accounts/import/batch \
    -d @batch-$i.json
  sleep 30
done
```

**SLO**：导入成功率 ≥ 99%；`account.state_changed: ONLINE` 事件在 60s 内到达 ≥ 95%。

### T+30min：基线观察（2 小时）

观察以下指标趋势：

| 指标 | 期望 |
|---|---|
| `sum(unsea_accounts_by_state{state="ONLINE"})` | 稳定在 1000 (±5) |
| `sum(rate(unsea_reconnect_total{type="A"}[5m]))` | 1-2 /s（IP 轮换计划性重连）|
| `sum(rate(unsea_reconnect_total{type="B"}[5m]))` | < 0.05 /s |
| `sum(rate(unsea_stale_detected_total[5m]))` | < 0.01 /s |
| `sum(rate(unsea_disconnect_total{semantic="NEED_REAUTH"}[5m]))` | < 0.001 /s |
| 单 worker RSS | < 1.2 GB |
| event_loop_lag P95 | < 200ms |
| heap used | 单 worker < 1 GB |
| 事件发布失败率 | < 0.01% |

### T+2.5h：业务能力验证（持续）

**拉群（每 10 分钟一批）**：
```
- 随机选 50 账号 × 1 群 × 5 成员 = 250 次 groupCreate + 250 次 groupParticipantsUpdate
- 期望成功率：groupCreate ≥ 98%；add ≥ 85%（部分 403 隐私）
```

**消息（每 5 分钟一批）**：
```
- 随机选 200 账号发文本（无媒体，省流量验证基线）
- 期望：所有发送 ack < 3s 内回，无 463 / 479 错误
```

**风控查询**：
```
- 每小时 1 次：随机 100 账号查 /usability
- 期望：返回 < 1s，canCreateGroup=true 比例 ≥ 95%
```

### T+6h：模拟故障

#### 故障 1：单 worker kill

```bash
kubectl delete pod protocol-worker-2
```

期望：
- master 在 60s 内检测到 worker dead
- failover 把 200 账号迁到其他 worker
- 受影响账号在 5 分钟内重新 ONLINE
- **无 NEED_REAUTH** 触发（换 worker 不重新授权）

#### 故障 2：Redis 主切

```bash
docker stop redis-master
```

期望：
- 短暂事件发布失败（< 10s）
- Redis 副本切主后恢复
- 重连风暴受令牌桶约束（< 50 /s）

#### 故障 3：模拟 IP 集中失效

```bash
# 把 200 个 sessionId 标为 PROXY_FAILED
for sid in $(cat failed-sessions.txt); do
  curl -X POST http://lb/v1/accounts/$sid/proxy/rebind -d @new-proxy.json
done
```

期望：
- 受影响账号重新绑定 + 上线
- 整体 ONLINE 数掉到 800 后 5 分钟内恢复 1000
- 无大量 NEED_REAUTH

### T+12h：终态验收

| SLO | 标准 | 实测 |
|---|---|---|
| 可用性 | ≥ 99.5% | __ |
| 平均 ONLINE 数 | ≥ 990 / 1000 | __ |
| 每日掉线率 | ≤ 0.5% | __ |
| 重连成功率 | ≥ 95% | __ |
| NEED_REAUTH 比例 | ≤ 0.1% | __ |
| Event publish 失败率 | < 0.01% | __ |
| Worker RSS 峰值 | < 1.4 GB | __ |
| Event loop lag P95 | < 200ms | __ |
| 群操作成功率 | ≥ 95% | __ |
| 消息 ack P95 | < 3s | __ |

## 不通过 → 进入根因分析

| 现象 | 排查方向 |
|---|---|
| ONLINE 数下滑 | 看 `disconnect_total` semantic 分布，定位是哪类错误 |
| RSS 不断上涨 | heap snapshot + libsignal session 数量；可能内存泄漏 |
| event_loop_lag 高 | CPU profile；通常是 libsignal 同步加密、JSON.parse 大对象 |
| NEED_REAUTH 异常 | 看 raw 字段，是否真的是 401/403；很可能是 importer 转出来的 creds 不完整 |
| STALE 高 | keepAlive 是否被 GC 卡住 / 代理是否中间死了 ws |

## 准入下一阶段

12 小时全部 SLO 通过 + 故障演练全部恢复 → 通知 Java 业务团队接入，准备进入 **Phase 1（1 万账号）**。
