# CandleScope 通用插件平台 v2 — Phase 0 执行记录

> 状态：**实现与技术验收已完成，待独立提交**，2026-07-22。
>
> 基线：`codex/plugin-platform-v1@400e520a9fa8a816229a5ad64330f10e8de9ddaf`。
>
> 边界：本阶段只增加文档、fixture、测试和基准工具/产物；没有改变生产运行时、API、
> 前端、registry、用户数据库或默认路由。Phase 1 尚未开始。

## 1. 验收结论

Phase 0 的技术退出门全部满足；形成独立阶段提交后才可以开始 Phase 1。不得把本记录解释
为 manifest v2、通用 Host API、OS 沙箱、Sandbox UI、数据提供器或交易能力已经交付。

| 退出门 | 结果 | 证据 |
| --- | --- | --- |
| 冻结 v1 SDK 与 HTTP/range/WS 契约 | 通过 | 采集器在运行任何负载前精确验证文件和 canonical wire SHA-256，漂移时退出码非零 |
| 基线可重复、机器可读 | 通过 | 标准模式写入 schema 化 JSON；临时文件加 `os.replace` 原子落盘；quick 子进程测试通过 |
| `.cspkg` install/check/upgrade/rollback | 通过 | 隔离临时 plugin root 完成完整生命周期，rollback 恢复 `0.1.0` |
| 两个官方 runtime 真实探针 | 通过 | 固定大小/摘要的 Pyne 与 Pine Compatibility bundle 全新安装，Host `ready=2/2`，真实执行均成功 |
| L0～L4 威胁模型 | 通过 | 本文逐级列出资产、威胁、当前事实、后续控制、证明方式与停止条件 |
| 六个参考插件契约 | 通过 | 固定 JSON fixture；测试验证数量、ID、阶段、贡献点、权限和禁止权限完整性 |
| v1 全量回归与 package smoke | 通过 | SDK 30、backend 1934、frontend 2334 项测试均通过；构建与 package smoke 通过 |
| 无生产行为变化 | 通过 | diff 仅涉及 `.gitignore` 基线白名单、docs、`backend/scripts` 与 `backend/tests` |

本阶段交付物：

- 总体执行方案：`GENERAL_PLUGIN_PLATFORM_V2_EXECUTION_zh.md`；
- 可重复采集器：`backend/scripts/plugin_platform_phase0_baseline.py`；
- 采集器门禁：`backend/tests/test_plugin_platform_phase0_baseline.py`；
- 六个参考插件合同：
  `backend/tests/fixtures/plugin_platform_v2/reference_plugins_v1.json`；
- 标准机器产物：
  `perf-baselines/plugin-platform-v2/phase0-2026-07-22-windows-amd64.json`。

## 2. 冻结的当前契约

采集器先验证契约，再运行性能负载。下列任一值漂移都会 fail closed，不会生成一个看似
成功的新 artifact。

### 2.1 文件摘要

| 文件 | SHA-256 |
| --- | --- |
| SDK Hello transcript fixture | `dd217159ab14af660481610cef5c369edbde3e7577bcf78e85bfad16cab5cf9c` |
| indicator HTTP/range/WS fixture | `b0db39165b888522ec27055ac1bfaf949b65a34a5d42932728d37aa767d77a47` |
| 官方 release lock | `23e03c28a32b42a0d523aefc0bd19db34d33fb840b41cbf44e0348fc263249f2` |

### 2.2 Canonical wire 摘要

| 公开表面 | Canonical SHA-256 |
| --- | --- |
| SDK 完整 transcript | `021825fb264a63555e0eb331f24f6ea0632b0d2a0c962ef89a35673526391ba2` |
| HTTP compute | `b2467295cc14ec0e772e97fce195f236739cecb260e967190d73af305ab6f7ee` |
| HTTP range | `ba66866f0330d62f1121c3a5ff77d6339d786df796672c9795e78a293c1ebb26` |
| indicator WebSocket | `6326a43822000618fe2feddcfe9b28b5a02e3663be106ef1dabfa511f6e418f2` |

`PLUGIN_PLATFORM_V1_EXECUTION_zh.md` 中的
`70b698c7dfb96de660a7986d4f387f1f222cf72ee71149e2009a6d5d4dddf09c`
是 Phase 1 当时的 Hello transcript 历史快照；后续结构化 Render IR 已显式演进 fixture。
Phase 0 冻结的是当前 HEAD 的 `021825...`，不回写历史记录，也不把两者宣称为相同字节。
今后如需改变公开语义，必须新增协议/fixture 版本与迁移说明，不能只更新本脚本常量。

