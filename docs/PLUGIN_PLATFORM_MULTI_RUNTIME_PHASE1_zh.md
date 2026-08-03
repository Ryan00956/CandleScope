# CandleScope 多运行时插件平台 — Phase 1 执行记录

> 状态：**已完成；本文件随 Phase 1 独立提交交付**
>
> 执行日期：2026-08-03
>
> 前置提交：Phase 0 `9839b11d490f41c816444ad9af4281e312635c2a`
>
> 总方案：`docs/MULTI_RUNTIME_PLUGIN_PLATFORM_EXECUTION_zh.md`

## 1. 阶段目标与结论

Phase 1 已让 SDK、manifest、`.cspkg` verifier 和 activation registry **严格表达**五种运行时，
同时维持“schema v3 只可 build/inspect、不可安装执行”的边界。

本阶段完成：

- 保留 `MANIFEST_SCHEMA_VERSION == 2` 和无参数 `manifest_schema()` 的 v2 默认语义；
- 新增显式 `MANIFEST_SCHEMA_VERSION_V3 == 3`、`manifest_schema(3)` 与
  `manifest_schema_v3()`；
- 新增 `python-module`、`native-executable`、`java-jar`、`node-module`、
  `wasm-component` 五种严格 runtime descriptor；
- v2 `pythonModule` 规范化为 `python-module / python-v2-compat`；
- 新增 bundle schema 3 与不可变 artifact inventory；
- activation registry 同时读取 schema 2/3，正常写入 schema 3；
- 旧 activation 只读加载，不在读取时改写文件；
- 新 activation 保存 `runtimeKind`、`runtimeId`、`artifactSha256` 与按 kind 校验的
  `launch`；
- 提供仅对 v2-compatible Python activation 成功的无损 schema-2 rollback export；
- `CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED` 默认关闭；
- schema-v3 install 在任何产品目录、venv、Grant Store、registry 或 probe 产生前停止；
- 即使显式打开总开关，Phase 1 仍返回 Provider 不可用，因为 Runtime Provider seam 属于
  Phase 2。

不得把本阶段解释为 Java、native、Node 或 WASM 插件已经可以运行。当前 schema-v3
Provider 数量仍严格为 `0`。

## 2. 背景审计

### 2.1 现有耦合

Phase 1 开始前重新审计了以下真实路径：

1. SDK `BackendEntrypoint` 只接受 `pythonModule`；
2. manifest-v2 schema 把 `pythonModule` 设为必填；
3. bundle schema 2 强制至少一个 wheel，content kind 仅覆盖 wheel/web/schema/probe/SBOM；
4. installer 无条件创建 venv、安装 wheels 并运行 Python probe；
5. activation entrypoint 只保存 `executable + module + workingDirectory`；
6. Core 固定生成 `-I -u -m <module>`；
7. Phase 0 reference wheel 打包全部 SDK `.py/.json`，所以添加 v3 SDK 文件必然改变 bundle
   SHA-256，但不应改变 v2 manifest 或 wire 语义。

因此，Phase 1 没有把 Java 命令塞入旧 Python module 字段，也没有让 Python 插件代为
`subprocess java`。实现先拆开“可表达/可检查”和“可准备/可启动”。

### 2.2 工作树隔离

仓库同时存在用户的 replay 相关混合改动。本阶段只读取插件平台边界，并使用显式 pathspec
提交 Phase 1 文件；不把 replay 改动加入测试通过依据或提交。

## 3. 冻结的 SDK 与 manifest v3 合同

### 3.1 版本兼容

| API | Phase 1 行为 |
| --- | --- |
| `MANIFEST_SCHEMA_VERSION` | 仍为 `2` |
| `MANIFEST_SCHEMA_VERSION_V2` | `2` |
| `MANIFEST_SCHEMA_VERSION_V3` | `3` |
| `manifest_schema()` | 仍返回 v2 schema |
| `manifest_schema(3)` | 显式返回 v3 schema |
| `candlescope.plugin/2` | 不变 |
| `jsonl/1` | 不变 |

manifest-v2 schema canonical SHA-256 仍为：

```text
sha256:16bc9cb9f51b66ad2e717cd74798cd5c2e0b6a7d6d0fc2f442ba60f68cb1b5a5
```

