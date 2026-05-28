#!/usr/bin/env bash
# 重新生成 TypeScript 类型 + 校验 YAML。修改 protocol-v1.yaml 后运行。
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js" >&2
  exit 1
fi

# ─────────────────────────────────────────────────────────────────
# openapi-typescript 来源：优先本地 npm cache（离线友好），fallback 到 npx
# ─────────────────────────────────────────────────────────────────
CLI=""
# 1) 项目本地 node_modules
if [ -x "../protocol-layer/node_modules/.bin/openapi-typescript" ]; then
  CLI="../protocol-layer/node_modules/.bin/openapi-typescript"
fi
# 2) ~/.npm/_npx 缓存（之前 npx 拉过会留在这）
if [ -z "$CLI" ]; then
  cached=$(find "$HOME/.npm/_npx" -maxdepth 8 -name "cli.js" -path "*openapi-typescript/bin/*" 2>/dev/null | head -n 1 || true)
  if [ -n "$cached" ]; then
    CLI="node $cached"
  fi
fi
# 3) 全局
if [ -z "$CLI" ] && command -v openapi-typescript >/dev/null 2>&1; then
  CLI="openapi-typescript"
fi
# 4) fallback to npx（需要网络）
if [ -z "$CLI" ]; then
  echo "  本地未找到 openapi-typescript，尝试 npx 在线下载..."
  CLI="npx -y openapi-typescript@7"
fi

echo "→ 生成 generated/types.ts (cli=$CLI)"
$CLI protocol-v1.yaml --output generated/types.ts

# ─────────────────────────────────────────────────────────────────
# 校验 YAML + $ref（不依赖 npm 拉包，js-yaml 直接从已有 node_modules 读）
# ─────────────────────────────────────────────────────────────────
echo "→ 校验 YAML + \$ref"
node --input-type=module -e "
import fs from 'fs'
let yaml
const candidates = [
  '../protocol-layer/node_modules/js-yaml/lib/js-yaml.js',
  '../Baileys-master_协议/node_modules/js-yaml/lib/js-yaml.js'
]
for (const c of candidates) {
  if (fs.existsSync(c)) { yaml = await import(c); break }
}
const f = fs.readFileSync('protocol-v1.yaml', 'utf8')
const refRegex = /\\\$ref:\\s*'#\\/components\\/schemas\\/(\\w+)'/g
const refs = new Set()
let m
while ((m = refRegex.exec(f)) !== null) refs.add(m[1])
if (yaml) {
  const doc = yaml.load(f)
  const schemas = new Set(Object.keys(doc.components.schemas))
  const missing = [...refs].filter(r => !schemas.has(r))
  if (missing.length) { console.error('MISSING refs:', missing); process.exit(1) }
  console.log('paths:', Object.keys(doc.paths).length)
  console.log('schemas:', Object.keys(doc.components.schemas).length)
  console.log('webhooks:', Object.keys(doc.webhooks||{}).length)
}
console.log('refs:', refs.size, 'OK')
"

echo "✓ 完成"
