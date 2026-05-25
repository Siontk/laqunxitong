# OpenAPI Spec & 类型生成

## 文件

```
openapi/
├── protocol-v1.yaml          # 主 spec（手写、唯一真实源）
├── regenerate-types.sh       # 重新生成 TS 类型脚本
├── generated/
│   ├── types.ts              # 自动生成，禁止手改
│   └── aliases.ts            # 类型快捷别名 + 工具函数（手写）
└── README.md                 # 本文件
```

## 数字概览

- **85 paths / 86 operations**
- **63 schemas**
- **19 webhook events**

## 使用方式

### Node 协议层 / TypeScript 业务侧

```ts
import type {
  AccountStatus, ImportResult, BusinessDetection,
  ParamsLoginBody, MessageKey
} from '../openapi/generated/aliases'
import { isBusinessAccount, canDispatchGroupTask } from '../openapi/generated/aliases'

// 例：业务侧下发拉群任务前判定
async function dispatchGroupTask(accountId: string) {
  const usability: UsabilityState = await api.getUsability(accountId)
  if (!canDispatchGroupTask(usability)) {
    log.warn({ accountId, reason: usability.blockedReason }, 'skip task')
    return
  }
  // 派任务...
}

// 例：导入账号后判定 Business
async function importAccount(body: ParamsLoginBody) {
  const result: ImportResult = await api.importParams(body)
  if (isBusinessAccount(result.businessDetection)) {
    // 走 Business 路径，开放 catalog/product API
  }
}
```

### Java 业务侧（用 openapi-generator）

```bash
# 推荐：生成 Spring Web Client + Jackson DTO
openapi-generator-cli generate \
  -i openapi/protocol-v1.yaml \
  -g java \
  -o java-client \
  --library webclient \
  --additional-properties=useJakartaEe=true
```

### Apifox / Postman 导入

直接打开 `protocol-v1.yaml`，文件 → 导入 → OpenAPI 3.x → 选择文件。

## 重新生成

修改 `protocol-v1.yaml` 后：

```bash
bash openapi/regenerate-types.sh
```

或手工：

```bash
npx openapi-typescript@7 openapi/protocol-v1.yaml --output openapi/generated/types.ts
```

## 账号类型识别 — 检测层级与字段

| 检测层 | 时机 | 数据源 | 在 BusinessDetection 中的 source |
|---|---|---|---|
| pair-success 实时检测 | 首次绑定 | `pair-success.<platform>` + `<biz>` 节点 | `pair_success` |
| creds 元数据检测 | online 后 | `creds.platform` + `creds.me.name` | `creds_meta` |
| 导入时 hint | paramsLogin/sixLogin | `vip` 字段 | `vip_hint`（不可靠，仅作初始猜测） |
| 服务端兜底查询 | 任何时候 | `getBusinessProfile(selfJid)` | `business_profile_query` |

`BusinessDetection` 字段说明见 `protocol-v1.yaml` 或 `generated/types.ts` 的 schema。

## 验证

```bash
# YAML 语法 + $ref 完整性
node -e "
const yaml = require('js-yaml');
const fs = require('fs');
const f = fs.readFileSync('openapi/protocol-v1.yaml', 'utf8');
const doc = yaml.load(f);
console.log('paths:', Object.keys(doc.paths).length);
console.log('schemas:', Object.keys(doc.components.schemas).length);
console.log('webhooks:', Object.keys(doc.webhooks).length);
"
```

## Schema 版本管理

- 当前 `info.version = 1.0.0-draft`
- 正式发布前升 `1.0.0`
- 后续 breaking change 升主版本（path 加 `/v2/`）
- 非 breaking 加字段直接升 minor
