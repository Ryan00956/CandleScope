# CandleScope 多运行时兼容性矩阵

> 此表是能力声明，不是路线图。只有机器证据真实通过的单元格才标为支持。

## 1. 已验证宿主

| 项目 | 已验证值 |
| --- | --- |
| OS | Windows 11 |
| architecture | x86_64 / AMD64 |
| CandleScope | `0.4.x` engine contract |
| protocol | `candlescope.plugin/2` + JSONL/1 |
| manifest | schema v3；v2 Python 保持兼容 |
| legacy | v1 compatibility wire frozen |

Linux、macOS、arm64 尚未获得等价 Host sandbox/installer/soak 证据，不属于当前 GA 声明。Phase 8 的
WSL Ubuntu 22.04 只证明相同 WASM component 的 cross-host canonical output 和 WASI boundary，
不等于 Linux 桌面 Host GA。

## 2. Runtime matrix

| runtime kind | SDK | 固定 runtime | artifact | Windows x86_64 | Marketplace sandbox | trusted-local |
| --- | --- | --- | --- | --- | --- | --- |
| `python-module` | Python SDK 0.2.0 | `host-python` / `python-v2-compat` | wheel/module | 支持 | AppContainer 已验证 | 可选但通常不需要 |
| `native-executable` | Rust/WASM SDK wire helpers | `native-host` | plugin-bundled PE | 支持 | AppContainer 已验证 | 已验证 |
| `java-jar` | Java SDK 0.1.0 | `temurin-25.0.4.7`；ta4j release 用 `temurin-26.0.2.10` | JAR | 支持 | AppContainer 已验证 | 未作为 GA 主路径声明 |
| `node-module` | TypeScript SDK 0.1.0 | `node-24.19.0` | prebuilt ESM | 支持 | AppContainer 已验证 | 未作为 GA 主路径声明 |
| `wasm-component` | Rust/WASM SDK | `wasmtime-47.0.3` | WASI Preview 2 component | 支持 | AppContainer + WASI 已验证 | 不建议绕过 WASI 边界 |

不同 JRE 不能互换。`java-jar` 可运行不代表任意 JRE 满足某个 manifest；Host 必须解析并验证精确
`runtimeId`，绝不使用系统 `java` 兜底。

## 3. 生命周期与供应链能力

| 能力 | Python | Native | Java | Node | WASM |
| --- | --- | --- | --- | --- | --- |
| fresh install | 已验证 | 已验证 | 已验证 | 已验证 | 已验证 |
| quick repeat | 已验证 | 已验证 | 已验证 | 已验证 | 已验证 |
| fresh process semantic probe | 已验证 | 已验证 | 已验证 | 已验证 | 已验证 |
| update/rollback | 已验证 | 已验证 | 已验证 | 已验证 | 已验证 |
| Host-managed runtime cache | N/A | N/A | 已验证 | 已验证 | 已验证 |
| offline cache hit | 已验证 | 已验证 | 已验证 | 已验证 | 已验证 |
| deterministic package | wheel | PE/bundle | JAR/bundle | tarball/bundle | crate/component/bundle |
| unified conformance transcript | 已验证 | 已验证 | 已验证 | 已验证 | 已验证 |

## 4. 隔离与能力边界

| 边界 | 当前证据 |
| --- | --- |
| Windows AppContainer | Marketplace Python、native、Java、Node、WASM 真实进程 |
| process tree | Job Object、`activeProcessLimit=1`、Host stop 零残留 |
| trusted-local | native 本地 bundle 两次确认；无 AppContainer 等价声明 |
| WASI | 无环境、外部文件、网络和子进程；Windows/WSL canonical output |
| stdout | 仅严格 JSONL；污染 fail-closed |
| stderr | 有界且 redaction；不能承载协议 |
| account/secret/live | 始终独立 authority，不由 trust mode 自动授予 |

## 5. 故障覆盖

| 故障 | 证据 |
| --- | --- |
| crash/process exit | `PLUGIN_PLATFORM_EXITED` |
| hang/request timeout | `PLUGIN_PLATFORM_TIMEOUT` |
| WASM cancel | `PLUGIN_WASM_CANCELLED` |
| stale generation | late result 被拒绝 |
| Host call cancel race | pending Host call 被取消 |
| restart storm | entrypoint circuit 打开 |
| network loss | 只用 verified offline cache；miss 稳定失败 |
| disk full | 安装事务原子失败 |
| cache corruption | quarantine + verified archive 恢复 |
| invalid JSON/UTF-8/depth/size | unified conformance 严格拒绝 |

## 6. 首批参考 Adapter

| Adapter | 上游 | runtime | 当前用途 |
| --- | --- | --- | --- |
| ta4j Elliott | `ta4j/ta4j` 固定 tag/commit | Java | point-in-time 波浪分析与 Python 对照 |
| aho-corasick Search | `BurntSushi/aho-corasick` 1.1.4 | native | 第二个 GitHub thin Adapter、离线 Rust build |
| Node hello | 仓库内 reference | Node | SDK/Provider/conformance |
| Rust WASM reference | 仓库内 reference | Wasmtime | WASI、跨 Host canonical output |

参考 Adapter 的存在不表示上游仓库整体受支持；支持单元是固定版本的 Adapter release。

## 7. 默认开关

以下新功能均默认关闭，且可独立关闭：

```text
CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED
CANDLESCOPE_PLUGIN_RUNTIME_PROVIDER_SEAM_ENABLED
CANDLESCOPE_PLUGIN_RUNTIME_NATIVE_ENABLED
CANDLESCOPE_PLUGIN_RUNTIME_JAVA_ENABLED
CANDLESCOPE_PLUGIN_RUNTIME_NODE_ENABLED
CANDLESCOPE_PLUGIN_RUNTIME_WASM_ENABLED
CANDLESCOPE_PLUGIN_RUNTIME_REGISTRY_ENABLED
CANDLESCOPE_PLUGIN_RUNTIME_REGISTRY_NETWORK_UPDATES_ENABLED
CANDLESCOPE_PLUGIN_MULTI_RUNTIME_TRUST_UX_ENABLED
CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED
CANDLESCOPE_PLUGIN_PLATFORM_V2_MARKETPLACE_ENABLED
CANDLESCOPE_PLUGIN_MARKETPLACE_TELEMETRY_ENABLED
```

全设为 `0` 后，Provider registry 只保留 `python-module`，v2 Python 能运行，v1 frozen wire 不变。

## 8. 证据位置

- 总矩阵：`docs/evidence/plugin-platform-multi-runtime-phase11-matrix.json`；
- SDK：`docs/evidence/plugin-platform-multi-runtime-phase11-sdk.json`；
- headed UI：`docs/evidence/plugin-platform-multi-runtime-phase11-browser.json`；
- ta4j：`docs/evidence/plugin-platform-multi-runtime-phase11-ta4j.json`；
- 4 小时 soak：`docs/evidence/plugin-platform-multi-runtime-phase11-soak-4h.json`；
- GA 汇总：`docs/evidence/plugin-platform-multi-runtime-phase11-ga.json`。