## 3. 基准环境、方法与结果

### 3.1 实测环境

| 项目 | 本次值 | 支持含义 |
| --- | --- | --- |
| OS | Windows 11 `10.0.26200`, AMD64 | Phase 0 实测环境 |
| CPU | 32 logical CPUs | 仅记录机器规模，不用于跨机器外推 |
| Python | CPython 3.12.7 | backend、SDK、installer 与 sidecar 实测 |
| Node.js | v22.14.0 | frontend 全量门禁实测 |
| 浏览器 inventory | Chrome 150.0.7871.129 | 仅记录已安装版本；本基线未执行浏览器交互性能 |
| FastAPI / pytest | 0.115.6 / 7.4.4 | artifact 中记录的关键 Python 依赖 |

### 3.2 方法边界

- registry cold start 每个场景运行 5 个全新 Python 进程，包含 import、
  `RuntimeHostService` 构造、start、health snapshot 和 stop；0/10/50 项均为 disabled，
  因而不启动 sidecar。
- control RPC 与 indicator batch 使用仓库真实 Hello console sidecar、真实 supervisor 和
  `IndicatorRuntimeService`，不允许落入 legacy adapter。
- K 线、逐笔和 full order book 使用真实 Data Engine 组件，但输入是确定性合成数据；
  不包含交易所网络、SQLite、回填、浏览器绘制或 `89m + 深历史` 的总链路成本。
- installer lifecycle 使用真实 bundle 构建器、真实 verifier/installer/registry，但根目录
  是一次性临时目录。
- official runtime 基线读取 release lock 中精确文件名、大小和 SHA-256，验证两个真实
  `.cspkg` 后在全新临时 plugin root 安装，再由真实 Host 完成 descriptor 和执行探针。
- `p95` 对 5 个 cold-start 样本等于该组最大值；样本量不足以作为稳定尾延迟 SLO。
- 所有数字是单机、单次 Phase 0 基线，不是容量承诺，也不能据 0/10/50 场景的轻微波动
  推断单调关系。

### 3.3 标准模式结果

| 场景 | 负载 | 结果 |
| --- | --- | --- |
| registry，0 disabled | 5 个新进程 | median 259.934 ms，p95/max 270.885 ms |
| registry，10 disabled | 5 个新进程 | median 281.407 ms，p95/max 318.507 ms |
| registry，50 disabled | 5 个新进程 | median 265.470 ms，p95/max 286.034 ms |
| Hello sidecar 首次 descriptor | 真实进程启动/握手/describe | 104.346 ms |
| control RPC | 50 次 × 10 bars | median 0.435 ms，p95 0.613 ms，max 0.690 ms |
| indicator batch | 10 次 × 1500 bars | median 33.613 ms，p95/max 42.985 ms；1 series/1500 points |
| K 线 EventBus | 10,000 events | enqueue 34.135 ms；全部交付 51.758 ms；dropped=0 |
| TradeFlowEngine | 20,000 agg trades | 488.797 ms，40,916.765 events/s；全部接受 |
| FullOrderBookEngine | 1000 levels/side + 10,000 deltas | 2346.201 ms，4262.209 deltas/s；gaps=0，state=live |
| order-book projection | depth 100 | 0.028 ms，snapshot available |

installer 生命周期结果：

| 操作 | 时间 | 语义结果 |
| --- | ---: | --- |
| 首装 `0.1.0` | 9724.601 ms | `changed=true`, `reusedInstallation=false` |
| 同包快速重复 | 998.559 ms | `changed=false`, `reusedInstallation=true` |
| check | 908.569 ms | active `0.1.0` |
| 升级 `0.2.0` | 9098.691 ms | `changed=true` |
| rollback | 1032.968 ms | activation 发生变化，恢复 `0.1.0` |

官方 runtime 结果：

| Runtime | 锁定 bundle | 全新安装 | 实际探针 |
| --- | --- | ---: | --- |
| `candlescope.pyne` 0.2.0 | 13,006,218 bytes；`a1812e0e...d34a216` | 15,042.255 ms | `pyne`，`ok=true`，1 series/2 points |
| `candlescope.pine-compat` 0.2.0 | 2,997,572 bytes；`f14094a6...c1a378` | 21,435.868 ms | `pine`，`ok=true`，1 series/2 points |

