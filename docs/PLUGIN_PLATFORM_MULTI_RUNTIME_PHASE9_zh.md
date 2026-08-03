# CandleScope 多运行时插件平台 Phase 9 完成证据

## 1. 阶段结论

Phase 9 已把“参考 GitHub 项目、生成 Adapter、人工审核、构建 `.cspkg`、本地安装”变成一条
可复现但不会自动执行不可信仓库的流程：

- `candlescope-plugin v3 assess-github`：只读固定 GitHub repository metadata；
- `v3 scaffold-adapter`：原子生成七类 pending/non-executable 工程；
- `v3 source-lock-check`：验证人工完成的 assessment、artifact、license、receipt、transcript；
- `v3 build`：只打包 build receipt 绑定的 platform content；
- `v3 inspect`：复用现有 `.cspkg` 严格验证器；
- 第二个真实项目 `BurntSushi/aho-corasick` 已从 signed tag assessment 走到 Windows x86_64
  native Adapter 的 fresh install 与 fresh-process check。

本阶段没有实现“输入 GitHub URL 后自动 clone/build/run”。assessment 与执行授权仍是两个独立
状态；pending scaffold 永远不能进入 build，GitHub helper 关闭后已构建 `.cspkg` 仍独立可用。

## 2. 实施前背景与决策

### 2.1 为什么不直接复用旧 bundle builder 的源目录

现有 `.cspkg` builder 的冻结内容布局只接受：

```text
manifest.json
licenses/
runtime/
source-maps/
wheels/
web/
schemas/
probes/
sbom/
```

Adapter 工程还需要 assessment、source lock、build receipt、Cargo/Gradle/npm 配置、源文件、测试和
惰性 CI 模板。这些是开发/审核材料，不应伪装成 runtime artifact。Phase 9 因而采用两层布局：

1. **开发工程**：保留源码、assessment、lock、receipt、CI 模板和证据；
2. **打包暂存目录**：只复制被 completed build receipt 逐文件绑定的 manifest、runtime、wheel、
   web、schema、source map、SBOM、licenses，并把完成态 transcript 映射到 `probes/<id>.json`。

底层 builder 没有放宽，也不接受新的任意顶层目录。若 package input 在 source-lock check 与复制
之间发生变化，v3 build 会再次比较 size/SHA-256 并失败。

### 2.2 assessment 不等于授权

assessment 的决定固定为：

```json
{
  "status": "assessment-only",
  "mayBuild": false,
  "mayInstall": false,
  "mayExecute": false,
  "nextStep": "human-review-and-complete-source-lock"
}
```

它只观察 repository、显式 tag/40 位 commit、tag object、commit/tree/parents/signature、Release
metadata、语言、许可证和固定清单中的包元数据。它不 clone、不下载 Release asset、不运行
workflow/install script/build script/二进制，也不把默认分支当依赖。

## 3. 已执行计划

1. 冻结 repository URL、tag/commit、固定 origin、response size 和 strict JSON 契约；
2. 新增默认关闭开关与显式 `--allow-network`；
3. 实现原子 Markdown + JSON assessment；
4. 实现七类 pending scaffold 与 Host-private import 静态拒绝；
5. 冻结 `candlescope.adapter-source-lock/1` 和 build receipt 完成门禁；
6. 把开发树与 platform bundle 暂存树分开；
7. 将 v3 命令接入现有 `candlescope_plugin.py`；
8. 使用真实 `aho-corasick 1.1.4` assessment；
9. 审核 public Rust API、crates、传递依赖和双许可证；
10. 实现不复制上游算法的 native thin Adapter；
11. 修复 MSVC PE timestamp/CodeView GUID 导致的双构建差异；
12. 生成 control transcript、SBOM、licenses、receipt 与 completed source lock；
13. 两次生成 byte-identical `.cspkg`；
14. 执行 Provider flag-off、fresh install、quick repeat、fresh check、disable/enable、helper rollback
    和 uninstall；
15. 固化 contract fixture、真实 gate、机器证据和本阶段文档。

## 4. GitHub assessment 接口

### 4.1 开关与认证

```powershell
$env:CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED = "1"

# 可选；匿名 API 未限流时不需要。token 只发往固定 api.github.com origin。
$env:GITHUB_TOKEN = (gh auth token)
```

支持 `GITHUB_TOKEN`、`GH_TOKEN`，前者优先。token 必须无空白/控制字符且不超过 4096 字节；它
不会进入 URL、assessment、命令输出或错误 details。客户端禁用 redirect，路径必须以
`/repos/` 开头，单响应最大 4 MiB。

匿名首次真实运行因 GitHub rate limit 返回：

