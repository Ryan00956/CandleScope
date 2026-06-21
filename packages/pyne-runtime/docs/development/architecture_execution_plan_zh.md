# Pyne Runtime 架构规范执行计划

本文档把当前架构审查结论转成可逐步落地的执行手册。目标不是推倒重写，而是在保持公共 API、测试金标和宿主集成稳定的前提下，把职责边界从“靠大文件经验维护”推进到“靠模块结构和契约维护”。

核心判断：Pyne Runtime 的主执行链路清晰，测试和文档基础很好；迁移前主要风险集中在 strategy、incremental、plot、request 这些复杂领域单文件模块，以及 `runtime.py` 作为 namespace 总装配中心的持续膨胀。

## 0. 总目标

重构完成后，项目应满足这些目标：

- `runtime.py` 只负责执行编排，不承载每个命名空间的构造细节。
- `strategy` 是一个领域子包，公开 API、订单模型、回放引擎、风险控制、成本模型、交易账本彼此分离。
- `incremental` 是一个领域子包，会话、上下文、TA 增量器、绘图对象、策略状态和限制策略彼此分离。
- `request` 的 host provider、表达式求值、bar merge 对齐和 lower timeframe grouping 可独立测试。
- `plot` 的输出收集、绘图函数工厂、drawing object 序列化边界清楚。
- 批处理和增量运行时共享尽可能多的策略、绘图和对象模型，减少重复语义。
- 所有迁移均保持 `pyne_runtime.__all__`、`pn.run()`、CLI、文档示例和 golden tests 兼容。

## 1. 非目标

本计划不做这些事：

- 不改变 Pyne 的产品定位。
- 不实现 Pine parser/compiler。
- 不重写全部 runtime。
- 不在架构迁移中顺手改业务语义。
- 不把 public API 改成 breaking change。
- 不把 CandleScope 或其他宿主代码引入 core package。
- 不为了“更干净”删除已有兼容性 helper，除非有明确替代路径和迁移说明。

架构迁移的第一原则是：先搬家，再装修。每个阶段都应尽量做到行为不变，只改变文件边界、内部对象和测试结构。

## 2. 当前架构基线

当前主链路：

```text
api.py
  -> executor.py
    -> runtime.py
      -> context.py / series.py / input.py / ta.py / request/ / strategy/ / plot/
      -> exec(script, namespace)
      -> result.py
```

当前职责较清晰的模块：

- `api.py`: 友好入口，负责读脚本和数据归一化。
- `executor.py`: inline/process 执行策略和超时进程边界。
- `data.py`: OHLCV 输入容器和 CSV/pandas/list 归一化。
- `context.py`: 单次执行的数据上下文和派生序列。
- `series.py`: Pine-like series 和 bars-back 索引。
- `settings.py`: runtime/executor/security 配置。
- `security.py`: 安全策略、builtins、导入限制、输出限制。
- `result.py`: 结构化结果模型。

迁移前职责偏重的模块：

- incremental 单文件模块：会话、上下文、增量 TA、增量 strategy、drawing objects、限制策略和 session manager 混在一起。
- strategy 单文件模块：public namespace、订单事件、仓位回放、风险控制、成本模型、OCA、交易账本和报告混在一起。
- plot 单文件模块：collector、plot/bar/marker/fill、drawing object API 和序列化混在一起。
- request 单文件模块：provider 协议、请求上下文、表达式 thunk、对齐和 lower timeframe grouping 混在一起。
- `runtime.py`: namespace 装配集中了解太多具体模块。

`ta.py` 当前体量也较大，但它更接近函数库式技术指标集合，状态耦合和跨领域边界风险低于 strategy/incremental/request/plot。本轮不把 `ta.py` 纳入主迁移路径；后续如果指标族继续膨胀，可单独评估 `ta/` 子包化。

## 3. 目标模块布局

目标布局可以分阶段演进，不要求一次完成：

