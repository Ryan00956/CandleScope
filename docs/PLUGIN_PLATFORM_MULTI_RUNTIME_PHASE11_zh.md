# CandleScope 多运行时插件平台 Phase 11 GA 验收记录

> 当前封板状态：`COMPLETE`（2026-08-04）。矩阵、SDK、ta4j、headed 浏览器、全量回归、
> 不可缩短的 4 小时 soak 和 GA finalizer 已全部通过；支持声明限定为 Windows 11 x86_64。

## 1. 阶段背景与验收原则

Phase 0～10 已经分别交付 schema v3、Runtime Provider seam、Python 等价迁移、native、Managed
Runtime Registry、Java/ta4j、trust UX/Windows sandbox、Node、WASM、GitHub assessment/scaffold 和
Marketplace 多运行时供应链。Phase 11 不再增加 runtime 或分发能力，只回答四个发布问题：

1. 五种 runtime 能否读取同一语言无关 conformance 事实源并保持各自协议实现一致；
2. no-plugin、v1、v2 Python 与 multi-runtime 能否在同一当前代码上同时成立；
3. 真实进程、沙箱、Plugin Manager、业务 corpus、故障与长时资源是否可核验；
4. 新能力关闭后，既有 v2 Python 与 v1 frozen wire 是否原样可用。

验收坚持：

- 不缩短 release soak，不因失败调宽阈值；
- 不用单元测试代替 fresh process、headed browser 或 Windows 进程证据；
- 不把 WSL 的 WASM 验证扩张成 Linux 桌面 GA；
- 不把 `trusted-local` 等同于 Marketplace sandbox、账户权限或 live authority；
- 不把 ta4j 与 Python 输出的不同解释成未经验证的优劣；
- 每个 gate 生成严格 JSON evidence，最终由独立 finalizer fail closed 汇总。

## 2. 实施计划与交付

本阶段按以下顺序完成：

1. 审计 Phase 0～10 合同、开关、真实证据、SDK 构建和现有全量测试命令；
2. 建立 `packages/plugin-conformance/suite.json` 作为 28 个协议/故障 case 的事实源；
3. 增加 Python checker，并让 Python、Java、TypeScript SDK 消费同一 suite/transcript 摘要；
4. 实现 no-plugin、v1-only、v2-Python-only、multi-runtime 和 12 flags-off 矩阵；
5. 实现四套 SDK 的 lint/test/build/package/determinism/fresh-install 总门禁；
6. 实现 ta4j point-in-time、Python 独立对照、JVM 性能和资源证据；
7. 实现真实五插件 soak、Windows 原生进程资源采样和 release 4 小时硬下限；
8. 用 production frontend build 和 headed Chrome 完成 Marketplace + trusted-local 双流程；
9. 运行 backend 全量 pytest、frontend `npm run check`；
10. 发布八份指南，运行 finalizer，更新总执行文档并精确提交。

新增门禁入口：

- `backend/scripts/plugin_platform_multi_runtime_phase11.py`：矩阵与 GA finalizer；
- `backend/scripts/plugin_platform_multi_runtime_phase11_sdk.py`：四 SDK 总门禁；
- `backend/scripts/plugin_platform_multi_runtime_phase11_ta4j.py`：业务 corpus/性能；
- `backend/scripts/plugin_platform_multi_runtime_phase11_soak.py`：五插件长时门禁；
- `backend/scripts/plugin_platform_multi_runtime_phase11_regression.py`：全量回归；
- `backend/scripts/plugin_platform_multi_runtime_phase11_browser_evidence.py`：浏览器证据验签；
- `backend/scripts/plugin_platform_multi_runtime_phase11_support.py`：共享真实运行/资源采样；
- `backend/tests/test_plugin_platform_multi_runtime_phase11.py`：门禁自测。

## 3. Unified conformance 与启动矩阵

`packages/plugin-conformance/suite.json` 固定 28 个 case，覆盖 handshake/feature negotiation、
manifest parity、generation、重复 id/字段、invoke、host.call、health、升级/关闭、invalid JSON/UTF-8、
NaN、深度/大小、stdout/stderr、timeout/cancel/late response、process exit/restart/circuit、lease revoke 和
canonical output。

事实源结果：