两包总安装 36,479.002 ms，Host 启动 521.393 ms，health 为
`configured=2, enabled=2, ready=2, failed=0`。

机器产物 SHA-256 为
`b37d2a2bc74eda8a111cd5a3d6c9365065377b28d7adcc7dd83b05605998bced`。

## 4. 六个参考插件合同

这些是验收合同，不是已交付插件，也不会在 Phase 0 被注册或启动。

| 参考插件 | 首个目标阶段 | 要证明的产品边界 | 必需能力 | 明确禁止 |
| --- | ---: | --- | --- | --- |
| Hello Command | 1 | 通用 descriptor、生命周期、命令、取消和 malformed input | 无 | network/file/secrets/account/live trade |
| Read-only Market Scanner | 7 | 非指标产品能力、原生声明式 UI、设置、存储、job、受控行情读取 | symbol/bar read、private storage | direct network/file/secrets/account/trade |
| Sandbox View | 8 | 隔离 iframe 与一次性 UI Bridge，不进入宿主 JS realm | 无；storage 可选 | direct network/file/secrets/account/trade |
| Mock Market-data Provider | 10 | symbol/history/realtime provider、标准化、序列、重同步与背压 | `market.data.provide` | secrets/account/trade |
| Paper Broker | 11 | account/order 形状、确定性、幂等、risk gate、审计和 kill switch | account read、trade simulate | network/secrets/live submit/cancel |
| v1 Script Runtime Adapter | 13 | Pyne/Pine 进入统一 catalog，同时保持 v1 wire 和 release 不变 | 无 | network/file/secrets/account/trade |

Fixture 还冻结了每个参考插件的逐条 acceptance。测试要求恰好 6 个唯一 ID、目标阶段
与总方案一致、贡献点非空、能力集合不相交，并确保所有合同都明确禁止 `trade.submit`。

## 5. 支持矩阵

支持必须区分“项目要求”“package metadata”“本次已测”和“尚未声明”。

| 表面 | 声明/目标 | Phase 0 证据 | 当前结论 |
| --- | --- | --- | --- |
| CandleScope 开发/运行 | Python 3.11+，Node.js 20+ | Python 3.12.7、Node 22.14.0 全量门禁 | 本机组合已验证；不是所有组合认证 |
| Plugin SDK v1 | `Requires-Python >=3.11`；classifiers 3.11/3.12/3.13 | 3.12.7 上 test/build/offline package smoke | metadata 覆盖 3.11～3.13；本次仅实测 3.12 |
| 官方 Pyne/Pine `.cspkg` | Windows/AMD64/CPython 3.12 | 两个 release-lock artifact 全新安装和真实探针 | 这是当前唯一正式锁定的官方 runtime 平台 |
| Chrome | 现代 Chromium 产品目标 | Chrome 150 inventory；frontend test/build | 本次未做真实浏览器插件性能/交互认证 |
| Edge/Firefox/Safari | 未在 Phase 0 声明 | 无 | 不宣称已验证 |
| Linux/macOS plugin sandbox | 后续对应 OS 隔离实现 | 无官方 lock artifact、无 OS 沙箱证据 | 不宣称支持不可信插件或 L3/L4 |
| Python 3.13 SDK 安装 | Phase 1 退出门目标 | 本次未运行 3.13 interpreter | Phase 1 前仍是待验证项 |

即使 CandleScope 主程序能在 Linux/WSL 启动，也不能据此推导 v2 插件的文件、网络、
进程树或 L4 安全边界已经成立。

## 6. 威胁模型

### 6.1 资产与信任边界

受保护资产包括用户行情/研究数据、插件私有状态、CandleScope 数据库与缓存、宿主进程和
DOM、CPU/内存/磁盘/句柄、用户文件、网络身份、凭据、账户、订单、审计记录，以及插件
更新/回滚链。

攻击者包括恶意作者、被接管的发布账号、被替换的 artifact、依赖投毒、被利用的正常
插件、伪造 localhost 请求、恶意行情源，以及通过重放/竞态/资源耗尽扩大权限的本地进程。

信任边界固定为：bundle/installer → catalog/activation → sidecar OS sandbox → Host RPC
broker → Data/Storage/Network/File/Secret/Trade adapter → UI iframe bridge。插件不能通过
Python import、原始对象引用、DOM、数据库连接或 direct socket 绕过任一边界。

### 6.2 L0～L4 覆盖

