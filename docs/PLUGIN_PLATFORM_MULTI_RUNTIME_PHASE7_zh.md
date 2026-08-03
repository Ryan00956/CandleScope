# CandleScope 多运行时插件平台 Phase 7 完成证据

## 1. 阶段结论

Phase 7 已在 Windows amd64 上交付可真实安装、探测、运行、取消、更新和回滚的
`node-module` Runtime Provider，以及无运行时依赖的 TypeScript SDK 和预构建 ESM 参考插件。

本阶段不是把 `npm install` 搬进 CandleScope。最终边界是：

- 作者在发布前完成 TypeScript 编译、依赖打包、source map 清洗和 SBOM；
- Marketplace 用户机器只接收不可变 `.cspkg`，不运行 npm、npx、corepack 或生命周期脚本；
- Host 从签名 Runtime Registry 安装固定 Node.js，绝不回退到系统 Node；
- Provider 只接受 `.mjs` 入口和闭合的静态相对 ESM 图；
- Node Permission Model、Windows AppContainer 和 Job Object 同时生效；
- child process、Worker、网络和安装目录写入默认全部拒绝；
- Provider、Registry 网络更新和多运行时总开关继续默认关闭。

Windows amd64 的真实门禁已通过。Linux、macOS、arm64 没有本阶段真实证据，因此不宣称支持。

## 2. 实施前背景审计

### 2.1 Phase 1～6 已提供的基础

进入本阶段时，平台已有 manifest schema 3、Runtime Provider API、不可变 artifact inventory、
activation record、独立 probe 进程、Supervisor、generation/cancel、签名 Runtime Registry、
runtime-bound trust/grant、AppContainer 和 Job Object。

Node 虽然已经出现在 schema 和 `restricted-node-v1` profile 中，但 Provider 数量仍为 0；这只是一处
被保留的扩展位，不能安装或运行 Node 插件。

### 2.2 实际缺口

审计确认不能仅添加一条 `node.exe main.js` 命令：

1. 没有签名、固定、可离线复用的 Node 发行版；
2. bundle 构建器只认识单个入口，不认识入口导入的静态模块；
3. 旧 Marketplace 依赖校验把依赖等同于 Python wheel，不能表达静态打包的 Node SDK；
4. 没有 Node Provider 的参数白名单、模块解析和 source map 路径规则；
5. 没有与 Python SDK transcript 对照的 TypeScript JSONL SDK；
6. 没有能直接离线安装的 Node reference `.cspkg`；
7. 没有 crash、hang、OOM、stderr flood、cancel、child、Worker 和进程残留证据；
8. Node 在 AppContainer 中会因默认 realpath 从盘符根开始遍历而启动失败；
9. 关闭 Provider 后是否保留安装、是否错误回退系统 Node 尚未验证。

### 2.3 首发取舍

首发选择 ESM-only，而不是同时支持 ESM/CJS/package.json loader：

- 入口与所有可执行模块必须是 `.mjs`；
- 只接受静态 `import` / `export ... from`；
- 只接受 `./`、`../` 相对路径或 `node:` builtin；
- 动态 import、bare package、loader hook、`--require`、`--eval` 全部拒绝；
- 所有相对模块最终必须落在安装目录的 `runtime/` 下；
- bundle inventory 必须与从入口可达的静态模块图完全相等。

这使 GitHub 上的 Node 项目可以通过一次薄构建适配进入平台，同时避免把包管理器和任意模块搜索
路径带到用户机器。

## 3. 已执行计划

1. 审计 Node.js 官方 Release、校验文件、签名、许可证和压缩包完整内容；
2. 发布连续签名的 Runtime Registry revision 4；
3. 新增 `NodeModuleProvider 1.0.0` 并接入 installer、probe runner 和 Core；
4. 扩展 bundle envelope 与 Provider request，表达入口和完整静态 ESM inventory；
5. 要求 Provider 证明 inventory 等于静态可达图；
6. 实现依赖为 0 的 `@candlescope/plugin-sdk-node 0.1.0`；
7. 用 Python SDK 的冻结 transcript 校验 TypeScript SDK 语义；
8. 生成确定性 SDK tarball、dist、类型声明与 supply-chain lock；
9. 实现 TypeScript reference plugin、scrubbed source map、CycloneDX SBOM 和离线 bundle；
10. 扩展 Marketplace，使签名 SBOM 可表达静态打包依赖，同时继续完整覆盖 Python wheels；
11. 建立真实 install/check/update/rollback/lifecycle/cancel/fault 门禁；
12. 建立 Permission Model 与 Windows AppContainer 双层攻击门禁；
13. 修复 Node realpath 与 AppContainer 的真实兼容问题；
14. 验证签名 Marketplace 安装期 probe、激活、调用和清理；
15. 冻结合同、真实证据和默认关闭/回滚边界。

