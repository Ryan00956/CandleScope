# Pyne Pine-Like Semantics Execution Plan

本文档是 Pyne 从“可运行的 Pine 风格 Python 指标包”升级为“逻辑上尽可能接近 Pine 的语义运行时”的执行手册。

目标不是兼容 TradingView Pine Script 源码，也不是实现 Pine parser/compiler。目标是让用户用 Python 语法写脚本时，核心计算模型、序列语义、bar 语义、`na` 规则、技术指标行为、绘图对象和多周期数据逻辑都尽量接近 Pine。

## 0. Direction

当前 Pyne 的第一阶段已经成立：

- 独立包：`pyne-runtime` / `pyne_runtime`
- 运行入口：`pn.run()`、`PyneRuntime.execute()`、`pyne run`
- 脚本 API：`indicator()`、`plot()`、`ta.*`、`input.*`、`color.*`
- 数据模型：OHLCV list / CSV / pandas -> runtime context
- 输出模型：lines、histograms、markers、fills、signals
- 安全模型：safe / research / unsafe
- 验证模型：ruff、pytest、build、twine check

下一阶段不再以“最小可运行”为目标，而以 Pine-like 语义完整性为目标。最重要的转变是：

```text
numpy array first
    ->
Pine-like series first, numpy as an implementation detail
```

现状中 `open/high/low/close/volume` 是裸 `np.ndarray`，因此 `close[1]` 在 Python 里表示数组第 2 个元素，而不是 Pine 的上一根 bar。这个问题不能靠文档解释绕过去，必须从运行时语义层解决。

## 1. Non-Goals

这些事情暂时不作为本计划目标：

- 不直接运行 TradingView Pine Script 源码。
- 不实现 `//@version=5`、`:=`、Pine 三元表达式、Pine parser 或 compiler。
- 不复制 TradingView 私有实现。
- 不承诺每个内置函数逐点等于 TradingView，除非已有金标测试覆盖。
- 不让 CandleScope 承担 Pyne 内部语义。CandleScope 是 host/workbench，Pyne 负责 runtime semantics。

## 2. Design Principles

### 2.1 Series Is The Core Type

所有价格、指标、条件、颜色和中间表达式都应逐步统一为 series-like 值。

```python
fast = ta.ema(close, 12)
slow = ta.ema(close, 26)
hist = fast - slow
plot(hist[1])
```

以上代码应成为 Pyne 的基本表达方式。

### 2.2 Pine-Like Indexing Means Bars Back

在 Pyne 脚本里：

```python
close[0]
close[1]
close[2]
```

应表示：

- `close[0]`: 当前序列
- `close[1]`: 前一根 bar 的序列
- `close[2]`: 前两根 bar 的序列

不是 Python list/NumPy 的位置索引。

### 2.3 Vectorization Is Optimization, Not Semantics

NumPy 可以继续用于性能，但不能定义用户语义。语义应由 `PyneSeries`、bar context、`na` rules、runtime state 定义。

### 2.4 Batch And Realtime Must Converge

当前 batch runtime 和 incremental runtime 是两套心智模型。长期目标是统一：

- batch: 一次性输入历史数据，内部仍遵守 bar-by-bar 语义
- realtime: 新 bar 更新，只计算必要增量
- 两者对 `close[1]`、`barstate.*`、`var`、`ta.*` 的结果一致

### 2.5 Host Provides Data, Pyne Defines Semantics

多周期、多 symbol、外部数据请求应由 host 提供数据源，由 Pyne 定义对齐、gap、lookahead、确认状态等语义。

## 3. Target Architecture

目标模块布局：

```text
src/pyne_runtime/
  series.py              # PyneSeries, PyneBoolSeries, PyneColorSeries
  values.py              # scalar/series coercion, na rules, type helpers
  barstate.py            # bar_index, barstate flags
  state.py               # var/state model
  request/               # host-backed request.security and data access
  objects.py             # line/label/box/table object models
  semantics/
    reference.py         # slow reference bar-by-bar evaluator helpers
    alignment.py         # timeframe/symbol merge and lookahead rules
    na.py                # na propagation testable rules
  ta.py                  # series-aware TA namespace
  utils.py               # series-aware utility helpers
  runtime.py             # namespace assembly and execution flow
```

