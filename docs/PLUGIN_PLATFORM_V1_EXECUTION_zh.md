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
| Phase 2：通用 Host/Supervisor | 未开始 | 注册表、生命周期、RPC、宿主服务、诊断 |
| Phase 3：隔离安装器 v2 | 未开始 | `.cspkg`、独立 venv、校验、探测、原子激活与回滚 |
| Phase 4：通用 Indicator Service | 未开始 | `legacy/shadow/sidecar` 路由与传输迁移 |
| Phase 5：Pyne 插件发行 | 未开始 | Pyne host facade 与 `candlescope-plugin-pyne` |
| Phase 6：Pyne 切换与源码快照删除 | 未开始 | shadow、cutover、独立删除提交 |
| Phase 7：描述符驱动前端 | 未开始 | 运行时/语言/能力描述符，无硬编码运行时联合类型 |
| Phase 8：Pine Compatibility 插件 | 未开始 | 修复发行来源、桥接插件、shadow、cutover |

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
  -> Pine Compatibility bridge + cutover
```

不能先删除源码快照再补兼容层，也不能让插件直接依赖 CandleScope 私有 Python 包。每次 runtime cutover 和旧实现删除必须是两个独立提交，以便快速回滚。