```text
src/pyne_runtime/
  api.py
  executor.py
  runtime.py
  namespace.py                 # 新增：script namespace 组装注册表
  context.py
  data.py
  series.py
  values.py
  settings.py
  security.py
  result.py

  strategy/
    __init__.py
    constants.py               # direction, commission, oca, risk mode constants
    module.py                  # StrategyModule public namespace
    orders.py                  # order dict/model helpers and lifecycle status
    replay.py                  # deterministic replay engine
    risk.py                    # risk gates and lock state
    costs.py                   # commission, slippage, margin helpers
    ledger.py                  # open/closed trade ledger helpers
    report.py                  # public strategy output serialization

  incremental/
    __init__.py
    result.py                  # IncrementalPyneResult
    bar.py                     # IncrementalBar and barstate wiring
    limits.py                  # IncrementalLimits and _LimitTracker
    ta.py                      # step-by-step TA helpers
    strategy.py                # incremental strategy namespace, later sharing strategy core
    context.py                 # IncrementalContext
    drawing.py                 # line/label/box/table object mutation
    session.py                 # PyneIncrementalSession
    manager.py                 # Shared session and manager
    detection.py               # is_incremental_pyne_script

  request/
    __init__.py
    provider.py                # DataProvider and provider capability helpers
    module.py                  # RequestModule public namespace
    eval.py                    # RequestEvalContext and expression result coercion
    alignment.py               # gaps/lookahead merge helpers
    lower_tf.py                # LowerTimeframeSeries and grouping helpers
    errors.py                  # request errors

  plot/
    __init__.py
    collector.py               # OutputCollector
    refs.py                    # PlotRef, ObjectRef
    functions.py               # create_plot_functions
    objects.py                 # drawing object serialization helpers
```

Python import compatibility matters. Public imports such as `from pyne_runtime import StrategyModule` must keep working. Existing module imports such as `from pyne_runtime.strategy import StrategyModule` should also keep working by exporting from the new package `__init__.py`.

## 4. 执行原则

### 4.1 每一步都必须可回滚、可测试

一次 PR 或一次工作块只做一个领域：strategy、incremental、request、plot 或 runtime namespace。不要同时改多个复杂域。

### 4.2 先内部搬迁，后抽象优化

第一轮只做 mechanical move：复制/移动代码、更新 import、保持函数名和行为。第二轮再引入 dataclass、service、registry 或共享 engine。

### 4.3 Public API 不破坏

这些入口在迁移阶段必须保持稳定：

- `import pyne_runtime as pn`
- `pn.run()`
- `pn.PyneRuntime`
- `pn.PyneSettings`
- `pn.PyneResult`
- `pn.PyneSeries`
- `pn.StrategyModule`
- `pn.RequestModule`
- `pn.PyneIncrementalSession`
- `pn.PyneIncrementalSessionManager`
- `pyne run`
- `python -m pyne_runtime`

### 4.4 测试先行保护边界

每个阶段开始前，先确认测试基线：

```powershell
$env:PYTHONPATH='H:\program\CandleScope\packages\pyne-runtime\src'
python -m pytest -q
python -m ruff check .
```

如果已执行 `python -m pip install -e .[dev]`，可以不设置 `PYTHONPATH`。在未安装包时，子进程测试需要 `PYTHONPATH=src`。

## 5. Phase 1 - 建立架构护栏

### 目标

先让未来重构有明确护栏，避免迁移时误伤公共 API、引入循环依赖或破坏包独立性。

### 工作项

1. 新增 `tests/test_architecture.py`。
2. 增加 public API smoke 测试，覆盖 `pyne_runtime.__all__` 中关键导出。
3. 增加包独立性测试：`src/pyne_runtime` 不得 import 宿主 app 模块。
4. 增加轻量循环导入检测。可以先用 AST 静态扫描，不必引入新依赖。
5. 增加 module size warning 测试或脚本，不作为硬失败也可以先输出报告。
6. 在 `docs/development/quality_gates.md` 补充架构检查说明。

### 建议测试样例

```python
def test_public_exports_are_importable():
    import pyne_runtime as pn

    for name in pn.__all__:
        assert hasattr(pn, name), name
```

```python
def test_core_package_does_not_import_host_app_modules():
    # 扫描 src/pyne_runtime/*.py，禁止 from app. / import app. / app.
```

### 验收标准

- `python -m pytest tests/test_architecture.py -q` 通过。
- `python -m pytest -q` 通过。
- 没有行为变化。
- 文档说明如何运行架构护栏。

## 6. Phase 2 - 拆分 strategy 子包

### 目标

把旧 strategy 单文件模块拆成领域子包，但保持 `StrategyModule` 行为和公开输出完全一致。

### 推荐顺序

#### Step 2.1 创建子包壳