| 项目 | 结果 |
| --- | --- |
| case count | `28` |
| suite SHA-256 | `sha256:078c556078466599e6de52d19058b9eb225a2d61d3efe22474b7ddcc39143788` |
| SDK consumers | Python、Java、TypeScript |
| runtime transcripts | Python、native、Java、Node、WASM 各 1 份 |
| manifest probe binding | 5/5 |
| Python selected test files | 5 组，全通过 |

真实启动矩阵全部通过：

- no-plugin：0 plugin、0 Supervisor；
- v1-only：wire SHA-256
  `sha256:e9a8f2839c2a5d0ad9a8a57a98ef0635c4563f6654bc0fd83b67b2d49c9a66c9` 不变；
- v2-Python-only：fresh、quick repeat、fresh process、update、rollback 和清理通过；
- multi-runtime：Python/native/Java/Node/WASM 五进程并存，5 个 Supervisor，调用摘要稳定；
- all flags off：12 个 flag 均为字符串 `0` 且 runtime 观察值 false，Provider 只剩
  `python-module`，v2 Python 可用、v1 wire 不变。

矩阵同时重跑 Phase 3～10 的 native、Registry、Java、sandbox、Node、WASM、GitHub 和 Marketplace
真实 gate；五进程结束后 residual process/Supervisor 为 `0/0`。最终重跑耗时 `345.756s`，四种
启动模式都显式记录 `result=pass`。

## 4. 故障注入

Phase 11 重新执行 8 个当前生产合同测试，并读取 Node/WASM 已保存 fault evidence：

- disk full：安装 transaction 原子失败；
- cache corruption：quarantine 后从 verified archive 恢复；
- network loss：verified offline cache 可用，miss fail closed；
- stale generation：迟到 invoke 被拒绝；
- host.call cancel race：pending call 被取消；
- restart storm：entrypoint circuit 打开；
- hang：`PLUGIN_PLATFORM_TIMEOUT`；
- crash/process exit：`PLUGIN_PLATFORM_EXITED`；
- WASM cancel/fuel/memory/trap：稳定的 `PLUGIN_WASM_*` 错误码。

本轮 8 个目标 nodeid 为 `8 passed in 3.23s`。没有把 error/hang/cancel 合并为一个模糊异常，也
没有用延长 timeout 或提高 restart budget 掩盖失败。

## 5. SDK 发布门禁

| SDK | 真实门禁 | 结果摘要 |
| --- | --- | --- |
| Python `0.2.0` | Ruff lint/format、pytest、两次 wheel、strict wheel RECORD、fresh venv offline install | `98 passed`；46 个 RECORD hash；wheel byte-identical |
| Java `0.1.0` | JDK 25、`--release 17 -Xlint:all -Werror`、两次 JAR、自测 | 16 main/8 test classes；JAR byte-identical |
| TypeScript `0.1.0` | Node 24.19、TS 6.0.3、两次 tarball、自测/serve | stdout isolation；tarball deterministic |
| Rust/WASM | fmt、clippy、test、release、crate package、reference component | 全通过；crate/component digest 已保存 |

Java 的两个自定义协议异常显式标为 process-local、不可序列化，因而使用
`@SuppressWarnings("serial")` 消除 `-Xlint:all -Werror` 的真实阻断；没有降低 compiler warning 门禁。
Python wheel 验证会逐条校验 METADATA/WHEEL/RECORD、entrypoint、size 和 SHA-256，并在全新 venv
离线安装。当前 pinned build environment 没有 `twine`，因此没有在线安装未固定工具，而是使用
标准库完成更严格的 wheel 内容验证。

## 6. ta4j point-in-time 与性能

上游冻结为 ta4j `0.23.0`、commit
`896d7138a9d1818fe6725b89b433ba7860b8f654`；Adapter JAR SHA-256 为
`sha256:19c60a36d178d9e9340c4133ed0d60f4d80e4c19c3e17e01aaca6231bdcd6060`。

五组冻结输入分别独立运行 ta4j 与干净的 Python Elliott plugin commit
`bd2846d4a1d9f83ba965d91b1a6e22340fc22a61`。结果：

- case count `5`，`futurePivotCount=0`；
- stable cases SHA-256
  `sha256:04fa67c73ad3dfedb1c788d7d4fc56d79f1e90ccf08837d386a9251e9c49904c`；
- JVM startup `64.871ms`；cold 240 bars `191.586ms`；
- 20 次 hot 的 median `11.048ms`、p95/max `40.131ms`；
- 5,000 bars `298.708ms`；peak RSS `229,728,256 bytes`；
- 进程 exit `0`；stderr 只有 3 行、186 bytes 的已知有界 SLF4J 提示，stdout 未污染。

