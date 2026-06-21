# Phase 11: `request.security()` Expression Thunks Execution Plan

本文档定义 Pyne 下一阶段对 `request.security()` 的升级计划。

目标不是运行 TradingView Pine Script 源码，也不是引入 Pine parser。目标是在
Python 语法限制内，把 Pine 的这个核心心智模型推进一大步：

```pine
request.security(symbol, timeframe, ta.ema(close, 20))
```

在 Pyne 中对应为：

```python
higher_ema = request.security(
    "BTCUSDT",
    "1h",
    lambda ctx: ctx.ta.ema(ctx.close, 20),
)
plot(higher_ema, "1h EMA")
```

当前实现已经支持字段级表达式：

```python
request.security("BTCUSDT", "1h", close)
request.security("BTCUSDT", "1h", close[1])
request.security("BTCUSDT", "1h", "close")
```

Phase 11 要解决的是：让请求表达式可以在目标 symbol/timeframe 的上下文里重新计算，
而不是先在当前图表上下文里算完再传入。

## 1. Problem

Python 函数调用会先求值参数。

因此下面这段如果直接支持：

```python
request.security("BTCUSDT", "1h", ta.ema(close, 20))
```

`ta.ema(close, 20)` 会在当前图表上下文计算，`request.security()` 只能拿到已经算好的
`PyneSeries`，无法知道用户原本想在 `"BTCUSDT" / "1h"` 上重新计算 EMA。

这和 Pine 的表达式参数不同。Pine 编译器能保留 expression tree，并在请求上下文中重算。

Pyne 的可行替代是 expression thunk：

```python
lambda ctx: ctx.ta.ema(ctx.close, 20)
```

这个 lambda 不立刻计算。`request.security()` 在拿到目标 OHLCV 之后，创建目标上下文，
再调用这个 thunk。

## 2. Goals

1. 支持 callable expression:

   ```python
   request.security("BTCUSDT", "1h", lambda ctx: ctx.close)
   request.security("BTCUSDT", "1h", lambda ctx: ctx.close[1])
   request.security("BTCUSDT", "1h", lambda ctx: ctx.ta.ema(ctx.close, 20))
   request.security("BTCUSDT", "1h", lambda ctx: ctx.ta.rsi(ctx.close, 14))
   request.security("BTCUSDT", "1h", lambda ctx: (ctx.high + ctx.low) / 2)
   ```

2. 保持已有字段级表达式兼容：

   ```python
   request.security("BTCUSDT", "1h", close)
   request.security("BTCUSDT", "1h", close[1])
   request.security("BTCUSDT", "1h", "close")
   ```

3. 请求上下文里使用独立 `PyneContext` 和 `TaModule`。

4. 请求结果仍按当前图表 `ctx.times` 对齐。

5. 错误要稳定、清楚，并使用已有 `PYNE_UNSUPPORTED_FEATURE` 或 `PYNE_RUNTIME_ERROR`。

6. 文档和兼容矩阵必须明确：这是 Pyne 的 Python-friendly 替代语法，不是 Pine 源码兼容。

## 3. Non-Goals

Phase 11 不做这些：

- 不支持直接写 `request.security(..., ta.ema(close, 20))` 并自动捕获表达式树。
- 不实现 Pine parser / AST compiler。
- 不支持在 requested expression 里调用 `plot()`、`strategy.*`、`line.new()`、`label.new()`。
- 不支持 nested `request.security()`。
- 不支持 tuple expression 返回多个 series。
- 不引入交易所网络请求。数据仍然由 host `DataProvider` 提供。
- 不承诺和 TradingView 每一个边缘 case 逐点一致，除非已有 golden tests。

## 4. Target User API

### 4.1 Basic thunk

```python
higher_close = request.security(
    "BTCUSDT",
    "1h",
    lambda ctx: ctx.close,
)
```

### 4.2 Computed expression

```python
higher_ema = request.security(
    "BTCUSDT",
    "1h",
    lambda ctx: ctx.ta.ema(ctx.close, 20),
)
```

### 4.3 History reference in requested context

