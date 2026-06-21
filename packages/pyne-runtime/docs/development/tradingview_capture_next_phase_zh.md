# TradingView Capture 下一阶段执行计划

本文是 strategy pine-equivalent 外部对照阶段的执行文档。目标不是让 Pyne
运行 Pine 源码，而是把 TradingView 导出的 plot 序列作为外部证据接入现有
golden runner，推动 Pyne strategy 回放语义从 Pyne-defined baseline 进入
TradingView-backed parity。

## 当前基线

- Strategy pine-equivalent case 总数：27。
- 当前 capture 状态：27 captured、0 not_captured、0 missing。
- Priority case 总数：10。
- Priority case 已完成：10/10 captured，且全部进入 parity gate。
- 第二批非 priority case 已开始：`cash_per_order_slippage_round_trip`、
  `exit_partial_then_close_all`、`same_bar_exit_stop_first`、
  `same_bar_exit_limit_first`、`intrabar_path_high_low_exit`、
  `intrabar_path_low_high_exit`、`oca_cancel_waits_for_intraday_risk_reset`、
  `oca_reduce_waits_for_intraday_risk_reset`、`limit_entry_then_close` 与
  `stop_entry_then_close`、`global_drawdown_lock_rejects_entries`、
  `max_position_size_caps_entry` 与 `limit_verification_waits_for_tick_assumption`
  以及 `short_bracket_stop_first_costs`、`short_bracket_limit_first_costs`、
  `short_max_position_size_caps_entry`、`short_oca_reduce_costs_use_reduced_quantity`
  已进入 parity gate。
- 所有 case 已具备 `external_capture` contract。
- `strategy_capture_scaffold.py --check` 已被测试保护。
- 已有工具：
  - `scripts/strategy_capture_status.py`
  - `scripts/strategy_capture_scaffold.py`
  - `scripts/strategy_capture_prepare.py`
  - `scripts/strategy_capture_next.py`
  - `scripts/strategy_capture_preflight.py`
  - `scripts/strategy_capture_import.py`
  - `scripts/strategy_capture_diff.py`

## 阶段目标

### G1: Priority Capture 完成

把 10 个 priority case 从 `not_captured` 推进到 `captured`。

当前状态：已完成。

完成标准：

- `python scripts/strategy_capture_status.py` 显示 `Priority captures: 10/10 captured`。
- `python scripts/strategy_capture_diff.py --assertion reference` 对刚导入的
  reference evidence 可报告差异；修到 parity 并升级 assertion 后，
  `python scripts/strategy_capture_diff.py --assertion parity` 返回 0。
- `python -m pytest tests/test_golden_strategy.py -q` 通过。
- 每个 captured case 的 `external_capture.notes` 记录导出来源、日期和必要对齐说明。

### G2: 差异分类闭环

真实 TradingView 导出与 Pyne 输出不一致时，不能直接覆盖 Pyne baseline。
每个差异必须归入一个类别，并记录处理结果。

差异类别：

- `alignment`: 数据窗口、bar 顺序、时间戳或导出列对齐问题。
- `pine_broker_emulator`: TradingView broker emulator 行为差异。
- `pyne_runtime_bug`: Pyne strategy 回放实现缺陷。
- `cost_model`: commission、slippage、closed trade allocation 或 equity 口径差异。
- `intrabar_policy`: same-bar stop/limit、intrabar path 或 limit verification 假设差异。
- `known_boundary`: Pyne 作为 Python 包明确不追求完全一致的边界。

完成标准：

- 差异保留在 fixture notes 或后续差异记录文档中。
- 可修复差异有对应测试或 fixture 更新。
- 不可修复或暂不修复差异有明确边界说明。

### G3: Captured Case 进入质量门

当至少一批 priority case 稳定 captured 后，把 diff 检查作为常规验证的一部分。

当前进度：

- `scripts/check.ps1`、`scripts/check.sh` 和 GitHub Actions CI 已显式运行
  `strategy_capture_scaffold.py --check` 与
  `strategy_capture_diff.py --assertion parity`。
- 当前 priority capture 已进入 parity gate；后续新导入的 reference evidence
  需要先显式用 `--assertion reference` 查看差异，修到 parity 后再升级质量门。

完成标准：

- `python scripts/strategy_capture_diff.py --assertion parity` 在 parity captured case
  上保持 0 difference。
- captured case 的失败会阻断本地完整验证或 CI。
- `docs/development/tradingview_strategy_capture_zh.md` 与本计划同步更新。

### G4: 全量 Strategy Capture

priority 10 个完成后，继续把剩余 17 个 case 推进到 captured。当前已完成。

完成标准：

- `python scripts/strategy_capture_status.py` 显示 `27/27 captured`。
- `python scripts/strategy_capture_diff.py --assertion parity` 显示 0 difference。
- 全量测试通过。

## Priority 批次

### Batch A: Market 与 Bracket 基线

目标是先打通最短链路，验证导出、导入、diff 和 golden runner 都工作正常。