The initial implementation can keep the current files, but new semantics should not be hidden inside ad hoc helpers.

## 4. Phase 1 - PyneSeries Foundation

### Goal

Replace user-facing OHLCV arrays with `PyneSeries` while preserving compatibility with existing `ta.*`, `plot()`, and tests.

### Work Items

1. Add `src/pyne_runtime/series.py`.
2. Implement `PyneSeries`.
3. Add `np.asarray(series)` compatibility via `__array__`.
4. Implement bars-back indexing.
5. Implement arithmetic operators.
6. Implement comparison operators.
7. Implement boolean operators using `&`, `|`, and `~`.
8. Add `to_numpy()` and `values` escape hatches for internals.
9. Wrap `open/high/low/close/volume/hl2/hlc3/ohlc4/hlcc4` in `PyneContext`.
10. Update `plot()` and `bar()` to accept `PyneSeries`.
11. Update `input.source()` to accept and identify `PyneSeries`.
12. Keep current NumPy-based `ta.*` working through coercion.

### Required User-Facing Behavior

```python
indicator("Series Indexing", overlay=True)

plot(close, "Close")
plot(close[1], "Previous Close")
plot((high + low) / 2, "Mid")
marker(close > close[1], text="Up")
```

Expected semantics:

- `close[1]` returns a series shifted one bar into the past.
- Bars without enough history become `na`.
- `close > close[1]` returns a boolean series.
- `plot()` serializes values with missing early bars skipped or represented consistently with current output policy.

### Implementation Notes

`PyneSeries.__getitem__` should only treat non-negative integers as bars-back indexing in script-facing series.

```python
close[1] -> shift by 1
close[0] -> self
close[-1] -> unsupported unless a future forward-reference policy is explicit
```

Do not expose Python positional indexing through `[]` on script series. If internals need positional access, use `.values[index]` or `.iloc(index)` style helpers.

### Tests

Add `tests/test_series.py`.

Minimum test cases:

- `close[1]` equals old `shift(close, 1)` behavior.
- `close[2]` produces two leading `na` values.
- `close + 1`, `close + open`, `(high + low) / 2` return series.
- `close > open` returns boolean series.
- `(close > open) & (close > close[1])` works.
- `np.asarray(close)` returns the underlying numeric array.
- `ta.ema(close, 3)` still works.
- `plot(close[1])` works through `pn.run()`.

### Exit Criteria

- Existing tests pass.
- New `series` tests pass.
- No user-facing OHLCV global is a raw `np.ndarray`.
- README or docs mention `close[1]` as the preferred history-reference syntax.

## 5. Phase 2 - Pine-Like `na` Semantics

### Goal

Make missing values a first-class semantic concept instead of an incidental `np.nan`.

### Work Items

1. Add `values.py` or `semantics/na.py`.
2. Define one canonical `na` sentinel/policy for numeric, bool, color, and object values.
3. Make `na(x)` callable if possible without breaking current `na` constant usage.
4. Keep `nz()` but make it series-aware.
5. Define comparison behavior involving `na`.
6. Define logical behavior involving `na`.
7. Define plot serialization behavior for `na`.
8. Define marker/signal behavior for `na` conditions.

### Target API

```python
plot(nz(close[1], close))
marker(na(close[1]), text="First")
plot(when(close > open, close, na))
```

Because Python cannot make `na(close)` work while `na` is also a plain float, this phase must choose one of these options:

- `na` remains a sentinel and `is_na(x)` is the function.
- `na` becomes a callable namespace/sentinel object.
- `na_check(x)` remains the explicit function.

The preferred direction is a callable sentinel object if it can remain ergonomic and safe.

### Tests

- `close[1]` first bar is `na`.
- `nz(close[1], 0)` replaces only missing values.
- `marker(close > close[1])` does not emit on the first bar.
- `plot(na)` or `plot(series_with_na)` has stable serialized output.
- `ta.rsi()` warmup values use the same `na` policy as history references.

### Exit Criteria

- A single documented `na` policy exists.
- `ta.*`, `utils.*`, `plot.*`, `input.source()` all use shared coercion helpers.
- No new feature manually invents missing-value behavior.

## 6. Phase 3 - Bar State And Runtime Clock

### Goal

Expose Pine-like runtime clock values.

