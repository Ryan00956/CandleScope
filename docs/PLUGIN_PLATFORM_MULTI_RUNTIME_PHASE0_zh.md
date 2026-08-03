# CandleScope 多运行时插件平台 — Phase 0 执行记录

> 状态：**已完成；本文件随 Phase 0 独立提交交付**
>
> 执行日期：2026-08-03
>
> 基线：`main@e60dd9f`；仓库同时存在用户的 replay 相关混合改动，本阶段使用显式
> pathspec 隔离，未读取这些改动作为通过依据，也未把它们加入提交。
>
> 总方案：`docs/MULTI_RUNTIME_PLUGIN_PLATFORM_EXECUTION_zh.md`

## 1. 阶段目标与结论

Phase 0 已冻结从当前 schema-v2/Python 平台演进到多运行时平台所需的兼容边界，并建立
真实、可重复、fail-closed 的 gate。本阶段没有添加 manifest v3 parser、Runtime
Provider、JRE/Node/WASM runtime，也没有把任何新环境变量接入生产 composition root。

完成结果：

- manifest schema v2、Hello Command manifest 和 JSONL transcript 有固定 raw/canonical
  SHA-256；
- Hello Command 的确定性 `.cspkg`、安装、activation、fresh-process probe、quick
  repeat、升级和精确 rollback 有机器可读合同；
- v2 `pythonModule` 到未来 `python-module` descriptor 的规范化目标已冻结；
- 五个 runtime kind、artifact role、trust alias、feature flag 与错误码 namespace 已冻结；
- 六个新 feature flag 均为 `default=false`、`wiredInPhase0=false`；
- ta4j `0.23.0` tag、peeled commit、Java 25、Maven wrapper、MIT 声明和首选公共 API 已重新
  从上游固定；
- 现有 Plugin Platform v2、Phase 13 compatibility、SDK 和前端插件架构回归通过；
- 所有新增生产能力仍为 0。

不得把 Phase 0 解释为 Java/native/Node/WASM 插件已可安装或执行。

## 2. 背景审计

### 2.1 当前已经成熟的基础

审计确认当前仓库已有：

- `backend/app/plugin_installer_v2/bundle.py`：严格 `.cspkg`、canonical descriptor、
  路径/压缩/摘要/SBOM 检查；
- `backend/app/plugin_installer_v2/installer.py`：隔离 venv、probe、安装收据、原子
  activation、state compensation、update 和 rollback；
- `backend/app/plugin_host/supervisor.py`：进程、handshake、generation、取消、健康、超时、
  stderr 和熔断；
- `backend/app/plugin_security_v2/*`：Grant Store、Capability Broker、AppContainer、
  Job Object 和审计；
- `packages/candlescope-plugin-sdk/.../platform_v2`：`candlescope.plugin/2`、
  `candlescope.host-api/1` 与 `jsonl/1`；
- `backend/tests/plugin_platform_bundle_testkit.py`：真实 Hello Command bundle 与 transcript
  构建器。

因此 Phase 0 复用真实 builder/installer/probe，不创建只会通过测试的假运行时。

### 2.2 当前阻塞点

当前入口在四层固定为 Python：

1. schema v2 entrypoint 必填 `pythonModule`；
2. SDK model 是 `BackendEntrypoint.python_module`；
3. activation record 是 `executable + module + workingDirectory`；
4. Core 固定生成 `-I -u -m <module>`。

当前 `local-trusted` 本来就不会使用 verified-publisher 的 AppContainer，所以兼容 ta4j 的
首要缺口是类型化多运行时入口，不是简单关闭沙箱。

## 3. 交付物

| 文件 | 作用 | 生产启动依赖 |
| --- | --- | --- |
| `docs/MULTI_RUNTIME_PLUGIN_PLATFORM_EXECUTION_zh.md` | Phase 0～11 总执行方案 | 否 |
| `docs/PLUGIN_PLATFORM_MULTI_RUNTIME_PHASE0_zh.md` | 本阶段记录、门禁与回滚 | 否 |
| `docs/plugin-adapters/ta4j-assessment.md` | ta4j 固定来源和 Adapter 边界 | 否 |
| `backend/tests/fixtures/plugin_platform_multi_runtime/phase0_contract_v1.json` | 机器可读冻结合同 | 仅测试 |
| `backend/scripts/plugin_platform_multi_runtime_phase0.py` | 合同校验与真实生命周期 gate | 否 |
| `backend/tests/test_plugin_platform_multi_runtime_phase0.py` | 漂移、无生产接线、生命周期与 CLI 测试 | 仅测试 |

生产代码、API、frontend、registry、用户数据和默认路由均未修改。

## 4. 冻结的 v2 契约

### 4.1 文件与 canonical 摘要