Python 同一目录下不能同时稳定依赖旧 strategy 单文件和 `strategy/` 包的同名导入行为。因此本阶段不采用“保留旧 strategy 单文件，同时新增 `strategy/`”的路线。

推荐做法：

1. 创建 `src/pyne_runtime/strategy/`。
2. 把旧 strategy 单文件内容一次性迁入 `src/pyne_runtime/strategy/module.py`，先保持行为不变。
3. 创建 `src/pyne_runtime/strategy/__init__.py`，从 `module.py` re-export `StrategyModule`，并继续导出原来可从 `pyne_runtime.strategy` 访问的 public symbols。
4. 删除旧同名文件入口。
5. 运行 public import smoke，确认 `from pyne_runtime.strategy import StrategyModule` 和 `from pyne_runtime import StrategyModule` 都可用。

如果某次迁移必须先用临时包名降低风险，临时包名应使用 `strategy_core/`，且必须在同一工作块或紧邻工作块完成最终替换，不能长期留下两套入口。

#### Step 2.2 提取 constants

搬迁这些无状态常量类：

- `StrategyCommission`
- `StrategyOca`
- `StrategyDirection`
- `StrategyRiskMode`
- `StrategySameBarPriority`
- `StrategyIntrabarPath`

目标文件：`strategy/constants.py`。

验收：所有 strategy 测试通过，`pn.StrategyModule.commission.percent` 等访问路径不变。

#### Step 2.3 提取 trade ledger

搬迁：

- `StrategyTradesNamespace`
- `_trade_float`
- `_record_fill`
- `_open_trade_from_order`
- `_closed_trade`
- `_target_entry_id`
- `_target_open_qty`
- `_trade_realized_profit`
- `_trade_open_profit`
- `_open_profit`

目标文件：`strategy/ledger.py`。

验收：`closedtrades`、`opentrades`、lot matching、partial close golden tests 全部通过。

#### Step 2.4 提取 costs 和 risk

搬迁成本相关：

- `_commission_amount`
- `_margin_required`
- `_is_exposure_reduction`
- `_strategy_equity`

目标文件：`strategy/costs.py`。

搬迁风险相关：

- `StrategyRiskNamespace`
- `_entry_allowed`
- `_entry_rejection_reason`
- `_entry_qty_for_max_position_size`
- `_max_drawdown_hit`
- `_intraday_filled_orders_hit`
- `_normalize_allowed_entry_direction`
- `_normalize_risk_mode`

目标文件：`strategy/risk.py`。

验收：risk lock、intraday reset、margin、cost model golden tests 全部通过。

#### Step 2.5 提取 orders 和 lifecycle

搬迁：

- `_is_pending_submission`
- `_pending_trigger`
- `_exit_trigger`
- `_same_bar_trigger`
- `_normalize_same_bar_fill_priority`
- `_normalize_intrabar_path`
- `_normalize_oca_type`
- `_apply_oca_after_fill`
- `_reject_order`
- `_strategy_lifecycle_events`
- `_strategy_lifecycle_event`
- `_strategy_lifecycle_status`
- `_strategy_lifecycle_phase`

目标文件：`strategy/orders.py`。

验收：pending entries、bracket exit、same bar priority、OCA lifecycle tests 全部通过。

#### Step 2.6 提取 replay engine

把 `StrategyModule._replay_position()` 中的回放逻辑迁入 `strategy/replay.py`。第一步可以保持函数式接口：

```python
def replay_strategy_orders(context, orders, config) -> StrategyReplayResult:
    ...
```

`StrategyModule` 保留 public API，只负责把用户调用转成 order event，然后调用 replay engine 同步状态。

后续再把 config/result 提升为 dataclass。

### Phase 2 验收标准

- `python -m pytest tests/test_golden_strategy.py -q` 通过。
- `python -m pytest tests/test_strategy_runtime.py tests/test_incremental.py -q` 通过。
- `python -m pytest -q` 通过。
- `from pyne_runtime.strategy import StrategyModule` 可用。
- `from pyne_runtime import StrategyModule` 可用。
- strategy public output 与迁移前完全一致。

## 7. Phase 3 - 拆分 incremental 子包

### 目标

把旧 incremental 单文件模块拆成 session、context、ta、strategy、drawing、limits、manager 等模块，降低单文件认知负担。

### 推荐顺序