| 等级 | 主要威胁 | 当前基线事实 | v2 必须控制与证明 | 停止条件 |
| --- | --- | --- | --- | --- |
| L0 展示 | descriptor 冒充、重复 ID/字段、oversize/deep JSON、路径穿越、压缩炸弹、图标/文案欺骗、artifact 替换 | v1 对 pinned bundle 做大小/摘要/manifest 校验，wire parser 严格；尚无通用 manifest v2 或 publisher 信任 | Phase 1/3：canonical schema、重复 key/NaN/unknown/limits、全文件清单、路径/解压预算、staging；Phase 12：签名、publisher、透明摘要、撤销 | 未经校验的内容可进入 catalog；同版本 artifact 可原地替换；安装失败能产生半激活 registry |
| L1 私有状态 | namespace 碰撞、越权读取、quota 绕过、迁移损坏、rollback 读到新格式、通知/任务骚扰 | 当前没有通用 v2 storage/job capability | Phase 4/5：grant、代际 handle、namespace、quota、事务迁移、旧数据 snapshot、disable/revoke 清理；故障注入证明原子性 | 插件可取得路径/DB handle；revoke 后仍能读写；迁移失败无法恢复旧版本和数据 |
| L2 市场数据 | 全库抓取与外传、跨 scope 查询、未来数据/no-lookahead、来源/终态伪造、事件洪泛、慢 consumer 拖垮 producer、旧 handle 重放 | 内部 EventBus/engines 有真实基线，但不是公共插件 API；v1 script runtime 只接收宿主提供的 bars | Phase 4/6：精确 exchange/market/symbol/interval/range scope，coverage/source/finality，额度、分页、credit/backpressure、drop/coalesce、sequence/resync，脱敏投影与 generation | 插件拿到 DataManager/EventBus/SQLite/raw Python object；队列无界；慢插件阻塞 Data Engine；revoked handle 仍可用 |
| L3 外部交互 | SSRF、localhost CSRF、云 metadata、DNS rebinding、任意文件读写、符号链接逃逸、子进程/环境变量绕过代理、HTTP endpoint 暴露 | v1 明确不是完整沙箱；Windows 只能保证主 sidecar 终止，不保证恶意后代、direct file/network 或资源隔离 | Phase 4/8/9：Windows restricted token/AppContainer/Job Object/ACL 的实证，direct network/file deny；域名/端口/TLS/IP policy proxy；file picker opaque handle；随机 endpoint token、Origin/CSRF/body/rate limits；iframe unique origin+CSP | direct socket/path/child process 能绕过 broker，却把插件标为 sandboxed；localhost endpoint 无随机授权；iframe 能访问 parent/origin/storage |
| L4 凭据/交易 | secret 外传、账户串线、重复下单、cancel/fill race、超限订单、未知结果误重试、确认 UI 伪造、kill switch 失效、审计篡改 | 当前通用插件平台没有 L4；Paper/Live 均未授权 | Phase 11/12：只给签名可信插件 opaque secret handle；独立高风险 grant；OrderIntent canonicalization、scope/risk/idempotency、unknown 状态、server-authoritative audit、全局 kill switch；先 Paper 确定性再 Live | unsigned/local-developer 获得 L4；插件接触明文 secret；风险门可绕过；unknown 自动重下；Paper 未过门就接 Live |

### 6.3 跨等级威胁登记

| 威胁 | 影响等级 | 所有者阶段 | 必须形成的证据 |
| --- | --- | ---: | --- |
| 依赖/发行链投毒 | L0～L4 | 3、12 | pinned digest、签名链、SBOM、publisher identity、不可变 artifact、撤销与离线复核 |
| Sidecar 逃逸与后代残留 | L1～L4 | 4 | direct file/network/child-process 负例、进程树回收、CPU/RSS/disk/handle quota、crash storm |
| Host RPC confused deputy | L1～L4 | 2、4 | plugin/entrypoint/generation/request/capability/scope 全绑定；伪造、重放、超时、取消负例 |
| 数据外传与跨插件串线 | L2～L4 | 4、6、9 | namespace/scope 交叉矩阵、revocation next-call fail、网络 broker 审计、无 raw data object |
| UI XSS/钓鱼/宿主 DOM 逃逸 | L0～L4 | 7、8 | iframe unique origin、CSP、一次性 MessageChannel、origin/token/generation/size 验证、确认 UI 由宿主持有 |
| Localhost CSRF/跨站调用 | L3～L4 | 9 | 随机 endpoint token、Origin/Host/method/content-type/body/rate limit 负例、重启失效 |
| 资源耗尽与背压 | L1～L4 | 2、4～11 | 有界 queue、credit、coalesce/drop 策略、公平调度、quota、trip/restart budget、主图持续可用 |
| 更新/迁移/回滚损坏 | L0～L4 | 3、5、12 | 全包先验证、staged activation、故障点注入、registry 原子替换、data snapshot、旧版本真实复启 |
| 凭据盗用 | L4 | 11、12 | secret 永不进入 manifest/env/stdout/log；handle 精确 scope/expiry/generation；使用审计和 revoke |
| 重复或越权交易 | L4 | 11 | Paper 固定 seed、idempotency conflict、cancel/fill/reconnect/unknown、risk/kill switch/audit 全链路 |

