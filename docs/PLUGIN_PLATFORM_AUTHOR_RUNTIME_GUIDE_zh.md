# CandleScope 插件作者运行时选择与发布指南

> 适用版本：CandleScope `0.4.x`、manifest schema v3、`candlescope.plugin/2`。
> 当前 GA 验证目标仅为 Windows x86_64；其他系统不得由此文档推断为已支持。

## 1. 先决定是否真的需要新运行时

插件不是把任意 GitHub 仓库直接塞进 CandleScope。Host 只执行一个边界清楚、可探测、可取消、
可关闭的 Adapter。上游库负责算法，Adapter 负责把 CandleScope JSONL 协议映射到上游公开 API。

按以下顺序选择：

1. 现有 Python SDK 能满足且性能足够：选 `python-module`；
2. 上游是 JVM 库且已有稳定公共 API：选 `java-jar`；
3. 上游是 Node/TypeScript 库且能预构建为无安装脚本的 ESM：选 `node-module`；
4. 计算可封装成 WASI Preview 2 component、无需宿主网络/文件：优先 `wasm-component`；
5. 只有预编译本机 CLI/库能满足：选 `native-executable`，并接受 OS/arch 矩阵和更高审核成本。

不要因为“仓库是某语言”就机械选择同语言 runtime。重点是：发布物能否离线复现、运行时能否固定、
能力是否可最小化、失败是否可在进程边界终止。

## 2. 五种 runtime 的已验证边界

| kind | 适用场景 | 发布物 | 运行时来源 | 当前 Windows 隔离 |
| --- | --- | --- | --- | --- |
| `python-module` | 纯 Python Adapter、指标和命令 | wheel + module | Host Python / v2 compatibility | Marketplace 为 AppContainer |
| `java-jar` | ta4j 等 JVM 公共库 | 预构建 JAR | 精确 `runtimeId` 的 Host-managed JRE | AppContainer + Job Object |
| `node-module` | 预构建 ESM Adapter | `.mjs`、可选 scrubbed map | 精确 `runtimeId` 的 Host-managed Node | AppContainer + Job Object |
| `wasm-component` | 确定性计算、最小宿主能力 | WASI Preview 2 component | 精确 `runtimeId` 的 Host-managed Wasmtime | AppContainer + WASI 边界 |
| `native-executable` | 预编译 CLI/本机算法 | PE executable | `plugin-bundled` | Marketplace 可 AppContainer；本地可 trusted-local |

`trusted-local` 不是沙箱等级，它表示用户明确允许代码以当前 Windows 用户身份运行；账户、密钥、
交易和 Host API grant 仍需独立授权。

## 3. manifest v3 最小契约

所有新运行时使用 schema v3。以下字段不能省略：

- `schemaVersion: 3`；
- 稳定的 `plugin.id`、SemVer `plugin.version`、SPDX `plugin.license`；
- 精确 CandleScope engine 范围；
- 至少一个 `backend.entrypoints[]`；
- `transport: "jsonl/1"`；
- `resourceProfile` 与 `activationEvents`；
- contributions 明确绑定 entrypoint；
- `permissions.required` 与 `permissions.optional`；
- control transcript probe 及其 canonical SHA-256。

Java runtime 示例：

```json
{
  "kind": "java-jar",
  "artifact": "runtime/adapter.jar",
  "runtimeId": "temurin-26.0.2.10",
  "mainClass": "com.example.candlescope.Main",
  "jvmArgs": ["-Xms32m", "-Xmx256m", "-XX:+UseSerialGC"]
}
```

Node、WASM、native 分别参考：

- `examples/plugin-platform-node-typescript/manifest.json`；
- `examples/plugin-platform-wasm-rust/manifest.json`；
- `examples/plugins/aho-corasick-adapter/manifest.json`；
- `examples/plugins/ta4j-elliott-adapter/manifest.json`。

## 4. 语言无关协议要求

Adapter stdout 只能写一行一个严格 JSON 对象。日志只能写 stderr，且不得包含 token、账户、密钥、
绝对私有路径或策略输入。每个 SDK 都必须通过同一 conformance suite，而不是复制后修改期望值。

必需生命周期：

```text
handshake -> describe -> activate -> invoke/healthCheck
          -> deactivate/prepareUpgrade -> shutdown
```

同时实现并测试：generation mismatch、重复 request id、业务错误与内部错误分离、Host call cancel、
late response 丢弃、stdout 污染拒绝、超时终止、restart budget 与 circuit breaker。

统一门禁：