### Work Items

1. Add `bar_index`.
2. Add `last_bar_index`.
3. Add `barstate` namespace.
4. Add `time_close` if host data can provide or infer it.
5. Define confirmed/unconfirmed behavior for batch and incremental modes.
6. Align incremental preview updates with `barstate.isconfirmed`.

### Target API

```python
plot(bar_index, "Bar Index")
marker(barstate.isfirst, text="First")
marker(barstate.islast, text="Last")
marker(barstate.isconfirmed, text="Confirmed")
```

### Proposed `barstate` Fields

- `barstate.isfirst`
- `barstate.islast`
- `barstate.ishistory`
- `barstate.isrealtime`
- `barstate.isnew`
- `barstate.isconfirmed`

### Tests

- Batch mode marks only first bar as `isfirst`.
- Batch mode marks only last bar as `islast`.
- Batch historical bars are confirmed.
- Incremental `on_bar_updated()` can produce unconfirmed preview output.
- Incremental `on_bar_closed()` produces confirmed output.

### Exit Criteria

- `bar_index` and `barstate.*` are available in both batch and incremental modes.
- Behavior is documented with examples.

## 7. Phase 4 - State And `var`-Like Semantics

### Goal

Support persistent bar-to-bar state for trend regimes, signal deduplication, trailing stops, and object handles.

### Work Items

1. Add `state.py`.
2. Provide a user-facing `var()` or `pyne.var()` API.
3. Decide whether state values are series cells, scalar cells, or both.
4. Make state deterministic in batch mode.
5. Make state persistent in incremental sessions.
6. Add reset semantics per script execution/session.

### Target API Candidates

Option A:

```python
trend = var("trend", 0)
trend.set(1 if close > ta.ema(close, 20) else trend.get())
```

Option B:

```python
trend = pyne.var("trend", 0)
trend.value = when(close > ema, 1, trend.value)
```

Option C:

```python
trend = state("trend", default=0)
```

Because Python conditionals do not naturally work on series, the first implementation should prefer explicit cell/state methods and document the limits.

### Tests

- A state initialized with default is created once.
- State can retain prior bar value.
- Batch and incremental produce matching output for a simple stateful indicator.
- State does not leak across independent `pn.run()` calls.

### Exit Criteria

- Users can express common Pine `var` patterns without writing a custom incremental script.
- State behavior is deterministic and isolated.

## 8. Phase 5 - Series-Aware TA Expansion

### Goal

Upgrade `ta.*` from a NumPy helper collection into a Pine-like standard namespace.

### Work Items

1. Change TA inputs to `SeriesLike`.
2. Change TA outputs to `PyneSeries`.
3. Normalize argument names toward Pine conventions where possible.
4. Preserve backwards compatibility for NumPy arrays where reasonable.
5. Add missing high-impact TA helpers.

### Priority TA Functions

First priority:

- `ta.cross`
- `ta.dev`
- `ta.variance`
- `ta.linreg`
- `ta.alma`
- `ta.hma`
- `ta.swma`
- `ta.mom`
- `ta.percentile_nearest_rank`
- `ta.percentile_linear_interpolation`

Second priority:

- `ta.sar`
- `ta.dmi`
- `ta.tsi`
- `ta.wpr`
- `ta.cmo`
- `ta.cog`
- `ta.correlation`
- `ta.cum` parity

Third priority:

- Less common helpers after compatibility tests exist.

### Tests

Each function should have:

- simple deterministic dataset test
- warmup/`na` behavior test
- series input test
- history-reference composition test, for example `ta.ema(close[1], 5)`

### Exit Criteria

- Current TA behavior still works.
- Core `ta.*` functions return `PyneSeries`.
- TA docs distinguish implemented functions, planned functions, and known differences.

## 9. Phase 6 - Expression Helpers For Python Syntax Limits

### Goal

Provide ergonomic replacements where Python syntax cannot mimic Pine directly.

### Work Items

1. Promote `when()` as the primary series conditional.
2. Keep `iff()` as alias if useful.
3. Add `switch()` helper.
4. Add documentation for `&`, `|`, `~` boolean series operations.
5. Add clear errors when Python tries to cast a series to bool.

### Target API