Hello v2 manifest 与 wire fixture canonical SHA-256 仍分别为：

```text
sha256:9f472a450c48025b2119ff880515898f7bd7748c06e1c99d2a6491754bc0d688
sha256:80408fa59e60e46b71e62ca390b2e498fbdbf793b9466878beea19900917f06f
```

manifest-v3 schema：

| 字段 | 值 |
| --- | --- |
| `$id` | `https://candlescope.local/schemas/plugin-manifest-v3.schema.json` |
| raw SHA-256 | `f9b896e93d243aa9c6ed3220899205754e6c6b2af70c99d61e2daa94b309b610` |
| canonical SHA-256 | `3ae83ba51edabd8865613bce1958c3beeb2af5f0257b939442c33a6fc0982a6f` |

### 3.2 Runtime `oneOf`

每个 v3 backend entrypoint 必须包含：

```json
{
  "id": "main",
  "runtime": {"kind": "<one supported kind>"},
  "transport": "jsonl/1",
  "resourceProfile": "standard",
  "activationEvents": ["onCommand"]
}
```

五个 descriptor 的边界：

| kind | 关键必填字段 | Phase 1 额外约束 |
| --- | --- | --- |
| `python-module` | `runtimeId`、`module` | module 必须可导入；args 有界 |
| `native-executable` | `artifact`、`operatingSystems`、`architectures` | 禁止 shell/脚本入口；OS/arch 必须排序唯一 |
| `java-jar` | `artifact`、`runtimeId`、`mainClass` | `.jar` 与 qualified class |
| `node-module` | `artifact`、`runtimeId` | `.js/.mjs/.cjs`；不接受 command string |
| `wasm-component` | `artifact`、`runtimeId`、`export` | `.wasm`、有界 export/WASI profile |

所有 descriptor 都拒绝未知字段。artifact 必须是 canonical bundle-relative path，不能包含
反斜杠、NUL、盘符、绝对路径、空段、`.` 或 `..`。argv 是字符串数组，不接受 shell command
字符串。

### 3.3 规范化

v2 入口保持原始 round-trip，同时得到内部值：

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

v3 保留类型化 runtime 内容，补充 `sourceManifestVersion: 3`。未知 schema、kind、字段、
重复 entrypoint 或跨 entrypoint 引用继续 fail closed。

## 4. Bundle schema 3 与 artifact inventory

### 4.1 Envelope

schema-v2 envelope 与 deterministic builder 字节结构不变。schema-v3 使用：

```json
{
  "schemaVersion": 3,
  "format": "candlescope.plugin-bundle/3",
  "compatibility": {
    "operatingSystems": ["linux", "macos", "windows"],
    "architectures": ["arm64", "x86_64"]
  },
  "contents": [],
  "probeAssets": [],
  "artifacts": []
}
```

`contents` 仍是全部 archive member 的 Host-owned digest table；`artifacts` 必须按 path 排序、
大小写唯一，并恰好覆盖除 `manifest.json` 之外的每个 content。两表的 path、size 和 SHA-256
必须一致。

### 4.2 Artifact role

冻结 role：

```text
python-wheel, native-executable, java-jar, node-bundle, wasm-component,
schema, probe, sbom, license-notice, web-asset, source-map
```

runtime artifact 必须：

- 位于 `runtime/`；
- 被至少一个 manifest entrypoint 引用；
- role 与 runtime kind 一致；
- artifact 的 OS/arch 覆盖当前 Host；
- native manifest 的 OS/arch 与 inventory 完全一致。

未引用 runtime、重复 artifact、错误 role、路径逃逸、大小写碰撞、symlink、非法 ZIP 类型、
压缩比炸弹、size/hash 漂移、重复 JSON key、NaN/Infinity 和非 canonical JSON 均被拒绝。

schema-v3 的 Python compatibility 是可选字段；只有 `python-module` bundle 必须有至少一个
`python-wheel` artifact。schema-v2 仍强制 Python compatibility 和 wheel。

## 5. Activation schema 3 与迁移

### 5.1 新记录

registry 文件名继续使用 `platform-registry-v2.json`，避免另建一份会与现有产品状态竞争的
registry；文件内容版本升级为 schema 3。每个 activation record 也显式带
`schemaVersion: 3`。

新 entrypoint 结构：

