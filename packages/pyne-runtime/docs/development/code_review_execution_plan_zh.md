# Pyne Runtime 分阶段代码审查执行计划

本文档用于把一次「逐文件、逐模块」的人工 + AI 协作代码审查拆成可控的阶段。
目标是在不改变公共 API 与 golden 契约的前提下，系统性地走查全部源码，
沉淀问题清单与改进项，而不是一次性读完上万行代码。

> 适用范围：`src/pyne_runtime/` 全量源码（约 60 个文件、约 13k 行）+ 配套测试与脚本。
> 审查方式：每个阶段独立可交付，按依赖从底层到上层推进，先读懂再提问题，最后才动手改。

---

## 0. 审查总目标与原则

### 0.1 目标
- 理解每个模块的职责边界、对外契约和内部不变量。
- 标记四类问题：**正确性 / 安全性 / 性能 / 可维护性**。
- 对每个发现产出可执行结论：保留、加测试、重构、或修复。
- 全程保持 `pyne_runtime.__all__`、`pn.run()`、CLI、文档示例、golden tests 兼容。

### 0.2 原则
- **先读后改**：每阶段先只读 + 记录问题，确认后再决定是否动手。
- **从契约入手**：先看公共入口与数据模型，再看内部实现。
- **小步验证**：任何改动后立即跑对应阶段的聚焦测试，再跑全量门禁。
- **不顺手改语义**：审查中发现的语义疑问先记录，不在审查 PR 里偷偷改业务行为。

### 0.3 每个文件的审查清单（统一模板）
对每个文件统一回答以下问题：
1. 职责是否单一、命名是否清晰？
2. 公共接口与类型注解是否完整、是否与文档一致？
3. 边界条件：空数据、`na`、单根 bar、超长序列如何处理？
4. 是否有可变全局状态 / 跨执行污染风险？
5. 错误处理是否使用统一错误码（`errors.py`）？
6. 是否有性能热点（循环内 numpy 重建、O(n²)、重复计算）？
7. 安全边界是否正确（builtins、import、输出限制、超时）？
8. 测试覆盖是否充分、是否需要补 golden 用例？

---

## 1. 架构基线（审查前必读）

主执行链路：

```text
api.py  ──>  executor.py  ──>  runtime.py
                                 ├─ context.py / series.py / values.py
                                 ├─ namespace.py（命名空间总装配）
                                 ├─ ta.py / utils.py / input.py / state.py / collections.py / *_ext.py
                                 ├─ plot/        （输出收集与绘图函数）
                                 ├─ request/     （host provider / 安全请求）
                                 ├─ strategy/    （订单 / 回放 / 风险 / 账本）
                                 └─ incremental/ （增量会话 / 上下文 / 增量 TA / 策略）
                            ──>  result.py
```

模块规模 Top（指导审查时间分配）：

| 文件 | 行数 | 复杂度提示 |
| --- | --- | --- |
| `plot/functions.py` | ~1249 | 绘图函数工厂，最大单文件 |
| `incremental/strategy.py` | ~1219 | 增量策略状态机 |
| `ta.py` | ~993 | 技术指标核心 |
| `strategy/replay.py` | ~881 | 仓位回放引擎 |
| `strategy/module.py` | ~716 | 策略公共命名空间 |
| `collections.py` | ~421 | array/map/matrix |
| `utils.py` | ~394 | 顶层工具与 series 算子 |

---

## 2. 阶段划分总览

| 阶段 | 主题 | 主要文件 | 关注重点 |
| --- | --- | --- | --- |
| P0 | 执行入口与配置 | `api` `executor` `runtime` `settings` `schema` `cli` `__init__` `_version` `__main__` | 入口契约、进程隔离、超时、装配编排 |
| P1 | 安全边界 | `security` `errors` `cache` | builtins/import 限制、输出限制、错误码、缓存隔离 |
| P2 | 数据与上下文 | `data` `context` `series` `values` `barstate` `metadata` `ticker` | OHLCV 归一化、派生序列、`na`、bar 索引 |
| P3 | 命名空间装配 | `namespace` | 名称注入、跨执行隔离、API 暴露面 |
| P4 | 核心计算 | `ta` `utils` `math_ext` `string_ext` `time_ext` `color` | 指标正确性、向量化、边界与 `na` |
| P5 | 输入与状态 | `input` `state` `collections` | 参数 schema、`var`/`state` 语义、容器语义 |
| P6 | 绘图与结果 | `plot/*` `result` | 输出收集、drawing objects、序列化、结果 schema |
| P7 | request 子包 | `request/*` | host provider、表达式求值、对齐、lower-tf、安全 |
| P8 | strategy 子包 | `strategy/*` | 订单模型、回放、风险、成本、账本、OCA |
| P9 | incremental 子包 | `incremental/*` | 会话、增量上下文、增量 TA、增量策略、限制 |
| P10 | 测试与契约 | `tests/*` `tests/golden/*` `scripts/*` | 覆盖率、golden 契约、capture 工作流 |

依赖顺序建议：**P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9 → P10**。
P4–P6 之间相对独立，可按需要并行；P7–P9 依赖前面的基础层。

---

## 3. 各阶段执行细则

### P0 — 执行入口与配置
- **文件**：`api.py` `executor.py` `runtime.py` `settings.py` `schema.py` `cli.py` `__init__.py` `__main__.py` `_version.py`
- **审查重点**：
  - `run()` / `execute_pyne_script()` 的参数透传是否完整（provider/syminfo/timeframe/session）。
  - inline vs process 两种执行模式的差异与超时/grace 边界（`executor.py` 的队列读取防假超时逻辑）。
  - `runtime.execute()` 的异常分类是否覆盖全部错误码路径。
  - `__init__.__all__` 与实际导出是否一致（结合 `tests/test_architecture.py`）。
- **验证**：`pytest tests/test_api.py tests/test_executor.py tests/test_cli.py tests/test_architecture.py -q`

### P1 — 安全边界
- **文件**：`security.py` `errors.py` `cache.py`
- **审查重点**：
  - `SAFE_BUILTINS` 白名单是否过宽/过窄；research 模式下的受限 `__import__`。
  - `validate_script_security()` 的 AST 走查是否能绕过（如动态 import、`__builtins__` 逃逸）。
  - `execution_timeout()` 在非主线程 / 非 Unix 下降级行为与进程模式的兜底关系。
  - `enforce_output_limits()` 计数口径与 `pyne_cache` 跨执行是否会泄漏状态。
- **验证**：`pytest tests/test_security.py tests/test_errors.py tests/test_cache.py -q`

### P2 — 数据与上下文
- **文件**：`data.py` `context.py` `series.py` `values.py` `barstate.py` `metadata.py` `ticker.py`
- **审查重点**：
  - CSV/pandas/list 归一化的列映射、时间单位、缺失字段处理。
  - 派生序列 `hl2/hlc3/ohlc4/hlcc4` 与 `bar_index` 对齐。
  - `na` 语义（`values.py`）在比较/算术中的传播一致性。
  - `barstate`（isfirst/islast/isconfirmed 等）在批处理下的取值。
- **验证**：`pytest tests/test_data.py tests/test_series.py tests/test_barstate.py tests/test_na_semantics.py tests/test_metadata_runtime.py tests/test_ticker_runtime.py -q`

### P3 — 命名空间装配
- **文件**：`namespace.py`
- **审查重点**：
  - 注入名称是否与文档 API 矩阵一致、是否有遗漏/多余暴露。
  - 每次 `execute()` 是否真正 stateless（`RuntimeServices` 重建）。
  - 顶层别名（`sma/ema/rsi...`）与 `ta.*` 的实现是否同源、避免重复语义。
- **验证**：`pytest tests/test_api.py tests/test_smoke.py -q`

### P4 — 核心计算
- **文件**：`ta.py` `utils.py` `math_ext.py` `string_ext.py` `time_ext.py` `color.py`
- **审查重点**：
  - 指标实现与 Pine 语义一致性（`rma` 初值、`rsi`/`macd`/`atr`/`bb` 边界）。
  - 向量化是否充分、是否存在循环内重复分配。
  - `na`/`nz`、`barssince`/`valuewhen`/`highest`/`lowest` 的边界。
  - `color.*` 的解析与 alpha 处理。
- **验证**：`pytest tests/test_ta_runtime.py tests/test_golden_ta.py tests/test_math_runtime.py tests/test_string_runtime.py tests/test_time_runtime.py tests/test_color_runtime.py -q`

### P5 — 输入与状态
- **文件**：`input.py` `state.py` `collections.py`
- **审查重点**：
  - `input.*` 生成的 param schema 与前端契约（`schema.py`）。
  - `var`/`state` 的跨 bar 持久化语义是否符合 Pine。
  - `PyneArray/PyneMap/PyneMatrix` 的可变性、越界、`na` 处理。
- **验证**：`pytest tests/test_input_runtime.py tests/test_state_runtime.py tests/test_collections_runtime.py -q`

### P6 — 绘图与结果
- **文件**：`plot/functions.py` `plot/collector.py` `plot/objects.py` `plot/refs.py` `result.py`
- **审查重点**：
  - `create_plot_functions()` 工厂的函数签名与 Pine 对齐、最大 drawing objects 限制。
  - `OutputCollector.to_dict()` 输出结构与 `result.py`/输出 schema 一致。
  - drawing objects（line/label/box/table）序列化与 `ObjectRef` 生命周期。
  - 批处理与增量绘图是否复用同一对象模型。
- **验证**：`pytest tests/test_plot_runtime.py tests/test_result.py tests/test_schema.py -q`

### P7 — request 子包
- **文件**：`request/module.py` `request/eval.py` `request/alignment.py` `request/lower_tf.py` `request/provider.py` `request/errors.py`
- **审查重点**：
  - host `DataProvider` 边界、无效 symbol 错误路径。
  - `request.security()` 的 gaps/lookahead 对齐与表达式求值 thunk。
  - lower timeframe grouping 的分组与回填。
- **验证**：`pytest tests/test_request_security.py tests/test_golden_request_security.py -q`

### P8 — strategy 子包
- **文件**：`strategy/module.py` `strategy/replay.py` `strategy/orders.py` `strategy/ledger.py` `strategy/risk.py` `strategy/costs.py` `strategy/constants.py`
- **审查重点**：
  - 订单事件模型、仓位回放的逐 bar 撮合与 fills。
  - 风险控制、成本/滑点模型、OCA、交易账本与报告字段。
  - 与 golden strategy / TradingView capture 契约的一致性。
- **验证**：`pytest tests/test_strategy_runtime.py tests/test_golden_strategy.py tests/test_strategy_shared_helpers.py -q`

### P9 — incremental 子包
- **文件**：`incremental/session.py` `incremental/context.py` `incremental/ta.py` `incremental/strategy.py` `incremental/drawing.py` `incremental/manager.py` `incremental/bar.py` `incremental/limits.py` `incremental/detection.py` `incremental/result.py`
- **审查重点**：
  - `is_incremental_pyne_script()` 检测逻辑与批处理路径的语义等价性。
  - 增量 TA / 策略状态机与批处理结果的一致性（这是最大风险面）。
  - 会话管理、共享会话、限制策略的资源边界。
- **验证**：`pytest tests/test_incremental.py -q`，并交叉对比批处理 golden。

### P10 — 测试与契约
- **文件**：`tests/*` `tests/golden/*` `scripts/strategy_capture_*.py`
- **审查重点**：
  - golden 契约覆盖面是否与「兼容性声明」匹配。
  - capture 工作流脚本（scaffold/diff/preflight/prepare/next/status/import）的门禁有效性。
  - 是否存在未覆盖的边界（空数据、单 bar、超限）。
- **验证**：完整质量门禁见 `docs/development/quality_gates.md`。

---

## 4. 统一质量门禁（每阶段收尾执行）

```powershell
$env:PYTHONPATH='H:\program\CandleScope\packages\pyne-runtime\src'
python -m compileall src tests -q
python -m ruff check .
python -m pytest tests/test_architecture.py -q
python -m pytest -q
```

策略 capture 相关阶段（P8/P10）额外执行：

```powershell
python scripts/strategy_capture_scaffold.py --check
python scripts/strategy_capture_diff.py --assertion parity
```

---

## 5. 进度跟踪表

> 状态：⬜ 未开始 / 🔶 进行中 / ✅ 已完成。问题数指本阶段记录的待办项。

| 阶段 | 主题 | 状态 | 问题数 | 备注 |
| --- | --- | --- | --- | --- |
| P0 | 执行入口与配置 | ✅ | 10 | 见 §7 P0 问题清单（仅审查未修改） |
| P1 | 安全边界 | ✅ | 8 | 见 §8 P1 问题清单；含 1 项高危沙箱问题 |
| P2 | 数据与上下文 | ✅ | 10 | 见 §9 P2 问题清单（仅审查未修改） |
| P3 | 命名空间装配 | ✅ | 8 | 见 §10 P3 问题清单；含 1 项 numpy 暴露安全项 |
| P4 | 核心计算 | ✅ | 11 | 见 §12 P4 问题清单；含 sma 对 NaN 的正确性问题 |
| P5 | 输入与状态 | ✅ | 10 | 见 §13 P5 问题清单 |
| P6 | 绘图与结果 | ✅ | 10 | 见 §14 P6 问题清单 |
| P7 | request 子包 | ✅ | 8 | 见 §15 P7 问题清单 |
| P8 | strategy 子包 | ✅ | 8 | 见 §16 P8 问题清单 |
| P9 | incremental 子包 | ✅ | 9 | 见 §17 P9 问题清单 |
| P10 | 测试与契约 | ✅ | 9 | 见 §18 P10 问题清单 |

---

## 6. 问题记录模板

每发现一个问题，按以下格式追加到对应阶段的问题清单（可单列文件或在本文件末尾汇总）：

```markdown
### [P{阶段}-{编号}] {简短标题}
- 文件/位置：`path/to/file.py:Lxx`
- 类别：正确性 / 安全 / 性能 / 可维护性
- 现象：
- 影响：
- 建议：保留 / 加测试 / 重构 / 修复
- 状态：待确认 / 已确认 / 已处理
```

---

## 7. P0 问题清单（执行入口与配置）

> 审查范围：`api.py` `executor.py` `runtime.py` `settings.py` `schema.py` `cli.py` `__init__.py` `__main__.py` `_version.py`。
> 本轮**仅审查、未修改任何代码**。结论列出建议，待确认后再决定是否进入修复阶段。