```python
bull = close > open
strong = bull & (volume > ta.sma(volume, 20))
body = when(bull, close - open, open - close)
kind = switch(
    (strong, "strong"),
    (bull, "bull"),
    default="bear",
)
```

### Tests

- `if close > open:` raises a helpful error.
- `when()` accepts scalar and series branches.
- `switch()` produces stable series output.
- Boolean combinations preserve `na` policy.

### Exit Criteria

- Docs explain Python syntax differences without apologizing for them.
- Users have first-class alternatives for Pine conditionals.

## 10. Phase 7 - Drawing Object Lifecycle

### Goal

Support Pine-like object APIs for dynamic lines, labels, boxes, and tables.

### Work Items

1. Add `objects.py`.
2. Add object handles.
3. Add output schema for object snapshots/events.
4. Implement `line` namespace.
5. Implement `label` namespace.
6. Implement `box` namespace.
7. Implement `table` namespace.
8. Define object limits in `PyneSettings`.
9. Define lifecycle in batch and incremental modes.

### Target API

```python
l = line.new(bar_index[10], close[10], bar_index, close)
line.set_color(l, color.orange)

lab = label.new(bar_index, high, text="Breakout")
label.set_text(lab, "Breakout")

t = table.new(position.top_right, 2, 2)
table.cell(t, 0, 0, "RSI")
table.cell(t, 1, 0, str.tostring(ta.rsi(close, 14)))
```

### Output Schema Direction

Add structured object output:

```json
{
  "objects": {
    "lines": [],
    "labels": [],
    "boxes": [],
    "tables": []
  },
  "objectEvents": []
}
```

### Tests

- Creating objects emits stable handles.
- Updating objects changes the final snapshot.
- Object limits are enforced.
- Batch and incremental snapshots match for simple cases.

### Exit Criteria

- Complex visual indicators can be represented without abusing marker/line output.
- Host apps can render object snapshots deterministically.

## 11. Phase 8 - Host-Backed `request.security`

### Goal

Support multi-timeframe and multi-symbol series requests without making Pyne own market data storage.

### Work Items

1. Define `DataProvider` protocol.
2. Add `request` namespace.
3. Implement `request.security()`.
4. Define timeframe parsing.
5. Define data alignment.
6. Define `gaps` behavior.
7. Define `lookahead` behavior.
8. Add host capability errors.

### Target API

```python
higher_close = request.security("BTCUSDT", "1h", close)
trend = ta.ema(higher_close, 20)
plot(trend)
```

### Design Notes

Pyne should not fetch exchange data directly by default. It should ask a provider supplied by the host:

```python
class DataProvider:
    def get_ohlcv(self, symbol: str, timeframe: str, start: int, end: int) -> list[dict]:
        ...
```

The runtime owns:

- expression evaluation against requested data
- alignment back to chart bars
- gaps and lookahead semantics
- deterministic error messages when provider support is missing

### Tests

- Same-symbol higher timeframe request.
- Different-symbol same timeframe request.
- Missing provider returns `PYNE_UNSUPPORTED_FEATURE`.
- Alignment behavior is deterministic.
- `lookahead` and gaps policies are explicitly tested.

### Exit Criteria

- CandleScope can provide market data through a clean host adapter.
- Pyne semantics remain host-independent.

## 12. Phase 9 - Strategy Semantics

### Goal

Introduce Pine-like strategy events without forcing the first implementation to be a full broker simulator.

### Work Items

1. Add `strategy` namespace.
2. Add order event output.
3. Add position state.
4. Add basic entry/exit/close APIs.
5. Add optional simple fill model.
6. Define commission/slippage settings later.

### Target API

```python
if crossover(ta.ema(close, 12), ta.ema(close, 26)):
    strategy.entry("Long", strategy.long)

if crossunder(ta.ema(close, 12), ta.ema(close, 26)):
    strategy.close("Long")
```

Because Python `if` cannot use series conditions directly, the first realistic API may need event helpers:

```python
strategy.entry_when(crossover(fast, slow), "Long", strategy.long)
strategy.close_when(crossunder(fast, slow), "Long")
```

### Tests

- Entry event emitted on crossover bars.
- Close event emitted on crossunder bars.
- Position state updates deterministically.
- No duplicate entries unless pyramiding is enabled.

### Exit Criteria

