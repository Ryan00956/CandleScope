# CandleScope 多运行时插件平台 Phase 8 完成证据

## 1. 阶段结论

Phase 8 已交付 `wasm-component` Runtime Provider、固定 Wasmtime 47.0.3 的签名
Runtime Registry revision 5、无第三方依赖的 Rust/WASM SDK，以及可离线构建和安装的
Rust reference plugin。

本阶段适合纯计算、确定性算法和不需要任意本机能力的 GitHub 项目。它不是“让 WASM 获得本机
权限”的通道。首发边界是：

- 只接受 Rust 1.97.1 `wasm32-wasip2` command component；
- descriptor 中的逻辑入口 `wasi:cli.run` 唯一映射到组件导出 `wasi:cli/run`；
- 只使用 stdin/stdout strict JSONL bridge，不开放自定义 Host imports；
- 不继承环境变量，不 preopen 目录，不开放网络、子进程或线程；
- fuel、linear memory、wall time、消息、stderr 和进程树都由 Host 限制；
- Windows 签名 Marketplace 同时使用 WASI 边界和 AppContainer；
- Ubuntu-22.04/WSL2 只验证 WASI 边界，不宣称存在等价 Linux OS sandbox；
- Provider、Runtime Registry 网络更新和多运行时总开关继续默认关闭。

Windows amd64 和 Ubuntu-22.04/WSL2 x86_64 的真实门禁已经通过。macOS、arm64 和原生 Linux
AppContainer 等价物没有本阶段证据，因此不宣称支持。

## 2. 实施前背景审计

### 2.1 已有扩展位不等于已有能力

Phase 1 的 schema v3 已能描述 `wasm-component`，Phase 2 有 Runtime Provider seam，Phase 6
也预留了 `restricted-wasm` 名称。但进入本阶段时：

1. 默认 Provider Registry 中没有 WASM Provider；
2. 没有被签名 Registry 固定的 Wasmtime；
3. 没有 tar.xz runtime 解压路径；
4. 没有 GitHub Release asset/commit 的稳定证据投影；
5. 没有 Rust/WASM SDK、reference component 或确定性构建；
6. 没有 fuel、trap、memory、cancel 的专用诊断；
7. 没有 Windows/非 Windows 同摘要和同 canonical output 证据；
8. 没有签名 WASM Marketplace 的 AppContainer 实测。

因此旧 schema 中出现 `wasm-component` 只能称为扩展位，不能称为可运行能力。

### 2.2 首发为什么选择 WASI Preview 2 command

Wasmtime CLI 对 component command 默认执行 `wasi:cli/run`。首版固定这一条路径，而不同时支持
WASIp1、自定义 WIT world、typed custom export、HTTP proxy 或任意 preview 混用。这样可以复用
现有 JSONL 生命周期、Supervisor 和 capability 模型，不需要给每个第三方项目新增一套 Host ABI。

官方依据：

