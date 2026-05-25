# protocol-layer

Unsea WhatsApp 协议层 — 基于 Baileys 7.x 的多账号承载集群。

## 能力概览

- **86 个 OpenAPI 接口**（auth / import / lifecycle / status / restriction / proxy / groups / messages / contacts / profile / business / channels）
- **19 个 NATS 事件**（state_changed / heartbeat / need_reauth / restricted / message.received ...）
- **2000 账号/4C8G** 单机承载（5-6 worker × 300-400 账号）
- **集群部署**：内部 Registry 仲裁 accountId → workerId，支持 Phase 0-4（1k → 100w concurrent）
- **三层 SessionStore**：L1 内存 / L2 Redis / L3 PostgreSQL
- **三类重连**（计划性 IP 轮换 / 意外断开 / 终态错误）+ 节点/全局令牌桶
- **Prometheus + Grafana** 可观测性 + K8s yaml + HPA

## 快速开始

```bash
# 本地 dev（含 Redis + NATS + Prometheus + Grafana）
docker compose -f deploy/docker-compose.yml up -d

# 安装依赖
npm install

# Master 进程（仲裁 + Registry）
npm run start:master

# Worker 进程（实际承载 socket）
npm run start:worker
```

启动后：
- HTTP API: http://localhost:8080
- Swagger UI: http://localhost:8080/docs
- Prometheus 指标: http://localhost:8080/metrics
- Health check: http://localhost:8080/healthz

## 接口契约

接口契约由 [`../openapi/protocol-v1.yaml`](../openapi/protocol-v1.yaml) 单点定义。修改契约后跑：

```bash
bash ../openapi/regenerate-types.sh
```

TypeScript 类型从 `../openapi/generated/types.ts` 引入，已封装到 [src/types/api.ts](src/types/api.ts) 提供短别名。

## 目录结构

```
protocol-layer/
├── src/
│   ├── server.ts                 # 启动入口（master / worker 双角色）
│   ├── config.ts                 # 配置 schema + 加载
│   │
│   ├── registry/                 # 集群 Registry（accountId → workerId）
│   │   ├── registry.ts           # Redis 仲裁接口
│   │   ├── master.ts             # 主进程：账号分配、worker 心跳
│   │   └── failover.ts           # worker 死时账号迁移
│   │
│   ├── worker/                   # 单 worker 内部
│   │   ├── account-manager.ts    # accountId → Sock 映射
│   │   ├── socket-factory.ts     # makeWASocket + agent 注入
│   │   ├── state-machine.ts      # 13 状态机
│   │   ├── stale-detector.ts     # 半开 ws 兜底
│   │   ├── reconnect.ts          # 三类重连
│   │   ├── business-detector.ts  # 账号类型识别
│   │   └── event-bridge.ts       # Baileys → NATS 事件桥接
│   │
│   ├── routes/                   # 12 个 OpenAPI 域路由
│   ├── events/                   # NATS 事件发布
│   ├── rate-limit/               # 节点/全局令牌桶
│   ├── proxy/                    # 代理 agent 工厂
│   ├── store/                    # 三层 SessionStore
│   ├── importers/                # 三类登录转换器
│   ├── observability/            # logger / metrics / health
│   ├── error/                    # 语义错误码翻译
│   └── types/                    # API 类型短别名
│
├── deploy/
│   ├── docker-compose.yml        # 本地 dev 环境
│   ├── Dockerfile
│   └── k8s/                      # K8s 部署 yaml + HPA + Prometheus 规则
│
├── docs/
│   ├── DEPLOYMENT.md             # 部署手册
│   ├── CAPACITY.md               # 阶段扩容容量规划
│   ├── APIFOX-STYLE-API.md       # Apifox 风格接口文档
│   ├── BUSINESS-INTEGRATION.md   # 业务层接入技术说明
│   ├── FUNCTION-API-GUIDE.md     # 功能层 API 对接文档
│   ├── SWAGGER-INTEGRATION.md    # Swagger 联调说明
│   └── PHASE0-SOP.md             # 1k 账号 12h 验收
│
└── package.json
```

## 角色模型

```
                ┌─────────────────┐
                │   Master proc   │   单实例（HA: 主备）
                │   - Registry    │
                │   - 账号分配      │
                │   - 心跳监控      │
                └────────┬────────┘
                         │ Redis pub/sub
        ┌────────────────┼────────────────┐
        │                │                │
   ┌────▼─────┐    ┌────▼─────┐    ┌────▼─────┐
   │ Worker-1 │    │ Worker-2 │    │ Worker-N │   每 worker 300-400 账号
   │ 300-400  │    │ 300-400  │    │ 300-400  │
   └────┬─────┘    └────┬─────┘    └────┬─────┘
        │               │                │
        └─── NATS publisher (events) ────┘
                         │
                ┌────────▼────────┐
                │  Java 业务层     │
                └─────────────────┘
```

## 关键设计

详见上级文档 [`../Baileys协议层接口封装与2000账号承载方案_副本.md`](../Baileys协议层接口封装与2000账号承载方案_副本.md)：
- § 4.3 **授权 vs 重连** — 换 IP 不需要重新授权
- § 4.4 13 状态机 + NEED_REAUTH 触发表
- § 4.5 三类重连分流
- § 4.6 动态住宅 IP 10-15 分钟 sticky
- § 4.7 三层证据 + STALE 兜底
- § 4.8 协议层 / 业务层职责划分

## 测试

```bash
npm run lint       # tsc 类型检查
npm test           # 单元测试
npm run test:e2e   # e2e（需 redis + nats）
```

## 部署

参考 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 和 [docs/CAPACITY.md](docs/CAPACITY.md)。

## 业务层联调

- Apifox 风格接口文档：[docs/APIFOX-STYLE-API.md](docs/APIFOX-STYLE-API.md)
- 技术边界与 owner 路由：[docs/BUSINESS-INTEGRATION.md](docs/BUSINESS-INTEGRATION.md)
- 功能层 API 对接：[docs/FUNCTION-API-GUIDE.md](docs/FUNCTION-API-GUIDE.md)
- Swagger 联调流程：[docs/SWAGGER-INTEGRATION.md](docs/SWAGGER-INTEGRATION.md)
- **业务侧 API 速查（按场景）**：[docs/API-CATALOG.md](docs/API-CATALOG.md) — 登录的几种方式、拉群、消息、风控、事件订阅全部对应接口