开始前先生成 TradingView export pack：

```powershell
python scripts/strategy_capture_prepare.py --out-dir .tmp/tradingview-priority --clean
python scripts/strategy_capture_next.py --manifest .tmp/tradingview-priority/manifest.json
```

默认只生成 priority cases；如需生成全部 27 个 case，使用 `--all`。

| Fixture | Case | 状态 | 备注 |
| --- | --- | --- | --- |
| `strategy_pine_equivalent_smoke.json` | `market_round_trip_process_on_close` | `not_captured` | 第一优先级，验证 market fill 和 process-on-close scaffold |
| `strategy_pine_equivalent_bracket_exit.json` | `bracket_limit_exit` | `not_captured` | 验证 bracket limit exit |
| `strategy_pine_equivalent_bracket_exit.json` | `bracket_stop_exit` | `not_captured` | 验证 bracket stop exit |

完成后必须运行：

```powershell
python scripts/strategy_capture_status.py
python scripts/strategy_capture_diff.py --assertion reference tests/golden/strategy_pine_equivalent_smoke.json
python scripts/strategy_capture_diff.py --assertion reference tests/golden/strategy_pine_equivalent_bracket_exit.json
python -m pytest tests/test_golden_strategy.py -q
```

### Batch B: 成本分摊

目标是验证 strategy cost model 中最容易偏离 TradingView 的部分。

| Fixture | Case | 状态 | 备注 |
| --- | --- | --- | --- |
| `strategy_pine_equivalent_cost_allocation.json` | `percent_commission_round_trip` | `not_captured` | 验证 percent commission 与 equity/netprofit |
| `strategy_pine_equivalent_cost_allocation.json` | `cash_per_contract_partial_close_allocation` | `not_captured` | 验证 partial close 成本分摊 |

完成后必须运行：

```powershell
python scripts/strategy_capture_diff.py --assertion reference tests/golden/strategy_pine_equivalent_cost_allocation.json
python -m pytest tests/test_golden_strategy.py -q
```

### Batch C: Reversal 与 Pyramiding

目标是验证反转交易、transaction quantity、lot 拆分和 pyramiding admission。

| Fixture | Case | 状态 | 备注 |
| --- | --- | --- | --- |
| `strategy_pine_equivalent_reversal_pyramiding.json` | `reversal_long_to_short_then_flat` | `not_captured` | 验证 opposite entry reversal |
| `strategy_pine_equivalent_reversal_pyramiding.json` | `pyramiding_two_entries_then_flat` | `not_captured` | 验证 pyramiding=1 两笔入场 |

完成后必须运行：

```powershell
python scripts/strategy_capture_diff.py --assertion reference tests/golden/strategy_pine_equivalent_reversal_pyramiding.json
python -m pytest tests/test_golden_strategy.py -q
```

### Batch D: Margin、Order 与 Cancel

目标是验证 margin admission、`strategy.order` 净仓位语义和 pending order 清理。

| Fixture | Case | 状态 | 备注 |
| --- | --- | --- | --- |
| `strategy_pine_equivalent_margin_order_cancel.json` | `margin_long_rejects_then_small_fill` | `not_captured` | 验证 margin rejection 与后续小单成交 |
| `strategy_pine_equivalent_margin_order_cancel.json` | `order_net_position_reduces_and_reverses` | `not_captured` | 验证 `strategy.order` 减仓/反转 |
| `strategy_pine_equivalent_margin_order_cancel.json` | `cancel_and_cancel_all_clear_pending` | `not_captured` | 验证 cancel 后 pending 不复活 |

完成后必须运行：

```powershell
python scripts/strategy_capture_diff.py --assertion reference tests/golden/strategy_pine_equivalent_margin_order_cancel.json
python -m pytest tests/test_golden_strategy.py -q
```

## 单个 Case 执行流程

0. 生成或刷新导出准备包：

```powershell
python scripts/strategy_capture_prepare.py --out-dir .tmp/tradingview-priority --clean
```

准备包包含：

- 每个 case 对应的 `.pine` 文件。
- 每个 case 对应的 `_bars.csv` 文件，用于核对 TradingView 数据窗口。
- `manifest.json`，记录 fixture、case、plot 标题、bar 数、bars 文件、导入命令和 diff 命令。
- `README.md`，用于人工执行导出时快速核对。

1. 使用 next 脚本确认下一条待采集 case：

```powershell
python scripts/strategy_capture_next.py --manifest .tmp/tradingview-priority/manifest.json
```

2. 打开 next 输出中的 `.pine` 文件，将内容复制到 TradingView Pine Editor。
3. 使用准备包里的 `_bars.csv` 核对数据窗口；如果使用外部导入数据源，必须与
   `_bars.csv` 的 `time/open/high/low/close/volume` 完全一致。
4. 导出 plot 数据，保留 fixture `values` 中声明的所有 plot 标题。
5. 导入前先运行 preflight，确认导出文件存在、plot 列完整、行数和可选 time 列对齐：