#### Step 3.1 提取基础模型

目标文件：

- `incremental/result.py`: `IncrementalPyneResult`
- `incremental/bar.py`: `IncrementalBar`
- `incremental/limits.py`: `IncrementalLimits`, `_LimitTracker`
- `incremental/detection.py`: `is_incremental_pyne_script`, `_call_name`

验收：incremental detection、seed history、barstate tests 通过。

#### Step 3.2 提取增量 TA

目标文件：`incremental/ta.py`。

搬迁：

- `_StepSMA`
- `_StepEMA`
- `_StepBOLL`
- `_StepMACD`
- `_StepRSI`
- `_StepATR`
- `_StepMonotonic`
- `IncrementalTaNamespace`
- `_rsi_from_avgs`

验收：`test_incremental_runtime_seeds_history` 以及所有增量 TA 相关测试通过。

#### Step 3.3 提取 drawing objects

目标文件：`incremental/drawing.py`。

搬迁：

- line/label/box/table object CRUD 方法。
- `_drawing_scalar`
- `_upsert_table_cell`
- `_filter_object_events`
- object snapshot/event helpers。

可以先保留为 mixin：

```python
class IncrementalDrawingMixin:
    ...
```

`IncrementalContext` 继承 mixin，减少一次性改动。

验收：incremental drawing object preview/commit tests 通过。

#### Step 3.4 提取 incremental strategy

目标文件：`incremental/strategy.py`。

搬迁：

- `IncrementalStrategyDirection`
- `IncrementalStrategyCommission`
- `IncrementalStrategyRiskMode`
- `IncrementalStrategyRiskNamespace`
- `IncrementalStrategyTradesNamespace`
- `IncrementalStrategyNamespace`
- 增量 strategy helper 函数。

短期保持独立实现，长期在 Phase 6 与 batch strategy replay core 合并。

验收：`tests/test_incremental.py` 中所有 strategy parity tests 通过。

#### Step 3.5 提取 context、session、manager

目标文件：

- `incremental/context.py`: `IncrementalContext`
- `incremental/session.py`: `PyneIncrementalSession`
- `incremental/manager.py`: `SharedPyneIncrementalSession`, `PyneIncrementalSessionManager`

验收：`pn.PyneIncrementalSession`、`pn.PyneIncrementalSessionManager`、`pn.is_incremental_pyne_script` public exports 不变。

### Phase 3 验收标准

- `python -m pytest tests/test_incremental.py -q` 通过。
- `python -m pytest tests/test_barstate.py tests/test_state_runtime.py -q` 通过。
- `python -m pytest -q` 通过。
- `from pyne_runtime.incremental import PyneIncrementalSession` 可用。
- `from pyne_runtime import PyneIncrementalSession` 可用。

## 8. Phase 4 - 拆分 request 子包

### 目标

让 host-backed request 的几类职责独立：provider 协议、表达式求值、bar merge 对齐、lower timeframe grouping、错误模型。

### 推荐顺序

#### Step 4.1 提取 errors/provider

目标文件：

- `request/errors.py`: `PyneRequestError`, `PyneInvalidSymbolError`
- `request/provider.py`: `DataProvider`, `_provider_supports`, `_request_metadata`, `_default_request_metadata`, `_symbol_metadata_with_defaults`

验收：missing provider、capability、invalid symbol tests 通过。

#### Step 4.2 提取 eval

目标文件：`request/eval.py`。

搬迁：

- `RequestEvalContext`
- `_resolve_requested_field`
- `_values_from_field_expression`
- `_values_from_expression_result`
- `_field_values`
- `_field_value`
- `_apply_history_offset`
- `_split_history_name`

验收：callable expression thunk、tuple return、history-in-request-context tests 通过。

#### Step 4.3 提取 alignment 和 lower_tf

目标文件：

- `request/alignment.py`: `_align_request_values`, `_align_single_request_values`, `_aligned_value`, `_normalize_request_option`
- `request/lower_tf.py`: `LowerTimeframeSeries`, `_group_lower_timeframe_values`, `_group_single_lower_timeframe_values`, `_lower_tf_numeric_series`

验收：gaps/lookahead/lower_tf golden 和 unit tests 通过。

#### Step 4.4 保留 RequestModule 门面

目标文件：`request/module.py`。

`RequestModule` 应只负责：