两套引擎的 scenario vocabulary 和 pivot semantics 不同。这份报告只证明相同请求时点输入下的
独立、无未来数据、可复现执行；`automaticReplacement=false`、`hindsightCalibration=false`。

## 7. Production headed Plugin Manager

先从当前 frontend 源码执行 production build（534 modules），再由专用 Phase 11 server 提供 dist
和真实 Host-owned plugin lifecycle，使用 headed Chrome 完成：

1. 打开 Settings -> Plugins；
2. Marketplace 下载、验签、stage、apply inactive、授权、activate/confirm；
3. 检查 publisher verified、official maintained、sandbox available、stable 分开展示；
4. 上传真实 native `.cspkg`；填写风险原因并勾选四项确认；
5. 经过两次确认激活 `trusted-local`；
6. 调用 `/phase11/verify` 核对实时进程、信任和沙箱；
7. 产品内 `/phase11/shutdown`，再核对清理 receipt。

结果：

- `headed=true`、`productionBuild=true`、Plugin Manager 页面真实可见；
- Marketplace Python 以 `marketplace-sandboxed` 运行，真实 AppContainer SID、Job process tree 和
  `activeProcessLimit=1` 全部存在；
- native 以 `trusted-local` 运行，`sandboxPolicy=null`，`doubleConfirmation=true`；
- 页面运行时 active process/Supervisor 为 `2/2`；
- console error、page error、unhandled rejection、unexpected HTTP 均为 `0`；
- 677 个 HTTP request；shutdown 后 residual process/Supervisor 为 `0/0`，临时 profile 删除 `1`；
- screenshot、headed trace、live/shutdown receipt 都有 size 和 SHA-256。

## 8. 全量回归

全量回归由同一 fail-closed 脚本顺序执行，只有 backend 通过才进入 frontend：

- backend：强制 `REPLAY_ENABLED=0`、`REPLAY_AGG_TRADE_ENABLED=0`，避免开发机 `.env` 把
  Plugin Platform GA 结论绑定到未提供的 Replay archive；结果为 `3127 passed, 5 warnings in
  1132.60s`，failed/skipped 均为 `0`；
- frontend：architecture、Plugin Platform boundary、TypeScript、ESLint、`2906` 项测试和 production
  build 全通过；
- Windows 控制台 evidence 输出使用 ASCII JSON escape，UTF-8 evidence 文件保持原文；失败时额外保存
  有界 `not ok` 上下文，避免 GBK 或长 TAP 尾部掩盖真实失败；
- Vite middleware-only 测试显式关闭 HMR，并在 24678 被占用时独立验证 `9/9` 通过。
- staged-only 隔离验证发现父提交的 Replay Phase 18 测试仍硬编码 schema `10`，而运行时已升级为
  `TRAINING_SCHEMA_VERSION=11`；测试改为引用共享常量后在干净 index 上 `11/11` 通过，没有纳入
  其他 Replay WIP。

最终结果写入 `docs/evidence/plugin-platform-multi-runtime-phase11-regression.json`，backend/frontend
输出分别绑定 SHA-256；失败运行不会生成新的 pass evidence。

## 9. 连续 4 小时五插件 soak

release soak 使用 Python、native、Java、Node、WASM 五个真实进程。三轮 warmup 和 baseline 完成后
才开始计时，startup/warmup 不计入 14,400 秒；每 10 秒调用、每 60 秒采样，持续核对五种 output
digest、PID、RSS、handle、thread、Supervisor、错误和 restart。Windows 资源采样优先使用 `psutil`，
不可用时用 `OpenProcess`、`GetProcessMemoryInfo`、`GetProcessHandleCount` 和 Toolhelp API，不以缺少
可选库为由跳过资源门禁。

短时自测只写 `output/phase11-soak-short.json` 且明确 `releaseQualified=false`；它不计入 GA。发布证据
必须由无 `--allow-short` 的真实 14,400 秒运行写入
`docs/evidence/plugin-platform-multi-runtime-phase11-soak-4h.json`。

最终 release-qualified 运行结果：