| 契约 | Raw SHA-256 | Canonical SHA-256 |
| --- | --- | --- |
| manifest-v2 schema | `9ab38bcbbf260fcadf65269b3a54e2eef02e3b295a1428c979d587fd98633d9b` | `16bc9cb9f51b66ad2e717cd74798cd5c2e0b6a7d6d0fc2f442ba60f68cb1b5a5` |
| Hello Command manifest | `03e21598303d8782be2f9626c3c40f6c16311b2cc58e084762e52fbb804f66e7` | `9f472a450c48025b2119ff880515898f7bd7748c06e1c99d2a6491754bc0d688` |
| Hello Command transcript fixture | `a7c35dfdf8a911ddf66c988523a851e3e37f282f8506b3651af7778565428af5` | `80408fa59e60e46b71e62ca390b2e498fbdbf793b9466878beea19900917f06f` |

Transcript 响应集合的既有语义 SHA-256 仍为
`d98ebd2fc9f5b0695925caf47ecf961eae47a56b5e8ec110f28acc9365afdd38`。

### 4.2 Reference bundle

Gate 使用当前真实 SDK source 构建两个确定性 bundle：

| 版本 | Bundle SHA-256 | Manifest SHA-256 |
| --- | --- | --- |
| `0.1.0` | `876120fde99c355c279cca97891e6a1f8a58455125856bd682f6977f167594b2` | `aee90ba2b5b2708f9615c981f061c5a9533e3f9e565ae0f03def62162b372f35` |
| `0.2.0` | `ccc8492b72de9c5ae8f21e8d493c065123a3f1b683bffbb739b9f367a7f2d7af` | `ef075f852819aead0885e15523fdc1fd30cc2fbeede318d0c1d66807364944d9` |

机器合同还冻结：

- content kinds 恰好为 manifest/probe/sbom/schema/wheel；
- 首装 active、enabled、activation-ready；
- activation 的 plugin/publisher/module/resource identity；
- probe entrypoint mode 为 `activated`；
- quick repeat 不创建新 activation；
- `0.2.0` 更新创建新 activation；
- rollback 恢复 `0.1.0` 的精确旧 activation；
- rollback 后 fresh-process probe 仍为 active。

这些摘要绑定当前 reference package。Phase 1 如果需要增加 SDK 文件，不能静默改写数值；
必须保留旧 fixture 或提交显式版本化迁移和新 digest。

## 5. v2 规范化目标

schema-v2 manifest 保持原样。Host 内部的未来规范化目标冻结为：

```json
{
  "id": "main",
  "runtime": {
    "kind": "python-module",
    "runtimeId": "python-v2-compat",
    "module": "candlescope_plugin_sdk.platform_v2.examples.hello_command"
  },
  "transport": "jsonl/1",
  "resourceProfile": "minimal",
  "activationEvents": ["onCommand"],
  "sourceManifestVersion": 2
}
```

`python-v2-compat` 是 Phase 1 要实现的兼容虚拟 runtime identity，不表示 Phase 0 已有
Runtime Registry。

## 6. 冻结的未来命名

### 6.1 Runtime kinds

| kind | 首个阶段 | Phase 0 状态 |
| --- | ---: | --- |
| `python-module` | 1 | compatibility contract |
| `native-executable` | 3 | planned |
| `java-jar` | 5 | planned |
| `node-module` | 7 | planned |
| `wasm-component` | 8 | planned |

### 6.2 Artifact roles

`python-wheel`、`native-executable`、`java-jar`、`node-bundle`、
`wasm-component`、`schema`、`probe`、`sbom`、`license-notice`、
`web-asset` 和 `source-map`。

### 6.3 Trust aliases

| 当前值 | 未来规范值 |
| --- | --- |
| `first-party-pinned` | `first-party-pinned` |
| `verified-publisher` | `marketplace-sandboxed` |
| `local-trusted` | `trusted-local` |
| `local-developer` | `developer-local` |
| `ui-only-untrusted` | `ui-only-untrusted` |

Phase 0 只冻结迁移方向，不修改现有持久化或 UI。

### 6.4 Feature flags

```text
CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED=0
CANDLESCOPE_PLUGIN_RUNTIME_NATIVE_ENABLED=0
CANDLESCOPE_PLUGIN_RUNTIME_JAVA_ENABLED=0
CANDLESCOPE_PLUGIN_RUNTIME_NODE_ENABLED=0
CANDLESCOPE_PLUGIN_RUNTIME_WASM_ENABLED=0
CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED=0
```

测试还要求这些名字不出现在当前 production bootstrap 中。换言之，它们不只是默认关闭，
而是 Phase 0 完全未接线。Phase 1 才能通过显式实现改变该断言。

### 6.5 错误码 namespace

- `PLUGIN_MULTI_RUNTIME_*`：跨 Provider 的 feature/manifest/normalization；
- `PLUGIN_RUNTIME_PROVIDER_*`：Provider lookup/prepare/launch/verify；
- `PLUGIN_RUNTIME_REGISTRY_*`：托管 runtime 获取、摘要、cache、撤销。

未知 runtime kind、未知字段和未启用 Provider 必须 fail closed。

## 7. ta4j 上游冻结

2026-08-03 通过上游 Git tag 和 `0.23.0` checkout 重新验证：