- 参数规范化。
- provider 调用。
- requested context cache。
- 调用 eval/alignment/lower_tf helper。
- 把错误转成稳定 `PyneRequestError`。

### Phase 4 验收标准

- `python -m pytest tests/test_request_security.py tests/test_golden_request_security.py -q` 通过。
- `from pyne_runtime.request import RequestModule, DataProvider, LowerTimeframeSeries, RequestEvalContext, PyneRequestError, PyneInvalidSymbolError, barmerge` 可用。
- `from pyne_runtime import RequestModule, DataProvider, LowerTimeframeSeries, RequestEvalContext, PyneInvalidSymbolError, barmerge` 可用。
- request public error code 不变。

## 9. Phase 5 - 拆分 plot 子包

### 目标

降低旧 plot 单文件模块规模，同时为 batch/incremental 共享 drawing object 模型打基础。

### 推荐顺序

1. 提取 `PlotRef`、`ObjectRef` 到 `plot/refs.py`。
2. 提取 `OutputCollector` 到 `plot/collector.py`。
3. 提取 `create_plot_functions()` 到 `plot/functions.py`。
4. 提取 drawing object 相关 helper 到 `plot/objects.py`。
5. `plot/__init__.py` re-export 旧 public symbols。

### 验收标准

- `python -m pytest tests/test_plot_runtime.py tests/test_result.py -q` 通过。
- `python -m pytest tests/test_incremental.py -q` 通过，确认 `ObjectRef` 兼容。
- `from pyne_runtime.plot import OutputCollector, ObjectRef` 可用。
- output schema 不变。

## 10. Phase 6 - 引入 runtime namespace registry

### 目标

把 `runtime.py` 的 `_build_namespace()` 从手写大字典推进到可维护的注册流程。

### 建议设计

新增 `namespace.py`：

```python
class RuntimeServices:
    def __init__(self, *, ctx, settings, params, policy):
        self.ctx = ctx
        self.settings = settings
        self.params = params
        self.policy = policy
        self.collector = OutputCollector(...)
        self.input = InputModule(...)
        self.ta = TaModule(ctx)
        self.strategy = StrategyModule(ctx, self.collector)
        self.state = PyneStateNamespace()

def build_script_namespace(services: RuntimeServices) -> dict[str, Any]:
    ns = {}
    install_data_namespace(ns, services)
    install_api_namespace(ns, services)
    install_plot_namespace(ns, services)
    install_compat_namespace(ns, services)
    install_builtins(ns, services)
    return ns
```

第一版不要做复杂依赖注入框架，只需要明确：

- data namespace 是一组函数。
- API namespace 是一组函数。
- plot namespace 是一组函数。
- builtins/security 是最后一步。

### 迁移步骤

1. 新增 `namespace.py`，复制现有 `_build_namespace()` 的主体逻辑。
2. `PyneRuntime.execute()` 创建 `RuntimeServices`。
3. `PyneRuntime._build_namespace()` 暂时代理到 `namespace.build_script_namespace()`。
4. 测试通过后，删除 runtime 中重复构造逻辑。
5. 后续新增 API 只能通过 namespace installer，而不是直接扩写 runtime。

### 验收标准

- `runtime.py` 仍是执行编排入口，但不直接包含全部 namespace 细节。
- `python -m pytest tests/test_smoke.py tests/test_api.py tests/test_cli.py tests/test_cli_contracts.py -q` 通过。
- `python -m pytest -q` 通过。

## 11. Phase 7 - 批处理与增量共享策略核心

### 目标

减少 batch strategy 和 incremental strategy 的重复语义，让二者共用订单、成本、风险、ledger 和生命周期模型。

### 推荐顺序

1. 先比较 batch `strategy/replay.py` 与 `incremental/strategy.py` 的重复 helper。
2. 把纯函数 helper 提升到 `strategy/orders.py`、`strategy/costs.py`、`strategy/risk.py`、`strategy/ledger.py`。
3. 增量 strategy 只保留 scalar 当前 bar 状态和 session lifecycle。
4. 为 shared helper 增加 unit tests，不只依赖集成 golden。
5. 扩展 batch vs incremental parity tests。

### 高风险点

- batch 是 vector replay，incremental 是 committed-bar state mutation。
- preview context 必须保持不污染持久状态。
- pending order 在 batch 和 incremental 中的生命周期不同，但 public report 需要一致。