```python
higher_prev = request.security(
    "BTCUSDT",
    "1h",
    lambda ctx: ctx.close[1],
)
```

这里的 `ctx.close[1]` 必须表示目标 `"BTCUSDT" / "1h"` 上的上一根 bar，而不是当前图表
上下文的上一根 bar。

### 4.4 Composite expression

```python
higher_mid = request.security(
    "BTCUSDT",
    "1h",
    lambda ctx: (ctx.high + ctx.low + ctx.close) / 3,
)
```

### 4.5 With gaps/lookahead

```python
higher_ema = request.security(
    "BTCUSDT",
    "1h",
    lambda ctx: ctx.ta.ema(ctx.close, 20),
    gaps="off",
    lookahead="off",
)
```

## 5. Architecture

### 5.1 Existing Pieces

Current package locations:

```text
src/pyne_runtime/request/module.py
src/pyne_runtime/request/eval.py
src/pyne_runtime/request/alignment.py
src/pyne_runtime/request/lower_tf.py
src/pyne_runtime/request/provider.py
src/pyne_runtime/context.py
src/pyne_runtime/ta.py
src/pyne_runtime/runtime.py
src/pyne_runtime/settings.py
tests/test_request_security.py
docs/api/request.md
```

Current data path:

```text
chart PyneContext
  -> RequestModule.security(symbol, timeframe, field expression)
  -> DataProvider.get_ohlcv(symbol, timeframe, start, end)
  -> requested OHLCV values
  -> align requested values back to chart times
```

Target data path:

```text
chart PyneContext
  -> RequestModule.security(symbol, timeframe, callable expression)
  -> DataProvider.get_ohlcv(symbol, timeframe, start, end)
  -> requested PyneContext.from_ohlcv(requested_bars)
  -> RequestEvalContext(requested_ctx, requested_ta, symbol, timeframe)
  -> expression(RequestEvalContext)
  -> requested PyneSeries
  -> align requested series back to chart times
```

### 5.2 New RequestEvalContext

Add a lightweight context object in `src/pyne_runtime/request/eval.py`.

Proposed shape:

```python
@dataclass(frozen=True)
class RequestEvalContext:
    symbol: str
    timeframe: str
    context: PyneContext
    ta: TaModule

    @property
    def open(self): ...
    @property
    def high(self): ...
    @property
    def low(self): ...
    @property
    def close(self): ...
    @property
    def volume(self): ...
    @property
    def time(self): ...
    @property
    def bar_index(self): ...
    @property
    def barstate(self): ...
    @property
    def hl2(self): ...
    @property
    def hlc3(self): ...
    @property
    def ohlc4(self): ...
    @property
    def hlcc4(self): ...
```

Do not expose:

- `plot`
- `marker`
- `strategy`
- `line`
- `label`
- `input`
- `request`

Rationale: `request.security()` expressions should calculate a value, not emit host outputs.

### 5.3 Expression Types

Update accepted expression type:

```python
RequestExpression = PyneSeries | str | Callable[[RequestEvalContext], Any]
```

Accepted callable return values:

- `PyneSeries`
- `np.ndarray`
- `list`
- numeric scalar, broadcast to requested length

Rejected callable return values:

- tuple
- dict
- object handles
- `None`

Rejection should raise `PyneRequestError` with `PYNE_UNSUPPORTED_FEATURE` and a helpful message.

### 5.4 Alignment

Reuse the existing `_aligned_value()` policy.

Need a new helper:

```python
def _values_from_expression_result(result: Any, requested_ctx: PyneContext) -> list[float]:
    ...
```

Rules:

- If result is `PyneSeries`, use `result.to_numpy().tolist()`.
- If result is `np.ndarray`, use `.tolist()`.
- If result is `list`, require length equals requested bar count.
- If scalar numeric/bool, broadcast to requested bar count.
- Preserve `na` as `np.nan`.

Then align:

```text
requested_times = requested_ctx.times
requested_values = expression values
chart_times = self._context.times
```

### 5.5 Existing Field Expression Compatibility

Keep current behavior by splitting `RequestModule.security()` into two paths:

