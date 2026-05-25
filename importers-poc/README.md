# importers-poc — Apifox 三类登录 → Baileys auth_state 转换器

对应主文档 § 3.6.3。三个纯函数转换器 + jest 测试，供新方案协议层 importer 模块直接复用。

## 文件结构

```
importers-poc/
├── package.json
├── tsconfig.json
├── jest.config.ts
└── src/importers/
    ├── types.ts                 共享类型 (ConvertOutput / Input / 结果枚举)
    ├── params.ts                paramsLogin (Apifox /api/login/paramsLogin)
    ├── six.ts                   sixLogin    (Apifox /api/login/sixLogin)
    ├── legacy-json.ts           jsonLogin   (Apifox /api/login/jsonLogin)
    ├── index.ts                 统一入口 importCredentials()
    └── __tests__/
        ├── params.test.ts
        ├── six.test.ts
        ├── legacy-json.test.ts
        └── fixtures/
            ├── params/          (3 个样本)
            ├── six/             (3 个样本)
            └── legacy-json/     (4 个样本)
```

## 设计原则

1. **纯函数**：无副作用，可单测，不做 IO。online 在上层完成。
2. **结果枚举显式**：`CONVERTED_FULL / CONVERTED_PARTIAL / NEED_REAUTH / UNSUPPORTED_FORMAT / INVALID_CREDENTIAL`，不 throw 兜底 Error。
3. **失败情形必须穷举**：缺字段、base64 错、protobuf 解码失败、分身设备缺 advSig，每种都有明确路径。
4. **warnings 列表**：转换成功也带 warnings，方便业务侧记录"需要重新生成 pre-key"等次要信息。

## 跑测试

```bash
cd importers-poc
yarn install
yarn test
```

预期 3 个 test suite，10 个 cases 全 pass。

## 各转换器的关键失败情形

### params.ts
- 缺 `clientStatic*` / `identity*` / `signPreKey*` / `registrationID` / `wid` 任一 → `NEED_REAUTH`
- base64 字段格式错 → `INVALID_CREDENTIAL`
- 全字段齐 → `CONVERTED_PARTIAL`（keys 缺，Baileys 在 online 后重建）

### six.ts
- 缺 4 段密钥（clientStatic*/identity*）任一 + wid → `NEED_REAUTH`
- 有 `deviceIdentityKey` 但 protobuf 解码失败 → `INVALID_CREDENTIAL`
- 无 `deviceIdentityKey` 且 `wsDeviceId > 0`（分身设备）→ `NEED_REAUTH`（分身没 advSig 无法上线）
- 无 `deviceIdentityKey` 且 `wsDeviceId == 0`（主设备）→ `CONVERTED_PARTIAL`

### legacy-json.ts
- `accountJsonBase64` 缺 → `NEED_REAUTH`
- base64 解码失败 → `INVALID_CREDENTIAL`
- JSON 解析失败 → `INVALID_CREDENTIAL`
- 字段完全不识别 → `UNSUPPORTED_FORMAT`
- 字段部分识别（缺 signedPreKey/registrationId）→ `CONVERTED_PARTIAL`
- 完整 creds + keys → `CONVERTED_FULL`

## PoC 阶段未完成的部分（TODO）

1. **`six.ts` 中 `deviceIdentityKey` 真实 protobuf 解码**
   - 当前只做 base64 校验占位
   - 真实实现需引入 `baileys` 的 `proto.ADVSignedDeviceIdentity.decode`
   - 完成后能从中提取 `account` 字段填充到 `creds.account`

2. **`params.ts` 中 `advSecretKey` 协商**
   - 旧协议不带 advSecretKey
   - online 后 Baileys 会在 pair-success 阶段重新协商，但这需要走完整 pairing 流程
   - 现实可能需要直接 NEED_REAUTH 给用户重做 pairing

3. **`legacy-json.ts` 的 fixture 覆盖**
   - 当前只有 4 个 fixture，实际旧 JSON 格式变体可能 5-8 种
   - 上线前需要从 malaixiya 真实样本批量补充