```json
{
  "id": "main",
  "runtimeKind": "python-module",
  "runtimeId": "python-v2-compat",
  "artifactSha256": "sha256:<64-hex>",
  "launch": {
    "kind": "python-module",
    "executable": "<absolute managed path>",
    "workingDirectory": "<absolute installation path>",
    "module": "fixture.runtime"
  }
}
```

`launch` 按 runtime kind 使用不同必填/可选字段；`launch.kind` 必须与 `runtimeKind` 一致，
未知字段、相对 launch path、无效摘要或类型混用均失败。

v2 Python activation 的 `artifactSha256` 使用整个不可变 bundle SHA-256。这是兼容身份：旧
schema 没有可靠记录“哪个 wheel 提供哪个 module”，而 bundle digest 已覆盖全部 wheels、
manifest、schema、probe 和 SBOM。

### 5.2 Read-old/write-new

- schema-2 registry 加载时在内存补充 `python-module / python-v2-compat / bundle SHA`；
- 只读加载不写文件、不增加 revision；
- 下一次正常 registry mutation 原子写 schema 3；
- schema-3 registry 严格读取 typed launch；
- schema-2/3 之外的版本拒绝；
- 原有 v1 `runtime-registry.json` 仍是独立兼容系统，未被读取或迁移。

### 5.3 回滚 export

`ActivationRegistry.to_schema_v2_wire()` 提供只读、无损的 schema-2 export：

- 仅当全部 entrypoint 都是 `python-module / python-v2-compat`；
- `artifactSha256` 必须等于对应 bundle SHA；
- 不允许 interpreter args 或任何非 v2 launch 数据；
- 任一条件不满足就 fail closed；
- helper 不写文件，调用者必须保留 schema-3 原件并在显式审核后自行原子替换。

这允许在 Phase 1 尚未安装任何新 runtime 的前提下回退旧二进制，而不会删除 plugin、grant、
history 或 installation。

## 6. 默认关闭与零执行证明

installer 在完成只读 bundle SHA、ZIP、manifest 和 artifact inspect 后、进入 installation lock
之前检查 schema 版本：

| 条件 | 结果 |
| --- | --- |
| manifest v2 | 继续既有 Python install/probe/activation |
| manifest v3 + 总开关关闭 | `PLUGIN_MULTI_RUNTIME_FEATURE_DISABLED` |
| manifest v3 + 总开关打开 | `PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE` |

两种 v3 错误都发生在以下动作之前：

- 创建 product root/staging/installation；
- 创建 venv 或安装 wheel；
- 执行插件、JAR、native、Node、WASM 或 probe；
- 修改 Grant Store、registry、history 或 transaction journal。

因此 Phase 1 的 v3 build/inspect 能力不能通过开关误变成执行能力。

## 7. Phase 0 摘要的显式版本化

Phase 0 历史 reference bundle SHA-256 原样保留：

| SDK generation | `0.1.0` | `0.2.0` |
| --- | --- | --- |
| Phase 0 historical | `876120fd…594b2` | `ccc8492b…2d7af` |
| Phase 1 additive SDK | `744cc3c3…d608b` | `0b9daac4…7ae02` |

manifest SHA-256 仍分别为 `aee90ba2…72f35` 与 `ef075f85…944d9`。变化只来自 reference wheel
新增 manifest-v3 schema 与 runtime model 源文件。

Phase 0 fixture 没有改写历史 digest。其生命周期 gate 现在验证 content kinds 与完整稳定语义；
Phase 1 独立 fixture `phase1_contract_v1.json` 固定新一代 bundle 的精确 SHA-256。这样后续 SDK
增量必须再建立新 generation，不能静默覆盖旧值。

## 8. Gate 与测试

机器合同：

```text
backend/tests/fixtures/plugin_platform_multi_runtime/phase1_contract_v1.json
```

Phase 1 gate：

```powershell
$env:PYTHONPATH = (
  (Resolve-Path 'packages/candlescope-plugin-sdk/src').Path + ';' +
  (Resolve-Path 'backend').Path
)

backend\.venv\Scripts\python.exe `
  backend\scripts\plugin_platform_multi_runtime_phase1.py `
  --output "$env:TEMP\candlescope-plugin-multi-runtime-phase1-gate.json"
```

