# CandleScope 插件平台 v1 执行记录

本文是 CandleScope 脚本运行时插件化的实施主线。每个阶段必须在独立提交中完成，并满足本阶段退出门禁后才能进入下一阶段。

## 总目标

将 Pyne Runtime 与 Pine Compatibility Runtime 从 CandleScope 内部实现细节改为可独立发布、安装、探测、运行和回滚的脚本运行时插件，同时保持 CandleScope 面向前端的 HTTP、历史区间和 WebSocket 契约稳定。

v1 的核心边界是：

- CandleScope 拥有公开 HTTP/WS 契约、插件生命周期、K 线数据和渲染协议；
- 插件只实现版本化脚本运行时协议，不导入 CandleScope 私有模块；
- 每个插件使用独立的版本化 Python 环境，并以 sidecar 进程运行；
- Pyne 与 Pine Compatibility 通过各自的小型桥接发行包接入同一宿主协议；
- 在 sidecar 通过 shadow 对比和本文冻结的兼容门禁之前，不删除现有实现。

## 阶段状态

| 阶段 | 状态 | 交付物 |
| --- | --- | --- |
| Phase 0：冻结兼容基线 | 已完成 | HTTP compute、HTTP range/history、WebSocket realtime 黑盒 golden |
| Phase 1：Plugin SDK v1 | 已完成 | Python 3.11+ 基线、独立 SDK、协议模型、Hello Runtime、契约测试 |
| Phase 2：通用 Host/Supervisor | 已完成 | 注册表、生命周期、RPC、宿主服务、诊断 |
| Phase 3：隔离安装器 v2 | 已完成 | `.cspkg`、独立 venv、校验、探测、原子激活与回滚 |
| Phase 4：通用 Indicator Service | 已完成 | `legacy/shadow/sidecar` 路由与传输迁移 |
| Phase 5：Pyne 插件发行 | 已完成（release-ready） | Pyne host facade、发行锁与 `candlescope-plugin-pyne` |
| Phase 6：Pyne 切换与源码快照删除 | 已完成 | 完整 Render IR、默认 sidecar、可信开发 Release、首启 bootstrap 与源码快照删除 |
| Phase 7：描述符驱动前端 | 已完成 | 运行时/语言/能力描述符，无硬编码运行时联合类型 |
| Phase 8：Pine Compatibility 插件 | 已完成（development prerelease） | 公开 v0.2.0 发行锁、独立 bridge、冻结 shadow、双插件 bootstrap 与 sidecar cutover |

## Phase 0：冻结现有公开行为

### 范围

Phase 0 只增加测试、fixture 与执行记录，不修改生产运行时、路由、前端或安装逻辑。Pyne 仍来自当前 `packages/pyne-runtime` 源码快照。

黑盒测试使用一份固定 Pyne 脚本和五根固定 K 线，覆盖：

1. `POST /api/v1/indicators/compute` 的完整脚本计算响应；
2. `POST /api/v1/indicators/range` 的历史查询、目标区间裁剪、warmup、稳定 indicator identity 与 data revision；
3. `WS /api/v1/stream/indicators` 的 connected、subscribe ack、单根收盘 K 线 patch 与 unsubscribe 帧顺序。

测试只调用公开 HTTP/WS 路由，不直接调用 Pyne payload 私有函数。执行器固定为 inline，仅用于消除测试进程隔离差异；生产默认执行模式没有改变。

### Golden 规则

fixture 位于 `backend/tests/fixtures/plugin_runtime/pyne_transport_v1.json`。完整响应先按 UTF-8、JSON key 排序、紧凑分隔符和禁止 NaN 的规则 canonicalize，再计算 SHA-256。除完整哈希外，测试还显式校验顶层字段、schema 版本、脚本 identity、range coverage、revision、WS 帧类型/序号和最后一根数据点。

当前冻结值：

| 传输 | Canonical SHA-256 |
| --- | --- |
| HTTP compute | `sha256:b2467295cc14ec0e772e97fce195f236739cecb260e967190d73af305ab6f7ee` |
| HTTP range/history | `sha256:ba66866f0330d62f1121c3a5ff77d6339d786df796672c9795e78a293c1ebb26` |
| WebSocket 四帧序列 | `sha256:6326a43822000618fe2feddcfe9b28b5a02e3663be106ef1dabfa511f6e418f2` |

这些值是迁移门禁，不是永远不可变的产品版本。如果公开契约确实需要改变，必须新增明确版本的 fixture 和迁移说明，不能直接覆盖 v1 哈希来让测试变绿。

### 运行方式

从仓库根目录执行：

```powershell
cd backend
python -m pytest -q tests/test_plugin_runtime_compatibility.py
python -m pytest -q `
  tests/test_plugin_runtime_compatibility.py `
  tests/test_indicator_api.py `
  tests/test_indicator_data_manager_bridge.py `
  tests/test_indicator_pyne_warm_resume.py `
  tests/test_indicator_range_batch.py `
  tests/test_indicator_range_result_service.py `
  tests/test_indicator_resume.py `
  tests/test_indicator_series_revision.py `
  tests/test_indicator_ws_resume.py