```python
if callable(expression):
    requested_values = _evaluate_expression_thunk(...)
else:
    requested_values = _evaluate_field_expression(...)
```

This avoids breaking existing tests and docs.

### 5.6 Security Model

The callable is created by the user script and invoked within the same runtime execution.
It does not need a second `exec()`.

Still enforce these boundaries:

- The requested eval context exposes calculation-only APIs.
- Nested `request.security()` is not available through `ctx`.
- Output-producing APIs are not available through `ctx`.
- If the thunk raises, convert to a deterministic Pyne error.

Potential policy:

```python
except PyneRequestError:
    raise
except Exception as exc:
    raise PyneRequestError(
        f"request.security() expression failed: {exc}",
        code="PYNE_RUNTIME_ERROR",
    )
```

## 6. Implementation Slices

### Slice 1: Add RequestEvalContext

Files:

- `src/pyne_runtime/request/eval.py`
- `src/pyne_runtime/request/module.py`
- `tests/test_request_security.py`

Work:

1. Import `Callable` and `TaModule`.
2. Add `RequestEvalContext`.
3. Add property forwarding for OHLCV, derived fields, bar clock, and `ta`.
4. Add unit test that creates a provider and calls:

   ```python
   request.security("BTCUSDT", "2", lambda ctx: ctx.close)
   ```

Expected: same output as field-level `close` request.

### Slice 2: Evaluate computed expression in requested context

Files:

- `src/pyne_runtime/request/eval.py`
- `src/pyne_runtime/request/module.py`
- `tests/test_request_security.py`

Work:

1. Add `_evaluate_expression_thunk()`.
2. Build requested `PyneContext`.
3. Build requested `TaModule`.
4. Call expression with `RequestEvalContext`.
5. Normalize result into requested values.

Target test:

```python
higher_sma = request.security(
    "BTCUSDT",
    "2",
    lambda ctx: ctx.ta.sma(ctx.close, 2),
)
plot(higher_sma, "Higher SMA")
```

Use a deterministic provider dataset where expected aligned values are easy to assert.

### Slice 3: History references inside thunk

Files:

- `tests/test_request_security.py`

Target:

```python
higher_prev = request.security(
    "BTCUSDT",
    "2",
    lambda ctx: ctx.close[1],
)
```

Assert that history is applied in requested context before alignment.

### Slice 4: Composite expression and `na`

Files:

- `src/pyne_runtime/request/eval.py`
- `tests/test_request_security.py`

Target:

```python
higher_mid = request.security(
    "BTCUSDT",
    "2",
    lambda ctx: when(ctx.close > ctx.open, ctx.close, na),
)
```

Decision: The thunk should not depend on outer global `when` unless Python closure/global lookup naturally works.
Preferred user style for request-local expressions:

```python
lambda ctx: ctx.where(ctx.close > ctx.open, ctx.close, na)
```

If we want this, add `when`, `where`, and `switch` to `RequestEvalContext`.

Recommended Phase 11 choice:

- Add `when`
- Add `where`
- Add `switch`
- Document them as request-local expression helpers.

### Slice 5: Error handling

Files:

- `src/pyne_runtime/request/eval.py`
- `tests/test_request_security.py`

Tests:

1. Callable returns tuple:

   ```python
   lambda ctx: (ctx.close, ctx.open)
   ```

   Expected: unsupported feature error.

2. Callable raises:

   ```python
   lambda ctx: 1 / 0
   ```

   Expected: stable runtime error.

3. Callable returns list with wrong length.

   Expected: stable runtime error or unsupported feature error with clear message.

### Slice 6: Docs and compatibility matrix

Files:

- `docs/api/request.md`
- `docs/tutorials/host_request_security.md`
- `docs/reference/pine_like_api_matrix.md`
- `CHANGELOG.md`

Updates:

1. Move `request.security()` from field-expression partial to thunk-supported partial.
2. Add examples for:
   - `lambda ctx: ctx.close`
   - `lambda ctx: ctx.ta.ema(ctx.close, 20)`
   - `lambda ctx: ctx.close[1]`
3. Keep known difference:
   - direct `ta.ema(close, 20)` expression capture is still not possible in Python.

