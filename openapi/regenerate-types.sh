#!/usr/bin/env bash
# 重新生成 TypeScript 类型。修改 protocol-v1.yaml 后运行。
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v npx >/dev/null 2>&1; then
  echo "需要 Node.js + npm" >&2
  exit 1
fi

echo "→ 生成 generated/types.ts"
npx -y openapi-typescript@7 protocol-v1.yaml --output generated/types.ts

echo "→ 校验 YAML + \$ref"
node -e "
const fs = require('fs');
let yaml;
try { yaml = require('js-yaml'); }
catch { console.log('(跳过：未安装 js-yaml，npm i -D js-yaml 可启用校验)'); process.exit(0); }
const f = fs.readFileSync('protocol-v1.yaml', 'utf8');
const doc = yaml.load(f);
const refRegex = /\\\$ref:\\s*'#\\/components\\/schemas\\/(\\w+)'/g;
const refs = new Set();
let m;
while ((m = refRegex.exec(f)) !== null) refs.add(m[1]);
const schemas = new Set(Object.keys(doc.components.schemas));
const missing = [...refs].filter(r => !schemas.has(r));
if (missing.length) { console.error('MISSING refs:', missing); process.exit(1); }
console.log('paths:', Object.keys(doc.paths).length);
console.log('schemas:', Object.keys(doc.components.schemas).length);
console.log('webhooks:', Object.keys(doc.webhooks||{}).length);
console.log('all', refs.size, 'refs OK');
"

echo "✓ 完成"