### [P0-01] 进程执行模式在 Windows / spawn 下 provider 可能无法 pickle
- 文件/位置：[executor.py](../../src/pyne_runtime/executor.py#L155-L163)（`_multiprocessing_context`、`_pyne_worker`）
- 类别：正确性 / 跨平台
- 现象：默认 `executor_mode="process"`。`_multiprocessing_context()` 优先 `fork`，Windows 无 fork 会回退到 `spawn`。spawn 需要 pickle `settings`（含 `data_provider`/`syminfo`/`session` 等任意对象）并传给子进程。
- 影响：当宿主通过 `data_provider=` 传入不可 pickle 的对象（如带闭包/连接的 provider）时，进程模式在 Windows 上会在启动子进程时抛 `PicklingError`，而不是返回结构化 `PyneResult`。`request.security()` 的 host-backed 路径在进程模式下基本不可用。
- 建议：加测试 + 文档说明。明确「host provider 仅在 inline 模式可用」或在 `execute_pyne_script` 检测到 provider 时给出清晰错误码；并评估 fork 在 3.12+ 多线程下的弃用警告。
- 状态：待确认

### [P0-02] 同名函数 `normalize_security_mode` 行为分歧（raise vs 静默回退）
- 文件/位置：[settings.py](../../src/pyne_runtime/settings.py#L114-L118) 与 [security.py](../../src/pyne_runtime/security.py#L104-L108)
- 类别：可维护性 / 正确性
- 现象：`settings.normalize_security_mode()` 对非法值**静默回退 `safe`**；`security.normalize_security_mode()` 对非法值**抛 `PyneSecurityError`**。两者同名、语义相反。
- 影响：`PyneSettings(security_mode="bogus")` 会被悄悄改成 safe；而 `pn.run(..., security_mode="bogus")` 走 policy 路径会报错。同一非法输入两种结局，易误导调用方与维护者。
- 建议：重构。统一为单一实现并消除歧义命名（如 settings 侧命名 `coerce_security_mode`），或都改为同一策略。
- 状态：待确认

### [P0-03] `with_security_mode` 手工逐字段复制，易随新字段遗漏
- 文件/位置：[settings.py](../../src/pyne_runtime/settings.py#L91-L111)
- 类别：可维护性
- 现象：`with_security_mode()` 手动枚举全部 14 个字段重建 `PyneSettings`，而非使用 `dataclasses.replace`。
- 影响：未来新增配置字段时极易忘记在此处补充，导致复制时该字段被重置为默认值（静默 bug）。
- 建议：重构为 `dataclasses.replace(self, security_mode=security_mode)`。
- 状态：待确认

### [P0-04] `mintick` 默认值不一致（1.0 vs 0.01）
- 文件/位置：[settings.py](../../src/pyne_runtime/settings.py#L70-L80)（`from_env` 默认 `PYNE_MINTICK=1.0`）与 [namespace.py](../../src/pyne_runtime/namespace.py#L114)（`math` 默认 `getattr(syminfo, "mintick", 0.01)`）
- 类别：正确性 / 一致性
- 现象：两处对 mintick 的默认值分别是 1.0 与 0.01。
- 影响：`math.round_to_mintick` 等依赖 mintick 的行为在「未设置 syminfo」与「from_env 默认」两条路径下结果不同，可能造成精度/对齐差异。
- 建议：确认。统一默认 mintick 来源与取值。
- 状态：待确认

### [P0-05] 运行时异常信息直接回传，存在信息泄露风险
- 文件/位置：[runtime.py](../../src/pyne_runtime/runtime.py#L168-L177)（`except Exception` 分支）
- 类别：安全 / 可维护性
- 现象：兜底 `except Exception` 返回 `error=f"Script error: {exc}"`，把原始异常字符串（可能含文件路径、内部对象 repr）直接放进结果；同时未保留 traceback、无日志。
- 影响：对不可信脚本场景可能泄露宿主内部信息；对开发者又缺少可定位的堆栈。
- 建议：修复。对外消息脱敏 + 可选 debug 日志/traceback（受 settings 控制）。
- 状态：待确认

### [P0-06] CLI `run` 未捕获脚本/数据读取异常
- 文件/位置：[cli.py](../../src/pyne_runtime/cli.py#L44-L67)
- 类别：可维护性 / 健壮性
- 现象：`read_ohlcv(args.ohlcv)` 与 `run(Path(args.script), ...)` 未做异常包装。脚本文件不存在、CSV 解析失败等会抛裸异常并打印 traceback。
- 影响：CLI 用户拿到 Python traceback 而非统一错误码/友好信息，与 `validate`/`run` 的结构化错误风格不一致。
- 建议：修复。捕获文件/解析异常并映射为 `PYNE_*` 错误码后以 JSON/退出码返回。
- 状态：待确认

### [P0-07] `_read_script` 字符串/路径启发式存在歧义
- 文件/位置：[api.py](../../src/pyne_runtime/api.py#L88-L94)
- 类别：正确性 / 边界
- 现象：当 `script` 为「无换行且 `Path(script).exists()` 为真」的字符串时，按文件读取。
- 影响：单行脚本若恰好与某个存在的文件名相同（如 `close`），会被误当作文件路径读取；超长字符串调用 `Path.exists()` 在个别平台可能抛 `OSError`。
- 影响低但语义隐晦。建议：确认 + 文档化。倾向显式区分：`Path` 入参才读文件，`str` 一律按脚本文本（或提供独立 `run_file`）。
- 状态：待确认

### [P0-08] `validate()` 不校验运行期资源限制，仅语法 + import 安全
- 文件/位置：[api.py](../../src/pyne_runtime/api.py#L60-L84)
- 类别：可维护性 / 一致性
- 现象：`validate()` 只做 `compile` 语法检查与 `validate_script_security`，不覆盖 `max_bars` / 输出限制等运行期约束（这些只能在执行时知道，合理），但文档/契约未明确 validate 的边界。
- 影响：调用方可能误以为 `validate` 通过即代表 `run` 一定不触发安全/限制错误。
- 建议：保留 + 文档化 validate 的检查范围。
- 状态：待确认

### [P0-09] inline 模式下全局 `pyne_cache` 被每次构造 runtime 重配置
- 文件/位置：[runtime.py](../../src/pyne_runtime/runtime.py#L48-L50)（`__init__` 调 `pyne_cache.configure`）
- 类别：性能 / 隔离（与 P1 衔接）
- 现象：`pyne_cache` 为模块级全局，`PyneRuntime.__init__` 每次都 `configure(max_items=...)`。inline 模式下多个不同 settings 的 runtime 会相互覆盖缓存容量；缓存内容在同进程多次执行间共享。
- 影响：inline 多脚本串跑时存在跨执行状态共享（依赖 key 正确性），需在 P1 与 `cache.py` 一并核实隔离与失效策略。
- 建议：转 P1 深查。
- 状态：待确认（转 P1）

### [P0-10] `execute_pyne_script` 的 provider/syminfo 透传仅覆盖 inline，进程路径依赖 settings 序列化
- 文件/位置：[executor.py](../../src/pyne_runtime/executor.py#L36-L60)
- 类别：正确性 / 一致性
- 现象：函数顶部用 `replace(settings, ...)` 把 `data_provider/syminfo/timeframe/session` 合并进 settings；inline 直接用，进程路径把整个 settings 传给子进程。与 [P0-01] 同源：进程路径正确性取决于这些对象可被 pickle。
- 影响：inline 与 process 两种模式对「带 provider/复杂 syminfo」的支持度不对称。
- 建议：与 [P0-01] 合并处理，明确两模式能力矩阵。
- 状态：待确认

### P0 小结
- 阻断级：无（现有测试与默认路径可用）。
- 优先级建议：先处理 [P0-02][P0-03][P0-05][P0-06]（低风险、收益明确）；[P0-01][P0-10] 需先确认 host provider 的目标使用模式再定方案；[P0-04] 需产品语义确认；[P0-09] 并入 P1。
- 本阶段未改动任何源码。

---

## 8. P1 问题清单（安全边界）

> 审查范围：`security.py` `errors.py` `cache.py`（并交叉核实 `namespace.py` 的 builtins 注入）。
> 本轮**仅审查、未修改任何代码**。

### [P1-01] ⚠️ safe/research 模式不是真正的沙箱，可通过 `__globals__` 逃逸（高危）
- 文件/位置：[security.py](../../src/pyne_runtime/security.py#L110-L131)（`validate_script_security` / `build_builtins`）+ [namespace.py](../../src/pyne_runtime/namespace.py#L168-L170)
- 类别：安全（高危）
- 现象：`exec(script, script_globals)` 仅把 `__builtins__` 换成受限 `SAFE_BUILTINS`；`validate_script_security` 只静态拦截 `Import`/`ImportFrom` 语句，**不限制属性/dunder 访问**。由于注入命名空间中存在大量纯 Python helper（如 `nz`/`crossover` 等来自 `utils`），脚本可直接通过其 `__globals__` 拿到所在模块的**真实** builtins：
  ```python
  nz.__globals__['__builtins__']['__import__']('os').system('...')
  ```
  或经典的 `().__class__.__base__.__subclasses__()` 遍历拿到 `subprocess`/`warnings` 等。无需任何 import 语句即可逃逸。
- 影响：README/executor 文案暗示进程模式用于「untrusted or buggy scripts」，但子进程**无 OS 级隔离**（可读写文件、联网），仅受超时约束。面对**恶意**脚本时 safe 模式不构成安全边界。
- 建议：修复/文档化。至少诚实说明威胁模型（safe 只防误操作、不防恶意）；若需真 untrusted 执行，需 OS 级沙箱（容器/seccomp）或增加 AST 拒绝 dunder 属性访问 + 切断 helper 的 `__globals__` 暴露。优先级最高。
- 状态：待确认

### [P1-02] `enforce_output_limits` 未覆盖全部 OUTPUT_KEYS，输出上限可绕过
- 文件/位置：[security.py](../../src/pyne_runtime/security.py#L135-L160) 与 [schema.py](../../src/pyne_runtime/schema.py#L11-L24)
- 类别：安全（资源）
- 现象：`enforce_output_limits` 仅统计 `lines/histograms/bars/markers` 的系列数与点数；而 `OUTPUT_KEYS` 还包含 `hlines/fills/bgcolors/barcolors/signals/objects/object_events`。
- 影响：脚本可通过大量 `fills/bgcolors/barcolors/signals` 等绕过 `max_output_points`/`max_output_series`，造成输出体积膨胀/内存压力（`objects` 另有 `max_drawing_objects` 单独限制，但其他集合无界）。
- 建议：修复。把限制口径扩到全部可增长集合，或明确文档哪些集合不受限及原因。
- 状态：待确认

### [P1-03] `pyne_cache` 进程全局单例，inline 模式跨脚本串扰/泄漏（承 P0-09）
- 文件/位置：[cache.py](../../src/pyne_runtime/cache.py#L86-L102)（`pyne_cache` 全局、`stats`、`configure`）
- 类别：安全（隔离）
- 现象：`pyne_cache = PyneCache()` 为模块级全局，**缓存键未按执行隔离**。inline 模式下脚本 A 缓存的 `key` 会被脚本 B 读到（缓存投毒/串扰）；`stats()` 返回全部 `keys`，泄漏其他执行的键；`configure()` 每次 runtime 初始化全局重置 `max_items`。
- 影响：多租户 inline 宿主下存在跨租户状态共享与信息泄漏（process 模式因独立进程而隔离）。
- 建议：修复。为缓存引入执行/会话级命名空间或改为执行范围实例；`stats` 不应跨执行暴露 keys。
- 状态：待确认

### [P1-04] `execution_timeout` 仅主线程+Unix 生效，inline 模式 Windows 无超时
- 文件/位置：[security.py](../../src/pyne_runtime/security.py#L162-L210)
- 类别：正确性 / 跨平台
- 现象：`execution_timeout` 依赖 `signal.SIGALRM`/`setitimer`，仅在主线程且 Unix 生效，其余场景静默降级为无操作。
- 影响：inline 模式在 Windows/非主线程下**完全无超时**，死循环会挂死；process 模式靠父进程 `terminate` 兜底（这是当前设计）。Windows 下默认 process 模式尚可，但显式 inline 调用需提醒风险。
- 建议：文档化 + 加测试。明确 inline 模式的超时为 best-effort，仅 process 模式提供硬边界。
- 状态：待确认

### [P1-05] `classify_security_error` 依赖错误消息子串匹配，脆弱
- 文件/位置：[errors.py](../../src/pyne_runtime/errors.py#L104-L109)
- 类别：可维护性
- 现象：通过 `"output series"`/`"output points"`/`"import"` 等消息子串判断错误码。一旦错误文案调整即误分类；`"import"` 子串也可能误命中无关消息。
- 影响：错误码与实际原因脱钩，影响调用方分支判断与文档链接。
- 建议：重构。让 `PyneSecurityError` 携带结构化 `code`，避免事后字符串分类。
- 状态：待确认

### [P1-06] `SAFE_BUILTINS` 缺 `__build_class__` 等，safe/research 下无法定义 class
- 文件/位置：[security.py](../../src/pyne_runtime/security.py#L19-L47)
- 类别：功能限制 / 一致性
- 现象：`SAFE_BUILTINS` 未包含 `__build_class__`，脚本中的 `class` 定义会报 `NameError: __build_class__`；同时缺 `getattr/type/repr/format/super/property` 等。
- 影响：research 模式做 ML/库集成时（允许 sklearn/torch）却无法定义辅助类，限制明显且错误信息不直观。注：部分缺失（如 `getattr/type`）也是弱沙箱加固，需与 P1-01 一并权衡。
- 建议：确认 + 文档化。明确 safe/research 可用的语言子集；若需支持 class，在不削弱安全的前提下评估补 `__build_class__`。
- 状态：待确认

### [P1-07] `cache.get_or_load` 并发语义与 TTL 语义需文档化
- 文件/位置：[cache.py](../../src/pyne_runtime/cache.py#L34-L58)、[cache.py](../../src/pyne_runtime/cache.py#L15-L16)
- 类别：正确性 / 并发
- 现象：loader 在锁外执行（避免持锁，合理），但并发同 key miss 会重复调 loader 且「后写入者胜」，非严格 memo；`expired` 中 `ttl<=0` 被视为永远过期（写入即失效），TTL 以 `created_at` 为准是绝对过期而非滑动窗。
- 影响：调用方可能误以为 `cache` 是严格单次加载/滑动 TTL。
- 建议：保留 + 文档化语义（并发可重入、绝对 TTL、ttl<=0 含义）。
- 状态：待确认

### [P1-08] `validate_script_security` 对 SyntaxError 静默跳过安全检查
- 文件/位置：[security.py](../../src/pyne_runtime/security.py#L110-L122)
- 类别：可维护性
- 现象：`validate_script_security` 在 `ast.parse` 抛 `SyntaxError` 时 `return`（跳过全部 import 检查）。功能上无害（语法错脚本随后 exec 仍会报 SyntaxError），但「安全检查被跳过」这一点未加注释，易误读。
- 影响：语义可接受，仅可读性。建议：保留 + 加注释说明「语法错交由 exec 报错」。
- 状态：待确认

### P1 小结
- 阻断级：无（默认 process 模式 + 现有测试可用）；但 **[P1-01] 为高危安全认知问题**，必须在对外文档中诚实陈述威胁模型。
- 优先级建议：[P1-01]（文档化威胁模型，长期考虑 OS 沙箱）> [P1-02][P1-03]（资源/隔离，与多租户相关）> [P1-05]（错误分类重构）> [P1-04][P1-06][P1-07][P1-08]（文档化/注释说明）。
- 本阶段未改动任何源码。

---

## 9. P2 问题清单（数据与上下文）

> 审查范围：[data.py](../../src/pyne_runtime/data.py)、[context.py](../../src/pyne_runtime/context.py)、[values.py](../../src/pyne_runtime/values.py)、[series.py](../../src/pyne_runtime/series.py)、[barstate.py](../../src/pyne_runtime/barstate.py)、[metadata.py](../../src/pyne_runtime/metadata.py)、[ticker.py](../../src/pyne_runtime/ticker.py)。

### [P2-01] 缺少对时间戳单调递增 / 唯一性的校验
- 文件/位置：[data.py](../../src/pyne_runtime/data.py#L1-L185)（`_normalize_bar` / `PyneData.from_ohlcv`）
- 类别：正确性
- 现象：归一化每根 bar 只做 `int(float(item["time"]))` 与 ms→s 折算，从不校验整组时间戳是否严格递增、是否存在重复或乱序。
- 影响：乱序 / 重复时间戳会让 `request.security` 对齐、时间相关逻辑（`time`/`time_close`/会话判断）与增量重放产生静默错误结果，且难以排查。
- 建议：在 `from_ohlcv`/`coerce_ohlcv` 末尾增加一次性校验（递增、非重复），用 `errors.py` 统一错误码报错；或至少在文档中明确「调用方需保证按时间升序、去重」。
- 状态：待确认

### [P2-02] 最后一根 bar 的 `time_close` 退化为 NaN
- 文件/位置：[context.py](../../src/pyne_runtime/context.py)（`_derive_time_close`）
- 类别：正确性 / 边界
- 现象：未显式提供 `time_close` 时，用「下一根 bar 的 time」推算，最后一根因无下一根而填 `NaN`。
- 影响：脚本在最后一根使用 `time_close`（会话结束判断、剩余时间等）会拿到 `NaN`，与 Pine「按周期推算收盘时间」语义不一致。
- 建议：用相邻 bar 的时间间隔（周期）外推最后一根的 `time_close`，或在文档中说明该边界行为。
- 状态：待确认

### [P2-03] 派生序列（hl2/hlc3/ohlc4/hlcc4）携带错误的 `name`
- 文件/位置：[context.py](../../src/pyne_runtime/context.py)、[series.py](../../src/pyne_runtime/series.py)（`PyneSeries._binary`）
- 类别：可维护性
- 现象：`_binary` 用左操作数的 `name` 生成结果序列名，`(high+low)/2` 之类的派生序列最终 `name` 被传成 `"high"` 等，而非 `"hl2"`。
- 影响：仅影响调试 / plot 图例 / 错误信息中的序列标识，不影响数值；但会误导排查。
- 建议：在 `context.from_ohlcv` 派生这些序列后显式 `replace(name=...)`，或为派生量单独赋名。
- 状态：待确认

### [P2-04] `na` 与序列的算术不对称、会丢失形状
- 文件/位置：[values.py](../../src/pyne_runtime/values.py)（`PyneNA._nan`）
- 类别：正确性 / 边界
- 现象：`series + na` 走 `PyneSeries._binary` 返回逐元素 NaN 序列；但 `na + series` 由 `PyneNA.__add__` 处理，直接返回**标量** `nan`，丢失序列形状。
- 影响：表达式中 `na` 在左侧时结果退化为标量，后续广播 / 长度推断行为与右侧时不一致，可能产生隐蔽 bug。
- 建议：让 `PyneNA` 的算术在遇到序列 / 数组时返回 `NotImplemented`（交回右操作数处理），从而保持形状一致。
- 状态：待确认

### [P2-05] OHLC 数值缺少合理性校验
- 文件/位置：[data.py](../../src/pyne_runtime/data.py)（`_normalize_bar`）
- 类别：正确性 / 边界
- 现象：仅 `float()` 转换，不校验 `high >= max(open, close)`、`low <= min(open, close)`、价格是否为 `NaN`/负数。
- 影响：脏数据（NaN 价、high<low）会无声进入指标计算，导致下游 TA 结果异常且无明确报错点。
- 建议：增加可选的轻量校验（至少 NaN 检测），通过 settings 开关控制严格 / 宽松模式，避免影响性能与现有 golden。
- 状态：待确认

### [P2-06] 两条入口对缺失字段的严格度不一致
- 文件/位置：[context.py](../../src/pyne_runtime/context.py)（`from_ohlcv` 使用 `d.get("open", 0)` 等默认值）vs [data.py](../../src/pyne_runtime/data.py)（`_normalize_bar` 缺字段直接报错）
- 类别：可维护性 / 一致性
- 现象：`data.py` 对缺失 OHLCV 字段抛错，而 `context.from_ohlcv` 用 `.get(key, 0)` 把缺失字段静默填 0。
- 影响：若有调用路径绕过 `coerce_ohlcv`/`PyneData` 直接喂给 `context.from_ohlcv`，缺字段会被静默当成 0，行为与主入口不一致。
- 建议：统一策略——要么都严格报错，要么都填默认并文档化；并明确 `context.from_ohlcv` 是否属于内部 API（不应被外部直接调用）。
- 状态：待确认

### [P2-07] `PyneSeries` 不可哈希且 `==` 返回序列，集合 / `in` 操作会异常
- 文件/位置：[series.py](../../src/pyne_runtime/series.py)（`__eq__`/`__ne__`/`__bool__`、frozen dataclass）
- 类别：可维护性 / 边界
- 现象：为实现 Pine 语义，`__eq__` 返回逐元素 `PyneSeries`，`__bool__` 抛 `TypeError`；同时字段含 `ndarray` 使实例实际不可哈希。
- 影响：把序列放进 `set`/`dict` key、或 `series in some_list` 之类操作会抛异常；属于刻意的语义取舍，但需明确告知用户与内部代码。
- 建议：在文档与开发约定中显式说明「序列不可用于集合 / 真值判断 / 成员检测」，并确保内部代码不依赖这些操作。
- 状态：待确认

### [P2-08] namespace 中 `mintick=0.01` 兜底为不可达死代码（对 P0-04 的补充）
- 文件/位置：[namespace.py](../../src/pyne_runtime/namespace.py)、[metadata.py](../../src/pyne_runtime/metadata.py)（`SymbolInfo.mintick` 默认 `1.0`）
- 类别：可维护性
- 现象：`ctx.syminfo` 始终是带 `mintick=1.0` 默认值的 `SymbolInfo`，namespace 中 `0.01` 的兜底分支实际永远走不到；全局有效默认 mintick 为 `1.0`。
- 影响：P0-04 记录的「0.01 vs 1.0 不一致」实为**外观问题**——真实生效值统一是 `1.0`，但残留的 `0.01` 兜底易误导维护者。
- 建议：删除不可达的 `0.01` 兜底，或将默认 mintick 收敛到单一常量来源（settings / metadata）。
- 状态：待确认

### [P2-09] 时间框架 `multiplier` 单位混用，字段语义含糊
- 文件/位置：[metadata.py](../../src/pyne_runtime/metadata.py)（`_parse_timeframe`）
- 类别：可维护性
- 现象：intraday 的 `multiplier` 对秒（`30S`→30）是秒、对分钟（`5m`→5）是分钟、对小时（`1h`→60）折算成分钟，而日 / 周 / 月又是「个数」。同一字段在不同分类下单位不同。
- 影响：消费 `multiplier` 的代码若不区分分类会算错周期长度；语义需配合 `isintraday/isdaily/...` 才能解释。
- 建议：要么把 intraday 全部归一到同一单位（如秒），要么在字段 / 文档中清晰标注「单位随分类变化」。
- 状态：待确认

### [P2-10] DataFrame 识别仅靠模块名前缀，扩展性差
- 文件/位置：[data.py](../../src/pyne_runtime/data.py)（`coerce_ohlcv`）
- 类别：可维护性
- 现象：pandas 检测用 `data.__class__.__module__.startswith("pandas")`；polars / pyarrow / numpy 结构化数组等不被识别，落入 dict 迭代分支并以不直观的错误失败。
- 建议：改用 duck-typing（如检测 `to_dict("records")` / `__dataframe__` 协议），或显式列出支持的输入类型并在不支持时给出清晰错误。
- 状态：待确认

### P2 小结
- 阻断级：无；本阶段均为正确性 / 边界 / 可维护性问题，未发现新的安全阻断项。
- 优先级建议：[P2-01]（时间戳校验，影响面最广）> [P2-04][P2-06]（语义 / 入口一致性）> [P2-02][P2-05]（边界正确性）> [P2-03][P2-07][P2-08][P2-09][P2-10]（命名 / 文档 / 可维护性）。
- 本阶段未改动任何源码。

---

## 10. P3 问题清单（命名空间装配）

> 审查范围：[namespace.py](../../src/pyne_runtime/namespace.py)（`RuntimeServices`、`build_script_namespace` 及各 `install_*` 装配函数）。

### [P3-01] 直接向脚本注入完整 `numpy`，绕过策略形成文件 I/O / 代码执行面
- 文件/位置：[namespace.py](../../src/pyne_runtime/namespace.py#L165-L170)（`install_compat_namespace` 中 `namespace["np"] = np` / `namespace["numpy"] = np`）
- 类别：安全性
- 现象：无论安全模式如何，都把完整 `numpy` 模块对象直接放进脚本全局命名空间；这是真实对象，不经过 `build_builtins` / import 策略过滤。
- 影响：脚本可调用 `np.load(path, allow_pickle=True)`（反序列化 pickle → **任意代码执行**）、`np.fromfile` / `np.save` / `ndarray.tofile`（**任意文件读写**），即便在 `safe` 模式也成立。这是对 P1-01 威胁模型的一个**具体、可达的逃逸 / 越权 I/O 向量**。
- 建议：在 `safe` 模式下改为暴露受限的 numpy 门面（仅数学 ufunc / 构造函数白名单），或至少在威胁模型文档中明确「注入了完整 numpy，等价于赋予文件 I/O 与反序列化能力」。
- 状态：待确认

### [P3-02] `math` 的 `mintick` 兜底 `0.01` 为不可达死代码（对 P2-08 的呼应）
- 文件/位置：[namespace.py](../../src/pyne_runtime/namespace.py)（`PyneMath(mintick=getattr(ctx.syminfo, "mintick", 0.01))`）
- 类别：可维护性
- 现象：`ctx.syminfo` 始终是带 `mintick=1.0` 的 `SymbolInfo`，`getattr(..., 0.01)` 的兜底永远走不到。
- 影响：与 P2-08 一致，残留 `0.01` 易误导维护者，真实生效值为 `1.0`。
- 建议：删除不可达兜底，统一 mintick 默认来源。
- 状态：待确认

### [P3-03] 多个 `install_*` 函数对同名键无冲突检测，存在静默覆盖风险
- 文件/位置：[namespace.py](../../src/pyne_runtime/namespace.py)（`build_script_namespace` 顺序调用 data/api/plot/utility/compat/builtins）
- 类别：可维护性
- 现象：各装配函数直接写 `namespace[key]`，`install_plot_namespace` 还用 `namespace.update(services.plot_functions)` 批量写入；若不同来源产生同名键（如 plot 函数与某工具别名同名），后者会静默覆盖前者，无任何告警。
- 影响：未来新增名称时易产生难排查的覆盖冲突，破坏脚本可见名称契约。
- 建议：装配时对已存在键做断言 / 收集冲突，或维护一份「保留名称」清单做防御性检查。
- 状态：待确认

### [P3-04] 大量 Python 内建名被刻意遮蔽，需明确文档化
- 文件/位置：[namespace.py](../../src/pyne_runtime/namespace.py)（`open`/`time`/`input`/`str`/`map`/`math` 等键）
- 类别：可维护性 / 边界
- 现象：`open`(序列)、`input`(InputModule)、`str`(string 命名空间)、`map`(map 命名空间)、`time`(time 命名空间)、`math`(PyneMath) 等遮蔽同名 Python 内建 / 模块。
- 影响：这是符合 Pine 语义的有意设计，但会让习惯 Python 的用户误用（如把 `str(x)` 当类型转换、`open(...)` 当文件打开），错误信息可能不直观。
- 建议：在面向用户文档中集中列出「被遮蔽的名称及其 Pine 语义」，并确认 `build_builtins` 未再额外暴露这些名的 Python 版本造成歧义。
- 状态：待确认

### [P3-05] `RuntimeServices.__post_init__` 急切构造全部子模块
- 文件/位置：[namespace.py](../../src/pyne_runtime/namespace.py#L46-L57)（`__post_init__`）
- 类别：性能
- 现象：无论脚本是否用到，都会立即实例化 `TaModule`、`InputModule`、`OutputCollector`、`StrategyModule` 等。
- 影响：对只用少量功能的简单脚本会带来固定开销；若其中某些构造较重（如 OutputCollector 预分配），在高频 / 大量脚本场景下累积明显。
- 建议：评估各子模块构造成本，必要时改为惰性属性（首次访问再构造），但需权衡命名空间装配的简洁性。
- 状态：待确认

### [P3-06] 原始可变 `params` 字典被直接注入命名空间且与 input 模块共享引用
- 文件/位置：[namespace.py](../../src/pyne_runtime/namespace.py)（`namespace["params"] = services.params`，同时 `InputModule(params=self.params, ...)`）
- 类别：可维护性 / 边界
- 现象：脚本通过 `params` 拿到的是与 `InputModule` 同一个可变 dict 引用，脚本若就地修改会影响 input 解析结果。
- 影响：单次执行内可能出现「脚本改了 params 导致后续 input 读取不一致」的隐蔽行为。
- 建议：注入 `MappingProxyType(params)` 只读视图，或注入副本，明确 params 对脚本只读。
- 状态：待确认

### [P3-07] `__builtins__` 由 `build_builtins(policy)` 注入（对 P1 的装配侧记录）
- 文件/位置：[namespace.py](../../src/pyne_runtime/namespace.py)（`install_builtins_namespace`）
- 类别：安全性（交叉引用）
- 现象：命名空间的 `__builtins__` 完全来自策略构造，本身设计合理；此处仅记录装配位置，安全分析见 P1-01。
- 影响：与 P1 一致；注意它与 [P3-01] 的 `np` 注入是两条独立的能力来源，numpy 不受 builtins 策略约束。
- 建议：在威胁模型评估中把「注入的对象（np 等）」与「__builtins__」一并纳入暴露面清单。
- 状态：待确认

### [P3-08] `pyne` / `cache` 等多入口指向同一缓存，作用域与隔离需文档化
- 文件/位置：[namespace.py](../../src/pyne_runtime/namespace.py)（`_pyne_namespace` 与 `cache`/`cache_clear`/`cache_stats`）
- 类别：可维护性
- 现象：`pyne.cache`、顶层 `cache`、`pyne.state`/`var` 等指向同一 `pyne_cache` 单例与同一 `state` 实例；缓存是进程级单例。
- 影响：进程级缓存单例在 inline 模式多脚本共享，可能造成跨脚本数据可见 / 污染；需明确缓存键隔离策略（与后续阶段 cache.py 审查衔接）。
- 建议：在缓存阶段（cache.py）专门核对键命名空间隔离；此处先记录「多入口同源」事实。
- 状态：待确认

### P3 小结
- 阻断级：无强制阻断，但 **[P3-01]（完整 numpy 注入）是对 safe 模式安全声明的具体削弱**，应与 P1-01 一起在威胁模型中处理。
- 优先级建议：[P3-01]（numpy 暴露面，安全）> [P3-03][P3-06]（覆盖冲突 / params 只读）> [P3-08]（缓存隔离，留待 cache 阶段）> [P3-02][P3-04][P3-05][P3-07]（死代码 / 文档 / 性能 / 交叉引用）。
- 本阶段未改动任何源码。

---

## 12. P4 问题清单（核心计算）

> 审查范围：[ta.py](../../src/pyne_runtime/ta.py)、[utils.py](../../src/pyne_runtime/utils.py)、[math_ext.py](../../src/pyne_runtime/math_ext.py)、[string_ext.py](../../src/pyne_runtime/string_ext.py)、[time_ext.py](../../src/pyne_runtime/time_ext.py)、[color.py](../../src/pyne_runtime/color.py)。

### [P4-01] `ta.sma` 用 `nancumsum` 处理 NaN，窗口含 NaN 时结果错误（不返回 na）
- 文件/位置：[ta.py](../../src/pyne_runtime/ta.py#L53-L67)（`sma` 中 `cs = np.nancumsum(source)`）
- 类别：正确性
- 现象：`sma` 用 `nancumsum` 将 NaN 当 0 累加，再除以固定 `period`；只要窗口内含一个 NaN，结果会偏小且**不为 na**。
- 影响：与 Pine `ta.sma`（窗口内有 na 则返回 na）语义不一致，也与同模块 `wma`/`alma`（`np.any(np.isnan(window))` 传播 na）、`stdev`（含 NaN 回退窗口法）不一致；`bb` 中间轨依赖 `sma`，会在 NaN 热身 / 嵌套指标场景下产生错误数值。
- 建议：与其他函数统一 NaN 策略（窗口含 NaN → na），或至少在含 NaN 时回退到逐窗口路径（同 `stdev`）。需配套 golden 验证。
- 状态：待确认

### [P4-02] 平窗口振荡指标返回中性常数而非 na
- 文件/位置：[ta.py](../../src/pyne_runtime/ta.py)（`stoch` 返回 `50.0`、`wpr`/`cmo`/`cci` 返回 `0.0`）
- 类别：正确性 / 语义
- 现象：当分母为 0（如 `highest-lowest==0`、`up_sum+down_sum==0`）时，用 50 / 0 等中性常数填充。
- 影响：平盘 / 零波动区间与 Pine（通常产生 na 或延续前值）不一致，可能误导下游信号 / 策略。
- 建议：明确该边界语义并与 Pine 对齐（返回 na 或上一值），至少在文档中说明平窗口填值策略。
- 状态：待确认

### [P4-03] `adx`/`dmi` 用 `nan_to_num(dx, 0)` 把热身期 NaN 污染为 0
- 文件/位置：[ta.py](../../src/pyne_runtime/ta.py)（`adx` / `dmi` 中 `dx = np.nan_to_num(dx, nan=0.0)`）
- 类别：正确性 / 边界
- 现象：在对 `dx` 做 `rma` 前先把 NaN 转 0，使热身期的 0 进入平滑，而非保持 na。
- 影响：ADX 热身期会被 0 拉低，与 Pine（热身期为 na）不一致，影响早期 bar 的 ADX 数值。
- 建议：热身期保留 na，仅对有效区间做 rma；或记录为有意近似并补 golden。
- 状态：待确认

### [P4-04] 模块内存在多套语义不一致的 EMA 实现
- 文件/位置：[ta.py](../../src/pyne_runtime/ta.py)（`ema`、模块函数 `_ema_skip_leading_na`、`tsi`/`macd` 对二者的混用）
- 类别：可维护性 / 正确性
- 现象：`ema` 用前 `period` 根 SMA 作种子；`_ema_skip_leading_na` 从「首个完整非-NaN 窗口」开始播种；`macd` 的 fast/slow 用 `ema`、signal 用 `_ema_skip_leading_na`，`tsi` 双重平滑又用后者。
- 影响：同为「EMA」但种子 / NaN 处理略有差异，难以推理一致性，也增加维护成本。
- 建议：收敛为单一 EMA 实现（可参数化种子策略），其他处复用；用 golden 锁定行为。
- 状态：待确认

### [P4-05] `highest`/`lowest` 缺少 `period<=0` / `period>n` 边界保护
- 文件/位置：[utils.py](../../src/pyne_runtime/utils.py)（`highest`/`lowest`，对比已有保护的 `_extreme_bars`）
- 类别：边界 / 健壮性
- 现象：`highest`/`lowest` 直接 `for i in range(period-1, n)`，period≤0 时起始为负、窗口切片异常，且对空窗口 `np.nanmax/nanmin` 会告警 / 报错；而 `_extreme_bars`/`sma`/`stdev` 都有 `period<=0` 防护。
- 影响：非法 period 时行为不一致（有的返回全 NaN，有的报错 / 告警）。
- 建议：为 `highest`/`lowest` 补上与其他函数一致的 period 校验。
- 状态：待确认

### [P4-06] 各函数间 NaN 策略不统一
- 文件/位置：[ta.py](../../src/pyne_runtime/ta.py)、[utils.py](../../src/pyne_runtime/utils.py)
- 类别：正确性 / 可维护性
- 现象：`highest`/`lowest` 用 `nanmax`/`nanmin`「忽略 NaN」；`sma` 把 NaN 当 0；`wma`/`alma`/`linreg` 「窗口含 NaN → na」；`cum` 用 `nancumsum`；各自一套。
- 影响：用户难以预期 NaN 传播行为，嵌套指标时更难推理；与 Pine 「遇 na 多数返回 na」的总体语义不一致。
- 建议：制定并文档化统一的 NaN 语义（推荐对齐 Pine），并逐函数核对。
- 状态：待确认

### [P4-07] `math.random` 默认不可复现，威胁运行时确定性
- 文件/位置：[math_ext.py](../../src/pyne_runtime/math_ext.py)（`random` 中 `np.random.default_rng(None ...)`）
- 类别：正确性 / 可复现性
- 现象：`seed` 为 None 时使用非确定随机源；而运行时其他处强调确定性 / golden 可复现。
- 影响：脚本一旦使用 `math.random()` 不传 seed，输出不可复现，会破坏 golden / 回测一致性，也是隐藏的不确定性源。
- 建议：默认从运行级种子（settings）派生，或明确文档化「math.random 是非确定的，不受 golden 保护」。
- 状态：待确认

### [P4-08] `str.format` 与 Pine / Python 格式说明符不兼容
- 文件/位置：[string_ext.py](../../src/pyne_runtime/string_ext.py)（`format` 先将所有 args `tostring` 再 `.format`）
- 类别：正确性 / 兼容性
- 现象：所有参数被预先转为字符串，`{0:.2f}` 之类数值格式会失败并落入「手动替换 `{idx}`」的脆弱兑底；也不支持 Pine 的 `{0,number,#.##}` 格式。
- 影响：使用格式说明符的脚本输出与预期不符。
- 建议：保留原始数值传给 `.format`（仅对 na 做特殊处理），或实现 Pine 格式语法的映射。
- 状态：待确认

### [P4-09] 时间毫秒/秒启发式与时区偏移解析受限
- 文件/位置：[time_ext.py](../../src/pyne_runtime/time_ext.py)（`_timestamp_seconds` `>1e11` 启发式、`_timezone` 仅支持 `±HH:MM`）
- 类别：边界 / 可维护性
- 现象：以 `abs(value)>1e11` 判定毫秒，极远未来的秒级时间戳会被误判；`_timezone` 仅识别 6 字符 `±HH:MM`，`+0800` 等格式静默回退 UTC。
- 影响：边界时间戳 / 非标准时区字符串会静默走错时区。
- 建议：明确输入时间戳单位约定（与 P2-01 数据层一致），扩展时区解析或对未知时区报错而非静默回退。
- 状态：待确认

### [P4-10] 普遍的逐 bar Python 循环，大序列性能存在热点
- 文件/位置：[ta.py](../../src/pyne_runtime/ta.py)（`ema`/`wma`/`rma`/`swma`/`alma`/`vwma`/`cci`/`linreg`/`correlation`/`sar`/`supertrend`/`variance`/`dev`/`percentile_*`/`obv`）、[utils.py](../../src/pyne_runtime/utils.py)（`highest`/`lowest`/`_extreme_bars`/`rising`/`falling`/`pivot*`）
- 类别：性能
- 现象：除 `sma`/`stdev`/`sum_`/`cum` 已向量化外，大量指标用逐 bar Python 循环，复杂度 O(n·period) 或 O(n) 的 Python 级迭代。
- 影响：在长序列 / 批量回测场景下累积明显，是潜在性能瓶颈。
- 建议：对热点函数改用滑动窗口 / 卷积 / `numpy.lib.stride_tricks` 向量化；优先处理 `highest`/`lowest`/`rising`/`falling`/`wma` 等高频调用者。重构后必须跟 golden 验证数值不变。
- 状态：待确认

### [P4-11] `math_ext` 默认 `mintick=0.01` 与实际注入 `1.0` 不一致（交叉 P3-02 / P2-08）
- 文件/位置：[math_ext.py](../../src/pyne_runtime/math_ext.py)（`PyneMath.__init__(mintick=0.01)`、`round_to_mintick`）
- 类别：可维护性
- 现象：`PyneMath` 默认 `mintick=0.01`，但 namespace 实际传入 `ctx.syminfo.mintick=1.0`；`round_to_mintick` 在 1.0 下会取整，可能意外。
- 影响：与 P3-02 / P2-08 同源，默认值多处不一致、真实生效 mintick 为 1.0，易误导。
- 建议：收敛 mintick 默认到单一常量来源（settings/metadata），避免多处碎片默认。
- 状态：待确认

### P4 小结
- 阻断级：无强制阻断；但 **[P4-01]（sma 对 NaN 错误）是明确的正确性缺陷**，会通过 `bb` 等依赖传播，建议优先跟 golden 评估。
- 优先级建议：[P4-01]（sma/NaN）> [P4-06]（NaN 策略统一）> [P4-02][P4-03]（振荡 / ADX 边界）> [P4-07]（random 可复现）> [P4-08]（str.format 兼容）> [P4-10]（性能热点）> [P4-04][P4-05][P4-09][P4-11]（EMA 收敛 / 边界保护 / 时间 / 默认值）。
- 本阶段未改动任何源码。

## 13. P5 问题清单（输入与状态）

> 范围：`input.py`（`InputModule` 参数 schema 收集与运行期取值）、`state.py`（`PyneVar` / `PyneStateNamespace`，`var`/`state`/`set_each` 语义）、`collections.py`（`PyneArray` / `PyneMap` / `PyneMatrix` 及对应 `array.*` / `map.*` / `matrix.*` 命名空间）。

### [P5-01] 同标题输入参数共享同一 key，导致 schema 去重 + 取值串扰
- 文件/位置：[input.py](../../src/pyne_runtime/input.py#L1-L120)（`_resolve` + `_seen_keys` 去重，以及各 `int/float/bool/string` 用 `title` 作为 key）
- 类别：正确性
- 现象：schema key 直接取自 `title`（仅当无 title 时退化为 `f"int_{len(self._schema)}"` 之类的位置 key）。若脚本里有两个 `input.*(..., title="Length")`，两者得到相同 key，`_seen_keys` 去重后第二个 schema 条目被丢弃，且两者从 `self._params[key]` 读到同一个用户值。
- 影响：UI/参数面板只会暴露一个 “Length”，两个语义不同的参数被静默合并；用户改一个会同时改动另一个，结果与脚本意图不符且难以察觉。
- 建议：key 生成应保证唯一性（如 `title` 冲突时追加序号或结合 `_id`/调用序号），并在检测到同标题冲突时给出告警；同时在文档中明确 title 与 key 的关系。
- 状态：待确认

### [P5-02] `PyneArray.__init__` 使用 `values or []`，传入 numpy 数组会抛“真值歧义”
- 文件/位置：[collections.py](../../src/pyne_runtime/collections.py#L11-L13)（`self._values = list(values or [])`）
- 类别：正确性（边界）
- 现象：`values or []` 会对 `values` 取布尔值。当 `values` 是长度>1 的 `np.ndarray` 时，`bool(ndarray)` 抛 `ValueError: truth value of an array ... is ambiguous`；长度为 1 时行为也不符合预期。`array.from_list(np.array([...]))` 因此直接报错。
- 影响：任何把 numpy 数组/Series 转入 `PyneArray`（如 `array.from_list`/`copy`）的路径在 ndarray 入参下崩溃，与“可接受任意可迭代”的接口语义矛盾。
- 建议：改为显式判空 `self._values = list(values) if values is not None else []`，避免对数组做真值判断。
- 状态：待确认

### [P5-03] 数组成员检测对 `na`/`NaN` 永不命中
- 文件/位置：[collections.py](../../src/pyne_runtime/collections.py#L67-L80)（`includes`/`indexof`/`lastindexof` 用 `in` 与 `==`）
- 类别：边界
- 现象：成员检测基于 Python `==`/`in`。`NaN != NaN`，故 `includes(na)` 始终 `False`、`indexof(na)` 始终 `-1`，即使数组中确实存在 `nan`。
- 影响：对含 `na` 的数组做存在性/定位判断时结果错误，与 Pine `array.includes`/`array.indexof` 的 na 语义可能不一致。
- 建议：在比较时对 `na`/`NaN` 做专门处理（用 `is_na_value` 双侧判定），或在文档中明确 na 不可被检索。
- 状态：待确认

### [P5-04] `array.sort` 对 `NaN`/混合类型行为未定义
- 文件/位置：[collections.py](../../src/pyne_runtime/collections.py#L93-L96)（`self._values.sort(reverse=...)`）
- 类别：边界
- 现象：直接调用 Python `list.sort`。含 `NaN` 时排序顺序不确定；元素为混合类型（如 str 与 float）时抛 `TypeError`。
- 影响：与 Pine `array.sort` 的 na 处理/稳定性约定不一致，可能产生难复现的顺序差异或运行期异常。
- 建议：实现 na 优先/末尾的稳定排序策略，并对非数值元素显式约定或报错。
- 状态：待确认

### [P5-05] `input.source` 依赖对象 identity 反查来源，回退“close”被静默吞掉
- 文件/位置：[input.py](../../src/pyne_runtime/input.py#L246-L300)（`source` 默认名解析 + `_identify_source` 用 `arr is ctx_arr` / `np.asarray(ctx_arr) is arr`）
- 类别：正确性 / 可维护性
- 现象：当默认值是数组/Series 时，`_identify_source` 通过对象 identity（`is`）逐一比对 `ctx.resolve_source(name)` 来反查来源名；`np.asarray(ctx_arr) is arr` 几乎不可能为真，派生源（hl2/hlc3 等）若每次返回新对象则匹配失败，最终静默回退 `"close"`。
- 影响：以派生序列作为 `input.source` 默认值时可能被错误识别为 `close`，且无任何告警，难以排查。
- 建议：在上下文层维护“数组对象 → 名称”的显式映射，或要求默认值以字符串名传入，避免脆弱的 identity 反查。
- 状态：待确认

### [P5-06] `PyneVar.reset` 绕过 `to_missing_scalar` 归一，na 处理与 `set`/`set_each` 不一致
- 文件/位置：[state.py](../../src/pyne_runtime/state.py#L84-L86)（`reset` 直接赋值），对比 [state.py](../../src/pyne_runtime/state.py#L44-L47)（`set` 走 `to_missing_scalar`）
- 类别：可维护性（一致性）
- 现象：`set`/`set_each` 都会把值经 `to_missing_scalar` 归一（na 哨兵 → `nan`），但 `reset` 直接 `self._value = self.default if value is None else value`，不做归一。
- 影响：`reset(na)` 后 cell 持有未归一的哨兵，与 `set` 路径产生的状态表示不同，下游对 na 的判断可能分叉。
- 建议：`reset` 同样经过 `to_missing_scalar`（或统一一个内部 setter），保证状态表示一致。
- 状态：待确认

### [P5-07] `PyneVar.set_each` 用 object 数组 + Python 逐条循环承接状态
- 文件/位置：[state.py](../../src/pyne_runtime/state.py#L50-L83)（`np.empty(len, dtype=object)` + for 循环 + `_normalize_series_values`）
- 类别：性能
- 现象：每次 `set_each` 都新建 object dtype 数组并逐元素 Python 循环判断 `is_na_value`，最后 `astype(float64)` 归一。
- 影响：长序列下属于 O(n) Python 级热点，与 P4-10 同类的逐条循环性能问题；批量 `var`/状态更新场景放大开销。
- 建议：在数值场景用向量化“前向填充”（如基于 `np.isnan` 掩码的 ffill）替代 object 循环。
- 状态：待确认

### [P5-08] `PyneVar` 把私有字段暴露为 dataclass 构造参数
- 文件/位置：[state.py](../../src/pyne_runtime/state.py#L13-L30)（`@dataclass` 字段 `_value` / `_initialized`）
- 类别：可维护性
- 现象：`_value` / `_initialized` 作为 dataclass 字段，会出现在自动生成的 `__init__` 形参里，外部可直接 `PyneVar(name, default, _value=..., _initialized=...)` 注入内部状态。
- 影响：封装泄漏，私有不变量可被绕过；API 表面含义模糊。
- 建议：改用 `field(init=False, repr=False)` 或常规属性管理内部状态，避免对外暴露。
- 状态：待确认

### [P5-09] `input.int/float` 对越界用户值静默 clamp、对非法值抛非 errors.py 异常
- 文件/位置：[input.py](../../src/pyne_runtime/input.py#L1-L180)（`int`/`float` 分支 `int(val)`/`float(val)` 与 `minval`/`maxval` 截断；`string` 分支对非法 option 静默回退 `defval`）
- 类别：可维护性（健壮性）
- 现象：用户传入越界数值时被静默 clamp 到 `minval`/`maxval`；传入无法转换的值时由内置 `int()`/`float()` 抛 `ValueError`，未走项目统一的 errors.py；`string` 选项非法时静默替换为默认值。
- 影响：越界/非法输入既不报错也不告警，问题被隐藏；异常类型不统一，错误信息不一致。
- 建议：统一通过 errors.py 抛带上下文的输入校验错误，或对 clamp/回退行为给出明确告警；并在文档约定边界策略。
- 状态：待确认

### [P5-10] 输入参数与 namespace 共享同一可变 `params` 字典（与 P3-06 同源）
- 文件/位置：[input.py](../../src/pyne_runtime/input.py#L1-L60)（`self._params = params or {}` 直接持有外部引用）
- 类别：可维护性
- 现象：`InputModule` 直接持有外部传入的 `params` 引用，未做拷贝；与 P3-06 中 namespace 共享同一可变 dict 的问题同源。
- 影响：脚本或外层在执行中改动该 dict 会影响输入取值，形成隐式耦合与潜在的跨执行状态泄漏。
- 建议：构造时浅拷贝一份只读快照，或用不可变映射封装。
- 状态：待确认

### P5 小结
- 阻断级：无强制阻断；但 **[P5-02]（PyneArray 接收 ndarray 直接崩溃）是明确的运行期缺陷**，**[P5-01]（同标题输入串扰）是隐蔽的正确性缺陷**，建议优先。
- 优先级建议：[P5-02]（ndarray 崩溃）> [P5-01]（输入串扰）> [P5-03][P5-04]（数组 na/排序边界）> [P5-05]（source 反查脆弱）> [P5-06]（reset 归一一致性）> [P5-09]（输入校验/异常统一）> [P5-07]（set_each 性能）> [P5-08][P5-10]（封装泄漏 / 共享可变字典，后者与 P3-06 同源）。
- 本阶段未改动任何源码。

## 14. P6 问题清单（绘图与结果）

> 范围：`plot/collector.py`（`OutputCollector` 输出收集与序列化）、`plot/functions.py`（plot/marker/line/label/box/table 等绘图函数工厂）、`plot/objects.py`、`plot/refs.py`（命名空间与引用对象）、`result.py`（`PyneResult` 结果模型与序列化）。

### [P6-01] drawing 上限只约束可变对象，序列/标记类输出完全不限量
- 文件/位置：[collector.py](../../src/pyne_runtime/plot/collector.py#L44-L57)（`_ensure_object_capacity` 仅统计 `_object_lines/_object_labels/_object_boxes/_object_tables`）
- 类别：安全性 / 性能
- 现象：`max_drawing_objects` 仅在 `line.new`/`label.new`/`box.new`/`table.new` 路径生效；而 `plot`/`marker`/`histogram`/`bgcolor`/`signals` 等会无限制追加到 `collector.lines`/`markers`/... 的列表中（每条还可能携带逐 bar 的 `data` 数组）。
- 影响：恶意或失控脚本可通过大量 `plot`/`plotshape` 或超长序列撑爆内存，绕过 drawing 上限；在 process/server 模式下构成资源耗尽风险。
- 建议：对所有输出通道（series 条数、每条 data 点数、marker 数等）设置统一上限并复用 settings/policy 的限额；超限时走 errors.py 报错。
- 状态：待确认

### [P6-02] `plot(color=<数组>)` 的逐 bar 颜色被丢弃，仅取首 bar 颜色
- 文件/位置：[functions.py](../../src/pyne_runtime/plot/functions.py#L213-L233)（`line_color_values[0]` 作为整条 `color`，逐点 `color` 仅在 `color_array` 提供时附加）
- 类别：正确性
- 现象：当 `color` 传入 `PyneSeries`/`ndarray` 时，line 级 `color` 只取 `[0]`，并设 `per_bar_color=True`，但 `points` 不会附加逐 bar 颜色（逐点着色只在单独的 `color_array` 参数下才生效）。
- 影响：Pine 常见写法 `plot(x, color=cond ? red : green)` 的逐 bar 颜色丢失，前端只拿到首 bar 颜色 + 一个无数据支撑的 `per_bar_color` 标志，渲染与脚本意图不符。
- 建议：当 `color` 为数组时，按 `color_array` 同样的逻辑把逐点颜色写入 `points`，统一两条着色路径。
- 状态：待确认

### [P6-03] 绘图对象坐标取自序列时坍缩为“最后一个非 na 值”，与 Pine 逐 bar 创建语义不一致
- 文件/位置：[functions.py](../../src/pyne_runtime/plot/functions.py#L73-L86)（`_scalar_from_value` 反向取最后非 na），用于 `line.new`/`label.new`/`box.new` 等坐标
- 类别：正确性 / 可维护性
- 现象：批处理模型下 `line.new(x1, y1, ...)` 若传入序列，坐标统一取序列最后一个非 na 标量；无逐 bar 循环，无法表达 Pine 中“每根 bar 各自创建/更新对象”的语义。
- 影响：依赖 `var line` + 循环逐 bar 画线/标签的 Pine 脚本无法正确迁移，对象数量与坐标都会塌缩；属模型层限制，易被误用。
- 建议：在文档明确批处理模型对 drawing 对象的限制；若要支持逐 bar 对象，需要在 incremental/逐 bar 执行路径提供专门 API。
- 状态：待确认

### [P6-04] drawing 上限超限抛裸 `RuntimeError`，未走 errors.py 统一错误面
- 文件/位置：[collector.py](../../src/pyne_runtime/plot/collector.py#L52-L56)（`raise RuntimeError(...)`）
- 类别：可维护性
- 现象：超过 `max_drawing_objects` 时抛裸 `RuntimeError`，无 error code、无 hint，与项目 errors.py 的结构化错误模型不一致。
- 影响：该错误在结果序列化/前端呈现时缺少 code/hint，定位与用户提示一致性差。
- 建议：改用 errors.py 定义的专用错误码（如 `DRAWING_LIMIT_EXCEEDED`）抛出，带上限额与建议。
- 状态：待确认

### [P6-05] 对失效/已删除引用的 setter 静默 no-op
- 文件/位置：[functions.py](../../src/pyne_runtime/plot/functions.py#L805-L860)（`line_set_*`/`label_set_*`/`box_set_*`：`entry is None` 时直接返回）
- 类别：边界 / 可维护性
- 现象：当 ObjectRef 类型不符或对象已被 `delete` 后，所有 `set_*` 静默返回不报错。
- 影响：脚本对已删除/错误对象的写操作被悄悄吞掉，掩盖逻辑错误，难以排查。
- 建议：在 strict 模式下对失效引用给出告警或可选报错；至少在文档明确该 no-op 行为。
- 状态：待确认

### [P6-06] `bgcolor` 不支持逐 bar 颜色，Pine 的 `cond ? color : na` 着色有损
- 文件/位置：[functions.py](../../src/pyne_runtime/plot/functions.py#L300-L340)（`bgcolor` 仅取单一 `color`，regions 只含 `{"time": t}`）
- 类别：正确性
- 现象：`bgcolor` 只接受一个常量 `color`，按布尔条件生成着色区段，无法表达 Pine 中按表达式给出不同背景色（`bgcolor(rsi>70 ? red : rsi<30 ? green : na)`）。
- 影响：多色背景的 Pine 脚本迁移时颜色信息丢失，只能呈现单色。
- 建议：支持 `color` 接受逐 bar 颜色数组/序列，并在 region 中写入对应颜色。
- 状态：待确认

### [P6-07] `plot(style="histogram")` 的 `color_up` 与 `color_down` 取同一颜色，与 `bar()` 语义不一致
- 文件/位置：[functions.py](../../src/pyne_runtime/plot/functions.py#L175-L205)（histogram 分支 `color_up`/`color_down` 在 `color` 为字符串时同值）
- 类别：正确性（一致性）
- 现象：通过 `plot(style="histogram")` 走的直方图分支，正负值用同一颜色；而独立的 `bar()` 函数按值正负切换 `color_up`/`color_down`。两条直方图路径着色语义不同。
- 影响：用户在 `plot` 直方图样式与 `bar()` 间切换时着色行为不一致，易困惑。
- 建议：统一直方图着色逻辑（要么都按符号着色，要么都用单色并在文档说明）。
- 状态：待确认

### [P6-08] `_color_for_index` 处理 list[dict] 时 `"time" not in item` 导致对齐脆弱
- 文件/位置：[functions.py](../../src/pyne_runtime/plot/functions.py#L52-L60)（`if item.get("time") == timestamp or "time" not in item`）
- 类别：边界
- 现象：逐点颜色取自 list[dict] 时，只要 dict 不含 `time` 字段就直接返回其 `color`，不校验索引/时间对齐；含 `time` 时又要求精确相等，否则返回 None。
- 影响：颜色与 bar 的对齐依赖输入结构是否带 `time`，混用时可能错位或丢色，行为不直观。
- 建议：统一逐点颜色的输入契约（要么纯数组按索引对齐，要么 dict 列表强制带 time 并按 time 匹配），避免两套隐式分支。
- 状态：待确认

### [P6-09] `PyneResult.to_frame` 按时间合并多条序列时同名列静默覆盖
- 文件/位置：[result.py](../../src/pyne_runtime/result.py#L70-L89)（`row[str(name)] = point.get("value")`，name 取 name||title||id）
- 类别：边界
- 现象：`to_frame` 以 timestamp 为行 key 合并所有 line；若两条 line 解析出的 `name` 相同（如都缺 title 回退到同一 id 规则或同标题），后者静默覆盖前者列。
- 影响：DataFrame 丢失其中一条序列且无告警；分析侧难以察觉。
- 建议：对重名列做去重（追加后缀）或告警；与 P5-01 输入同名问题一并约定命名唯一性策略。
- 状态：待确认

### [P6-10] 绘图层 legacy 别名与函数对象属性较多，维护面偏大
- 文件/位置：[functions.py](../../src/pyne_runtime/plot/functions.py#L1130-L1180)（`add_line` 等 legacy；`plot.style_line=...`、`hline.style_dashed=...` 等挂在函数对象上的属性）
- 类别：可维护性
- 现象：存在 `add_line`/`colorData`/`color_data` 等并行兼容入口，以及大量把样式常量挂到函数对象属性上的写法；命名空间与枚举常量分散定义。
- 影响：API 表面冗杂、重复分支多，后续修改着色/样式逻辑时需多处同步，易遗漏。
- 建议：收敛 legacy 入口（标注 deprecated 并集中），把样式枚举统一到 objects/常量模块，减少函数对象属性挂载。
- 状态：待确认

### P6 小结
- 阻断级：无强制阻断；但 **[P6-01]（输出通道无限额）涉及资源耗尽风险**、**[P6-02]（plot 逐 bar 颜色丢失）是明确的正确性缺陷**，建议优先。
- 优先级建议：[P6-01]（输出限额/DoS）> [P6-02]（plot 逐 bar 颜色）> [P6-06]（bgcolor 多色）> [P6-07]（直方图着色一致性）> [P6-03]（drawing 批处理模型限制）> [P6-08]（逐点颜色对齐）> [P6-04]（错误码统一）> [P6-09]（to_frame 重名列）> [P6-05][P6-10]（静默 no-op / 维护面）。
- 本阶段未改动任何源码。

## 15. P7 问题清单（request 子包）

> 范围：`request/module.py`（`RequestModule` 门面、security/security_lower_tf）、`request/alignment.py`（bar 合并与对齐）、`request/eval.py`（表达式/字段求值）、`request/lower_tf.py`（lower-tf 分组结果）、`request/provider.py`（provider 协议与 capability/metadata）、`request/errors.py`。

### [P7-01] 默认 `lookahead=off` 仍以 HTF bar 开盘时间对齐，可能泄漏“未收盘”高周期值（前视/重绘偏差）
- 文件/位置：[alignment.py](../../src/pyne_runtime/request/alignment.py#L108-L130)（`_aligned_value`：`lookahead!="on"` 时 `idx = bisect_right(requested_times, chart_time) - 1`）
- 类别：正确性 / 安全性（前视偏差）
- 现象：`requested_times` 取自 `requested_ctx.times`，即高周期 bar 的**开盘时间**。`lookahead=off` 选取“开盘时间 ≤ 当前 chart 时间”的最后一根 HTF bar。当 chart bar 落在某根尚未收盘的 HTF bar 内时，会取到该 HTF bar 的（未来才确定的）值。
- 影响：默认（无前视）模式下仍可能引入前视偏差/重绘，回测结果偏乐观，与 Pine `lookahead_off` 应使用“已收盘 HTF bar”的语义不符。
- 建议：no-lookahead 应基于 HTF bar 的**收盘时间**对齐（或对开盘时间结果整体后移一根 HTF bar），并补 golden 用例覆盖 HTF 边界。
- 状态：待确认

### [P7-02] provider capability 校验默认放行，dict 缺键或 None 时不拦截
- 文件/位置：[provider.py](../../src/pyne_runtime/request/provider.py#L28-L42)（`_provider_supports`：`capabilities is None` → True；dict 中无对应键 → 末尾 `return True`）
- 类别：安全性 / 契约
- 现象：当 provider 未声明 `capabilities`（None）时全部放行；当声明为 dict 但**未包含**所请求的 capability key 时，循环未命中后默认 `return True`。只有显式 `set/list/tuple` 才按成员判定。
- 影响：宿主以 dict 形式声明能力却遗漏某项时会被默认允许，capability 门控形同虚设，可能越过宿主预期的功能限制。
- 建议：dict 缺键时应按 False（默认拒绝）处理；None 是否放行需在协议文档中显式约定，并与安全策略保持一致。
- 状态：待确认

### [P7-03] `LowerTimeframeSeries` 聚合按 chart bar 逐组构建 Python 列表再 numpy 运算
- 文件/位置：[lower_tf.py](../../src/pyne_runtime/request/lower_tf.py#L96-L114)（`_aggregate`：对每个 group 用列表推导过滤 na 后 `np.asarray` + op）
- 类别：性能
- 现象：`sum/min/max/avg` 对每根 chart bar 的 group 都重新做 Python 级列表推导 + 建 numpy 数组 + 调用 op；`first/last/get/size` 亦为逐 group Python 循环。
- 影响：chart bar 数 × 每组元素数较大时为显著 Python 级热点，与 P4-10/P5-07 同类的逐条循环性能问题。
- 建议：分组阶段一次性构建带边界索引的扁平数组，用 `np.add.reduceat`/分段聚合做向量化。
- 状态：待确认

### [P7-04] `_requested_context_cache` 无上限
- 文件/位置：[module.py](../../src/pyne_runtime/request/module.py#L43-L47)（缓存 dict），写入处 [module.py](../../src/pyne_runtime/request/module.py#L238-L246)
- 类别：性能 / 可维护性
- 现象：按 `(symbol, timeframe, start, end)` 缓存请求结果，无容量上限或淘汰策略。虽实例随单次执行生命周期，但脚本若发起大量不同 symbol/tf/区间的请求，会持续累积。
- 影响：极端脚本下内存增长不可控；与 P1 缓存隔离同类，缺乏限额。
- 建议：设置 LRU 上限或复用全局缓存策略与限额。
- 状态：待确认

### [P7-05] 历史偏移解析对非法下标静默回退为 0（当前 bar）
- 文件/位置：[eval.py](../../src/pyne_runtime/request/eval.py#L166-L173)（`_split_history_name`：`int(...)` 失败 → `(field, 0)`）
- 类别：边界
- 现象：`close[abc]`、`close[1]x` 等非法历史下标在 `int()` 抛 `ValueError` 时被静默吞掉，按 offset=0（当前 bar）处理，不报错。
- 影响：表达式书写错误被悄悄忽略，返回非预期序列且无提示，难以察觉。
- 建议：非法历史下标应抛 `PyneRequestError`（带 code/hint），或在文档明确仅接受 `field[正整数]`。
- 状态：待确认

### [P7-06] 对齐结果统一强制 `float64`，布尔/类型语义丢失
- 文件/位置：[alignment.py](../../src/pyne_runtime/request/alignment.py#L96-L106)（`_align_single_request_values`：`np.asarray(values, dtype=np.float64)`）
- 类别：边界 / 正确性
- 现象：`request.security()` 的对齐结果一律转 `float64`。当表达式 thunk 返回布尔/分类序列时，`True/False` 被静默转成 `1.0/0.0`。
- 影响：以 `request.security(..., () => cond)` 获取布尔条件的脚本拿到的是浮点，类型与后续布尔运算/比较语义不一致。
- 建议：保留原始 dtype（或在文档明确仅支持数值字段），对非数值返回给出明确错误/约定。
- 状态：待确认

### [P7-07] provider 返回的 OHLCV 缺乏结构校验，缺 `time` 默认 0 影响排序
- 文件/位置：[module.py](../../src/pyne_runtime/request/module.py#L233-L237)（`sorted(requested, key=lambda item: int(item.get("time", 0)))`）、字段缺省见 [eval.py](../../src/pyne_runtime/request/eval.py#L222-L252)（`bar.get(field, np.nan)`）
- 类别：健壮性
- 现象：对 provider 返回的 bar 仅按 `time` 排序，缺 `time` 的 bar 默认 0 会被排到最前；不校验单调性/去重/必需字段，缺字段静默为 `nan`。
- 影响：异常 provider 数据会被部分静默接受，产生错位或全 nan 序列且无诊断信息。
- 建议：在 `_requested_context` 入口校验 bar 结构（必需键、时间单调/去重），异常时抛带上下文的 `PyneRequestError`。
- 状态：待确认

### [P7-08] `security_lower_tf` 末根 chart bar 的分组为开区间，纳入尾部所有 lower-tf bar
- 文件/位置：[lower_tf.py](../../src/pyne_runtime/request/lower_tf.py#L150-L166)（`end = len(requested_times) if next_time is None else bisect_left(...)`）
- 类别：边界
- 现象：最后一根 chart bar 没有 `next_time`，其 group 取 `[chart_time, 末尾]` 全部 lower-tf bar；若 provider 返回的数据超出该 chart bar 周期，会把后续/正在形成的 lower-tf bar 也并入。
- 影响：末根 bar 的 lower-tf 聚合可能包含超出其周期的样本，边界语义不严格（对最后一根 bar 类似前视纳入）。
- 建议：用 chart 周期推导末根 bar 的右边界（`chart_time + tf_ms`），与中间 bar 保持一致的半开区间。
- 状态：待确认

### P7 小结
- 阻断级：无强制阻断；但 **[P7-01]（默认无前视仍可能泄漏未收盘 HTF 值）是高优先的正确性/前视偏差缺陷**，**[P7-02]（capability 默认放行）是安全门控弱点**，建议优先。
- 优先级建议：[P7-01]（前视偏差）> [P7-02]（capability 门控）> [P7-07]（provider 数据校验）> [P7-05]（历史下标静默）> [P7-06]（float64 类型丢失）> [P7-08]（lower-tf 末根边界）> [P7-03]（聚合性能）> [P7-04]（缓存无上限）。
- 本阶段未改动任何源码。

## 16. P8 问题清单（strategy 子包）

本阶段审查 `strategy/` 子包：订单事件发射（[module.py](../../src/pyne_runtime/strategy/module.py)）、整体回放引擎（[replay.py](../../src/pyne_runtime/strategy/replay.py)）、订单触发与 OCA（[orders.py](../../src/pyne_runtime/strategy/orders.py)）、风险门控（[risk.py](../../src/pyne_runtime/strategy/risk.py)）、成本与保证金（[costs.py](../../src/pyne_runtime/strategy/costs.py)）、成交账本（[ledger.py](../../src/pyne_runtime/strategy/ledger.py)）、常量（[constants.py](../../src/pyne_runtime/strategy/constants.py)）。

### [P8-01] 每次策略 API 调用都对全量订单历史做整体重放，close/exit 更在逐 bar 循环内重放，复杂度爆炸
- 文件：[module.py](../../src/pyne_runtime/strategy/module.py)、[replay.py](../../src/pyne_runtime/strategy/replay.py)
- 位置：`entry_when`/`order_when` 末尾 `self._replay_position()`；`close_when`/`exit` 在 `for idx` 循环体内调用 `self._replay_position()`；[replay.py#L27-L60](../../src/pyne_runtime/strategy/replay.py#L27-L60) `replay_strategy_orders` 每次对 `self._collector.strategy_orders` 全量排序并跨所有 bar 重放。
- 类别：性能
- 现象：`_replay_position()` → `replay_strategy_orders(self)` 每次都从零开始，重排并重放**全部累积订单**、重建 `_closed_trades_by_bar`/`_open_trades_by_bar`（按 `bar_count` 分配列表）、逐 bar 推进。`entry_when`/`order_when` 在循环后调用一次；但 `close_when`/`exit` 把 `self._replay_position()` 放在**每个命中 bar 的循环内部**，命中 K 根就重放 K 次。脚本里每多调用一次策略方法（多个 entry/exit/close），就再触发一次全量重放。
- 影响：整体复杂度约 O(策略调用次数 × bar 数 × 订单数)，对含多笔 entry/exit 或长序列的脚本呈二次/三次方放大；close/exit 的逐 bar 重放进一步恶化。大数据集上回测耗时可能不可接受，也是潜在的算法复杂度型 DoS 面（与 P6-01 限额缺口叠加）。
- 建议：将订单收集与一次性回放解耦——所有 `*_when` 仅追加事件，回放只在结果物化阶段执行一次；至少把 `close_when`/`exit` 的 `_replay_position()` 移出逐 bar 循环。
- 状态：待确认

### [P8-02] 风险强平合成订单写回持久 `strategy_orders`，重复重放会累积重复合成单
- 文件：[replay.py](../../src/pyne_runtime/strategy/replay.py)
- 位置：[replay.py#L686-L726](../../src/pyne_runtime/strategy/replay.py#L686-L726) `_force_close_for_risk` 中 `strategy._collector.strategy_orders.append(order)`。
- 类别：正确性 / 性能
- 现象：风险强平（max_drawdown / max_intraday_loss）触发时，`_force_close_for_risk` 构造一个 `type="close_all"`、`_risk_liquidation=True` 的合成订单并**追加进持久的 `collector.strategy_orders`**。但 `replay_strategy_orders` 每次都对整个 `strategy_orders` 列表重放（见 P8-01）；下一次策略 API 调用再次触发重放时，上一轮注入的合成单仍在列表中，且若风险条件再次命中又会**再追加一个新的合成单**（`_seq` 递增、id 相同）。
- 影响：多次重放后合成强平单不断累积，污染 `strategy_orders`、`lifecycle` 事件与列表长度；同一时间戳出现多个合成 `close_all`，破坏回放的幂等性，长脚本下既是正确性问题也是内存/性能问题。
- 建议：合成强平单不应写入持久订单源；应放入回放本地的临时列表，或在每次回放开始时清除上一轮注入的 `_risk_liquidation` 合成单（按标记过滤）。
- 状态：待确认

### [P8-03] 市价单在信号 bar 当根以收盘价（或指定价）成交，而非 Pine 默认的下一根开盘
- 文件：[module.py](../../src/pyne_runtime/strategy/module.py)、[replay.py](../../src/pyne_runtime/strategy/replay.py)
- 位置：`entry_when`/`order_when` 中 `price` 默认 `None` → `_price_values(price, self._context.close, ...)` 取当根 `close`；`_base_price=close[idx]`、`_submit_time=times[idx]`；replay 非挂单分支 `fill_price = self._fill_price(_base_price, side)` 在同一 `timestamp`/`idx` 成交。
- 类别：正确性（模型差异）
- 现象：无 limit/stop 的市价 entry/order，默认以**信号当根的收盘价**在**当根**成交。Pine 默认（`process_orders_on_close=false`）市价单在**下一根开盘**成交。本实现没有“下一根开盘”延迟。
- 影响：与 Pine 回测语义存在系统性差异，等同于用当根收盘价成交，含一定的当根前视成分；同一脚本在 Pine 与本运行时上回测结果会有偏差。模块 docstring 已声明“不是撮合模拟器/确定性事件层”，故归为已知模型差异，但对依赖 Pine 对齐的用户需显式说明。
- 建议：在文档与 API 注释中明确市价成交价/时点约定；如需更贴近 Pine，可提供“下一根开盘成交”选项。
- 状态：待确认

### [P8-04] 持仓 size 以未取整 float 累积，`== 0` 精确判定可能漏掉 epsilon 残留持仓
- 文件：[replay.py](../../src/pyne_runtime/strategy/replay.py)
- 位置：`current_size` 在整个回放中以原始 float 累加；多处 `current_size == 0`、`(current_size > 0) != (position_after > 0)`、`remaining = abs(current_size) - fill_qty` 等判定基于精确相等。
- 类别：边界 / 正确性
- 现象：`current_size` 本体不取整（仅写入快照时 `round(...,8)`），经过多次部分成交/加减仓的浮点累加后，平仓可能残留极小非零值（如 1e-14）。此时 `current_size == 0` 为假，被视为仍持有一个近零微小仓位，影响后续 `same_direction_entry_count`、均价、风险与开仓判定。
- 影响：长序列或大量部分成交场景下可能出现“幽灵微仓”，导致持仓状态、入场计数、强平判定偏离预期。
- 建议：对 `current_size` 引入统一容差（如低于 `mintick` 或 1e-9 视为 0）并在平仓后归零；散落的 `1e-9`/`1e-12` 容差应抽为统一常量。
- 状态：待确认

### [P8-05] 方向 / OCA 类型等归一化对非法值静默回退，缺乏校验
- 文件：[replay.py](../../src/pyne_runtime/strategy/replay.py)、[orders.py](../../src/pyne_runtime/strategy/orders.py)
- 位置：[replay.py#L913-L919](../../src/pyne_runtime/strategy/replay.py#L913-L919) `_normalize_direction` 仅当值属于 `{short,-1,sell}` 才判为 short，其余一律 long；[orders.py#L363-L373](../../src/pyne_runtime/strategy/orders.py#L363-L373) `_normalize_oca_type` 对未知值直接返回小写原串透传。
- 类别：健壮性
- 现象：`direction="shrt"` 之类拼写错误被静默当作 `long`；未知 `oca_type` 透传后在 `_apply_oca_after_fill` 既不匹配 cancel 也不匹配 reduce，静默退化为无 OCA 行为。无任何告警或异常。
- 影响：用户传错方向/OCA 类型时不会得到反馈，回测结果与意图悄然不符，排查困难。
- 建议：对方向与 OCA 等枚举型入参做白名单校验，非法值抛出统一的策略参数错误（参照 errors.py），或至少发出告警。
- 状态：待确认

### [P8-06] mintick / 滑点 / 限价校验依赖 `syminfo.mintick`，与 P2-08、P3-02 同源默认值问题联动
- 文件：[module.py](../../src/pyne_runtime/strategy/module.py)
- 位置：`__init__` 中 `self._mintick = max(float(context.syminfo.mintick), 0.0)`；`_fill_price`（滑点 = `slippage_ticks * mintick`）、`_limit_fill_verification_amount`（= `backtest_fill_limits_assumption * mintick`）。
- 类别：可维护性（跨阶段关联）
- 现象：滑点成交价与限价成交校验量均按 `mintick` 缩放。若 `syminfo.mintick` 取了默认/不准确值（见 P2-08、P3-02 关于 mintick 默认来源的记录），滑点与限价验证的绝对额都会随之失真。
- 影响：成交价、限价触发的“多走一个 tick 才确认成交”等行为可能偏离真实品种最小变动价位，回测成本/成交率失真。
- 建议：与 P2-08/P3-02 一并处理 mintick 默认来源；策略层在 mintick 为 0 或缺省时给出提示。
- 状态：待确认

### [P8-07] 风险强平合成单 id 直接用 reason，可能与用户订单 id 冲突并进入 lifecycle
- 文件：[replay.py](../../src/pyne_runtime/strategy/replay.py)
- 位置：[replay.py#L702-L719](../../src/pyne_runtime/strategy/replay.py#L702-L719) `order = {... "id": reason ...}`（reason 形如 `risk.max_drawdown`/`risk.max_intraday_loss`），随后该订单进入 `strategy_orders` 与 `_strategy_lifecycle_events`。
- 类别：边界 / 可维护性
- 现象：合成强平单以风险原因字符串作为订单 id。若用户恰好使用相同 id，cancel/exit 的 id 匹配、`closedtrades`/`opentrades` 的 entry/exit id 关联、以及 lifecycle 报告都可能与之混淆。
- 影响：极端命名下出现 id 命名空间碰撞，导致订单关联或取消行为异常、报告含义不清。
- 建议：为合成单使用受保留前缀或独立命名空间（如 `__risk__:...`），并在文档中声明保留 id。
- 状态：待确认

### [P8-08] 事件发射层大量 `*` / `*_when` 包装 + 逐 bar Python 循环，性能与维护面偏大
- 文件：[module.py](../../src/pyne_runtime/strategy/module.py)
- 位置：`entry/entry_when`、`order/order_when`、`close/close_when`、`exit`、`cancel`、`cancel_all`、`close_all` 等均以 `for idx, flag in enumerate(...)` 逐 bar 构造 dict 追加事件。
- 类别：性能 / 可维护性
- 现象：每个策略方法都对全 bar 做 Python 级循环逐根构造订单 dict；`entry`/`order`/`close` 还各自维护一份 `_when` 包装，重复样板较多。配合 P8-01 的全量重放，整体在大数据集上偏慢。
- 影响：长序列下事件发射本身即 O(bar) Python 循环、再叠加重放放大；样板重复增加维护成本与漂移风险。
- 建议：用向量化方式批量生成命中 bar 的订单（`np.nonzero(flags)`）替代逐 bar 循环；收敛 `_when` 包装的重复逻辑。
- 状态：待确认

### P8 小结
- 阻断级：无强制阻断；但 **[P8-01]（全量重放 + close/exit 逐 bar 重放的复杂度爆炸）与 [P8-02]（风险强平合成单累积、破坏幂等）是高优先问题**，前者性能、后者正确性兼性能，建议优先处理。
- 优先级建议：[P8-02]（合成单累积/幂等）> [P8-01]（重放复杂度）> [P8-03]（市价成交时点差异）> [P8-04]（epsilon 残留持仓）> [P8-05]（非法枚举静默回退）> [P8-07]（合成单 id 冲突）> [P8-06]（mintick 默认联动）> [P8-08]（事件发射性能/样板）。
- 本阶段未改动任何源码。

## 17. P9 问题清单（incremental 子包）

本阶段审查 `incremental/` 子包：会话管理（[session.py](../../src/pyne_runtime/incremental/session.py)、[manager.py](../../src/pyne_runtime/incremental/manager.py)）、增量上下文（[context.py](../../src/pyne_runtime/incremental/context.py)）、绘图变更（[drawing.py](../../src/pyne_runtime/incremental/drawing.py)）、增量 TA（[ta.py](../../src/pyne_runtime/incremental/ta.py)）、增量策略（[strategy.py](../../src/pyne_runtime/incremental/strategy.py)）、安全限额（[limits.py](../../src/pyne_runtime/incremental/limits.py)）、脚本检测（[detection.py](../../src/pyne_runtime/incremental/detection.py)）、bar 模型（[bar.py](../../src/pyne_runtime/incremental/bar.py)）。

### [P9-01] 预览态每根 bar 对整个 context 做全量 `deepcopy`，且克隆后又清空 series/markers（先拷后弃）
- 文件：[context.py](../../src/pyne_runtime/incremental/context.py)、[session.py](../../src/pyne_runtime/incremental/session.py)
- 位置：[context.py#L62-L68](../../src/pyne_runtime/incremental/context.py#L62-L68) `clone_for_preview` 中 `clone = copy.deepcopy(self)` 后立即 `clone._series = {}`、`clone._markers = {}`；`session.on_bar_updated` 每次预览都调用 `self._ctx.clone_for_preview()`。
- 类别：性能
- 现象：实时预览（`on_bar_updated`）对每一个未确认 bar 都对**整个 IncrementalContext 深拷贝**——含全部 `_states`、`_windows`、`_series`、`_markers`、所有绘图对象、`_object_events`、以及整个 strategy 命名空间（含 `_orders`/`_closed_trades`/`_open_trades`）。随会话状态累积，单次预览成本约 O(累积状态规模)。更糟的是 `_series`/`_markers` 先被深拷贝、紧接着被丢弃重置，做了无用功。
- 影响：高频 tick 预览流下，每个 tick 都为不断增长的状态做一次全量深拷贝，预览延迟随会话存活时间线性恶化，是潜在的算法复杂度型 DoS 面。
- 建议：改为浅克隆 + 写时复制，或仅克隆预览真正会改写的子集；至少在深拷贝前先排除 `_series`/`_markers`（不拷贝再赋空）。
- 状态：待确认

### [P9-02] 长生命周期会话中 `_orders`/`_closed_trades`/`_object_events`/series data 无上限累积，安全模式限额未覆盖
- 文件：[strategy.py](../../src/pyne_runtime/incremental/strategy.py)、[drawing.py](../../src/pyne_runtime/incremental/drawing.py)、[context.py](../../src/pyne_runtime/incremental/context.py)、[limits.py](../../src/pyne_runtime/incremental/limits.py)
- 位置：`IncrementalStrategyNamespace._orders`/`_closed_trades` 持续 `append`；`IncrementalDrawingMixin._record_object_event` 每次 create/update/delete 都向 `_object_events` 追加；`IncrementalContext.plot` 向各 series 的 `data` 持续 `append`；`IncrementalLimits` 只约束 `max_window_size`/`max_total_window_items`/`max_state_keys`。
- 类别：安全性 / 性能
- 现象：增量会话是引用计数的长生命周期对象（见 manager），跨成千上万根 bar 持续存活。订单列表、已平仓列表、对象事件日志、每条 plot 序列的数据点都**只增不减**。安全模式限额仅覆盖窗口与状态键数量，对订单/成交/事件/序列的累积完全不设限。
- 影响：长时间运行的实时会话内存单调增长（每 tick 更新一个 label 即可让 `_object_events` 无限膨胀），既是内存泄漏型隐患也是资源耗尽型 DoS 面；与 P6-01、P8-01 的限额缺口一脉相承。
- 建议：为 `_object_events`、`_orders`、`_closed_trades`、series `data` 等引入安全模式上限或滚动窗口/截断策略，并纳入 IncrementalLimits 统一治理。
- 状态：待确认

### [P9-03] 读取 strategy 标量属性会触发风险强平副作用，纯读产生持仓/账本变更且结果依赖读取时机
- 文件：[strategy.py](../../src/pyne_runtime/incremental/strategy.py)
- 位置：`position_size`/`netprofit`/`openprofit`/`equity` 等 getter 调用 `self._sync_risk_liquidation()`；`_sync_risk_liquidation` → `_force_close_for_risk` 会向 `_orders` 追加合成 `close_all`、平掉 `_open_trades`、累加 `_commission`、置 `_drawdown_locked`/`_intraday_locked`。
- 类别：正确性 / 可维护性
- 现象：看似只读的属性访问（如用户脚本里 `ctx.strategy.equity`）会触发强平：构造合成订单、修改成交账本与佣金、设置风险锁。是否/何时强平因此取决于用户**是否以及在何处读取了某个属性**；若脚本从不读取这些属性，强平只在 `end_bar` 发生，时序不同。
- 影响：纯读带强副作用违反最小意外原则；强平时点对读取顺序敏感，导致同一逻辑因属性读取位置不同而产生不同回测结果，难以推理与复现。
- 建议：将风险强平从属性 getter 中剥离，集中在每根 bar 的确定性结算点（如 `end_bar`）触发；getter 仅返回当前快照值。
- 状态：待确认

### [P9-04] 增量引擎与批量回放引擎为两套独立实现，存在显著语义漂移风险
- 文件：[strategy.py](../../src/pyne_runtime/incremental/strategy.py)、[replay.py](../../src/pyne_runtime/strategy/replay.py)
- 位置：增量侧 `_submit_position_order`/`_fill_entry_order`/`_close_lots`/`_try_fill_pending_order`/`_force_close_for_risk` 等，与批量侧 [replay.py](../../src/pyne_runtime/strategy/replay.py) 的 `replay_strategy_orders` 各自独立实现成交、FIFO 平仓、同向计数、风险与 OCA。
- 类别：可维护性
- 现象：两种模式共享部分底层 helper（orders/costs/risk/ledger 的若干函数），但**核心撮合/持仓推进/账本/风险闭环各写一份**。例如同向入场计数、`_position_after_fill`、佣金分摊、强平逻辑在两边重复实现。
- 影响：同一脚本在批量与增量模式下需保持结果一致，但双实现极易在边界（部分成交、反手、OCA reduce、强平）上悄然分叉；任何一侧改动都需手工同步另一侧，维护成本与回归风险高。
- 建议：抽取共享的撮合/账本/风险核心为单一可复用引擎，批量与增量仅在“喂 bar 的方式”上分叉；并以 golden 用例交叉校验两模式一致性。
- 状态：待确认

### [P9-05] 增量 TA 为独立逐步实现，EMA 种子 / RSI·ATR 的 Wilder 平滑需与批量 ta 严格对齐
- 文件：[ta.py](../../src/pyne_runtime/incremental/ta.py)
- 位置：`_StepEMA`（前 `period` 个样本用 SMA 作种子）、`_StepRSI`/`_StepATR`（首段均值后用 `(prev*(n-1)+x)/n` Wilder 平滑）、`_StepBOLL`（总体方差 `sumsq/period - mid²`）、`_StepMonotonic`。
- 类别：正确性（一致性）
- 现象：增量 TA 是与批量 `ta` 平行的逐步实现，warm-up/种子约定、Wilder 平滑系数、BOLL 用总体方差（除以 period 而非 period-1）等都内嵌于本文件。这些约定若与批量 `ta` 不完全一致，同一脚本在两模式下会产生不同数值。
- 影响：增量与批量结果在指标 warm-up 段或长期平滑上可能出现系统性偏差，用户在两模式间迁移时结果不可比。
- 建议：用 golden 数据对增量 TA 与批量 `ta` 做逐点比对，固化一致性测试；将共用的 warm-up/平滑约定抽为共享实现或常量。
- 状态：待确认

### [P9-06] manager 去重缓存的 event_key 仅含 OHLCV 标量，忽略 session_*/其它 raw 字段，且 time 缺省回退 0 易碰撞
- 文件：[manager.py](../../src/pyne_runtime/incremental/manager.py)
- 位置：[manager.py#L70-L93](../../src/pyne_runtime/incremental/manager.py#L70-L93) `process_bar` 中 `event_key = ("preview"/"closed", int(bar.get("time") or 0), open, high, low, close, volume)`，命中即 `return copy.deepcopy(shared.last_event_result)`。
- 类别：健壮性 / 边界
- 现象：去重键只覆盖事件类型与 OHLCV 六个标量。若相邻事件 OHLCV 相同但 `session_ismarket`/`session_isfirstbar` 等 raw 字段不同（bar.py 会据此推导 session 信息并影响 `begin_bar` 的盘中重置逻辑），会命中缓存、返回旧结果，忽略新的 session 语义。`bar.get("time") or 0` 还会把 `time=0` 与缺省 time 都折叠为 0，增加碰撞面。
- 影响：在 OHLCV 恰好重复或携带变化的 session 元数据时，可能返回过期快照，导致盘中重置/会话边界处理被跳过。
- 建议：将 session 相关字段纳入 event_key，或对 time 缺省做显式校验而非静默归零；必要时关闭对带 session 元数据事件的去重。
- 状态：待确认

### [P9-07] 每根 bar 双重 `deepcopy`（缓存一份 + 返回一份），叠加 `Window.__getitem__` 每次全量 `list()` 取值
- 文件：[manager.py](../../src/pyne_runtime/incremental/manager.py)、[limits.py](../../src/pyne_runtime/incremental/limits.py)
- 位置：[manager.py#L92-L94](../../src/pyne_runtime/incremental/manager.py#L92-L94) `shared.last_event_result = copy.deepcopy(result)` 后另有 `return result`（seed/snapshot 路径还各自 `copy.deepcopy`）；[limits.py#L41-L43](../../src/pyne_runtime/incremental/limits.py#L41-L43) `Window.__getitem__` 为 `list(self._values)[index]`。
- 类别：性能
- 现象：`process_bar` 每次成功处理都对结果做一次 deepcopy 存入缓存；`seed_or_snapshot` 对返回值再 deepcopy。`Window.__getitem__` 每次按下标取值都把整个 deque 物化成 list，循环内访问退化为 O(n²)。
- 影响：结果对象较大时每 bar 多次深拷贝开销显著；窗口逐元素访问在脚本中常见，O(n²) 放大长窗口成本。
- 建议：缓存与返回复用同一份不可变快照（或仅缓存、返回时再拷贝其一）；`Window.__getitem__` 改用 deque 索引或预转列表缓存。
- 状态：待确认

### [P9-08] `is_incremental_pyne_script` 直接 `ast.parse` 未捕获 `SyntaxError`，非法脚本抛出裸异常
- 文件：[detection.py](../../src/pyne_runtime/incremental/detection.py)
- 位置：[detection.py#L7-L8](../../src/pyne_runtime/incremental/detection.py#L7-L8) `tree = ast.parse(script)`，无 try/except。
- 类别：健壮性
- 现象：脚本检测在安全/语法校验之前对源码做 `ast.parse`，语法非法时直接抛出原生 `SyntaxError`，未包装为统一的 PyneError 体系（与前序阶段记录的错误分类一致性问题同源）。
- 影响：调用方在“判断是否增量脚本”这一步就可能收到未归类的异常，错误信息与处理路径不统一，前端契约难以稳定。
- 建议：对 `ast.parse` 做 try/except，语法错误时返回 False 或抛出统一的 PyneError（带 code/line/column）。
- 状态：待确认

### [P9-09] 增量风险强平合成单 id 复用风险原因字符串，可能与用户订单 id 冲突（与 P8-07 同源）
- 文件：[strategy.py](../../src/pyne_runtime/incremental/strategy.py)
- 位置：`_force_close_for_risk` 中 `order = {... "id": reason ...}`（reason 为 `risk.max_drawdown`/`risk.max_intraday_loss`），随后进入 `_orders` 与 lifecycle。
- 类别：边界 / 可维护性
- 现象：与批量侧 [P8-07] 完全相同——合成强平单以风险原因作为订单 id，可能与用户自定义 id 在 cancel/exit 匹配、trade 关联、lifecycle 报告中混淆。
- 影响：极端命名下出现 id 命名空间碰撞，订单关联或报告含义不清；两套引擎重复同一缺陷，印证 P9-04 的双实现风险。
- 建议：与 P8-07 统一处理——为合成单使用受保留前缀/独立命名空间，并声明保留 id。
- 状态：待确认

### P9 小结
- 阻断级：无强制阻断；但 **[P9-02]（会话无上限累积，资源耗尽型 DoS）与 [P9-01]（预览全量深拷贝性能塌陷）是高优先问题**，**[P9-04]（双引擎语义漂移）是高优先可维护性风险**，建议优先。
- 优先级建议：[P9-02]（无上限累积）> [P9-01]（预览深拷贝）> [P9-03]（属性读取触发强平副作用）> [P9-04]（双引擎漂移）> [P9-05]（增量 TA 一致性）> [P9-06]（去重键不完整）> [P9-07]（双重深拷贝/窗口取值）> [P9-08]（detection 裸异常）> [P9-09]（合成单 id 冲突）。
- 本阶段未改动任何源码。

---

## 18. P10 问题清单（测试与契约）

> 范围：`tests/**`（含 `tests/golden/` 固化样例、CLI 契约、golden 校验、增量 parity）。
> 关注点：测试覆盖广度、契约稳定性、golden 一致性与与 Pine 的正确性等价。

### [P10-01] 增量会话管理与限额完全无测试覆盖
- 文件：[tests/test_incremental.py](../../tests/test_incremental.py)（仅覆盖 `PyneIncrementalSession`）
- 位置：全局检索 `SessionManager` / `IncrementalLimits` / `process_bar` / 引用计数（acquire/release/ref_count）在 `tests/` 下 **零命中**。
- 类别：可维护性 / 覆盖
- 现象：`PyneIncrementalSessionManager`（长生命周期、引用计数、`process_bar` 事件去重）与 `IncrementalLimits` 没有任何单元测试；增量测试只覆盖单会话 `on_bar_closed`/`on_bar_updated`。
- 影响：P9 中最高风险的两项——[P9-02]（会话资源无上限累积）与 [P9-06]（`process_bar` 去重键仅含 OHLCV、忽略 session/raw 字段）——完全没有测试守护，回归无法被发现；多会话/并发引用计数的释放正确性也无验证。
- 建议：补充会话管理器（acquire/release/复用/释放后清理）、限额触发、去重键边界（time=0、session 字段变化）等用例。
- 状态：待确认

### [P10-02] ta/request golden 为运行时自快照，不提供与 Pine 的正确性基准
- 文件：[tests/test_golden_ta.py](../../tests/test_golden_ta.py#L23-L33)、[tests/test_golden_request_security.py](../../tests/test_golden_request_security.py#L34-L49)
- 位置：`assert result.get_series(name) == expected`，`expected_series` 来自 `ta_*.json` / `request_security_*.json`。
- 类别：一致性 / 契约
- 现象：ta、request_security 的 golden `expected_series` 是运行时自身输出固化的快照（无外部 TradingView 参考、精确 `==` 比较）；不同于 strategy 侧带 `external_capture`（captured/parity/tol 1e-9）的真实参考。
- 影响：这些 golden 只能防止「自身回归」，无法证明与 Pine 的数值等价；一旦初始固化值本身偏离 Pine，测试会把错误结果当成正确基准长期固化（命名如 `ta_core_indicators` 也未提示其无外部基准）。
- 建议：对核心指标补充少量 TradingView 捕获参考（如 strategy 侧 external_capture 模式），或在文档/命名中明确「快照=回归守护，非正确性等价」。
- 状态：待确认

### [P10-03] process 执行器仅冒烟，缺 inline↔process 输出 parity
- 文件：[tests/test_executor.py](../../tests/test_executor.py#L14-L24)
- 位置：`test_process_executor_runs_script`（单条 plot）、`test_process_executor_kills_infinite_loop`；全部 golden 固定 `executor_mode="inline"`。
- 类别：覆盖 / 一致性
- 现象：进程执行器只验证「能跑一条 plot」与「死循环被杀」，没有任何用例断言 inline 与 process 两种模式对同一脚本产出一致结果；strategy/ta/request 全量 golden 都只走 inline 路径。
- 影响：进程执行器涉及脚本/数据序列化、子进程结果还原、超时与资源限制等独立代码路径，其正确性无契约校验；inline 通过不代表 process 通过，反之亦然。
- 建议：增加少量「同脚本 inline 与 process 结果逐字段相等」的 parity 用例，至少覆盖一个 indicator 与一个 strategy。
- 状态：待确认

### [P10-04] strategy_pine_equivalent 含未捕获参考的占位用例
- 文件：[tests/test_golden_strategy.py](../../tests/test_golden_strategy.py#L51-L60)、`strategy_pine_equivalent_pending_entries.json` 等
- 位置：`_assert_external_capture` 中 `status == "not_captured"` 分支 `return`（不做任何数值断言）；`pending_entries`、`risk_size_limit`、`oca_risk` 第二段均为 `not_captured`。
- 类别：一致性 / 契约
- 现象：名为 `pine_equivalent`（Pine 等价）的样例中，部分 case 的 `external_capture.status` 为 `not_captured`，测试对其只校验形状后直接返回，未与任何 TradingView 参考比对。
- 影响：「Pine 等价」命名下存在尚未真正对齐的占位用例，给人覆盖完整的错觉；这些路径（挂单、风险限仓等）恰是语义易偏差处，却缺少外部基准。
- 建议：补全这些 case 的 captured 参考并启用 parity 断言，或将未捕获用例从 `pine_equivalent` 命名空间中区分出来。
- 状态：待确认

### [P10-05] pytest/CI 配置缺少严格门禁（警告、标记、覆盖率）
- 文件：[pyproject.toml](../../pyproject.toml#L57-L60)（`[tool.pytest.ini_options]` 仅 `testpaths`/`pythonpath`）、`[project.optional-dependencies].dev`
- 类别：健壮性 / 契约
- 现象：pytest 配置无 `-W error`（弃用/运行时警告不升级为失败）、无 `--strict-markers`、无覆盖率阈值；dev 依赖未含 `pytest-cov`，无覆盖率度量与门禁。
- 影响：弃用警告、未注册标记、覆盖率回退都不会让 CI 失败；P9/P8 指出的高风险路径即便长期 0 覆盖也不会被门禁拦截。
- 建议：开启 `filterwarnings = ["error"]`（按需豁免）、`--strict-markers`，引入 `pytest-cov` 并对关键子包设最低覆盖率。
- 状态：待确认

### [P10-06] examples 仅冒烟，无数值 golden
- 文件：[tests/test_examples.py](../../tests/test_examples.py#L11-L18)
- 类别：覆盖
- 现象：打包示例测试只断言 `result.ok`、`meta.title` 非空、`lines or output` 非空，不校验任何指标数值。
- 影响：示例脚本（bollinger/macd/rsi/supertrend 等）的语义回归无保护，输出值整体漂移只要不报错就能通过。
- 建议：对 1～2 个代表性示例补充 series 数值 golden，或纳入 ta golden 体系。
- 状态：待确认

### [P10-07] 增量↔批量 parity 仅极小样本，未覆盖复杂路径与预览副作用
- 文件：[tests/test_incremental.py](../../tests/test_incremental.py#L50-L64)
- 位置：`_assert_strategy_matches_batch` / `_assert_full_strategy_matches_batch`，输入 `_bars()` 仅 3 根 bar。
- 类别：覆盖 / 一致性
- 现象：增量与批量一致性校验只用 3 根 bar、简单脚本；未覆盖多 bar、`on_preview` 与 `on_bar_closed` 交错、风险强平、OCA、金字塔加仓等复杂路径。
- 影响：P9-03（读取属性触发强平副作用，结果依赖读取时机）、P9-01（预览深拷贝）等增量特有缺陷无针对性用例；两引擎在复杂场景下的漂移（P9-04）难以被 parity 测试捕获。
- 建议：扩展 parity 矩阵，覆盖更长序列与含风险/OCA/加仓的策略，并显式测试预览态不污染确认态。
- 状态：待确认

### [P10-08] CLI run 的失败/超时/进程模式分支无契约测试
- 文件：[tests/test_cli.py](../../tests/test_cli.py#L9-L102)、[tests/test_cli_contracts.py](../../tests/test_cli_contracts.py#L1-L60)
- 位置：`test_cli_run_*` 仅覆盖成功路径（`exit_code == 0`）；契约测试只覆盖 schema/validate(syntax)/version。
- 类别：契约 / 覆盖
- 现象：`run` 子命令只测了 happy path 与参数注入，运行失败（非零退出码）、超时被杀、`--executor process` 等分支的退出码与 stdout JSON 形状无契约断言。
- 影响：CLI 是对外契约面，错误码/错误 JSON 结构一旦回退，集成方无法依赖；这些分支恰是消费方最依赖的稳定面。
- 建议：补充 run 失败（运行期异常）、超时、process 模式下的退出码与输出结构契约用例。
- 状态：待确认

### [P10-09] golden 浮点用精确相等，跨平台脆性且与 strategy 容差不一致
- 文件：[tests/test_golden_ta.py](../../tests/test_golden_ta.py#L31-L33)、[tests/test_golden_request_security.py](../../tests/test_golden_request_security.py#L48-L49)
- 类别：边界 / 健壮性
- 现象：ta/request golden 对浮点序列用精确 `==` 比较（无容差），而 strategy external_capture 用 `pytest.approx(abs=1e-9)`；两套标准不统一。
- 影响：不同 numpy/BLAS/平台下末位浮点差异可能造成脆性失败；同一仓库内浮点比较策略不一致，增加维护与排障成本。
- 影响范围与 [P9-05]（增量 TA 与批量 TA 平滑/总体方差对齐）相关——若实现微调，精确相等会立即破裂。
- 建议：统一为带绝对/相对容差的比较（如 1e-9），或明确说明哪些样例要求逐位一致及其理由。
- 状态：待确认

### P10 小结
- 阻断级：无强制阻断；但 **[P10-01]（增量会话管理/限额零覆盖）直接放大了 P9-02/P9-06 的高风险**，**[P10-02]（ta/request golden 无外部正确性基准）与 [P10-04]（pine_equivalent 含未捕获占位）削弱了 golden 的可信度**，建议优先。
- 优先级建议：[P10-01]（增量管理零覆盖）> [P10-02]（golden 无外部基准）> [P10-04]（未捕获占位用例）> [P10-03]（process parity 缺失）> [P10-07]（增量 parity 样本过小）> [P10-08]（CLI 失败分支）> [P10-05]（pytest 门禁宽松）> [P10-09]（浮点精确相等脆性）> [P10-06]（examples 仅冒烟）。
- 本阶段未改动任何源码。