- [Wasmtime 47.0.3 Release](https://github.com/bytecodealliance/wasmtime/releases/tag/v47.0.3)
- [Wasmtime CLI Options](https://docs.wasmtime.dev/cli-options.html)
- [Wasmtime Security](https://docs.wasmtime.dev/security.html)
- [Wasmtime Interrupting Execution](https://docs.wasmtime.dev/examples-interrupting-wasm.html)

### 2.3 不改旧冻结契约

WASM 需要专用 failure classifier 和“取消即终止进程”语义，但 Phase 3 已冻结公共
`PreparedLaunch` 字段。本阶段没有重录旧快照，而是用 `WasmPreparedLaunch` 派生描述提供两个
WASM-only 属性；旧 Provider DTO 仍保持原字段集合。Phase 1～7 门禁在本阶段回归中继续通过。

## 3. 已执行计划

1. 审计 schema、Provider、installer、probe、Supervisor、sandbox 和 Registry 扩展位；
2. 固定 Wasmtime 47.0.3、commit、Windows/Linux x86_64 Release 和许可证；
3. 扩展 Registry 以安全支持 tar.xz、根目录 legal inventory 和证据 projection；
4. 发布连续签名的 Runtime Registry revision 5；
5. 冻结 WASI Preview 2 command、JSONL bridge 和 Host capability 边界；
6. 实现 `WasmComponentProvider 1.0.0`；
7. 实现 dependency-free Rust/WASM SDK；
8. 实现 Rust reference component、CycloneDX SBOM、control transcript 和 supply-chain lock；
9. 修复 Windows/Linux 路径嵌入导致的构建摘要差异；
10. 实现 fuel、memory、trap、wall、stderr 和 cancel 诊断；
11. 建立真实 Runtime Registry first/repeat/offline/fresh-process 门禁；
12. 在 Windows 与 Ubuntu-22.04/WSL2 分别完成两次 clean/offline build；
13. 验证同 module digest、同 transcript 和同 canonical output；
14. 验证签名 Marketplace 的 SBOM、AppContainer、WASI 边界和进程清理；
15. 验证 install/check/update/rollback、Registry v5→v4→v5 和 Provider disable；
16. 冻结合同、machine-readable evidence、文档和回滚边界。

## 4. 固定 Wasmtime 供应链

### 4.1 Registry revision 5

共同身份：

| 字段 | 值 |
| --- | --- |
| runtime id | `wasmtime-47.0.3` |
| version | `47.0.3` |
| upstream commit | `5554cc1a651da536af2cc46c7324bdc085b162e3` |
| license | `Apache-2.0 WITH LLVM-exception` |
| Registry revision | `5` |
| Registry SHA-256 | `815409a99dc7dd77297b86bc1cefce92abcbee5ac53f20c0ea20dd3c254a390d` |
| previous revision SHA-256 | `36eb70c60f77779d56e05273b78bc1f54221c1de0ec1116fdd1e98b3f30adfcf` |

平台资产：

| OS | archive | SHA-256 | size | extracted |
| --- | --- | --- | ---: | ---: |
| Windows x86_64 | `wasmtime-v47.0.3-x86_64-windows.zip` | `80ddf037820b35a9a53c13519632f52947e848d6ba69a483840b7330110408f3` | 13,283,825 | 42,552,781 |
| Linux x86_64 | `wasmtime-v47.0.3-x86_64-linux.tar.xz` | `ca1fc56d1afc40c8782e96c297fd182a0da162f9a8f52a1e7b094e1dd648e178` | 11,712,804 | 63,953,797 |

每份 archive 都严格只有 4 个文件。`legalDirectory="."` 是显式的“archive root legal
inventory”，不是空路径或绕过目录检查。

### 4.2 GitHub 证据投影

Registry 不直接签易变的 GitHub API 完整响应，而是先生成稳定、严格、有界的 projection：

- `github-release-asset-v1`：绑定 asset id、名称、content type、download URL、digest 和 size；
- `github-git-commit-v1`：绑定固定 commit、tree、parents、author/committer 和 verified PGP
  signature；
- `RELEASES.md` 与 `Cargo.lock` 使用固定 commit 的 raw bytes。

投影在摘要校验之前完成；无效 UTF-8、重复 key、未验证签名、asset digest/size/URL 不匹配都会
fail closed。真实门禁还对 Windows/Linux 两份 archive 分别执行 `gh attestation verify`，确认
SLSA provenance 的仓库、tag、commit、workflow 和 subject digest。

### 4.3 缓存与回滚

真实空目录门禁证明：

- 首次 ensure 获取 archive + 4 份证据，共 5 个文件；
- quick repeat 与 offline ensure 不再下载；
- fresh Python process 命中同一 executable/probe digest；
- 空缓存 offline 返回 `PLUGIN_RUNTIME_REGISTRY_OFFLINE_CACHE_MISS`；
- Registry revision 5 回滚到 4 后返回 `PLUGIN_RUNTIME_REGISTRY_RUNTIME_NOT_FOUND`；
- 再激活 revision 5 后，已验证缓存恢复可用；
- 不搜索 PATH，不回退系统 Wasmtime，不从源码编译。

## 5. `WasmComponentProvider 1.0.0`

### 5.1 安装合同

Provider 要求：

- artifact role 必须为 `wasm-component` 且后缀为 `.wasm`；
- 文件必须是 Component Model header `0061736d0d000100`，不是 core module；
- artifact SHA-256/size 必须与 bundle inventory 完全一致；
- OS/arch 必须声明当前已验证目标；
- runtime id 必须是 `wasmtime-47.0.3`；
- logical export 必须是 `wasi:cli.run`，WASI profile 必须是 `wasi-preview2`；
- 插件不能提供 Wasmtime CLI 参数。

### 5.2 固定执行 policy

Host 固定的关键参数包括：

```text
run
--config=NUL                 # Windows；Linux 为 /dev/null
-Ccache=n
-Wfuel=1000000000
-Wmax-memory-size=67108864
-Wmax-instances=8
-Wmax-tables=8
-Wmax-memories=4
-Wtrap-on-grow-failure=y
-Wnan-canonicalization=y
-Wrelaxed-simd-deterministic=y
-Wthreads=n
-Wshared-memory=n
-Wcomponent-model=y
-Wconcurrency-support=y
-Shttp=n -Sthreads=n -Sconfig=n -Skeyvalue=n -Stls=n
-Sinherit-network=n -Stcp=n -Sudp=n
-Sinherit-env=n
```

`--config` 指向平台空设备，`-Ccache=n` 禁止读取或写入用户 Wasmtime 编译缓存。这两项来自真实
AppContainer 兼容门禁：不能为了默认配置目录给沙箱扩大文件权限。

额外 Host 上限：

- request wall time：10 秒；
- stdout 单消息：standard profile 1 MiB；
- stderr：standard profile 64 KiB；
- Windows OS memory：256 MiB；
- WASM linear memory：64 MiB；
- process fuel：1,000,000,000；
- active process：1；
- Job Object 管理整个进程树；
- 普通 invoke 被取消时立即终止对应 Wasmtime 进程。

fuel 是进程生命周期预算，不是插件可重置的单次调用额度。Host wall time仍逐 request 生效。

## 6. Rust/WASM SDK 与 reference plugin

### 6.1 SDK

`packages/candlescope-plugin-sdk-rust-wasm` 固定：

| 字段 | 值 |
| --- | --- |
| package | `candlescope-plugin-sdk-wasm` |
| version | `0.1.0` |
| rust-version | `1.97.1` |
| dependencies | `[]` |
| target | `wasm32-wasip2` |

SDK 实现 strict JSON parser/canonical encoder、duplicate key 拒绝、safe integer、深度/容器/字符串/
消息边界，以及 handshake、describe、activate、invoke、eventBatch、healthCheck、cancel、
prepareUpgrade、deactivate、shutdown。协议只写 stdout；诊断只写 stderr。

### 6.2 Reference

`examples/plugin-platform-wasm-rust` 同时包含 source、预构建 component、manifest、control
transcript、CycloneDX、许可证和 supply-chain lock。固定结果：

| 字段 | 值 |
| --- | --- |
| component SHA-256 | `99af98c6163433b9a951a9494b4bb154bb2195913021661e201d0f1fcf10bcea` |
| component size | 185,621 bytes |
| transcript responses | 12 |
| transcript SHA-256 | `447b2b15f8be4d1f5a8232f0af1a400acaa30e78eaace277bc29197fb38f3ed4` |
| clean offline builds | 2 per OS gate |

构建使用 source path remapping；Windows 路径分隔符和 Linux mount path 不进入最终 component。
Windows 与 WSL 的 component digest、size 和 transcript digest 完全一致。

## 7. 跨主机与能力边界证据

同一 module 和输入在 Windows 与 Ubuntu-22.04/WSL2 得到 canonical output SHA-256：

```text
2ee2c1e4b12d5ccf7bcbe1068cfe89c379baa2c78a8458bc36d8b4f77d98e3f9
```

两边的 reference sandbox probe 均为：

```json
{
  "environmentCount": 0,
  "externalFileRead": false,
  "networkConnected": false,
  "processStarted": false
}
```

这证明当前 WASI policy 没有环境、任意文件、网络和子进程的 ambient capability。它不证明
Linux 有 Windows AppContainer 的 OS 隔离，所以支持矩阵明确写作 `wasi-boundary-only`。

## 8. 故障诊断与真实生命周期

### 8.1 精确故障码

| 故障 | 实测 Host 诊断 |
| --- | --- |
| process fuel 耗尽 | `PLUGIN_WASM_FUEL_EXHAUSTED` |
| `unreachable` / panic trap | `PLUGIN_WASM_TRAP` |
| linear memory grow 超过 64 MiB | `PLUGIN_WASM_MEMORY_LIMIT_EXCEEDED` |
| request wall time 超限 | `PLUGIN_PLATFORM_TIMEOUT` |
| stderr 超限 | `PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED` |
| Host cancel | `PLUGIN_WASM_CANCELLED` |

cancel fixture 使用 WASI clock 阻塞，而不是 CPU 死循环；否则会先触发 fuel，无法证明取消路径。
实测取消会终止 Wasmtime，下一次调用重新启动成功。

### 8.2 安装、更新与清理

真实产品路径完成：

- fresh install、fresh-process semantic probe、quick repeat、check；
- 同版本新 bundle update 与 activation rollback；
- 53 次真实 lifecycle/invoke 操作；
- cancel 后重启恢复；
- Host stop 后 process/supervisor 残留均为 0；
- 关闭 WASM Provider 后 catalog 明确不可用、安装保留、supervisor 为 0；
- 没有系统 Wasmtime fallback。

## 9. 签名 Marketplace

真实 Marketplace 门禁验证：

1. SBOM application id/version/license 与签名 release 完全一致；
2. SDK component 与签名 dependency list 完全一致；
3. 安装期 semantic probe 在 AppContainer 内完成；
4. 激活、health、invoke 和 WASI boundary probe 均成功；
5. trust mode 为 `marketplace-sandboxed`；
6. sandbox status 为 `windows-appcontainer`；
7. active process limit 为 1；
8. AppContainer SID 与 launch config 有 machine-readable 证据；
9. stop 后 process/supervisor 残留为 0。

因此 WASM 不会因为“本机开源项目”自动回退为宽 `trusted-local`。本地用户仍可选择本地信任，
但 Provider 的 WASI ambient capability 边界不随该选择放宽。

## 10. 支持矩阵与不支持项

| 场景 | Phase 8 状态 |
| --- | --- |
| Windows amd64 local bundle | verified，默认关闭 |
| Windows amd64 signed Marketplace | verified，WASI + AppContainer |
| Ubuntu-22.04/WSL2 x86_64 build/run | verified，WASI boundary only |
| 原生 Linux Host 集成 | 未声明 |
| macOS / arm64 | 未验证 |
| WASIp1 | 不支持 |
| 任意 WASI preview 混用 | 不支持 |
| custom WIT Host imports/typed exports | 不支持 |
| plugin-supplied Wasmtime flags | 不支持 |
| preopened directory / inherited env / socket / subprocess | 不支持 |
| system Wasmtime fallback | 不支持 |
| 用户机器 source build | 不支持 |

## 11. 可复现命令

```powershell
# Rust SDK
cd packages/candlescope-plugin-sdk-rust-wasm
cargo +1.97.1 test --locked

# Reference 双 clean build + transcript
backend\.venv\Scripts\python.exe examples\plugin-platform-wasm-rust\scripts\build_release.py `
  --cargo C:\Users\<user>\.cargo\bin\cargo.exe `
  --wasmtime <verified-wasmtime.exe>

# 冻结合同与记录证据校验
backend\.venv\Scripts\python.exe backend\scripts\plugin_platform_multi_runtime_phase8.py

# Phase 8 回归
cd backend
.venv\Scripts\python.exe -m pytest -q `
  tests/test_plugin_platform_multi_runtime_phase8.py `
  tests/test_plugin_runtime_registry_phase8.py `
  tests/test_plugin_platform_multi_runtime_phase8_gate.py
```

真实门禁的输入目录必须包含两份固定 archive、`RELEASES.md` 和 `Cargo.lock`；GitHub API
projection 与 attestation 会在运行时重新验证。仓库保存的最终证据是：

- `backend/tests/fixtures/plugin_platform_multi_runtime/phase8_contract_v1.json`
- `docs/perf-baselines/plugin-platform-v2/multi-runtime-phase8-2026-08-03-windows-wsl2-amd64.json`

### 11.1 最终验证结果

最终验证显式保持 `REPLAY_ENABLED=0` 和 `CANDLESCOPE_PLUGIN_RUNTIME_WASM_ENABLED=0`，
避免本机常驻 replay/runtime 配置污染默认关闭态门禁：

- Phase 8 真实 Windows/WSL2 门禁：通过，58.4 秒；
- 冻结证据校验：通过，component SHA-256 为
  `99af98c6163433b9a951a9494b4bb154bb2195913021661e201d0f1fcf10bcea`，真实证据 SHA-256 为
  `49080efabb2dbcbc692bcf5d6cbde443e9bccdf7f29450a9e36d7c447042cbe0`；
- Phase 8 Provider/Registry/gate：`12 passed`；
- Phase 0～8 全部多运行时门禁：17 个测试文件，`125 passed`；
- 完整插件后端回归：57 个测试文件，`521 passed`；
- Python SDK：在按 `.[dev]` 创建的一次性隔离环境中 `98 passed`；
- Rust/WASM SDK：`cargo +1.97.1 test --locked`，`3 passed`；
- Rust reference：`cargo +1.97.1 check --locked --target wasm32-wasip2` 通过；
- Phase 8 精确 Python 文件集：Ruff lint 与 format check 通过；两个 Rust crate 的
  `cargo fmt --check` 通过。

全 backend 聚合测试还包含当前工作树中独立、未提交的 replay 开发和真实归档锁，不作为 Phase 8
退出门。一次未隔离运行暴露了本机启用 replay 导致的归档锁冲突；显式关闭 replay 后，受影响的
生命周期测试与上述完整插件回归均已通过。没有修改 replay 文件、放宽测试阈值或忽略失败。

## 12. 回滚

最小运行时回滚：

```powershell
$env:CANDLESCOPE_PLUGIN_RUNTIME_WASM_ENABLED='0'
```

完整多运行时回滚还可关闭：

```powershell
$env:CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED='0'
$env:CANDLESCOPE_PLUGIN_RUNTIME_PROVIDER_SEAM_ENABLED='0'
$env:CANDLESCOPE_PLUGIN_RUNTIME_REGISTRY_ENABLED='0'
$env:CANDLESCOPE_PLUGIN_RUNTIME_REGISTRY_NETWORK_UPDATES_ENABLED='0'
```

关闭开关不会删除 bundle、activation history 或共享 runtime cache。恢复开关后会重新核对 receipt、
runtime supply、probe 和 Registry identity。Phase 8 没有数据库迁移，也不改变 schema-v2 Python 或
v1 compatibility 的默认路径。

## 13. 阶段判定

Phase 8 的退出门全部满足：

- Windows/Linux 至少一个真实构建：通过；
- 相同 module digest：通过；
- 相同输入 canonical output：通过；
- fuel、trap、OOM、wall、stderr、cancel 可诊断：通过；
- Windows signed Marketplace 不回退宽本地访问：通过；
- Ubuntu/WSL 支持声明限定为 WASI boundary：通过；
- 所有新开关默认关闭：通过；
- Phase 1～7 frozen contract 无重录回归：通过。

Phase 9 才开始实现 GitHub assessment/scaffold；本阶段没有 clone 或执行任意第三方仓库。