## 7. Test Matrix

Add or update `tests/test_request_security.py`.

Required tests:

1. Field expression still works:

   ```python
   request.security("BTCUSDT", "2", close)
   ```

2. String field still works:

   ```python
   request.security("BTCUSDT", "2", "close")
   ```

3. Basic thunk:

   ```python
   request.security("BTCUSDT", "2", lambda ctx: ctx.close)
   ```

4. Computed TA thunk:

   ```python
   request.security("BTCUSDT", "2", lambda ctx: ctx.ta.sma(ctx.close, 2))
   ```

5. History thunk:

   ```python
   request.security("BTCUSDT", "2", lambda ctx: ctx.close[1])
   ```

6. Composite expression:

   ```python
   request.security("BTCUSDT", "2", lambda ctx: (ctx.high + ctx.low) / 2)
   ```

7. `gaps="on"` works with thunk values.

8. `lookahead="on"` works with thunk values.

9. Missing provider still returns `PYNE_UNSUPPORTED_FEATURE`.

10. Invalid callable return type fails predictably.

11. Callable exception fails predictably.

12. Provider call range remains chart start/end.

## 8. Example Provider Dataset

Use small deterministic bars:

```python
chart_bars = [
    {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
    {"time": 2, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 120},
    {"time": 3, "open": 3, "high": 4, "low": 2.5, "close": 3.5, "volume": 140},
    {"time": 4, "open": 4, "high": 5, "low": 3.5, "close": 4.5, "volume": 160},
]

requested_bars = [
    {"time": 1, "open": 10, "high": 12, "low": 8, "close": 10, "volume": 1000},
    {"time": 3, "open": 30, "high": 34, "low": 28, "close": 30, "volume": 3000},
]
```

Expected examples:

```text
lambda ctx: ctx.close
gaps off -> [10, 10, 30, 30]

lambda ctx: ctx.close[1]
gaps off -> [na, na, 10, 10]

lambda ctx: (ctx.high + ctx.low) / 2
gaps off -> [10, 10, 31, 31]
```

Plot serialization skips `na`, so assertions using `result.values()` may omit leading missing values.
When exact missing positions matter, assert against `result.get_series()`.

## 9. Documentation Wording

Use this explanation consistently:

```text
Pyne cannot capture Python expressions before they are evaluated. Use a callable
request expression to tell Pyne what to calculate in the requested context.
```

Good:

```python
request.security("BTCUSDT", "1h", lambda ctx: ctx.ta.ema(ctx.close, 20))
```

Unsupported:

```python
request.security("BTCUSDT", "1h", ta.ema(close, 20))
```

Reason:

```text
Python evaluates ta.ema(close, 20) in the current chart context before
request.security() receives it.
```

## 10. Exit Criteria

Phase 11 is done only when:

- `request.security()` supports callable expression thunks.
- Existing field expression tests still pass.
- Computed TA expression thunk is tested.
- History references inside the thunk are tested.
- `gaps` and `lookahead` still work with thunk results.
- Invalid callable returns and callable exceptions produce stable errors.
- `docs/api/request.md` documents thunk syntax and Python limitations.
- `docs/reference/pine_like_api_matrix.md` reflects the new status.
- Full quality gate passes:

  ```powershell
  .\scripts\check.ps1 -Python .\.venv\Scripts\python.exe
  ```

## 11. Suggested Implementation Order

1. Add tests for desired thunk behavior and watch them fail.
2. Add `RequestEvalContext`.
3. Add callable path in `RequestModule.security()`.
4. Normalize callable return values.
5. Reuse existing alignment logic.
6. Add error tests.
7. Update request docs and compatibility matrix.
8. Run targeted request tests.
9. Run full quality gate.

## 12. Future Work After Phase 11

After expression thunks, the next meaningful improvements are:

- `box` and `table` drawing objects.
- `strategy.exit()` with stop/limit bracket events.
- More complete realtime/incremental `barstate` parity.
- Golden compatibility tests for TA and request alignment.
- Optional expression builder DSL if lambda syntax proves too verbose.