```text
PLUGIN_GITHUB_IMPORT_RATE_LIMITED
```

没有生成 Markdown 或 JSON 半成品。改用已有 GitHub CLI credential 后完成 assessment；这同时
验证了失败原子性与可选认证路径。

### 4.2 可执行命令

```powershell
backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v3 --json assess-github `
  https://github.com/BurntSushi/aho-corasick `
  --tag 1.1.4 `
  --output docs\plugin-adapters\aho-corasick-assessment.md `
  --allow-network
```

固定结果：

| 字段 | 值 |
| --- | --- |
| repository | `https://github.com/BurntSushi/aho-corasick` |
| tag | `1.1.4` |
| annotated tag object | `4fb4e803829ae895e3c11f7a93e05c2a65a6a719` |
| commit | `17f8b32e3b7c845ef3c5429b823804f552f14ec9` |
| tree | `4b6ad335b05185e2d7be6d675502c7de6126d5fb` |
| tag/commit verified | `true` / `true` |
| GitHub Release | `not-published` |
| assessment identity | `c2944ab10b1920ad6729fa6bf546e0516e781c30515e594c0f1daada8b37fb5d` |
| assessment file SHA-256 | `c7ba06a5e797dc560dcabb64eb81c0921def9225352a10397ef75604bc1999fe` |

Markdown 与机器 JSON 分别位于：

- `docs/plugin-adapters/aho-corasick-assessment.md`
- `docs/plugin-adapters/aho-corasick-assessment.json`

## 5. 七类 Adapter 脚手架

实际模板名：

```text
java-library
native-cli
python-package
node-library
wasm-computation
service
sandbox-view
```

示例：

```powershell
backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v3 --json scaffold-adapter native-cli `
  --id candlescope.aho-corasick `
  --name "aho-corasick Search" `
  --publisher candlescope-contributors `
  --license GPL-3.0-only `
  --assessment docs\plugin-adapters\aho-corasick-assessment.json `
  --output examples\plugins\aho-corasick-adapter
```

共同保证：

- 输出目录必须不存在，先写同父目录 staging，再原子 rename；
- manifest 为 schema v3，但 runtime artifact 不存在；
- source lock、build receipt、license、SBOM、conformance 都是 pending；
- `thirdPartyCodeExecutionApproved=false`；
- 不生成活动 `.github/workflows/`；只生成需人工固定 action commit 后才能复制的 `ci/` 模板；
- 生成源码不允许 `from app.*`、`import app.*` 或 `backend/app/`；
- Python/Node/Java/Rust/WASM 只引用公共 SDK/协议边界。

## 6. completed source lock 门禁

`v3 source-lock-check` 至少验证：

- assessment raw SHA-256、assessment identity、repository、pin kind 与 commit 一致；
- assessment 仍声明未执行第三方代码且 `mayExecute=false`；
- artifact pin 使用 HTTPS、非零 size 和 lowercase SHA-256；
- 本地 license bytes 与审核记录完全一致；
- manifest runtime target 与 entry artifact 一致；
- build receipt 固定 commit、离线状态、是否源码编译和至少两次可复现构建；
- build receipt path-sorted、无重复，并精确覆盖每个 package input；
- control transcript 使用语言无关 schema，response 数量和摘要完整；
- manifest probe 绑定 semantic transcript digest；
- CycloneDX 至少列出 Adapter 与依赖；
- third-party notices 不再 pending，工程里没有任何 `*.pending`；
- reviewer、UTC 时间、public API、capabilities、Host imports、execution approval 均已填写；
- 所有源码合计不超过 16 MiB且不导入 Host 内部模块。

pending lock、runtime/wheel 篡改、receipt 缺项、license 篡改、transcript 漂移或 Host internal import
任一发生都会在构建前失败。

## 7. `aho-corasick` thin Adapter

### 7.1 为什么选择它

这是 ta4j 之外的第二个真实 GitHub 项目，满足：

- 稳定 signed tag 与 public Rust API；
- 纯算法库，无 GUI、daemon、网络、数据库或账户能力；
- 适合验证 native CLI Adapter，而不是再次验证 Java；
- 上游没有 GitHub Release，能验证“没有现成二进制时必须人工固定源码包并离线构建”。

### 7.2 供应链

| 包 | 版本 | crate SHA-256 | size | license |
| --- | --- | --- | ---: | --- |
| aho-corasick | 1.1.4 | `ddd31a130427c27518df266943a5308ed92d4b226cc639f5a8f1002816174301` | 184,015 | Unlicense OR MIT |
| memchr | 2.8.3 | `cf8baf1c55e62ffcace7a9f06f4bd9cd3f0c4beb022d3b367256b91b87513d98` | 99,165 | Unlicense OR MIT |