- 正式窗口 `14400.937s`，startup/warmup `99.281s` 不计入窗口，总墙钟 `14506.187s`；
- `7215` 次调用，即五种 runtime 各 `1443` 次；资源采样 `240` 次；
- error `0`、restart `0`，五种结果 digest 全程稳定；
- baseline/peak/final 总 RSS 分别为 `203362304`、`204685312`、`114917376` bytes；
- handle peak/final 为 `741/710`，低于 `1024` 门槛；
- shutdown 后 residual process/Supervisor 为 `0/0`；
- `releaseQualified=true`、`shortRunExplicitlyAllowed=false`，没有放宽任一阈值。

## 10. 发布文档

Phase 11 提供八份可执行文档：

1. `PLUGIN_PLATFORM_AUTHOR_RUNTIME_GUIDE_zh.md`；
2. `PLUGIN_PLATFORM_TRUSTED_LOCAL_USER_GUIDE_zh.md`；
3. `PLUGIN_PLATFORM_GITHUB_INTEGRATION_GUIDE_zh.md`；
4. `PLUGIN_PLATFORM_RUNTIME_COMPATIBILITY_MATRIX_zh.md`；
5. `PLUGIN_PLATFORM_MARKETPLACE_RELEASE_CHECKLIST_zh.md`；
6. `PLUGIN_PLATFORM_TA4J_PROVENANCE_UPGRADE_zh.md`；
7. `PLUGIN_PLATFORM_DIAGNOSTICS_BOUNDARIES_zh.md`；
8. `PLUGIN_PLATFORM_ROLLBACK_RUNBOOK_zh.md`。

作者指南给出 runtime decision tree 和 build-to-cspkg 流程；用户指南明确本地代码风险与双确认；
GitHub 指南坚持 assessment-only 和七类模板；兼容性矩阵只声明 Windows 11 x86_64；其余四份覆盖
Marketplace 发布、ta4j 升级、最小诊断数据和不删除用户状态的逐级回滚。

## 11. Evidence 索引

| Evidence | 内容 | 当前结果 |
| --- | --- | --- |
| `plugin-platform-multi-runtime-phase11-matrix.json` | conformance、启动、flags-off、故障、Phase 3～10 重跑 | pass |
| `plugin-platform-multi-runtime-phase11-sdk.json` | Python/Java/TypeScript/WASM | pass |
| `plugin-platform-multi-runtime-phase11-ta4j.json` | corpus、Python 对照、性能/资源 | pass |
| `plugin-platform-multi-runtime-phase11-browser.json` | production headed UI、沙箱、双确认、清理 | pass |
| `plugin-platform-multi-runtime-phase11-regression.json` | backend 全量、frontend check | pass |
| `plugin-platform-multi-runtime-phase11-soak-4h.json` | 五 runtime 真实 4h soak | pass、release-qualified |
| `plugin-platform-multi-runtime-phase11-ga.json` | finalizer 绑定上述六份 evidence | pass |

## 12. 支持与回滚边界

当前支持声明只到 Windows 11 x86_64；Runtime Registry 精确固定 Python/native、Temurin、Node、
Wasmtime。WSL Ubuntu 只作为 WASM cross-host evidence，不是 Linux Host GA。Marketplace stable reference
当前仅按已签 platform artifact 声明，不把所有 GitHub repository 或系统 runtime 自动纳入支持。

所有新增能力均有独立 flag，12 项全设 `0` 后必须只留下 Python Provider，并重新证明 v2 Python 与
v1 compatibility。单插件可回滚 immutable release；单 runtime 可关对应 flag 或回滚 Registry；
Marketplace 可关闭 index/update/telemetry 并追加 revocation quarantine。任何层级都不删除安装、
Grant Store、audit、quarantine receipt、用户数据库或本地 source。

## 13. 最终退出门

只有以下各项全部满足，本文状态才改为 `COMPLETE`：

- [x] 28-case unified conformance 与五 runtime transcript；
- [x] 四种启动矩阵与 12 flags-off rollback drill；
- [x] fresh/quick/fresh-process/update/rollback/failure injection；
- [x] 四套 SDK 发布门禁；
- [x] ta4j point-in-time/性能；
- [x] production headed Plugin Manager/Windows sandbox/trusted-local；
- [x] backend 全量与 frontend `npm run check`；
- [x] 真实连续 4 小时五插件 soak；
- [x] 八份发布文档；
- [x] GA finalizer 绑定全部 pass evidence，且 thresholdsRelaxed=false；
- [x] 最终 diff/check、focused regressions、精确 pathspec commit。