```powershell
backend\.venv\Scripts\python.exe packages\plugin-conformance\check.py `
  --run-python-cases `
  --python backend\.venv\Scripts\python.exe
```

通过标准是 28 个 case、5 种 runtime transcript、固定 suite digest 全部匹配。

## 5. 各 runtime 的构建规则

### 5.1 Python

- wheel 不得带未声明依赖；
- 两个空输出目录在固定 `SOURCE_DATE_EPOCH` 下构建，wheel bytes 必须一致；
- 校验 `METADATA`、`WHEEL`、全部 `RECORD` hash/size；
- 在全新 venv 中用 `--no-index --no-deps` 安装并运行真实 console entrypoint。

### 5.2 Java

- Adapter 只使用公共 SDK/上游 API，不导入 `backend.app`；
- `javac --release 17 -Xlint:all -Werror`；
- JAR 内时间、权限、排序和 manifest 固定；
- 两次 JAR bytes 一致；
- 运行时版本由 manifest 的 `runtimeId` 决定，不能用系统 `java` 兜底。

### 5.3 TypeScript/Node

- 发布的是预构建 ESM，不在用户机器运行 `npm install`；
- 禁止 lifecycle script 和 package manager side effect；
- source map 必须 scrub 本机路径；
- tarball 确定性构建，使用锁定 Node runtime；
- stderr/stdout 隔离必须由真实 sidecar self-test 证明。

### 5.4 Rust/WASM

- 固定 Rust toolchain、`Cargo.lock`、`--locked`；
- `cargo fmt --check`、`clippy -D warnings`、test、release build、crate package；
- component 目标是 `wasm32-wasip2`，manifest 声明 `wasi-preview2`；
- 默认无环境变量、网络、外部文件 preopen 或子进程；
- Windows 与 WSL/Linux 的相同 component 必须给出 canonical output 证据。

### 5.5 Native

- Marketplace 只接受已审核的预构建 artifact；
- source build、系统 PATH fallback、未声明下载、安装脚本均为 false；
- manifest 必须列出 OS/arch；
- PE 的 timestamp、CodeView 等非确定字段必须处理；
- AppContainer 与 trusted-local 是两条不同信任路径，不能共用声明。

## 6. 权限与 point-in-time 数据

权限从空集合开始。只有实际业务需要才声明，例如 ta4j：

```json
{
  "id": "market.bars.read",
  "scope": {
    "contexts": ["live"],
    "symbols": ["BTCUSDT"],
    "intervals": ["1h"],
    "maxHistoryBars": 5000,
    "maxConcurrent": 1,
    "pointInTimeRequired": true
  }
}
```

插件不得自行访问 CandleScope 数据库。历史 bars 由 Host call 提供；在 `pointInTimeRequired=true` 时，
任何未来 bar、修订后数据或最终标签都不得进入当前决策。

## 7. 从源码工程到 `.cspkg`

推荐顺序：

1. 固定上游 tag、commit、license、NOTICE、包/JAR/crate SHA-256；
2. 运行 GitHub assessment，但不执行仓库代码；
3. 生成 pending Adapter scaffold；
4. 人工审核公共 API、依赖和能力；
5. 在隔离缓存中准备依赖，正式构建只离线执行；
6. 完成 source lock、SBOM、license inventory、build receipt 和 transcript；
7. 运行 `v3 source-lock-check`；
8. 两次构建 `.cspkg` 并比较 bytes；
9. `v3 inspect`；
10. fresh install、quick repeat、fresh-process check、update、rollback；
11. 运行 SDK 与 conformance；
12. 进入 Marketplace 清单或交给用户走 trusted-local 双确认。

常用命令：

```powershell
backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v3 --json source-lock-check <adapter-root>

backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v3 --json build <adapter-root> <output.cspkg> --os windows --arch x86_64

backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v3 --json inspect <output.cspkg>
```

## 8. 发布前退出条件

- 所有 artifact 与依赖均被 digest/SBOM/license inventory 覆盖；
- 两次隔离构建完全一致；
- 不执行用户机器上的 source compile、包管理器或系统 runtime fallback；
- control transcript 与 manifest probe 一致；
- fresh、repeat、fresh process、update、rollback 全通过；
- crash、hang、cancel、stale generation、cache corruption 有稳定错误码；
- 真实 Windows 进程清理为零残留；
- 只声明实际跑过的 OS/arch/runtime；
- 新 runtime flags 默认关闭，关闭后 v2 Python 与 v1 compatibility 不变。

完整机器门禁与证据索引见 `PLUGIN_PLATFORM_MULTI_RUNTIME_PHASE11_zh.md`。