构建工具固定为：

```text
rustc 1.97.1 (8bab26f4f 2026-07-14)
cargo 1.97.1 (c980f4866 2026-06-30)
x86_64-pc-windows-msvc
```

`Cargo.lock`、Adapter source、公共 Rust/WASM SDK source、build script 和 `.cargo/config.toml`
全部进入 `supply-chain.lock.json`。构建命令固定 `--locked --offline --release`，并设置
`CARGO_NET_OFFLINE=true`、`CARGO_INCREMENTAL=0` 和固定 `SOURCE_DATE_EPOCH`。

MSVC 默认 PE timestamp 与 CodeView GUID 在两个 target dir 间不同。真实失败后加入 linker
`/Brepro`；随后两个隔离 target dir 的 executable bytes 完全一致。没有通过固定到同一个 target
directory 来掩盖差异。

固定 runtime：

| 字段 | 值 |
| --- | --- |
| path | `runtime/adapter.exe` |
| SHA-256 | `dc2a213ff9bb2ef7db8a9c499a583655e2bb32bdd47d9234c5f63a779ab5924d` |
| size | 427,008 bytes |
| clean offline builds | 2 |

### 7.3 业务映射边界

Adapter 只调用上游公开 API：

```rust
AhoCorasickBuilder
find_iter
find_overlapping_iter
```

它不复制自动机、DFA/NFA、prefilter 或搜索核心。自有代码只负责：

- 输入字段与 unknown field 拒绝；
- pattern 数量、总字节、haystack 和最大 match 数上限；
- `standard`、`leftmost-first`、`leftmost-longest` 映射；
- ASCII case-insensitive 与 overlapping 合法组合；
- 规范化 byte offset、pattern index、truncated 与 provenance 输出；
- `candlescope.plugin/2` 生命周期。

插件声明零 required/optional permission，不访问网络、文件、数据库、环境变量、密钥或交易能力。

## 8. 构建、inspect 与安装步骤

### 8.1 离线双构建

首次开发者需要在明确审核后获取 Cargo registry source；正式 release build 只离线运行：

```powershell
cd examples\plugins\aho-corasick-adapter
cargo fetch --locked                 # 只用于准备审核缓存
cargo test --locked --offline
..\..\..\backend\.venv\Scripts\python.exe scripts\build_release.py `
  --report evidence\build-report.json
```

完成 provenance（参考项目命令，必须显式 reviewer/UTC/approval）：

```powershell
..\..\..\backend\.venv\Scripts\python.exe scripts\finalize_release.py `
  --reviewer <reviewer-id> `
  --confirmed-at <YYYY-MM-DDTHH:mm:ssZ> `
  --approve-reviewed-source
```

### 8.2 source lock、bundle 与 inspect

```powershell
cd H:\program\CandleScope

backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v3 --json source-lock-check examples\plugins\aho-corasick-adapter

backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v3 --json build examples\plugins\aho-corasick-adapter `
  dist\aho-corasick-adapter-0.1.0-windows-x86_64.cspkg `
  --os windows --arch x86_64

backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v3 --json inspect dist\aho-corasick-adapter-0.1.0-windows-x86_64.cspkg
```

两次 bundle build 完全相同：

| 字段 | 值 |
| --- | --- |
| bundle SHA-256 | `9fbb59299b2f3d900b4d8a2bd1c677f36b801eb27cfd39c2dca73efa44bcc249` |
| size | 475,101 bytes |
| transcript responses | 12 |
| semantic transcript SHA-256 | `6984851b56ecf44f860501c4fee6043742e34afa20e9198c102d858f344c91e2` |

### 8.3 fresh install/check

```powershell
$env:CANDLESCOPE_PLUGIN_RUNTIME_PROVIDER_SEAM_ENABLED = "1"
$env:CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED = "1"
$env:CANDLESCOPE_PLUGIN_RUNTIME_NATIVE_ENABLED = "1"
$env:CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED = "0"

$root = Join-Path $env:TEMP "candlescope-aho-fresh-root"
$bundle = "dist\aho-corasick-adapter-0.1.0-windows-x86_64.cspkg"
$digest = "sha256:9fbb59299b2f3d900b4d8a2bd1c677f36b801eb27cfd39c2dca73efa44bcc249"

backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v2 --root $root --json install $bundle --sha256 $digest --enable

# quick repeat；必须 reusedInstallation=true、changed=false
backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v2 --root $root --json install $bundle --sha256 $digest --enable

backend\.venv\Scripts\python.exe backend\scripts\candlescope_plugin.py `
  v2 --root $root --json check candlescope.aho-corasick