```

完整阶段门禁还包括：

```powershell
cd backend
python -m pytest -q
python -m compileall -q app tests
cd ..
git diff --check
```

### 退出门禁

- 三条公开传输 golden 全部通过；
- 既有 Pyne/indicator 定向回归全部通过；
- backend 全量测试、compileall 与 `git diff --check` 通过；
- diff 中没有生产代码变化；
- 阶段提交可单独 revert，回滚后生产行为不受影响。

### 2026-07-21 验证证据

- 基线：`main@2346dba32c0ce9e35dd6941bc4445366da4362a7`；
- 新增兼容基线：`3 passed in 1.06s`；
- 全部 indicator/Pyne 定向回归（包含新增基线）：`118 passed in 8.45s`；
- backend 全量：`1836 passed, 4 warnings in 114.07s`；
- 4 条 warning 均为既有 FastAPI `on_event` 弃用提示；
- `python -m compileall -q app tests` 通过；
- `python -m ruff check tests/test_plugin_runtime_compatibility.py` 通过；
- `git diff --check` 通过；
- 变更仅包含测试、golden fixture 与本文，没有生产代码变化。

### Phase 1 Python 基线决策

`pyne-runtime` 要求 Python 3.11+，因此 CandleScope 从 Phase 1 起统一要求
Python 3.11+，不在 plugin platform v1 中实现独立解释器下载器。

根目录和 backend 双语 README 是用户可见声明；`app.python_runtime` 是机器可
校验的权威门禁。Python 3.10 及更低版本会在 FastAPI 应用导入前 fail fast。

2026-07-21 验证：

- Python runtime contract：`3 passed in 0.01s`；
- 本机 Python 3.10 实际导入 `app`：按预期以非零状态拒绝，并报告检测到 3.10；
- backend 全量：`1839 passed, 4 warnings in 100.16s`；
- 4 条 warning 仍是既有 FastAPI `on_event` 弃用提示。

## Phase 1：Plugin SDK v1

### 交付边界

新增独立可构建包 `packages/candlescope-plugin-sdk`。该包没有运行时第三方依赖，
不导入 CandleScope backend、Pyne Runtime 或 Pine Compatibility Runtime；插件
实现因此只能依赖公开协议，不能偷用宿主私有模块。

Phase 1 冻结：

- 协议 ID：`candlescope.script-runtime/1`；
- Render IR ID：`candlescope.render/1`；
- UTF-8 JSON-RPC 2.0 JSON Lines stdin/stdout transport；
- 必需方法：`handshake`、`describe`、`analyze`、`executeBatch`、`shutdown`；
- 能力：`source-analysis/1`、`batch-execution/1`、
  `render.line-series/1`；
- 类型化 runtime/language descriptor、chart context、OHLCV bar、diagnostic、
  analysis、batch execution 和 line series 模型；
- 请求 ID 必需、16 MiB 默认消息上限、重复 key/NaN/Infinity 拒绝、未知方法和
  未协商能力 fail closed；
- 插件未预期异常只进入 stderr，JSON-RPC 客户端只收到稳定内部错误；
- 非 JSON 输出不会污染 stdout，而会转换为 `PLUGIN_RESULT_NOT_JSON`。

### Hello Runtime

随 SDK wheel 安装的 `candlescope-hello-runtime` 是最小可运行插件。它只接受
`plot(close)`，分析成功后把每根 K 线 close 转为一个 ID 为 `close` 的主图
line series。它不是 mock transport：测试会构建 wheel、装进全新临时 venv，
再通过真实 console entry point 完成五方法会话。

固定 transcript 位于
`packages/candlescope-plugin-sdk/tests/fixtures/hello_transcript_v1.json`，完整响应
序列 canonical SHA-256 为：

```text
sha256:70b698c7dfb96de660a7986d4f387f1f222cf72ee71149e2009a6d5d4dddf09c
```

### 验证证据

- SDK 契约、负例、Hello Runtime、架构与 transcript：`26 passed`；
- `python -m ruff check .` 通过；
- `python -m ruff format --check .` 通过；
- `python -m compileall -q src tests scripts` 通过；
- 标准隔离构建成功生成 sdist 与 `py3-none-any` wheel；
- wheel metadata 为 `Requires-Python: >=3.11`，无默认 `Requires-Dist`；
- sdist 包含协议文档、golden fixture 和离线 package smoke；
- wheel 在干净 Python 3.12 与 Python 3.13 venv 中使用
  `pip --no-index --no-deps` 安装成功；
- 两个 venv 均通过真实 `candlescope-hello-runtime` 五帧 transcript smoke；
- Phase 0 的 HTTP/range/WebSocket Pyne golden 继续作为未来 host cutover 门禁。

### 明确不包含

Phase 1 不接入 CandleScope 生产路由，不启动或监督外部进程，不定义 `.cspkg`
安装/激活格式，不提供 realtime session、host data callback、secrets、交易动作、
任意前端 JavaScript 或 marketplace。sidecar 是依赖与传输边界，不被宣称为完整
安全沙箱；资源、权限、信任和终止策略由 Phase 2 host/supervisor 负责。

## Phase 2：通用 Host/Supervisor

### 交付边界

新增 `backend/app/plugin_runtime`，作为与具体脚本语言无关的 sidecar 宿主内核。
Host 直接依赖 Phase 1 的 `candlescope-plugin-sdk` 类型模型，因此 handshake、runtime
descriptor、analysis、batch result 和 Render IR 不在 backend 复制第二套 schema。
通用 Host 的架构门禁禁止导入 `app.indicator`、`pyne_runtime` 和 `pine_compat`。

Phase 2 只把 Host 生命周期接入 FastAPI，不修改任何 Indicator/Pyne HTTP、range 或
WebSocket 执行路径。默认 activation registry 不存在时等价于空 registry，不会启动
sidecar；`CANDLESCOPE_PLUGIN_HOST_ENABLED=0` 可以完全绕过 registry 并关闭 Host。

### Activation registry v1

Registry schemaVersion 为 `1`，每项冻结：

- runtime ID、预期 Python package 和精确 version；
- 绝对 executable、argv 和可选绝对 working directory；
- `enabled`、`autoStart`、`required` 生命周期策略；
- startup/request/shutdown timeout；
- 单消息和 stderr tail 上限；
- restart max attempts 与时间窗。

Parser 限制文件为 1 MiB、最多 128 个 runtime，拒绝重复 JSON key、NaN/Infinity、
重复 ID、未知字段、相对 executable、NUL、非法范围和矛盾生命周期状态。Registry
不接受 shell command、环境变量或 secrets。显式
`CANDLESCOPE_RUNTIME_REGISTRY` 指向缺失或非法文件时 fail closed；只有未覆盖的默认
用户数据路径允许不存在。

Registry 是 Phase 3 安装器未来原子生成的“已解析激活状态”，不是下载或信任清单。
Phase 2 手写 registry 仅用于本地开发，Host 不声称已经验证包来源或 artifact hash。

### Supervisor 契约

每个 runtime 由独立 `RuntimeSupervisor` 拥有：

1. 使用 `create_subprocess_exec` 直接启动 absolute executable + argv，不经过 shell；
2. 只继承 OS、临时目录、locale、证书和 PATH allowlist，宿主自定义变量不传入；
3. 启动阶段依次调用 `handshake`、`describe`，两份 descriptor 必须一致；
4. descriptor 的 ID、package、version 必须与 registry 精确相等；
5. negotiated features 必须等于 runtime features 与 host features 的有序交集；
6. 所有请求由 async lock 串行化，request ID 每代唯一；
7. stdout 严格解析 UTF-8 JSON Lines，拒绝错 ID、重复 key、非有限数、未知顶层字段、
   缺失换行和超大消息；
8. SDK typed model 再验证 analyze/execute 结果，非法 Render IR 会终止会话；
9. 合法 JSON-RPC error 不杀进程；transport/protocol/timeout/cancellation 会销毁会话；
10. 后续请求可以在受限次数/时间窗内惰性重启，超过预算返回
    `PLUGIN_RESTART_LIMIT`；
11. shutdown 先调用协议方法，超时后 terminate/kill；POSIX 使用独立 process group；
12. stderr 始终被 drain 且只保留有界 tail，`/health` 不公开 stderr、命令或路径。

Sidecar 仍不是完整安全沙箱。Windows v1 保证主 sidecar 终止，但不宣称能够约束恶意
后代进程；secrets、网络权限、宿主文件访问和 OS 级资源沙箱不在协议 v1 中。

### Host Service 与应用生命周期

`RuntimeHostService` 拥有注册表和全部 Supervisor。optional autostart 失败保留
`degraded` 诊断但不阻止现有应用；required autostart 失败会停止本次已启动的其他
sidecar 并中止应用启动。FastAPI 后续 DataEngine 启动若抛出 fatal error，也会立即
回收已经启动的 sidecar，因为 startup 中断时不能依赖 shutdown hook 一定执行。

`GET /health -> plugin_runtimes` 只包含 `status/configured/enabled/ready/failed`。
内部 diagnostics 另外提供 generation、PID、计数器、协商能力、descriptor、最后错误
和可显式请求的 stderr tail。

### 阶段门禁

- Host 对真实 SDK Hello Runtime 完成 handshake、describe、analyze、executeBatch 和
  shutdown；
- fault sidecar 覆盖启动崩溃、请求崩溃、超时、stdout 日志污染、重复 key、错 ID、
  超大消息、非法 typed result、descriptor 漂移和 shutdown hang；
- 验证合法 remote error 保持会话、非法 transport error 销毁会话；
- 验证 stderr 有界、宿主自定义 secret 环境变量不继承、重启预算最终熔断；
- 验证 required/optional 语义和 FastAPI startup failure 回收；
- 架构测试证明 Host 没有导入具体 runtime，也没有提前接入 Indicator 路由；
- Phase 0 公开 HTTP/range/WebSocket golden、backend 全量和 SDK 全量继续通过；
- `ruff`、`compileall`、`git diff --check` 通过后才将本阶段改为已完成。

完整配置和本地开发方法见
`backend/app/plugin_runtime/README_zh.md`。

### 2026-07-21 验证证据

- Phase 2 registry/supervisor/service/lifecycle/architecture：`41 passed`；
- 真实 SDK Hello Runtime 由 Host 完成五方法子进程会话；
- Phase 1 SDK 全量：`26 passed`，Ruff、format check、compileall 通过；
- Phase 0 HTTP/range/WebSocket golden：`3 passed`；
- Indicator/Pyne 定向回归（包含 Phase 0）：`118 passed`；
- backend 全量：`1880 passed, 4 warnings in 102.48s`；
- 4 条 warning 仍是既有 FastAPI `on_event` 弃用提示；
- `python -m compileall -q app tests` 通过；
- Host 与新增测试的 `ruff check`、`ruff format --check` 通过；
- 从 `backend` 目录执行的 requirements dry-run 能正确解析并构建本仓库
  `candlescope-plugin-sdk==0.1.0` editable metadata；
- Phase 2 测试退出后没有残留 fake/Hello Python sidecar；
- `git diff --check` 通过，Phase 0 compatibility 测试文件没有 diff；
- 生产 Indicator 目录没有 `plugin_runtime` 引用，尚未发生 sidecar cutover。

## Phase 3：隔离 Bundle 安装器

### 交付边界

Phase 3 新增严格 `.cspkg`、本地管理 CLI、每 bundle 独立 venv、离线 wheel 安装、
协议结果探针、原子 activation registry 写入和逐 runtime 精确回滚。安装器仍属于通用
Host，不导入 Pyne、Pine Compatibility 或 Indicator 私有模块。

现有 Indicator/Pyne HTTP、range 和 WebSocket 执行路径保持不变。Phase 3 激活的
runtime 已可由 Phase 2 Host 启动，但 production route 只有在 Phase 4 引入
`legacy/shadow/sidecar` 后才会选择它。

### `.cspkg` schema v1

Archive 只能包含一个 `manifest.json` 和 manifest 明确列出的 wheel。Manifest 冻结：

- plugin ID、显示名、精确 version、主 Python package 和
  `candlescope.script-runtime/1`；
- Python 范围和可用 `python -I -u -m <module>` 启动的 sidecar module；
- 每个 wheel 的 archive path、package、精确 version、size 和 SHA-256；
- 一个小型确定性 analyze/execute probe，以及两个 typed result canonical SHA-256。

Builder 可以从省略 wheel size/hash 的 template 生成确定性 ZIP。验证拒绝未知字段、
重复 JSON key、NaN/Infinity、绝对/父级/反斜杠/平台危险路径、大小写冲突、symlink、
加密或不支持压缩、未声明 entry、大小上限、wheel hash 漂移，以及
`METADATA/WHEEL/RECORD`、package/version 或 Wheel-Version 不一致。

安装必须由调用者提供外层 bundle 的预期 SHA-256；`inspect` 只用于显示本地 bytes 的
摘要，不能替代可信 release/lock。v1 CLI 不下载 URL，也不把 bundle 和摘要同时从
未知来源自动发现。

### 隔离安装与 probe

安装器使用宿主明确选择的 Python 创建 `venv`，但从不修改 backend interpreter。
全部依赖必须作为 bundle wheel 一次提供，安装命令固定为 `--isolated --no-index
--no-deps --only-binary=:all:`，环境同时清除 `PYTHONPATH/PYTHONHOME` 和外部 pip
配置；随后运行 `pip check`，并用 `importlib.metadata` 校验所有 distribution 的
精确 version。

安装器通过通用 `RuntimeSupervisor` 完成 handshake/describe、analyze 和
executeBatch。Descriptor 必须精确匹配 manifest 的 ID/package/version，两个结果还要
匹配 manifest 固定 hash。Probe 失败不会写 activation registry。

### 原子 activation 与回滚

完整 bundle SHA-256 的 64 位 hex 是确定性 `installationId`，安装目录为：

```text
installs/<runtime-id>/<installation-id>/
```

安装先在 `staging` 完成，probe 后原子重命名；目录不会原地覆盖或升级。安装器使用
跨进程文件锁串行化写操作。每次真正切换会生成独立 `activationId`，先原子记录
`before/after` history，再以同目录临时文件、flush、fsync 和 `os.replace` 替换
`runtime-registry.json`；registry replacement 是唯一 activation commit point。

相同 bundle 与相同 lifecycle policy 重复安装会重新校验现有环境并保持 activation
不变。升级保留旧安装。Rollback 只接受当前 managed activation，验证 history 的
`after` 与当前 registry 完全相等，再探测精确 `before` 目标并只替换该 runtime；其他
managed 或手写 registry 条目保持不变。Rollback 不删除安装目录，可以继续沿历史链
回退。

应用不会热加载 registry；install/rollback 返回 `restartRequired=true`。旧安装和
quarantine 的显式可达性 GC 不属于 Phase 3，安装器不会静默删除它们。

### 社区开发入口

CLI `backend/scripts/candlescope_plugin.py` 提供：

- `build --manifest --wheel --output`；
- `inspect <bundle>`；
- `install <bundle> --sha256 <trusted digest>`；
- `check <runtime-id>`、`list`、`rollback <runtime-id>`；
- 全局 `--root`、`--registry`、`--python` 和 `--json`。

双语完整说明位于 `backend/app/plugin_runtime/INSTALLER.md` 和
`INSTALLER_zh.md`；SDK 提供可直接复制的 Hello manifest template。

### 安全边界

- 外层 SHA-256 是完整性 pin，不是发布者身份认证；
- wheel-only/offline 阻止静默联网和 source build，但 runtime probe 会执行插件代码；
- venv/sidecar 是依赖、协议和故障边界，不是恶意插件沙箱；
- v1 仍无签名、透明日志、权限声明、网络隔离、secrets 或前端 JavaScript；
- registry、receipt 或已有 venv 损坏时 fail closed，不覆盖同 identity 安装。

### 阶段门禁

- 确定性 bundle 构建、外层/内层 SHA、严格 archive/wheel 负例；
- 真实 Hello wheel 在独立 venv 中离线安装并由 Host 完成协议和结果 probe；
- 相同 bundle 快速重复安装不新建 venv/activation；
- v1 -> v2 activation 后精确 rollback，且其他 registry entry 不变；
- 错误 hash、错误 probe 和损坏已有安装不改变 registry；
- Phase 0 transport golden、Phase 2 Host、SDK 和 backend 全量继续通过；
- Ruff、format、compileall、diff check 通过且没有残留 sidecar/测试 venv。

### 2026-07-21 验证证据

- `.cspkg` builder、manifest/archive/wheel 审计、TOCTOU 和 CLI inspect：
  `14 passed in 0.40s`；
- 独立 venv、离线安装、环境隔离、probe、幂等、升级、history tamper、原子失败和
  rollback：`10 passed in 50.36s`；
- Phase 2 Host/Supervisor、managed registry、生命周期和架构门禁：
  `46 passed, 4 warnings in 3.65s`；
- Phase 0 HTTP/range/WebSocket golden：`3 passed in 1.30s`；
- Indicator/Pyne 定向回归（包含 Phase 0）：`118 passed in 12.68s`；
- Phase 1 SDK：`26 passed`，Ruff、format、compileall、隔离 sdist/wheel build 和
  wheel package smoke 通过；Hello manifest template 已进入 SDK sdist；
- backend 全量：`1909 passed, 4 warnings in 130.99s`；4 条 warning 仍为既有
  FastAPI `on_event` 弃用提示；
- Host/installer/测试的 Ruff、format check 与 `python -m compileall -q app tests
  scripts/candlescope_plugin.py` 通过；`git diff --check` 通过；
- 真实 SDK wheel 通过 CLI `build` 和 `inspect` 得到一致 bundle SHA-256；
- 测试退出后 worktree 内没有残留 sidecar、venv、staging 或 `.part`；
- Phase 3 提交时生产 Indicator 目录仍无 `plugin_runtime` 引用，Phase 4 尚未开始。

## Phase 4：通用 Indicator Service

### 交付边界

Phase 4 引入由 CandleScope 拥有的 `IndicatorRuntimeService`，将公开传输与具体 runtime
包解耦。应用启动时分别读取 activation registry 与
`indicator-runtime-routes.json`：前者回答“哪个版本已激活”，后者回答“某种语言的流量
发给谁”。两个 schema 不混用，缺少默认路由文件时精确保持 `pyne=legacy`；显式指定但
缺失、损坏、含未知字段或重复语言的路由文件会 fail closed。

每种语言只能显式选择一种模式：

| 模式 | 用户响应 | Runtime 行为 | 故障语义 |
| --- | --- | --- | --- |
| `legacy` | 现有进程内 payload | 不调用插件 Host | 保持冻结行为 |
| `shadow` | 完全原样返回 legacy payload | 并行调用 sidecar 并异步比较 | 只记诊断，不改变响应 |
| `sidecar` | CandleScope 适配后的稳定 payload | 插件是唯一执行者 | 返回宿主定义的不可用错误，绝不静默回退 |

非 legacy 路由会在启动时校验 runtime descriptor：目标语言、`batch-execution/1` 和
`render.line-series/1` 必须全部声明。当前只有 `pyne` 存在 legacy adapter；社区语言可
通过请求或已保存 custom indicator 的 `language` 字段选择，但只能配置为 `sidecar`，
不允许伪造没有实现的 legacy/shadow 路径。

### 传输与隔离语义

同一个 Service 已接入：

- `POST /api/v1/indicators/compute`；
- `POST /api/v1/indicators/range`；
- `POST /api/v1/indicators/range/batch`；
- `WS /api/v1/stream/indicators` 的脚本订阅与实时 patch。

CandleScope 继续拥有 market context、OHLCV 查询、HTTP/WS envelope、range cache 与
Render IR 适配；插件只接收 SDK `ExecuteBatchRequest`，不能导入或重定义私有传输模块。
HTTP、range 与普通 WS snapshot 的 shadow 两侧使用同一次查询得到的 bars，range batch
仍只查询一次共享 K 线。sidecar Host 故障不会写入 range cache；缓存命中会把
`indicatorId`、series、annotation、fill 与 pane 引用重新绑定到本次 client identity，
且脚本缓存 identity 包含 language，不会跨语言复用或 singleflight 合并。

Shadow 不阻塞 legacy 响应，每进程最多保留 64 个待完成比较；满载时仅执行 legacy，并
通过 `shadowSkipped`、`pendingShadow` 和 `maxPendingShadow` 暴露降采样。诊断只保存
hash、不同的顶层字段、runtime/transport、状态与计数，不保存源码、bars、参数、命令或
stderr，也不公开本地路由文件路径。插件 style 也不能覆盖宿主拥有的 series
`id/data/type` 字段。

### 明确保留的迁移缺口

- SDK/Render IR v1 当前只承诺 line series；marker、hline、fill、背景、K 线着色、signal
  以及真正有状态的 realtime session 仍需后续能力协商；
- Phase 4 完成时前端仍默认 Pyne，描述符驱动语言发现留给 Phase 7；
- Pyne 桥接发行包尚未进入本阶段，默认路由仍为 legacy；
- `packages/pyne-runtime` 源码快照没有删除。删除只能在 Phase 5 发行、Phase 6 shadow
  与 cutover 达标后作为独立提交执行。

### 2026-07-21 验证证据

- Phase 4 路由、Service、HTTP/range/batch/WS、生命周期与架构聚焦测试：
  `44 passed, 4 warnings in 4.60s`；
- Phase 0 HTTP/range/WebSocket 冻结 golden：`3 passed in 1.96s`，fixture 未改动；
- Indicator/Pyne 定向回归（包含 Phase 0 与 Phase 4）：`150 passed in 28.29s`；
- Phase 2 Host/Supervisor、registry、生命周期与兼容门禁：
  `50 passed, 4 warnings in 4.97s`；
- Phase 3 bundle/installer、独立 venv、升级与 rollback：`24 passed in 71.33s`；
- Phase 1 SDK：`26 passed`，Ruff、format check 与 compileall 通过；
- backend 全量：`1942 passed, 4 warnings in 137.07s`；4 条 warning 仍为既有
  FastAPI `on_event` 弃用提示；
- 所有变更 Python 文件 Ruff check、新文件 format check、backend compileall 与
  `git diff --check` 通过；测试退出后无残留 sidecar、测试 venv、staging 或 `.part`。

## Phase 5：Pyne 插件发行

### 独立发行边界

新增独立可构建包 `packages/candlescope-plugin-pyne`，其 runtime ID 为
`candlescope.pyne`。生产源码只导入 `candlescope-plugin-sdk` 与公开的
`pyne_runtime` package，不导入 `app.*`、Indicator serializer、transport 或当前
`packages/pyne-runtime` 快照，也不复制任何 Pyne 源文件。包 metadata 精确固定：

- `candlescope-plugin-pyne==0.1.0`；
- `candlescope-plugin-sdk==0.1.0`；
- `pyne-runtime==0.2.0rc1`；
- Python `>=3.11,<3.14`。

桥接层从 SDK `MarketContext` 构造 Pyne 的 `syminfo` 与 `timeframe`，透传 params 和经过
校验的 `securityMode`，并把 Pyne 的结构化 analysis/runtime 错误映射为 SDK
`Diagnostic`。CandleScope sidecar 已经是宿主可超时、终止和重启的硬进程边界，因此桥内
固定 `executor_mode="inline"`，避免 Windows 下再嵌套一层 multiprocessing worker；
Pyne 自身资源上限仍由 `PyneSettings` 默认值约束。

### 发行锁与 bundle

`release/release-lock.json` 固定插件、SDK、引擎和 NumPy 版本，以及确定性的 analysis /
execution probe。Pyne 引擎只接受 GitHub Release
`v0.2.0rc1` 的 universal wheel，固定 SHA-256 为
`sha256:53597fd53150c7beecdfd57ecd1c4e5c5ebaa2edf2ae1006e0723ae41467e754`；
它仍明确标记为 prerelease，没有被文档提升为 stable。

`scripts/build_bundle.py` 从 wheel 内的 `METADATA` 读取真实 package/version，只接受恰好
四个 wheel（bridge、SDK、Pyne Runtime、目标平台 NumPy），并在进入通用 `.cspkg`
builder 前核对 Pyne 官方 artifact hash。NumPy 固定为 `2.3.3`，因此 bundle 是目标
Python ABI / OS 相关产物；外层 `.cspkg` hash 才是用户安装时必须从可信发布渠道取得的
最终锁。

真实 NumPy wheel 包含标准零字节 ZIP directory entries。Phase 3 审计器原先错误地拒绝
此类合法 wheel，Phase 5 将规则收窄为：只在嵌套 wheel 中允许路径规范、零字节的目录
entry；`.cspkg` 外层仍禁止 directory entry，且两层都继续拒绝路径穿越、大小写冲突、
symlink、加密 entry 和不支持的压缩方式。

### Render IR 覆盖与切换门禁

桥接只把 Pyne line 输出转换为 `candlescope.render/1`，包括稳定/去重后的 series ID、
点、pane、scale 和受控 style。它会把所有非空、非 `lines/meta` 的 Pyne 输出类型列在
`output.meta.unsupportedOutputKinds`，但不把 runtime 私有对象夹带进公共协议。

Phase 0 冻结脚本在真实已安装 sidecar 中得到与 legacy 一致的 `plot_1` 和
`[202, 204, 206, 208, 210]`，同时明确报告 `hlines`、`markers` 尚不可传输。因此
line parity 已建立，但完整 HTTP/range/WS golden 预期仍不相等；Phase 6 不能把这种已知
缺口记成 shadow success。默认路由保持 `pyne=legacy`，当前源码快照未删除，也没有增加
任何静默 fallback。

### 2026-07-21 验证证据

- bridge runtime、诊断、context、fail-closed output、架构和发行 builder 聚焦测试，连同
  通用 bundle 回归：`34 passed in 0.51s`；
- bridge 独立包：`18 passed in 0.23s`；SDK 独立回归：`26 passed in 0.07s`；
- Phase 0 HTTP/range/WebSocket 冻结 golden：`3 passed in 1.08s`，fixture 未修改；
- backend 全量：`1943 passed, 4 warnings in 120.79s`；4 条 warning 仍为既有 FastAPI
  `on_event` 弃用提示；
- 真实构建 `candlescope_plugin_pyne-0.1.0-py3-none-any.whl` 与
  `candlescope_plugin_sdk-0.1.0-py3-none-any.whl`，下载并校验官方 Pyne wheel；当前
  Windows CPython 3.12 NumPy wheel SHA-256 为
  `sha256:497d7cad08e7092dba36e3d296fe4c97708c93daf26643a1ae4b03f6294d30eb`；
- 候选 `.cspkg` 为 `13,004,213` bytes，SHA-256
  `sha256:81a35b285ad6d2c98b9edf6d6ec568923b9691ab83e67f7c37a7e43081a0a9cc`；该值只记录本次
  本地 release candidate，不冒充尚未发布的公开 Release asset；
- 全新 managed root 完成离线 wheel install、`pip check`、descriptor、analysis 和
  execution probe；随后 `check` 再次通过；重复 install 返回 `changed=false`、
  `reusedInstallation=true` 且 activation ID 不变；
- 已安装 wheel 的 descriptor 报告 `engineVersion=0.2.0rc1`、
  `engineVersionVerified=true`，真实 Phase 0 fixture 的 line parity 与
  `unsupportedOutputKinds=["hlines","markers"]` 断言通过；
- 本阶段只生成临时二进制验证产物，不提交 wheel、`.cspkg`、managed venv 或 registry，
  验证后已删除两个受限系统临时目录；不执行 GitHub push / Release 发布。

## Phase 6：Pyne shadow、cutover 与源码删除门禁

### 可协商的完整公共输出

SDK 升级为 `candlescope-plugin-sdk==0.2.0`，但协议 ID 与 Render schema 仍保持
`candlescope.script-runtime/1` / `candlescope.render/1`。新增的
`render.histogram-series/1` 与 `render.structured-output/1` 都是显式协商的附加能力；
旧的 line-only 插件不发送 `collections` / `inputs`，wire 行为不变。

公开 `RenderCollections` 只接受固定的宿主集合名：line、histogram、marker、hline、fill、
背景、legacy label、K 线着色、signal、strategy、drawing objects 与 object events。集合
内容必须是有限深度、有限数值的 JSON；未知集合、Python 私有对象、非字符串 key、NaN
与 Infinity 都在进入 transport 前 fail closed。插件因此不需要导入 CandleScope 私有
serializer，同时宿主仍拥有 HTTP/WS envelope、normalized series/annotation/fill 和 pane
layout。

`candlescope-plugin-pyne==0.2.0` 把 Pyne 公开 output、parameter schema 和 result metadata
映射到上述协议。宿主从公共结构重建既有 `result`、extended legacy fields 与 normalized
output；不是把 Pyne runtime 对象夹带在 `meta` 中。Phase 0 脚本的 legacy 与 sidecar
adapter payload 已逐字段相等，marker 与 hline 不再是已知缺口。Histogram、fill/bgcolor/
barcolor/signal、drawing objects 与 strategy 的补充样本也逐字段相等。
只有 indicator metadata、没有任何 plot 的合法脚本也保留 `result` 形状，不会泄露
Render schema 包装或制造 shadow mismatch。

### Shadow 与默认切换

真实 0.2.0 wheel 集合构建出的本地 Windows CPython 3.12 候选 `.cspkg` 为
`13,006,218` bytes，SHA-256
`sha256:a1812e0e2b43670e75858b5f57d59f71a403350360ea58bf2822efba7d34a216`。它在全新
managed root 中完成离线安装、probe、`check` 与幂等重装；真实 supervisor shadow
得到一次 `matched`、零 mismatch/sidecar error，legacy 与 sidecar hash 同为
`sha256:50298c7df91a12241a8ce8bbc75402bcbbb1eb97fac52460ab6c1690020bc710`。

HTTP compute、HTTP range 与 WebSocket sidecar 重放分别匹配 Phase 0 冻结 golden；默认
路由在缺少显式 route 文件时已经从 `pyne=legacy` 切换为
`pyne=sidecar,candlescope.pyne`。插件没有激活时启动 fail closed，不存在静默 legacy
fallback；显式 route 文件仍可在源码删除提交前用于回滚。

### 2026-07-21 验证证据

- SDK 模型、wire、Hello Runtime 与 golden transcript：`30 passed`；最终 wheel 在干净
  venv 中离线安装并通过真实 console sidecar package smoke；
- Pyne bridge 的完整 Render IR、descriptor、options、架构与发行 builder：`20 passed`；
- HTTP compute、HTTP range、WebSocket 与宿主 serializer 的 Phase 0 精确 parity：
  `15 passed`；
- backend 全量：`1950 passed, 4 warnings in 128.49s`；4 条 warning 仍为既有 FastAPI
  `on_event` 弃用提示；
- 最终本地 `.cspkg` 在全新 managed root 中安装并通过 probe/`check`；重复安装返回
  `changed=false`、`reusedInstallation=true`，activation ID 不变；
- 真实 Host descriptor 报告 `engineVersion=0.2.0rc1`、
  `engineVersionVerified=true`、完整 Render coverage；shadow 为 `1 matched / 0 mismatch /
  0 sidecar error`，默认 sidecar 与 legacy adapter 摘要均为
  `sha256:50298c7df91a12241a8ce8bbc75402bcbbb1eb97fac52460ab6c1690020bc710`。

### Phase 6 当时的硬门禁：尚无可信公开 bundle（已解除）

本次 `.cspkg` 仍只是本地候选。`Ryan00956/CandleScope` 当前没有可供用户取得的 GitHub
Release asset，也没有已发布的外层 SHA-256；把本地临时摘要写成公开下载锁会伪造供应链
信任。因此本阶段暂不删除 `packages/pyne-runtime`，也不把删除与 cutover 混在一个提交。
必须先把 0.2.0 `.cspkg` 与其外层摘要作为同一可信 Release 发布，再用全新用户目录完成
首次安装/启动验证，之后才能执行独立的源码快照删除提交。

## 后续阶段不可越过的顺序

关键路径固定为：

```text
compatibility golden
  -> SDK v1 + Hello Runtime
  -> generic host/supervisor
  -> isolated bundle installer
  -> legacy/shadow/sidecar routing
  -> Pyne bridge release
  -> Pyne shadow + cutover
  -> delete vendored Pyne snapshot
  -> descriptor-driven frontend
  -> Pine Compatibility bridge + cutover