### 验收标准

- 现有 incremental strategy parity tests 全部通过。
- strategy golden 全部通过。
- 新增至少一组 shared helper unit tests。
- 文档说明 batch/incremental 共享边界。

## 12. Phase 8 - 文档和开发流程收尾

### 工作项

1. 更新 `docs/concepts/script_runtime.md`，说明 runtime namespace registry。
2. 更新 `docs/concepts/incremental_runtime.md`，说明 incremental 子包职责。
3. 更新 `docs/api/strategy.md` 和 `docs/api/request.md`，确认 public API 不变。
4. 更新 `docs/development/quality_gates.md`，加入架构测试和推荐阶段测试命令。
5. 在 README Development 区域链接本计划。
6. 更新 changelog，记录内部架构重组但无 public breaking change。

### 验收标准

- README 链接有效。
- docs 中没有指向已删除模块路径的描述。
- `python -m pytest -q` 通过。
- `python -m ruff check .` 通过。

## 13. 每阶段推荐命令

最小检查：

```powershell
$env:PYTHONPATH='H:\program\CandleScope\packages\pyne-runtime\src'
python -m pytest -q
```

策略相关阶段：

```powershell
$env:PYTHONPATH='H:\program\CandleScope\packages\pyne-runtime\src'
python -m pytest tests/test_golden_strategy.py tests/test_strategy_runtime.py tests/test_incremental.py -q
python scripts/strategy_capture_scaffold.py --check
python scripts/strategy_capture_diff.py
```

request 相关阶段：

```powershell
$env:PYTHONPATH='H:\program\CandleScope\packages\pyne-runtime\src'
python -m pytest tests/test_request_security.py tests/test_golden_request_security.py -q
```

incremental 相关阶段：

```powershell
$env:PYTHONPATH='H:\program\CandleScope\packages\pyne-runtime\src'
python -m pytest tests/test_incremental.py tests/test_barstate.py tests/test_state_runtime.py -q
```

完整门禁：

```powershell
$env:PYTHONPATH='H:\program\CandleScope\packages\pyne-runtime\src'
python -m compileall src tests -q
python -m ruff check .
python -m pytest -q
python scripts/strategy_capture_scaffold.py --check
python scripts/strategy_capture_diff.py
git diff --check
```

如果环境已通过 editable install 准备好，可以使用：

```powershell
python -m pip install -e .[dev]
python -m pytest -q
```

## 14. 风险控制清单

每次提交前确认：

- 是否保持 public imports 不变？
- 是否保持 `PyneResult.to_dict()` 输出结构不变？
- 是否保持 golden fixtures 不变，除非本次明确改变语义？
- 是否避免同时迁移两个复杂领域？
- 是否没有修改用户未相关的工作区改动？
- 是否更新了相关文档？
- 是否记录了迁移前后的测试命令和结果？

如果某次迁移必须改变 public behavior，必须单独写：

- 变更原因。
- 迁移方式。
- 兼容窗口。
- 测试证据。
- changelog 条目。

## 15. 建议实施节奏

推荐按小步推进：

1. 第 1 个工作块：Phase 1 架构护栏。
2. 第 2-4 个工作块：Phase 2 strategy 拆分。
3. 第 5-7 个工作块：Phase 3 incremental 拆分。
4. 第 8 个工作块：Phase 4 request 拆分。
5. 第 9 个工作块：Phase 5 plot 拆分。
6. 第 10 个工作块：Phase 6 namespace registry。
7. 第 11+ 工作块：Phase 7 batch/incremental 共享核心。

不要把 Phase 7 提前。共享核心必须建立在 strategy 和 incremental 已经拆清楚的基础上，否则会把两个大文件之间的重复逻辑变成一个更难理解的大抽象。

## 16. 完成定义

本计划完成时，应能做到：

- 新贡献者可以通过目录结构理解每个领域的入口。
- 修改 strategy 成本模型时，不需要阅读完整 strategy public namespace。
- 修改 request gaps/lookahead 时，不需要阅读 provider metadata 或 expression thunk 全部逻辑。
- 修改 incremental drawing object 时，不需要碰 session manager。
- 新增脚本 namespace 时，不需要直接扩写 `runtime.py` 的大字典。
- 全量测试、golden tests、strategy capture gates 和文档入口保持绿色。