```

真实 check 返回 `runtimeKind=native-executable`、`runtimeId=native-host`、state `active`，fresh
process semantic probe 与 manifest transcript digest 一致。

## 9. 测试与机器证据

### 9.1 Phase 9 专用测试

```powershell
backend\.venv\Scripts\python.exe -m pytest `
  backend/tests/test_plugin_github_import_v3.py `
  backend/tests/test_plugin_platform_multi_runtime_phase9.py `
  backend/tests/test_plugin_platform_multi_runtime_phase9_gate.py -q
```

结果：`37 passed`。真实 gate 约 27 秒，包含两次 clean/offline Rust release build 和两次
`.cspkg` build，不以 fixture 替代 executable/install。

### 9.2 兼容性与 SDK 回归

全量 `test_plugin*.py` 共 60 个文件。由于安装器、Marketplace、AppContainer 和各阶段真实
runtime gate 串行执行超过单次 10 分钟工具上限，回归按互斥文件集合拆分执行，并保持
`REPLAY_ENABLED=0`、`CANDLESCOPE_PLUGIN_RUNTIME_WASM_ENABLED=0` 的默认关闭基线：

- 旧插件体系 39 个文件分四组：`126 + 128 + 68 + 71 = 393 passed`；
- Phase 0–9 的 21 个文件：`165 passed`；
- 合计：`558 passed`，没有跳过失败项，也没有把超时记为通过；
- 首次生命周期组的 2 个失败仅由开发机 `.env` 打开 Replay、且本机没有
  `data/replay-agg-trades/trade-index.json` 引起；显式恢复默认关闭基线后该组
  `71 passed`，插件断言全部执行通过。

SDK 与 Adapter 独立验证：

- Python SDK 在由 `packages/candlescope-plugin-sdk[dev]` 创建的一次性隔离环境中
  `98 passed`；
- Rust/WASM SDK：`cargo test --locked --offline`，`3 passed`；
- Aho-Corasick Adapter：`cargo test --locked --offline`，`3 passed`；
- Adapter `cargo fmt --all --check` 与本阶段 Python Ruff 检查通过。

其他验证：

```powershell
D:\anaconda\Scripts\ruff.exe check `
  backend/app/plugin_github_import_v3 `
  backend/tests/test_plugin_github_import_v3.py `
  backend/tests/test_plugin_platform_multi_runtime_phase9.py `
  backend/tests/test_plugin_platform_multi_runtime_phase9_gate.py `
  backend/scripts/candlescope_plugin.py `
  backend/scripts/plugin_platform_multi_runtime_phase9.py `
  examples/plugins/aho-corasick-adapter/scripts

cd examples\plugins\aho-corasick-adapter
cargo fmt --all --check
cargo test --locked --offline
```

机器证据：

- `backend/tests/fixtures/plugin_platform_multi_runtime/phase9_contract_v1.json`
- `docs/plugin-platform-multi-runtime-evidence/2026-08-03/phase9-gate.json`
- `examples/plugins/aho-corasick-adapter/evidence/build-report.json`

真实 gate 还验证：

- GitHub helper 关闭时 assessment 在网络/输出前返回
  `PLUGIN_GITHUB_IMPORT_FEATURE_DISABLED`；
- native Provider 关闭时安装返回 `PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE`；
- fresh install、quick repeat、fresh-process check；
- disable 后 installation 保留，enable 后再次 check；
- GitHub helper 保持关闭时已构建 bundle 继续运行；
- uninstall 后临时 registry 为空。

## 10. 回滚、支持范围与未交付项

Phase 9 回滚：

```powershell
$env:CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED = "0"
```

这只关闭新的 GitHub metadata assessment，不删除 scaffold、source、`.cspkg`、已安装内容或
activation。bundle/install/runtime 不读取此开关，真实 gate 已证明关闭后仍能 fresh check。

本阶段只声明：

- assessment：公开 GitHub repository，显式 tag 或完整 commit；
- reference Adapter：Windows x86_64 native executable；
- 安装信任：本地开发者路径；`marketplaceApproved=false`；
- 不声明 macOS/Linux/arm64 的这个 native artifact；
- 不声明 GitHub 私有仓库、自动 clone、自动 source build 或 Marketplace URL import；
- 不把可选 GitHub token 当发布者认证；
- 不把 source review 自动等同于文件、网络、账户、密钥或 Live trading 权限。

Marketplace 多运行时 release、签名、撤销和 preview rollout 属于 Phase 10；完整故障注入、4 小时
soak、生产浏览器与 GA 支持矩阵属于 Phase 11。