威胁模型的“覆盖”表示风险、所有者和证明门已定义，不表示尚未实施的控制已经有效。尤其在
Phase 4 完成 OS 级负例前，任何后端 sidecar 都只能被视为 `first-party-pinned` 或
`local-trusted`，不得向用户声称能安全运行不可信 marketplace 代码。

## 7. 可重复执行

从仓库根目录运行标准基线；两个官方 bundle 必须使用 release lock 中的精确文件名：

```powershell
$env:PYTHONPATH = 'H:\program\CandleScope-plugin-platform\packages\candlescope-plugin-sdk\src;H:\program\CandleScope-plugin-platform\backend'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
python backend\scripts\plugin_platform_phase0_baseline.py `
  --output docs\perf-baselines\plugin-platform-v2\phase0-2026-07-22-windows-amd64.json `
  --official-bundle-dir <pinned-bundle-directory> `
  --fail-on-missing-official `
  --browser 'Chrome 150.0.7871.129'
```

CI 或开发快速验证可以使用 `--quick --skip-installer`；它只验证可执行性和精确契约，不能
替代标准性能 artifact 或官方 runtime 探针。

本次门禁：

| 门禁 | 结果 |
| --- | --- |
| 新 Phase 0 测试 | `4 passed in 2.89s` |
| v1/Host/installer/routes 定向回归 | `125 passed, 4 warnings in 62.80s` |
| Plugin SDK | Ruff check、format check、compileall；`30 passed`；sdist/wheel build；隔离 venv `--no-index --no-deps` 安装与 console sidecar smoke 通过 |
| Backend 全量 | `1934 passed, 4 warnings in 154.28s`；随后 `compileall app tests scripts` 通过 |
| Frontend `npm run check` | architecture allowlist=0、typecheck、ESLint、`2334 passed`、Vite production build 456 modules 全部通过 |
| 变更 Python 文件 | Ruff check、format check、`py_compile` 通过 |

4 条后端 warning 均为既有 FastAPI `on_event` 弃用提示，不是 Phase 0 新失败。

## 8. 回滚与下一阶段入口

本阶段没有写入用户 plugin registry、数据库、路由或生产配置；installer 和 Host 探针都在
一次性临时根目录运行。回滚只需移除 Phase 0 文档、fixture、测试、采集器、curated
artifact 及其 `.gitignore` 白名单，不需要迁移数据或恢复运行时。

当前变更尚未 stage 或 commit；这是有意保留给用户确认的 Git 边界，不把未提交工作树
冒充为可独立 revert 的阶段提交。Phase 1 在该边界处理前保持未开始。

测试退出后没有 Hello sidecar 或基准进程。installer/Host 的临时 plugin root 已由
`TemporaryDirectory` 回收；当前命令安全策略拒绝了额外的 `Remove-Item` 清理，因此仍有
两个只读来源/构建缓存目录：
`%TEMP%\candlescope-phase0-official-400e520`（两个已校验 `.cspkg`）和
`%TEMP%\candlescope-sdk-phase0-5d20368918e34c6587be693166406cb1`（SDK sdist/wheel）。
它们不是 activation，也不在用户 plugin registry 中，可独立手工删除。

Phase 1 可以开始的前提是：

1. 后续变更以当前四个 wire hash 和三个文件 hash 为不可静默改写的兼容门；
2. `platform_v2` 使用新命名空间，现有 SDK 顶层 import 和
   `candlescope.script-runtime/1` 不变；
3. Hello Command 只实现 L0 command，不借 Phase 1 提前开放 network/file/data/secrets/trade；
4. Phase 1 仍为独立、可单独 revert 的提交，并重复 SDK package smoke、backend 全量和
   frontend 全量门禁。

Phase 0 完成不自动授权发布、安装用户插件、修改 marketplace 或继续到 Phase 2。