- Users can prototype strategy-like scripts.
- CandleScope can render or backtest strategy events from Pyne output.

## 13. Phase 10 - Documentation And Compatibility Matrix

### Goal

Make Pyne's Pine-like surface explicit, test-backed, and honest.

### Work Items

1. Expand `docs/reference/compatibility.md`.
2. Add `docs/concepts/series_semantics.md`.
3. Add `docs/concepts/bar_execution_model.md`.
4. Add `docs/reference/pine_like_api_matrix.md`.
5. Add examples for `close[1]`, `barstate`, `var`, `request.security`, objects, and strategy events.

### Compatibility Matrix Columns

```text
Feature
Pyne API
Pine-like status
Known differences
Tests
Docs
```

Example:

```text
History reference | close[1] | Supported | Python negative indexes unsupported | test_series.py | series_semantics.md
```

### Exit Criteria

- Users can see what is supported, partial, planned, or intentionally different.
- Each claimed Pine-like behavior has a test reference.

## 14. Quality Gates

Every phase must pass:

```powershell
.\scripts\check.ps1 -Python .\.venv\Scripts\python.exe
```

For semantic phases, also add targeted tests:

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_series.py -q
.\.venv\Scripts\python.exe -m pytest tests\test_barstate.py -q
.\.venv\Scripts\python.exe -m pytest tests\test_request_security.py -q
```

No phase should close with only manual examples. If a behavior is advertised as Pine-like, it needs an automated semantic test.

## 15. Definition Of Done

A phase is done only when:

- user-facing behavior is implemented
- tests cover normal and edge cases
- docs explain syntax and known differences
- examples use the new preferred API
- old public API either still works or has a documented migration path
- quality gate passes

## 16. Suggested Branch/Commit Rhythm

Use short checkpoint branches and commits:

```text
codex/series-semantics
codex/na-semantics
codex/barstate-runtime
codex/request-security
```

Recommended commit pattern:

1. Add design/test skeleton.
2. Implement core runtime type.
3. Migrate one integration surface.
4. Expand tests.
5. Update docs/examples.
6. Run full quality gate.

This keeps each semantic layer reviewable instead of turning the runtime into one huge rewrite.

## 17. Immediate Next Implementation Slice

The first implementation slice should be Phase 1 only.

### Files To Add

- `src/pyne_runtime/series.py`
- `tests/test_series.py`
- `docs/concepts/series_semantics.md`

### Files To Modify

- `src/pyne_runtime/context.py`
- `src/pyne_runtime/runtime.py`
- `src/pyne_runtime/plot/`
- `src/pyne_runtime/input.py`
- `src/pyne_runtime/ta.py`
- `src/pyne_runtime/utils.py`
- `docs/api/ta.md`
- `docs/api/plot.md`
- `README.md`

### First Target Script

This script should pass before moving to later phases:

```python
indicator("Pine-Like Series", overlay=True)

prev = close[1]
mid = (high + low) / 2
fast = ta.ema(close, 3)
slow = ta.ema(close[1], 5)

plot(close, "Close", color=color.orange)
plot(prev, "Previous Close", color=color.blue)
plot(mid, "Mid", color=color.gray)
marker((fast > slow) & (close > prev), text="Signal", color=color.green)
```

### First Target Assertions

- `result.ok is True`
- `Previous Close` starts from the second bar logically, with first-bar history missing.
- `ta.ema(close[1], 5)` accepts a shifted series.
- `marker()` accepts a boolean series expression.
- Existing examples still pass.

## 18. Long-Term North Star

Pyne should feel like:

```python
indicator("Trend System", overlay=True)

fast = ta.ema(close, input.int(12, "Fast"))
slow = ta.ema(close, input.int(26, "Slow"))

bull = crossover(fast, slow)
bear = crossunder(fast, slow)

trend = pyne.var("trend", 0)
trend.set(when(bull, 1, when(bear, -1, trend.get())))

bgcolor(when(trend.get() > 0, color.new(color.green, 90), color.new(color.red, 90)))
plot(fast, "Fast")
plot(slow, "Slow")
marker(bull, text="Buy", location=location.belowbar)
marker(bear, text="Sell", location=location.abovebar)
```

This is still Python. It is not Pine source compatibility. But its logic model should be close enough that a Pine user recognizes the mental model immediately.