```

不能先删除源码快照再补兼容层，也不能让插件直接依赖 CandleScope 私有 Python 包。每次 runtime cutover 和旧实现删除必须是两个独立提交，以便快速回滚。

## Phase 6 收尾：公开开发包、首启 bootstrap 与源码快照退出

### 可信开发发布

2026-07-21 已从 `codex/plugin-platform-v1` worktree 的 Phase 6 cutover commit
`6803b8fe86a80aa27c33be380e903b974855959f` 直接发布公开 prerelease，未合并或移动
`main`：

- tag：`candlescope-plugin-pyne-v0.2.0-dev.1`；
- Release：<https://github.com/Ryan00956/CandleScope/releases/tag/candlescope-plugin-pyne-v0.2.0-dev.1>；
- asset：`candlescope-pyne-0.2.0-cp312-win_amd64.cspkg`；
- 大小：`13,006,218` bytes；
- 外层 SHA-256：
  `sha256:a1812e0e2b43670e75858b5f57d59f71a403350360ea58bf2822efba7d34a216`；
- 同一 Release 同时发布 `SHA256SUMS`。GitHub asset digest、公网重新下载后的字节数和
  本地 SHA-256 三者一致。

### 产品 bootstrap 与社区边界

`backend/app/official-plugin-releases.json` 固定官方 runtime ID、package、version、
GitHub Release URL、文件名、平台、大小和外层 SHA-256。
`app.first_party_plugin_bootstrap` 在通用 Host 启动前执行：

1. 只有当前语言 route 确实指向锁中的官方 runtime 才处理；
2. 只支持锁声明的 Windows / AMD64 / CPython 3.12，其他平台明确失败；
3. 已有完全匹配的 managed activation 时运行 `check` 并复用，不访问网络；
4. 首次安装先把下载写入同目录唯一临时文件，严格校验固定大小和 SHA-256 后再
   `os.replace` 到 cache；
5. 最后调用原有 local-only `PluginInstaller`，以
   `enabled=true/autoStart=true/required=true` 原子激活；
6. 同 runtime ID 的 unmanaged activation 永不自动覆盖。

这层产品策略没有进入 `app.plugin_runtime`。通用 Host、bundle verifier 和 installer
仍然不含 downloader，社区作者继续使用公开 SDK、`.cspkg` 和本地 artifact 安装流程。
离线首启可通过 `CANDLESCOPE_OFFICIAL_PLUGIN_BUNDLE` 指向摘要完全相同的文件；
`CANDLESCOPE_OFFICIAL_PLUGIN_BOOTSTRAP=0` 只用于已经手工准备好兼容 activation 的环境。

### 源码退出

Phase 6 的独立源码退出提交删除：

- `packages/pyne-runtime` 的 286 个受版本控制文件；
- `backend/app/indicator/pyne` 的 16 个 in-process facade 文件；
- 只验证 Pyne 内部 incremental/cache/executor 语义的 CandleScope 测试；这些语义由
  `pyne-runtime` 自身仓库和 `candlescope-plugin-pyne` 契约测试负责。

HTTP compute、HTTP range/batch 和 WebSocket production transport 已不再导入或调用
`pyne_runtime`。WebSocket 不在宿主内维护 `PyneIncrementalSession`，而是和其他社区
runtime 一样通过公共 batch request 重算所需窗口。旧 metadata 清理函数只移除历史
session key，不再持有 runtime 对象。显式 stale legacy/shadow route 会在产品 service
启动时因为没有 in-process adapter 而 fail closed；回滚边界是独立 Git commit，而不是
运行中静默回退。

### 删除后真实验证

在没有把 `pyne_runtime` 安装进 backend Python 的情况下，`import app.main` 成功；宿主
定向门禁为 `94 passed`。随后在全新用户目录和空下载缓存中从 GitHub Release 走真实
bootstrap：首次结果为
`status=installed, changed=true, downloaded=true`，立即重复为
`status=ready, changed=false, downloaded=false`；真实 Host descriptor 返回
`candlescope.pyne==0.2.0`、`engineVersion=0.2.0rc1`、
`engineVersionVerified=true`，执行 `plot(close * 2)` 得到 `[202.0, 204.0]`。插件自身
测试使用该隔离安装中的 Pyne engine 运行，结果为 `20 passed`。删除快照后的 backend
全量回归为 `1923 passed, 4 warnings in 128.80s`；4 条 warning 仍是既有 FastAPI
`on_event` 弃用提示。

## Phase 7：描述符驱动前端

### 公开发现契约

新增 `GET /api/v1/indicators/runtimes`，公开 schema v1 的
`schemaVersion`、`defaultLanguage`、`languages` 和 `runtimes`。目录只由启动时已验证的
`indicator-runtime-routes.json` 与 runtime `describe` descriptor 投影产生；不会把 registry
路径、启动命令、PID、stderr 或宿主失败细节暴露给前端。每种 routed language 同时带有
runtime ID、route mode、可用状态和 descriptor features，runtime 项保持 SDK 的公开
identity、language、feature 与 JSON-only metadata。

`pyne` 仍是省略 `language` 时的兼容默认值，但它不再是前端封闭联合类型。前端会严格
校验目录 schema、重复 ID、route/runtime 引用和 runtime 的 language 声明；目录无效或
不可用时编辑器 fail closed，不会猜测一个 runtime。

### 前端与传输闭环

指标编辑器从公开目录动态生成语言选择器、runtime 名称和版本。任意社区 language ID
都可进入同一工作流；未知语言默认使用 Monaco `plaintext`。Pyne 的补全、主题与
security mode 作为可选的宿主增强保留，不构成 runtime ID 白名单。

插件可以在 `RuntimeDescriptor.meta.ui.languages.<language-id>` 下提供
`monacoLanguage` 和 `starterSource` 字符串作为安全展示提示。宿主可以忽略这些提示，
且该约定不允许插件注入或执行 JavaScript、CSS、React component 或其他前端代码。

所选 `language` 会贯穿：

- one-shot compute、range、range batch；
- Indicator WebSocket subscribe 与 reconnect identity；
- 自定义指标保存、读取、编辑和重新运行；
- result cache、singleflight 与 stream configuration identity。

因此两个 runtime 即使脚本内容和市场上下文相同，也不会跨 language 复用结果或继承旧
订阅。旧的 Pyne 自定义指标没有 `language` 字段时仍按 `pyne` 读取。

### 阶段边界与门禁

本阶段不发行或切换 Pine Compatibility runtime，也不把未发布的 realtime ABI 候选写入
产品能力；它只交付通用发现与前端消费闭环。Phase 8 才负责 Pine Compatibility 插件的
发行来源、桥接、shadow 与 cutover。

完成前必须通过 backend 全量、frontend tests/typecheck/lint/build、SDK tests/build、
compileall 和 `git diff --check`，并以带任意社区 language ID 的契约测试证明前端没有
封闭 runtime 联合类型。

2026-07-21 最终验证：

- backend 全量：`1926 passed, 4 warnings in 118.08s`；4 条 warning 仍为既有 FastAPI
  `on_event` 弃用提示；
- backend 本阶段 4 个 Python 文件的 Ruff check/format check 与 `compileall` 通过；
- frontend `npm run check` 全绿：architecture allowlist 为 0，typecheck、全仓 ESLint、
  `2331 passed` 和 Vite production build（455 modules）通过；
- Plugin SDK：Ruff check/format check、`30 passed`、sdist/wheel build 与仅包含当前
  `candlescope_plugin_sdk-0.2.0-py3-none-any.whl` 的干净临时目录 package smoke 通过；
- `git diff --check` 通过；全仓 backend Ruff 仍报告 34 个本阶段未修改文件中的既有
  finding，因此没有在 Phase 7 越界修改 Data Engine、Exchange 或旧 Indicator internals。

## Phase 8：Pine Compatibility 插件与 cutover

### 公开发行边界

2026-07-21 重新查询 `Ryan00956/pine-compat-runtime` 的 GitHub Releases 后，稳定公开
发行仍只有 `v0.2.0`；没有把本地或未发布的 `v0.2.1` realtime ABI 候选写进产品能力。
宿主精确固定：

- release tag：`v0.2.0`，tag commit
  `cec39d807a469ebae199f30bc67a91d7081a3b9f`；
- release manifest：
  `sha256:3fce2cf4aa78ea54b3be805c5417466d9014445c50004317932d044b00f23deb`；
- Windows wheel：`pine_compat_runtime-0.2.0-cp310-abi3-win_amd64.whl`，
  `2961677` bytes，
  `sha256:4f38c25a92261a8594d346c858c43f2a675afaac789bb1f75458c8a568c43c3e`；
- analysis/runtime/render schema 分别为 `5/8/1`，公开 API 只有
  `analyze_script` 与 `run_script`，不存在 `create_realtime_session`。

因此 Phase 8 的产品契约明确为闭合 K 线 batch；forming bar、增量/realtime session、
strategy、`request.*`、import/library 和不能忠实映射的原生对象全部 fail closed。

### 独立 bridge 与冻结 shadow

新增 `packages/candlescope-plugin-pine-compat`，runtime ID 为
`candlescope.pine-compat`，包版本 `0.2.0`。生产依赖只有公开
`candlescope-plugin-sdk==0.2.0` 与 `pine-compat-runtime==0.2.0`；包内没有 Pine 引擎
源码快照，不导入 `app.*`，descriptor 明确返回 `sourceSnapshot=false`、
`closedBarsOnly=true` 与宿主实际提供的 chart symbol/timeframe fields。

Bridge 把公开引擎结果映射为 SDK Render IR，覆盖 line、histogram/columns、受支持的
plotshape 子集、hline、fill、bgcolor、barcolor 与 alert。通用 CandleScope serializer
同时补齐 histogram 的稳定 ID、linewidth、line style 与 per-bar color，不加入任何
Pine runtime 私有分支。

当前 plugin-platform 分支在 Phase 6 已删除进程内脚本 facade，因此不存在可继续承载
Pine live shadow 的 legacy 执行路径。Phase 8 没有伪造在线 shadow 窗口，而是从旧适配层
在同一个公开 v0.2.0 wheel 上冻结 line、histogram、shape、input 四类输出 fixture，桥接
测试逐字段对比该 fixture；此外再用真实 `.cspkg` 安装探针与 Host 端到端执行作为 cutover
门禁。若未来公开 realtime ABI，需要在新的协议版本中重新建立 live shadow，不能扩写
本阶段的 v1 声明。

### 发行、首启与默认路由

确定性 bundle 已作为 development prerelease 发布：

- release：
  `candlescope-plugin-pine-compat-v0.2.0-dev.1`；
- asset：`candlescope-pine-compat-0.2.0-cp312-win_amd64.cspkg`，
  `2997572` bytes；
- outer digest：
  `sha256:f14094a6243485d198814464d359ae05711b6cbec34adb7030998caad2c1a378`；
- URL：<https://github.com/Ryan00956/CandleScope/releases/tag/candlescope-plugin-pine-compat-v0.2.0-dev.1>。

`official-plugin-releases.json` 同时固定 Pyne 与 Pine 两个开发资产。产品 bootstrap 先下载
并校验全部待安装 bundle，再按 runtime ID 顺序调用通用 installer；任一 bundle 失败时
不会先写入另一半 activation。默认路由文件不存在时现在选择：

```text
pyne=sidecar,candlescope.pyne
pine=sidecar,candlescope.pine-compat
```

前端继续从公开 descriptor 发现语言。Pine 的 Monaco tokenizer、starter source 与补全由
宿主静态实现；补全只展示 descriptor 声明的 `syminfo.*`/`timeframe.*`，不加载插件代码，
也不会提示未托管的 `timeframe.in_seconds()`、`strategy` 或 `plotarrow`。编辑器明确展示
“Pine v5/v6 · closed bars only”。

在全新的临时 `LOCALAPPDATA` 中，第一次默认启动真实下载并安装两个 pinned bundle，返回
`status=installed, count=2, changed=true, downloaded=true`；第二次启动对两个 activation
逐个执行 `check`，返回 `status=ready, changed=false, downloaded=false`。真实 Host 目录
随后同时返回 `candlescope.pyne`/`candlescope.pine-compat` 与 `pyne`/`pine`，Pine descriptor
报告 `engineVersion=0.2.0`、`closedBarsOnly=true`；执行 `plot(close * 2)` 的三点结果为
`[202.0, 204.0, 206.0]`。

### 回滚边界

本阶段只在 `codex/plugin-platform-v1` worktree/branch 上开发与发布，不合并 `main`，也不
创建 PR。开发测试期回滚 Pine 时，先显式配置只包含
`pyne=sidecar,candlescope.pyne` 的 route 文件，再对
`candlescope.pine-compat` 执行 installer rollback；这样产品 bootstrap 不会重新选择 Pine，
且 Pyne 流量与社区插件契约不受影响。发布资产保持 prerelease；回滚不需要删除 Release，
也不能静默回退到已删除的进程内实现。

### 最终门禁记录

2026-07-21 最终验证：

- backend 全量：`1930 passed, 4 warnings in 145.47s`；4 条 warning 仍是既有 FastAPI
  `on_event` 弃用提示；
- frontend `npm run check` 全绿：architecture allowlist 为 0，typecheck、全仓 ESLint、
  `2334 passed` 与 Vite production build（456 modules）通过；
- Plugin SDK：Ruff check/format check、`30 passed`、wheel/sdist build 通过；
- Pine bridge：Ruff check、冻结 shadow/发行/架构/runtime 的 `11 passed` 与 wheel build
  通过；真实 dev.1 `.cspkg` 的首次安装、重复 `check`、双 descriptor 与执行探针通过；
- `compileall`、本次改动 Python 文件 Ruff/format check、`git diff --check` 通过；
- GitHub 复核确认 prerelease tag 指向
  `68c60445449c6302279cdab492c41f2c1ce9d467`，远端 asset 的 size/digest 与官方发行锁
  一致。

额外对已发布 bridge 源码执行 `ruff format --check` 时，formatter 会机械重排
`build_bundle.py`、`runtime.py` 与 `test_runtime.py`。这些文件的 Ruff 规则、测试、构建和
真实 artifact 门禁均通过；本阶段没有为了纯格式变更改写已锁定 dev.1 的源码对应关系。
若需要统一 formatter 输出，应以新的 dev.2 asset、摘要与 release lock 独立发布，不能
在 dev.1 名下静默替换字节。