## 4. 固定 Node.js 供应链

### 4.1 Registry revision 4

本阶段固定：

| 字段 | 值 |
| --- | --- |
| runtime id | `node-24.19.0` |
| version | `24.19.0+LTS-Krypton` |
| archive | `node-v24.19.0-win-x64.zip` |
| archive SHA-256 | `57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73` |
| archive size | `37,304,352` bytes |
| extracted files | `1,989` |
| extracted size | `106,112,876` bytes |
| license | `MIT` |
| Registry revision | `4` |
| Registry SHA-256 | `36eb70c60f77779d56e05273b78bc1f54221c1de0ec1116fdd1e98b3f30adfcf` |

上游来源固定到 [Node.js v24.19.0 Release](https://nodejs.org/dist/v24.19.0/)、
`v24.19.0` tag object `1dbab0e88e7ccc6b44c801418911767447796ed0` 与 commit
`cdc1b38d40cb567b7ad0b39c86addf830a0af0ae`。

Registry 同时绑定 4 份证据：`SHASUMS256.txt`、固定 commit 的 changelog、固定 commit 的
`LICENSE`、`SHASUMS256.txt.sig`。Node Release 没有发布本项目 Registry schema 所期望的标准
SBOM，因此历史名为 `vendor-sbom` 的兼容槽明确绑定“固定 tag 的 vendor LICENSE inventory”；
文档和状态都不把它误称为 CycloneDX SBOM。

真实门禁还复核了解压后的 `node.exe`：

- Authenticode 状态 `Valid`；
- subject 为 OpenJS Foundation；
- certificate thumbprint 为 `8EA1D142EA3F46023BACA38C23A7E7AE6AFCE30C`；
- 可执行文件 SHA-256 为 `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237`。

### 4.2 缓存语义

真实空目录门禁证明：

- 首次 ensure 下载 5 份文件；
- quick repeat 不再下载；
- offline cache hit 成功；
- fresh Python process 命中相同 runtime、probe 和 executable digest；
- offline cache miss 返回 `PLUGIN_RUNTIME_REGISTRY_OFFLINE_CACHE_MISS`；
- revision 4 回滚到 revision 3 后，Node 返回 `PLUGIN_RUNTIME_REGISTRY_RUNTIME_NOT_FOUND`；
- 再激活 revision 4 后，同一离线缓存恢复可用。

不会检查 PATH，也不会调用系统 Node。

## 5. `NodeModuleProvider 1.0.0`

### 5.1 安装期合同

bundle envelope 为入口和全部 `.mjs` 生成独立 SHA-256、size、OS/arch 和 `node-bundle` role。
Installer 分别把 `entry_artifacts` 与完整 artifact inventory 传给 Provider。Provider 从每个入口遍历
静态 import，最后要求：

```text
所有入口静态可达的 .mjs 集合 == bundle 声明的 node-bundle 集合
```

缺文件、多文件、符号链接、越界路径、动态 import、bare package、非 UTF-8、重复/不合法 source
map 都会 fail closed。

### 5.2 固定启动描述

Provider 生成的启动参数由 Host 决定：

```text
node.exe
  --permission
  --allow-fs-read=<installation>
  --no-addons
  --no-global-search-paths
  --disallow-code-generation-from-strings
  --preserve-symlinks
  --preserve-symlinks-main
  --disable-proto=throw
  --unhandled-rejections=strict
  --max-old-space-size=<64..384>
  [--enable-source-maps]
  <exact-main.mjs>
```

`--preserve-symlinks*` 不是允许符号链接。bundle、安装器和 Provider 都先拒绝符号链接；这两个参数
只阻止 Node 在 AppContainer 内从 `C:\` 开始 realpath，避免为了启动一个已验证的不可变模块而给
磁盘根目录增加访问权。

插件只能在 allowlist 中选择 `--enable-source-maps` 与 64～384 MiB heap。`--allow-worker`、
`--allow-child-process`、`--inspect`、`--require`、`--eval`、loader hook 等均不可声明。

## 6. TypeScript SDK

`packages/candlescope-plugin-sdk-typescript` 交付：

- strict UTF-8 / strict JSON parser；
- duplicate key、非有限数、非法 surrogate、深度、item 和 message size 限制；
- canonical JSON 与 SHA-256；
- handshake、describe、activate、invoke、eventBatch、healthCheck；
- host.call / host.response；
- Deferred、cancel、prepareUpgrade、deactivate、shutdown；
- stdout 协议隔离，插件普通输出重定向到 stderr；
- `.d.mts` 类型声明；
- 无 dependencies、optionalDependencies、peerDependencies 或 scripts。

固定发布物：

| 字段 | 值 |
| --- | --- |
| package | `@candlescope/plugin-sdk-node` |
| version | `0.1.0` |
| Node | `v24.19.0` |
| TypeScript | `6.0.3` |
| tarball | `candlescope-plugin-sdk-node-0.1.0.tgz` |
| tarball SHA-256 | `300eb4c1e7de4893492da7cc6080f46dca9bbeaa504aa489d52fc664326d9815` |
| tarball size | `24,819` bytes |

构建脚本直接调用固定 `node.exe` 与仓库锁定的 `tsc` 文件，不调用 npm。clean build、tarball safe
extract、自测试、Python transcript response digest 对照和 4 响应 serve smoke 全部通过。

## 7. 离线参考插件

`examples/plugin-platform-node-typescript` 是完整发布参考，不依赖用户机器编译：

- source：`src/main.mts`；
- runtime：预构建 `main.mjs` 与 SDK `sdk.mjs`；
- source map：只含 `src/main.mts`，不含构建机绝对路径或 URI；
- control transcript：13 个完整 lifecycle 响应；
- CycloneDX：插件和静态打包 SDK 的许可证与依赖；
- supply-chain lock：Node、tsc、SDK、每个 artifact 和 transcript 摘要；
- manifest：`node-module` + `node-24.19.0` + ESM 入口。

参考 transcript SHA-256 为
`755dcac9d779b1a49f82da0e8bbd7da8d1a2543d6e4f38442c150b44a3d32624`。

## 8. Marketplace 与 SBOM

Marketplace 仍要求：

1. bundle SHA、manifest SHA、SBOM SHA 全部由签名发布绑定；
2. SBOM application id/version/license 与发布记录一致；
3. SBOM components 与签名 dependency list 完全一致；
4. 所有 Python wheels 都必须出现在签名 dependency list；
5. Node 的静态打包依赖可以由 SBOM + 签名发布共同声明。

因此修改 SDK、许可证、SBOM 或发布依赖中的任一项，都会在执行插件前失败。

## 9. 真实运行与故障门禁

### 9.1 安装与生命周期

真实产品路径完成：

- fresh install；
- fresh-process semantic probe；
- quick repeat；
- check；
- 同版本新 bundle update；
- activation rollback；
- Core 启动与 51 次真实 JSONL invoke；
- deferred invocation cancel，最终 `pending=0`；
- Host stop 后 process/supervisor 残留均为 0。

更新后回滚恢复初始 installation id 和 bundle SHA。关闭 Node Provider 后 catalog 明确不可用，安装
仍保留，supervisor 为 0，没有系统 Node fallback。

### 9.2 精确故障码

| 故障 | 实测 Host 诊断 |
| --- | --- |
| 启动即 crash | `PLUGIN_PLATFORM_EXITED` |
| 活跃事件循环且不 handshake | `PLUGIN_PLATFORM_TIMEOUT` |
| 64 MiB heap OOM | `PLUGIN_PLATFORM_EXITED` |
| 超过 4 KiB stderr | `PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED` |

单独 unresolved top-level await 在事件循环为空时会让 Node 以 code 13 退出，不是真正 hang；最终
hang fixture 使用活动 timer，避免把 Node 语义差异误记为 Host timeout。

## 10. 双层沙箱证据

### 10.1 Node Permission Model

在不依赖 AppContainer 的直接 Provider launch 中：

- `spawnSync`：`ERR_ACCESS_DENIED`；
- `Worker`：`ERR_ACCESS_DENIED`；
- `maxProcesses=1`；
- isolated search path 生效；
- stderr 为 0。

### 10.2 Windows AppContainer 攻击矩阵

真实 `restricted-node-v1` 结果：

| 攻击/能力 | 实测 |
| --- | --- |
| 读 bundle 外 secret | 拒绝 |
| 读 Host source | 拒绝 |
| 写 installation | 拒绝 |
| 写 private directory | 允许 |
| 连回环 TCP | 拒绝 |
| 启动 child process | 拒绝 |
| active process limit | `1` |
| network capabilities | `[]` |

签名 Marketplace 还真实完成安装期 sandbox probe、激活、health、invoke 和停止清理。状态为
`marketplace-sandboxed` / `windows-appcontainer`，残留进程与 supervisor 都为 0。

## 11. 默认关闭与回滚

以下开关仍默认 `false`：

- `CANDLESCOPE_PLUGIN_RUNTIME_PROVIDER_SEAM_ENABLED`
- `CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED`
- `CANDLESCOPE_PLUGIN_RUNTIME_NODE_ENABLED`
- Runtime Registry 网络更新开关
- 所有 Live authority 开关

最小回滚：关闭 `CANDLESCOPE_PLUGIN_RUNTIME_NODE_ENABLED`。效果是停止并隐藏 Node backend
capability，但不删除安装、grant 或共享 runtime cache；重新开启并核对同一 runtime identity 后可恢复。

供应链回滚：Runtime Registry 从 revision 4 回到 revision 3，Node 立即不可解析，不尝试系统 Node；
重新激活已签名 revision 4 后恢复。

## 12. 证据与复现命令

冻结文件：

- `backend/tests/fixtures/plugin_platform_multi_runtime/phase7_contract_v1.json`
- `docs/perf-baselines/plugin-platform-v2/multi-runtime-phase7-2026-08-03-windows-amd64.json`
- `packages/candlescope-plugin-sdk-typescript/supply-chain.lock.json`
- `examples/plugin-platform-node-typescript/supply-chain.lock.json`
- `examples/plugin-platform-node-typescript/probes/node-control.json`

核心命令：

```powershell
backend\.venv\Scripts\python.exe backend\scripts\plugin_platform_multi_runtime_phase7.py
backend\.venv\Scripts\python.exe -m pytest backend\tests\test_plugin_platform_multi_runtime_phase7.py backend\tests\test_plugin_platform_multi_runtime_phase7_gate.py -q
backend\.venv\Scripts\python.exe packages\candlescope-plugin-sdk-typescript\scripts\check.py `
  --node <managed-node.exe> `
  --tsc frontend\node_modules\typescript\bin\tsc `
  --type-roots frontend\node_modules\@types `
  --python-transcript packages\candlescope-plugin-sdk\tests\fixtures\hello_command_transcript_v2.json
```

`--run-real` 需要冻结的 Node Release/evidence 目录；普通 release gate 只读取已提交合同与真实证据，
不会访问网络。

### 12.1 最终自动化结果

| 测试组 | 结果 |
| --- | ---: |
| Phase 7 contract/unit/recorded gate | 14 passed |
| 全部 plugin / Runtime Registry 后端回归 | 535 passed |
| Python SDK | 98 passed |
| TypeScript SDK clean build/package/self-test/serve | passed |
| Ruff + format | passed |
| frontend Plugin Platform architecture | passed |
| frontend TypeScript | passed |
| frontend ESLint | passed |
| frontend tests | 2,905 passed |
| frontend production build | passed |

完整 `npm run check` 的第一步仍报告 4 条与本阶段无关的 Lightweight Charts import 违规：
`SingleChartPanes.tsx` 以及并行工作树中的 3 个 replay 文件。Phase 7 没有修改这些前端文件，也没有
把它们纳入提交；其余前端子门均已单独通过。前端测试首轮还遇到一次固定端口 24678 竞争，完整
重跑结果为 `2,905 passed / 0 failed`。

## 13. 本阶段未宣称的能力

- 不支持 CJS、package.json exports/imports 或任意 loader；
- 不在用户机器执行 npm install、postinstall 或源码编译；
- 不支持 child process 或 Worker manifest 扩权；
- 不支持 Node 原生 addons；
- 不支持系统 Node fallback；
- 不宣称 Linux/macOS/arm64 已验证；
- 不授予账户、密钥、Paper 或 Live 交易能力；
- 不代表任意 GitHub Node 仓库无需 Adapter 即可直接运行。

Phase 7 的结果是建立了可复用 Node Adapter 目标：第三方项目只需在发布端输出闭合 ESM 图、薄
JSONL Adapter、SBOM 和冻结证据，就能复用 CandleScope 的安装、生命周期、沙箱、权限、更新和
回滚能力。