| 字段 | 值 |
| --- | --- |
| Stable tag | `0.23.0` |
| Annotated tag object | `0f3a703b651864953c78f2e7f1b91a30778b0625` |
| Peeled commit | `896d7138a9d1818fe6725b89b433ba7860b8f654` |
| Release date | 2026-07-13 |
| Java | release 25 |
| Maven wrapper | 3.9.16 |
| Source license declaration | MIT |
| Proposed API | `ElliottWaveAnalysisRunner` |

详细输入、输出、权限、许可证依赖、性能、sandbox 和 point-in-time 对照见
`docs/plugin-adapters/ta4j-assessment.md`。Maven Central JAR 与传递依赖尚未在 Phase 0
下载固定，因此不允许构建或发布 ta4j 插件。

## 8. Gate 行为

`backend/scripts/plugin_platform_multi_runtime_phase0.py` 依次执行：

1. strict JSON 读取冻结 fixture；
2. 从当前 SDK 重新计算 v2 schema/manifest/transcript；
3. 对比全部 future names 与 ta4j provenance；
4. 构建 Hello Command `0.1.0` 和 `0.2.0`；
5. 在 `TemporaryDirectory` 创建隔离 product root；
6. 安装并启用 `0.1.0`；
7. 运行 fresh-process semantic probe；
8. 快速重复安装同包；
9. 更新到 `0.2.0`；
10. rollback 到精确旧 activation；
11. 再运行 fresh-process probe；
12. 输出有界、机器可读 JSON。

任何 contract/digest/lifecycle 漂移都返回
`PLUGIN_MULTI_RUNTIME_PHASE0_GATE_FAILED`，不会写入产品 plugin root。

执行：

```powershell
$env:PYTHONPATH = (
  (Resolve-Path 'packages/candlescope-plugin-sdk/src').Path + ';' +
  (Resolve-Path 'backend').Path
)

backend\.venv\Scripts\python.exe `
  backend\scripts\plugin_platform_multi_runtime_phase0.py `
  --output "$env:TEMP\candlescope-plugin-multi-runtime-phase0-gate.json"
```

快速只读合同打印：

```powershell
backend\.venv\Scripts\python.exe `
  backend\scripts\plugin_platform_multi_runtime_phase0.py `
  --print-contract
```

`--print-contract` 不运行 installer；不能替代完整 gate。

## 9. 验证结果

| 门禁 | 结果 |
| --- | --- |
| Phase 0 新测试 | `5 passed`；包含真实 bundle lifecycle |
| backend v2/installer/core/supervisor/Phase 13 聚焦回归 | `55 passed` |
| Python lint/format/compile | Ruff check/format 与 `py_compile` 通过 |
| Plugin SDK | Ruff check/format；`85 passed` |
| SDK build/package smoke | sdist + wheel 构建、隔离 wheel install 与 console smoke 通过 |
| frontend plugin architecture | `check:plugins` 通过：18 host files、1 opaque-origin gateway |
| frontend TypeScript | app 与 node tsconfig 均通过 |
| 独立 CLI gate | `result=pass`；rollback `0.1.0`；final probe `active` |
| 文档/fixture | strict JSON、成对 code fences、无尾随空白、`git diff --check` |

SDK pytest 的第一次解释器选择缺少 `jsonschema`，收集阶段产生 2 个 dependency error；
改用机器上已有、包含 `jsonschema 4.25.1` 的 `D:\anaconda\python.exe` 后，
`85 passed`。仓库依赖、锁文件和全局环境均未修改。

## 10. 安全与支持边界

- Gate 的安装和 registry 全在临时根目录；
- 不写用户数据库、产品 registry 或权限状态；
- 不执行 ta4j、Java、Node、native 或 WASM；
- 不从任意 GitHub URL 下载或执行代码；
- 当前真实沙箱证据仍只覆盖现有 Windows/Python 路径；
- Linux/macOS 多运行时沙箱未验证；
- `trusted-local` 不等于密钥、账户或实盘交易；
- 所有 Live 相关生产开关保持原值和默认关闭边界。

## 11. 回滚

Phase 0 没有状态迁移。回滚本阶段提交只会删除：

- 总方案与 Phase 0/ta4j 文档；
- machine-readable contract fixture；
- dev-only gate；
- gate tests。

不需要修改 registry、数据库、runtime cache、grants 或 frontend。若只关闭后续工作而保留
证据，可保留 Phase 0 提交并不进入 Phase 1。

## 12. Phase 1 入口条件

Phase 1 只能在以下条件下开始：

1. schema v2、`candlescope.plugin/2` 和 v1 compatibility 继续保持独立；
2. manifest v3 只增加表达能力，不启动非 Python runtime；
3. v2 `pythonModule` 按冻结的 `python-v2-compat` 目标规范化；
4. activation 新版本有旧记录只读迁移和负例；
5. 所有新 Provider flag 仍默认关闭；
6. reference v2 bundle 若因 SDK additive 内容变化而改变，必须版本化说明，不能静默更新
   Phase 0 fixture；
7. Phase 1 是新的独立提交，并重新执行本 gate。

Phase 0 完成不自动授权进入 Marketplace、下载 JRE、打包 ta4j 或替换现有 Elliott 插件。