Gate 会：

1. 重算 v2 schema/manifest/wire frozen hashes；
2. 重算 v3 schema 与五个合法 manifest fixture；
3. 确定性构建两个 v2 generation bundle；
4. 确定性构建并 inspect 五种 v3 bundle；
5. 验证 v3 feature-off 与 provider-unavailable 均不产生产品状态；
6. 真实安装、check、quick-repeat v2 Python reference；
7. 验证新 registry schema、normalized runtime identity 与 artifact digest；
8. 读取旧 registry，证明源文件不变，并验证 schema-2 rollback export。

最终验证结果：

| 门禁 | 结果 |
| --- | --- |
| SDK Ruff check/format | 通过；49 个 Python 文件格式一致 |
| SDK 全量 pytest | `98 passed` |
| backend Phase 1 聚焦回归 | `86 passed`；含 v2/v3 bundle、installer、registry、Core、Supervisor、Phase 0/1/13 |
| Phase 1 独立 CLI gate | `result=pass`；contract SHA-256 `f790fb0a…3b754` |
| frontend 插件架构 | 通过；18 个 Host 文件、1 个 opaque-origin sandbox gateway |
| frontend TypeScript | app 与 node tsconfig 均通过 |
| SDK build | sdist 与 wheel 构建成功 |
| fresh wheel install | 全新 venv 安装成功；installed wheel 的 v2/v3 schema smoke 通过 |
| 发行物 inventory | sdist/wheel 均包含 manifest-v3 schema；`pip check` 无 broken requirements |
| JSON/文档/diff | 新增 JSON strict parse、`git diff --check` 通过 |

发行 smoke 曾额外尝试 `twine check`，但当前 `D:\anaconda\python.exe` 没有安装 twine；该项没有
被记为通过，也没有为 Phase 1 修改全局 Python 环境。Phase 1 不发布包，要求的 build、archive
inventory、fresh install、installed-resource smoke 与 `pip check` 均已独立通过。

任何失败均未通过放宽 schema、摘要、路径、OS/arch 或执行开关来消除。

## 9. 安全与支持边界

- schema-v3 artifact 仍必须 pinned、摘要覆盖、SBOM 覆盖并通过 archive limits；
- inspect 不等于信任，也不授予网络、文件、账户、密钥或交易权限；
- `trusted-local` 迁移尚未发生；
- 未下载 JRE、Node、Wasmtime，也未查找系统 runtime；
- 未执行 ta4j 或下载其 Maven artifact；
- 未修改 Plugin Manager UI、Marketplace 或 GitHub import；
- 未创建 Runtime Provider；
- Linux/macOS/Windows 新 runtime sandbox 均未宣称完成；
- v1 compatibility、v2 Python、Grant Store 与 `candlescope.plugin/2` 继续保持独立边界。

## 10. 回滚

首选 operational rollback：

1. 保持 `CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED=0`；
2. 保留 Phase 1 registry reader，以继续读取 schema 2/3；
3. 不删除 registry、grants、history、installations 或 bundle cache；
4. v2 Python 插件继续正常工作。

若必须回退到 Phase 0 二进制：

1. 停止 CandleScope，备份 schema-3 registry；
2. 用 Phase 1 reader 加载并调用 `to_schema_v2_wire()`；
3. 仅在无损 export 成功后原子替换 registry；
4. 保留原 schema-3 文件作为恢复证据；
5. 再启动旧二进制并运行 v2 `check`。

禁止手工删除 typed launch 字段或强改 `schemaVersion`。一旦未来存在非 Python activation，
schema-2 export 会拒绝，必须先通过正常 rollback/disable 回到兼容 activation。

## 11. Phase 2 入口条件

Phase 2 只有在以下条件继续满足时才能开始：

1. Phase 0 与 Phase 1 machine contract/gate 均通过；
2. schema-v2、reference manifest 和 `candlescope.plugin/2` 摘要不变；
3. v3 仍不能绕过 Provider 启动；
4. Runtime Provider registry 对未知 kind fail closed；
5. Python Provider 与旧固定启动路径做 transcript、fault、performance 等价对照；
6. Phase 2 rollback flag 能回到旧 Python launch path；
7. 不在 Phase 2 顺带实现 native、Java、Node、WASM 或 GitHub import。