```powershell
python scripts/strategy_capture_preflight.py .tmp/tradingview-priority/manifest.json --case <case_name>
```

6. 用 import 脚本写回 fixture：

```powershell
python scripts/strategy_capture_import.py `
  tests/golden/<fixture>.json `
  --case <case_name> `
  --values <tradingview_export.csv> `
  --tolerance 1e-9 `
  --note "TradingView export YYYY-MM-DD, symbol/timeframe/source"
```

7. 运行单 case 或单 fixture diff：

```powershell
python scripts/strategy_capture_diff.py --assertion reference tests/golden/<fixture>.json --case <case_name>
```

8. 如果 diff 为 0，运行 strategy golden：

```powershell
python -m pytest tests/test_golden_strategy.py -q
```

9. 如果 diff 不为 0，进入差异分类流程，不要直接覆盖 Pyne baseline。

## 差异处理流程

### 1. 先排除导出与对齐问题

检查项：

- TradingView 导出的 bar 数是否等于 fixture `bars` 长度。
- CSV/JSON plot 标题是否和 fixture `values` 完全一致。
- 时间戳列是否只是对齐列，未被错误当作 plot。
- 导出序列是否从同一根 bar 开始。
- 是否存在 TradingView 的空值导出，需要转为 `null`。

如果是对齐问题：

- 重新导出或修正导入文件。
- 不修改 Pyne baseline。
- 不把 case 标记为 captured，直到 diff 可解释。

### 2. 再判断语义差异

检查项：

- 差异是否只出现在 position/equity/netprofit 之一。
- 差异是否从某个成交 bar 后持续传播。
- 差异是否与 commission、slippage、margin 或 risk lock 同时出现。
- 差异是否只在 same-bar stop/limit 或 intrabar path 场景出现。

如果是 Pyne runtime bug：

- 新增或调整最小 golden fixture。
- 修 runtime。
- 保留 TradingView capture。
- diff 必须回到 0。

如果是 known boundary：

- 在 `external_capture.notes` 中说明。
- 必要时在本文件或专门差异文档中记录。
- 不把该差异伪装成 parity。

## 全量验证顺序

每完成一个 batch，运行：

```powershell
python scripts/strategy_capture_status.py
python scripts/strategy_capture_diff.py --assertion parity
python -m pytest tests/test_golden_strategy.py -q
python -m pytest -q
```

提交前运行：

```powershell
python -m compileall src tests scripts -q
python -m ruff check src tests scripts
git diff --check
python -m pytest -q
```

## 记录规范

每个 captured case 的 `external_capture.notes` 至少包含：

- TradingView 导出日期。
- symbol/timeframe 或导入数据源说明。
- 是否使用 `process_orders_on_close`。
- 是否存在手工对齐或空值处理。
- 若有 diff，差异类别与处理结论。

示例：

```json
{
  "external_capture": {
    "provider": "tradingview",
    "status": "captured",
    "tolerance": 1e-9,
    "values": {},
    "notes": [
      "TradingView export 2026-05-21, synthetic bars aligned to fixture order.",
      "process_orders_on_close=true; no manual value edits after export."
    ]
  }
}
```

## 阶段退出标准

下一阶段可以视为完成，当且仅当：

- Priority captures 达到 10/10。
- `strategy_capture_diff.py --assertion parity` 对 parity captured case 保持
  0 difference；reference evidence 的非零差异用 `--assertion reference` 或
  `--assertion all` 显式查看并分类。
- `tests/test_golden_strategy.py` 与全量测试通过。
- `docs/development/pine_like_semantics_progress_zh.md` 更新 capture 进度。
- 若差异暴露 Pyne runtime bug，相关修复和测试已提交。

## 后续扩展

Priority 完成后，按以下顺序推进剩余 case：

1. `strategy_pine_equivalent_pending_entries.json`
2. `strategy_pine_equivalent_costs.json`（`cash_per_order_slippage_round_trip`
   已 captured/parity）
3. `strategy_pine_equivalent_exit_path.json`
4. `strategy_pine_equivalent_oca_risk.json`
5. `strategy_pine_equivalent_risk_size_limit.json`（`global_drawdown_lock_rejects_entries`
   与 `max_position_size_caps_entry`、`limit_verification_waits_for_tick_assumption`
   已 captured/parity）
6. `strategy_pine_equivalent_short_paths.json`（`short_bracket_stop_first_costs`
   与 `short_bracket_limit_first_costs`、`short_max_position_size_caps_entry`
   和 `short_oca_reduce_costs_use_reduced_quantity` 已 captured/parity）

全量 27/27 captured 后，再回到非 strategy 方向：

- TA golden 的真实 TradingView 输出对照。
- `request.security()` edge-case 的真实 Pine 输出对照。
- array/map/matrix 历史快照边界。
- `docs/reference/pine_like_api_matrix.md` 的状态矩阵更新。
