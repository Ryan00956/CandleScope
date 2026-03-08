# Indicator Development Guide

> **Target audience**: Developers who want to write custom indicators for CandleScope.  
> **After reading this guide you will be able to**: Understand the complete indicator system logic, and independently write, register, and use a new indicator.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Core Concepts](#3-core-concepts)
4. [Type Reference](#4-type-reference)
5. [Indicator Lifecycle](#5-indicator-lifecycle)
6. [Tutorial: Writing a KDJ Indicator](#6-tutorial-writing-a-kdj-indicator)
7. [Four Typical Patterns](#7-four-typical-patterns)
8. [Registration](#8-registration)
9. [Output Configuration & Rendering](#9-output-configuration--rendering)
10. [Script Mode (Quick Experiments)](#10-script-mode-quick-experiments)
11. [API Reference](#11-api-reference)
12. [FAQ & Troubleshooting](#12-faq--troubleshooting)
13. [Built-in Indicator Cheat Sheet](#13-built-in-indicator-cheat-sheet)

---

## 1. Overview

The **indicator module** is CandleScope's incremental computation engine. It receives candlestick data (`BarData`), runs computations through registered indicator classes, and outputs standardized `IndicatorResult` objects for frontend chart rendering, strategy engines, and alert systems.

The entire system revolves around one core loop:

```
Bar data → Engine dispatch → Indicator instance computation → Standardized output → Consumers
```

---

## 2. Architecture

```
indicator/
├── __init__.py          # Auto-register built-in indicators + export public API
├── types.py             # All data type definitions
├── base.py              # Indicator abstract base class
├── events.py            # Indicator events (engine → consumers)
├── registry.py          # Registry (global singleton: registry)
├── dependency.py        # Dependency graph (indicator chaining)
├── engine.py            # IndicatorEngine (dispatch + caching + lifecycle)
└── indicators/          # Built-in implementations
    ├── __init__.py
    ├── ma.py            # MA  — Simple Moving Average
    ├── ema.py           # EMA — Exponential Moving Average
    ├── macd.py          # MACD — Moving Average Convergence Divergence
    ├── rsi.py           # RSI — Relative Strength Index
    ├── boll.py          # BOLL — Bollinger Bands
    └── atr.py           # ATR — Average True Range
```

**Responsibilities**:

| File | What it manages |
|------|-----------------|
| `base.py` | Defines what indicators must implement and what utility methods they inherit |
| `types.py` | All data structures: Key, Meta, Param, Spec, Output, Result, etc. |
| `registry.py` | Knows which indicators are available (register / lookup / list) |
| `engine.py` | Receives bar events, creates/caches indicator instances, dispatches computation, distributes results |
| `events.py` | Defines event types emitted by the engine |
| `dependency.py` | Supports indicators consuming other indicators' outputs (e.g. MA(MACD.hist, 5)) |

---

## 3. Core Concepts

### 3.1 Indicators Are Instances, Not Functions

`MA(close, 20)` and `MA(close, 60)` are two independent objects. Each instance maintains its own rolling state (windows, accumulators, etc.).

Instances are uniquely identified by `IndicatorKey`:

```python
key = IndicatorKey("BTCUSDT", "1m", "MA", {"period": 20, "source": "close"})
# key.uid → "BTCUSDT:1m:MA:a3f1c8..."
```

**Same Key = same instance**. Multiple subscribers (chart windows, strategies, alerts) share one computation — no duplicate work.

### 3.2 Two-Phase Updates

Every bar has two stages: **forming (unclosed)** and **closed**. Indicators handle them with two separate methods:

| Method | When called | Behavior | Result used for |
|--------|-------------|----------|-----------------|
| `update_partial(bar)` | Every tick update | Compute temporary preview value, **do NOT modify state** | Frontend real-time display |
| `update_closed(bar)` | Bar close confirmed | Compute final value, **advance internal state** | Strategy / alerts / storage |

Why separate? A bar may receive dozens or hundreds of tick updates before closing. If we advanced state on every tick, the state would be corrupted. By separating:

- `update_partial` can be called any number of times without polluting state
- `update_closed` is called exactly once per bar, cleanly advancing state

### 3.3 O(1) Incremental Updates

Built-in indicators maintain rolling state (running sums, EMA values, etc.), so each new bar requires only **constant time** to process.

For example, MA(20):
- Maintains a `deque(maxlen=20)` and a `rolling_sum`
- New bar arrives: `rolling_sum += new_val - oldest_val`, `ma = rolling_sum / 20`
- No need to iterate over 20 values each time

### 3.4 Instance Caching & Deduplication

The engine internally uses a dictionary `{IndicatorKey → Indicator}` to cache all active instances.

- First request for a Key → create new instance
- Subsequent requests for same Key → reuse existing instance
- Reference count reaches zero → auto-destroy instance

### 3.5 Standardized Output

All indicator outputs follow the same format:

```
IndicatorResult
  └── outputs: dict[str, IndicatorOutput]
       └── data: list[OutputPoint(timestamp, value)]
```

Whether your indicator outputs one line (MA) or three lines (MACD), the format is identical. The frontend can render any indicator uniformly.

### 3.6 Registry-Driven

All indicators register with `IndicatorRegistry`, which exposes:

- Indicator name, description, category
- Parameter schema (frontend auto-generates configuration forms)
- Output definitions (frontend knows how many lines to draw)

---

## 4. Type Reference

### 4.1 `BarData` — Candlestick Data

This is the input received by indicators. From `app.data_engine.data_manager.models`.

```python
@dataclass
class BarData:
    time: int        # Unix seconds
    open: float
    high: float
    low: float
    close: float
    volume: float
```

### 4.2 `IndicatorKey` — Unique Indicator Instance Identifier

```python
@dataclass(frozen=True)
class IndicatorKey:
    symbol: str           # "BTCUSDT"
    interval: str         # "1m"
    indicator_name: str   # "MA"
    params: dict          # {"period": 20, "source": "close"}

    @property
    def uid(self) -> str:
        # → "BTCUSDT:1m:MA:a3f1c8..."
```

- `symbol` is auto-uppercased
- `params` are frozen into an immutable form (for hashing)
- `uid` is a human-readable unique ID

### 4.3 `IndicatorMeta` — Indicator Metadata

Controls rendering behavior and location.

```python
@dataclass
class IndicatorMeta:
    name: str                             # Display name, e.g. "MA(20)"
    category: str = ""                    # "Trend" / "Oscillator" / "Volatility"
    description: str = ""
    pane: PaneType = PaneType.MAIN        # Main chart or separate pane
    overlay: bool = True                  # Overlay on price chart?
    precision: int = 8                    # Decimal places
    warmup_period: int = 0                # Bars needed before valid output
    version: str = "1.0"
```

**`PaneType` enum**:

| Value | Meaning |
|-------|---------|
| `PaneType.MAIN` | Main chart (overlaid on candlesticks, e.g. MA, BOLL) |
| `PaneType.SEPARATE` | Separate sub-pane (e.g. MACD, RSI) |
| `PaneType.VOLUME` | Volume pane |

### 4.4 `IndicatorParam` — Parameter Schema

Defines type, range, and default value for a parameter. The frontend auto-generates forms from this.

```python
@dataclass
class IndicatorParam:
    key: str                    # Parameter name, e.g. "period"
    label: str = ""             # Display label
    type: str = "int"           # "int" / "float" / "color" / "string" / "bool"
    default: Any = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: list[str] | None = None  # For dropdown/select
```

**Examples**:

```python
IndicatorParam(key="period", label="Period", type="int", default=20, min=1, max=500)
IndicatorParam(key="source", label="Source", type="string", default="close",
               options=["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"])
IndicatorParam(key="color", label="Color", type="color", default="#f59e0b")
```

### 4.5 `IndicatorSpec` — Full Indicator Specification

This is what the registry stores, and what the frontend receives via API.

```python
@dataclass
class IndicatorSpec:
    name: str                                   # Unique name, e.g. "MA"
    display_name: str = ""                      # e.g. "Simple Moving Average"
    description: str = ""
    category: str = ""
    input_specs: list[str] = ["close"]          # Required input fields
    output_specs: list[str] = ["value"]         # Output series names
    param_schema: list[IndicatorParam] = []     # Parameter schema
    default_params: dict = {}                   # Default parameter values
    meta: IndicatorMeta | None = None
    is_builtin: bool = True
```

### 4.6 `OutputPoint` — Output Data Point

```python
@dataclass
class OutputPoint:
    timestamp: int        # Unix seconds
    value: float | None   # Indicator value (None during warmup)
```

### 4.7 `IndicatorOutput` — One Output Line

```python
@dataclass
class IndicatorOutput:
    name: str                                    # Internal name, e.g. "ma", "dif"
    display_name: str = ""                       # Display name, e.g. "MA(20)"
    series_type: SeriesType = SeriesType.LINE    # LINE or HISTOGRAM
    pane: PaneType = PaneType.MAIN               # Rendering pane
    color: str = "#f59e0b"
    line_width: int = 2
    line_style: int = 0                          # 0=solid, 1=dotted, 2=dashed, 3=large-dashed, 4=sparse-dotted
    data: list[OutputPoint] = []
    color_data: list[dict] | None = None         # Per-bar colors (for histograms)
```

**`SeriesType` enum**:

| Value | Meaning |
|-------|---------|
| `SeriesType.LINE` | Line chart |
| `SeriesType.HISTOGRAM` | Bar/histogram chart |

### 4.8 `IndicatorResult` — Complete Result Envelope

This is what the engine returns to consumers.

```python
@dataclass
class IndicatorResult:
    key: IndicatorKey
    meta: IndicatorMeta
    outputs: dict[str, IndicatorOutput] = {}     # name → output line
    error: str | None = None

    def to_dict(self) -> dict: ...               # JSON serializable
    def lines(self) -> list[dict]: ...           # Flat list for frontend rendering
    def get_latest(self) -> dict: ...            # Latest values
```

---

## 5. Indicator Lifecycle

### 5.1 Complete Flow

```
                       ┌─────────────────────────────────────────┐
                       │            IndicatorEngine              │
                       ├─────────────────────────────────────────┤
                       │                                         │
  User calls compute() │  1. Build IndicatorKey                  │
  ─────────────────►   │  2. Look up indicator class in registry │
                       │  3. Create instance cls(params=...)     │
                       │  4. Call instance.recompute(bars)       │
                       │     └─► reset() + init(bars)            │
                       │  5. Call instance.build_result(key)     │
                       │  6. Return IndicatorResult              │
                       │                                         │
  BAR_CLOSED event     │  Find all instances subscribed to this  │
  ─────────────────►   │  (symbol, interval)                     │
                       │  └─► instance.update_closed(bar)        │
                       │      └─► emit INDICATOR_UPDATED event   │
                       │                                         │
  BAR_UPDATED event    │  Find all instances subscribed to this  │
  ─────────────────►   │  (symbol, interval)                     │
                       │  └─► instance.update_partial(bar)       │
                       │      └─► emit INDICATOR_PREVIEW event   │
                       │                                         │
  BACKFILL event       │  Find all instances subscribed to this  │
  ─────────────────►   │  (symbol, interval)                     │
                       │  └─► instance.recompute(bars)           │
                       │      └─► emit INDICATOR_RECOMPUTED      │
                       └─────────────────────────────────────────┘
```

### 5.2 Detailed Lifecycle Methods

#### `init(bars: list[BarData]) -> None`

**When called**: When the instance first receives historical data.

**What you need to do**:
1. Reset internal state (call `_reset_state()`)
2. Iterate over all historical bars, processing each one
3. For each bar, call `self._append_output("output_name", bar.time, value)` to record the result
4. During warmup (insufficient data), output `None`
5. Set `self._bar_count = len(bars)` and `self._initialized = True`

```python
def init(self, bars: list[BarData]) -> None:
    self._reset_state()
    for bar in bars:
        val = self._get_field(bar, self._source)
        # ... computation ...
        self._append_output("ma", bar.time, result_or_none)
    self._bar_count = len(bars)
    self._initialized = True
```

#### `update_partial(bar: BarData) -> None`

**When called**: On every tick update of the current forming bar (called many times per bar).

**What you need to do**:
1. Use current internal state + new bar value to compute a **temporary preview value**
2. Write the result to `self._preview["output_name"]`
3. ⚠️ **Never modify any internal state variables** (don't write to `self._ema`, `self._window`, etc.)

```python
def update_partial(self, bar: BarData) -> None:
    if self._ema is None:
        self._preview["ema"] = None
        return
    val = self._get_field(bar, self._source)
    # Read self._ema, don't write!
    self._preview["ema"] = self._alpha * val + (1 - self._alpha) * self._ema
```

**Key principle**: `update_partial` is a **read-only** operation. It may read internal state to compute preview values, but **after the method returns, the indicator instance's state must be exactly the same as before the call**.

#### `update_closed(bar: BarData) -> None`

**When called**: When a bar close is confirmed (called exactly once per bar).

**What you need to do**:
1. Update internal state with the new bar's value (windows, accumulators, EMAs, etc.)
2. Compute the new final value
3. Call `self._append_output("output_name", bar.time, value)` to record the result
4. Increment `self._bar_count += 1`

```python
def update_closed(self, bar: BarData) -> None:
    val = self._get_field(bar, self._source)
    # Advance state
    if len(self._window) == self._period:
        self._rolling_sum -= self._window[0]
    self._window.append(val)
    self._rolling_sum += val
    self._bar_count += 1
    # Output
    if len(self._window) >= self._period:
        self._append_output("ma", bar.time, self._rolling_sum / self._period)
    else:
        self._append_output("ma", bar.time, None)
```

#### `recompute(bars: list[BarData]) -> None` (optional override)

**When called**: When historical data is corrected or backfilled.

**Default behavior**: `reset()` + `init(bars)`. Usually no need to override.

Only consider overriding if recomputation is extremely costly and you can do incremental correction.

### 5.3 Warmup Period

Most indicators need N bars before producing meaningful values. This period is called the warmup period.

**Rule**: During warmup, you must output `None` — not 0 or an arbitrary value.

**Example**: MA(20) needs 20 bars for the first value, so the first 19 bars output `None`:

```python
if len(self._window) >= self._period:
    self._append_output("ma", bar.time, self._rolling_sum / self._period)
else:
    self._append_output("ma", bar.time, None)  # warmup period
```

---

## 6. Tutorial: Writing a KDJ Indicator

Let's write a KDJ (Stochastic Oscillator) from scratch, covering every key step you'll encounter.

KDJ algorithm:
1. `RSV = (close - lowest_low_N) / (highest_high_N - lowest_low_N) × 100`
2. `K = α × RSV + (1 - α) × K_prev` (α is typically 1/3)
3. `D = α × K + (1 - α) × D_prev`
4. `J = 3K - 2D`

### Step 1: Create the File

Create `kdj.py` in `backend/app/indicator/indicators/`:

```python
# -*- coding: utf-8 -*-
"""
KDJ -- Stochastic Oscillator.

Combines multi-output + rolling window + recursive state patterns.
"""
from __future__ import annotations

from collections import deque
from typing import Any

from app.data_engine.data_manager.models import BarData

from ..base import Indicator
from ..types import IndicatorMeta, IndicatorParam, IndicatorSpec, PaneType
```

### Step 2: Define Class and Class-Level Metadata

```python
class KDJIndicator(Indicator):
    # ── Class-level metadata (must set) ──────────────
    name = "KDJ"                            # Unique indicator name (uppercase)
    version = "1.0"
    input_specs = ["high", "low", "close"]  # Required input fields
    output_specs = ["k", "d", "j"]          # Output series names
    warmup_period = 9                       # Will be dynamically overridden in __init__
```

- `name`: The registry uses this to look up your indicator. Case-insensitive, but uppercase is recommended.
- `input_specs`: Declares which BarData fields you need. Mainly for documentation.
- `output_specs`: **Very important**. Each name creates an empty list in `self._outputs`. You must use these exact names when calling `_append_output`.

### Step 3: `__init__` — Initialize Parameters and Internal State

```python
    def __init__(self, params: dict[str, Any] | None = None) -> None:
        super().__init__(params)  # ⚠️ Must call super().__init__

        # Read user configuration from params
        self._n: int = int(self.params.get("n", 9))         # RSV period
        self._m1: int = int(self.params.get("m1", 3))       # K smoothing period
        self._m2: int = int(self.params.get("m2", 3))       # D smoothing period

        # Dynamically set warmup period
        self.warmup_period = self._n

        # Internal computation state
        self._high_window: deque[float] = deque(maxlen=self._n)
        self._low_window: deque[float] = deque(maxlen=self._n)
        self._k: float = 50.0    # K initial value
        self._d: float = 50.0    # D initial value
        self._count: int = 0
```

**Notes**:
- Must call `super().__init__(params)`. The base class initializes `self.params`, `self._outputs`, `self._preview`, etc.
- Use `self.params.get(...)` to read parameters, providing sensible defaults.
- Declare all internal state variables here.

### Step 4: `_reset_state` — Optional but Strongly Recommended

```python
    def _reset_state(self) -> None:
        """Reset custom internal state. Called automatically by reset()."""
        self._high_window.clear()
        self._low_window.clear()
        self._k = 50.0
        self._d = 50.0
        self._count = 0
```

The base class `reset()` will automatically call `_reset_state()` if you define it. It already clears `_outputs` and `_preview` — you only need to clean up your own private variables.

### Step 5: `init(bars)` — Full Historical Computation

```python
    def init(self, bars: list[BarData]) -> None:
        self._reset_state()

        for bar in bars:
            self._high_window.append(bar.high)
            self._low_window.append(bar.low)
            self._count += 1

            if self._count < self._n:
                # Warmup: not enough data, output None
                self._append_output("k", bar.time, None)
                self._append_output("d", bar.time, None)
                self._append_output("j", bar.time, None)
            else:
                # Compute RSV
                highest = max(self._high_window)
                lowest = min(self._low_window)
                if highest == lowest:
                    rsv = 50.0
                else:
                    rsv = (bar.close - lowest) / (highest - lowest) * 100

                # Recursive smoothing
                alpha1 = 1.0 / self._m1
                alpha2 = 1.0 / self._m2
                self._k = alpha1 * rsv + (1 - alpha1) * self._k
                self._d = alpha2 * self._k + (1 - alpha2) * self._d
                j = 3 * self._k - 2 * self._d

                self._append_output("k", bar.time, self._k)
                self._append_output("d", bar.time, self._d)
                self._append_output("j", bar.time, j)

        self._bar_count = len(bars)
        self._initialized = True
```

**Key rules**:
- Each bar must call `_append_output` for **every** output. Missing calls cause length mismatches.
- Output `None` during warmup.
- Set `_bar_count` and `_initialized = True` at the end.

### Step 6: `update_partial(bar)` — Preview Values (Read-Only!)

```python
    def update_partial(self, bar: BarData) -> None:
        if self._count < self._n:
            self._preview.update({"k": None, "d": None, "j": None})
            return

        # Simulate window after adding new bar (don't actually modify window)
        temp_highs = list(self._high_window)
        temp_lows = list(self._low_window)
        if len(temp_highs) == self._n:
            temp_highs.pop(0)
            temp_lows.pop(0)
        temp_highs.append(bar.high)
        temp_lows.append(bar.low)

        highest = max(temp_highs)
        lowest = min(temp_lows)
        if highest == lowest:
            rsv = 50.0
        else:
            rsv = (bar.close - lowest) / (highest - lowest) * 100

        alpha1 = 1.0 / self._m1
        alpha2 = 1.0 / self._m2
        k_preview = alpha1 * rsv + (1 - alpha1) * self._k  # Read self._k, don't write!
        d_preview = alpha2 * k_preview + (1 - alpha2) * self._d  # Read self._d, don't write!
        j_preview = 3 * k_preview - 2 * d_preview

        self._preview["k"] = k_preview
        self._preview["d"] = d_preview
        self._preview["j"] = j_preview
```

⚠️ Notice we create **copies** of `temp_highs` / `temp_lows` instead of modifying `self._high_window` directly. This is what "read-only" means.

### Step 7: `update_closed(bar)` — Close Confirmation

```python
    def update_closed(self, bar: BarData) -> None:
        self._high_window.append(bar.high)
        self._low_window.append(bar.low)
        self._count += 1
        self._bar_count += 1

        if self._count < self._n:
            self._append_output("k", bar.time, None)
            self._append_output("d", bar.time, None)
            self._append_output("j", bar.time, None)
        else:
            highest = max(self._high_window)
            lowest = min(self._low_window)
            if highest == lowest:
                rsv = 50.0
            else:
                rsv = (bar.close - lowest) / (highest - lowest) * 100

            alpha1 = 1.0 / self._m1
            alpha2 = 1.0 / self._m2
            self._k = alpha1 * rsv + (1 - alpha1) * self._k  # Write self._k ✓
            self._d = alpha2 * self._k + (1 - alpha2) * self._d  # Write self._d ✓
            j = 3 * self._k - 2 * self._d

            self._append_output("k", bar.time, self._k)
            self._append_output("d", bar.time, self._d)
            self._append_output("j", bar.time, j)
```

Compare with `update_partial`: here we **directly modify** `self._k` and `self._d`, because the close is confirmed.

### Step 8: `get_meta()` — Metadata

```python
    def get_meta(self) -> IndicatorMeta:
        return IndicatorMeta(
            name=f"KDJ({self._n},{self._m1},{self._m2})",
            category="Oscillator",
            description=f"KDJ Stochastic ({self._n},{self._m1},{self._m2})",
            pane=PaneType.SEPARATE,    # Separate sub-pane
            overlay=False,
            precision=2,
            warmup_period=self._n,
        )
```

### Step 9: `_get_output_configs()` — Rendering Configuration

```python
    def _get_output_configs(self) -> dict[str, dict]:
        return {
            "k": {
                "display_name": f"K({self._n})",
                "color": self.params.get("color_k", "#f59e0b"),
                "pane": PaneType.SEPARATE,
            },
            "d": {
                "display_name": f"D({self._m2})",
                "color": self.params.get("color_d", "#3b82f6"),
                "pane": PaneType.SEPARATE,
            },
            "j": {
                "display_name": "J",
                "color": self.params.get("color_j", "#ef4444"),
                "pane": PaneType.SEPARATE,
            },
        }
```

### Step 10: `get_spec()` — Registration Specification

```python
    @classmethod
    def get_spec(cls) -> IndicatorSpec:
        return IndicatorSpec(
            name="KDJ",
            display_name="KDJ Stochastic",
            description="KDJ Stochastic Oscillator",
            category="Oscillator",
            input_specs=["high", "low", "close"],
            output_specs=["k", "d", "j"],
            param_schema=[
                IndicatorParam(key="n", label="N Period", type="int",
                               default=9, min=2, max=100),
                IndicatorParam(key="m1", label="M1 (K smooth)", type="int",
                               default=3, min=2, max=50),
                IndicatorParam(key="m2", label="M2 (D smooth)", type="int",
                               default=3, min=2, max=50),
                IndicatorParam(key="color_k", label="K Color", type="color",
                               default="#f59e0b"),
                IndicatorParam(key="color_d", label="D Color", type="color",
                               default="#3b82f6"),
                IndicatorParam(key="color_j", label="J Color", type="color",
                               default="#ef4444"),
            ],
            default_params={
                "n": 9, "m1": 3, "m2": 3,
                "color_k": "#f59e0b", "color_d": "#3b82f6", "color_j": "#ef4444",
            },
        )
```

**`param_schema` purpose**: The frontend auto-generates a parameter configuration panel from this schema. When users change parameters, the new values come back through `params`.

### Step 11: Register with the System

Open `backend/app/indicator/indicators/__init__.py` and add the import:

```python
from .kdj import KDJIndicator
```

Open `backend/app/indicator/__init__.py` and add to the `_BUILTINS` list:

```python
from .indicators.kdj import KDJIndicator

_BUILTINS = [
    MAIndicator,
    EMAIndicator,
    MACDIndicator,
    RSIIndicator,
    BOLLIndicator,
    ATRIndicator,
    KDJIndicator,  # ← new
]
```

**Done!** After restarting the backend, KDJ will appear in the indicator list and be usable from the frontend.

---

## 7. Four Typical Patterns

### Pattern 1: Rolling Window (MA, BOLL)

**Use case**: Need the last N bars to compute.

**Core idea**: Use `deque(maxlen=N)` for the window, and accumulator variables to avoid re-summing.

```python
class MyWindowIndicator(Indicator):
    name = "MY_WIN"
    output_specs = ["value"]

    def __init__(self, params=None):
        super().__init__(params)
        self._period = int(self.params.get("period", 20))
        self._window: deque[float] = deque(maxlen=self._period)
        self._rolling_sum: float = 0.0

    def _reset_state(self):
        self._window.clear()
        self._rolling_sum = 0.0

    def init(self, bars):
        self._reset_state()
        for bar in bars:
            val = bar.close
            if len(self._window) == self._period:
                self._rolling_sum -= self._window[0]
            self._window.append(val)
            self._rolling_sum += val

            if len(self._window) >= self._period:
                self._append_output("value", bar.time, self._rolling_sum / self._period)
            else:
                self._append_output("value", bar.time, None)
        self._bar_count = len(bars)
        self._initialized = True

    def update_partial(self, bar):
        if len(self._window) < self._period:
            self._preview["value"] = None
            return
        val = bar.close
        preview_sum = self._rolling_sum - self._window[0] + val
        self._preview["value"] = preview_sum / self._period

    def update_closed(self, bar):
        val = bar.close
        if len(self._window) == self._period:
            self._rolling_sum -= self._window[0]
        self._window.append(val)
        self._rolling_sum += val
        self._bar_count += 1
        if len(self._window) >= self._period:
            self._append_output("value", bar.time, self._rolling_sum / self._period)
        else:
            self._append_output("value", bar.time, None)
```

### Pattern 2: Recursive State (EMA)

**Use case**: Current value depends only on the previous value and new input — `V_t = f(V_{t-1}, input_t)`.

**Core idea**: Maintain a state variable, update with a recursive formula each time.

```python
class MyRecursiveIndicator(Indicator):
    name = "MY_REC"
    output_specs = ["value"]

    def __init__(self, params=None):
        super().__init__(params)
        self._period = int(self.params.get("period", 20))
        self._alpha = 2.0 / (self._period + 1)
        self._value: float | None = None
        self._count: int = 0
        self._sum: float = 0.0

    def _reset_state(self):
        self._value = None
        self._count = 0
        self._sum = 0.0

    def init(self, bars):
        self._reset_state()
        for bar in bars:
            val = bar.close
            self._count += 1
            if self._count < self._period:
                self._sum += val
                self._append_output("value", bar.time, None)
            elif self._count == self._period:
                self._sum += val
                self._value = self._sum / self._period  # Initialize with SMA
                self._append_output("value", bar.time, self._value)
            else:
                self._value = self._alpha * val + (1 - self._alpha) * self._value
                self._append_output("value", bar.time, self._value)
        self._bar_count = len(bars)
        self._initialized = True

    def update_partial(self, bar):
        if self._value is None:
            self._preview["value"] = None
            return
        val = bar.close
        self._preview["value"] = self._alpha * val + (1 - self._alpha) * self._value

    def update_closed(self, bar):
        val = bar.close
        self._count += 1
        self._bar_count += 1
        if self._value is None:
            self._sum += val
            if self._count >= self._period:
                self._value = self._sum / self._period
                self._append_output("value", bar.time, self._value)
            else:
                self._append_output("value", bar.time, None)
        else:
            self._value = self._alpha * val + (1 - self._alpha) * self._value
            self._append_output("value", bar.time, self._value)
```

### Pattern 3: Multi-Output (MACD, BOLL, KDJ)

**Use case**: One indicator produces multiple output lines.

**Key differences**:
- `output_specs` lists multiple names
- `init`/`update_closed` call `_append_output` for each output
- `update_partial` sets `self._preview` for each output
- `_get_output_configs` configures colors/types for each output

```python
class MyMultiOutput(Indicator):
    name = "MY_MULTI"
    output_specs = ["upper", "middle", "lower"]  # ← three lines

    def init(self, bars):
        for bar in bars:
            # ... computation ...
            self._append_output("upper", bar.time, upper_val)
            self._append_output("middle", bar.time, mid_val)
            self._append_output("lower", bar.time, lower_val)

    def update_partial(self, bar):
        self._preview["upper"] = ...
        self._preview["middle"] = ...
        self._preview["lower"] = ...

    def _get_output_configs(self):
        return {
            "upper":  {"display_name": "Upper",  "color": "#ef4444", "line_style": 2},
            "middle": {"display_name": "Middle", "color": "#f59e0b"},
            "lower":  {"display_name": "Lower",  "color": "#22c55e", "line_style": 2},
        }
```

### Pattern 4: Multi-Input (ATR)

**Use case**: Need multiple OHLCV fields (not just close).

**Key differences**:
- `input_specs` lists all required fields
- Access `bar.high`, `bar.low`, `bar.close` directly, or use `self._get_field(bar, "field_name")`

```python
class MyMultiInput(Indicator):
    name = "MY_INPUT"
    input_specs = ["high", "low", "close"]  # ← declares multiple fields
    output_specs = ["value"]

    def init(self, bars):
        for bar in bars:
            hl = bar.high - bar.low             # Direct access
            val = self._get_field(bar, "hlc3")  # Or use utility method for derived values
            # ...
```

`_get_field` supported fields:

| Field | Value |
|-------|-------|
| `open` | `bar.open` |
| `high` | `bar.high` |
| `low` | `bar.low` |
| `close` | `bar.close` |
| `volume` | `bar.volume` |
| `hl2` | `(high + low) / 2` |
| `hlc3` | `(high + low + close) / 3` |
| `ohlc4` | `(open + high + low + close) / 4` |
| `hlcc4` | `(high + low + close + close) / 4` |

---

## 8. Registration

### 8.1 Registering Built-in Indicators

1. Create your `.py` file in `indicators/`
2. Import your class in `indicators/__init__.py`
3. Add your class to the `_BUILTINS` list in `indicator/__init__.py`

```python
# indicators/__init__.py
from .kdj import KDJIndicator

# indicator/__init__.py
from .indicators.kdj import KDJIndicator

_BUILTINS = [
    ...,
    KDJIndicator,
]
```

After registration, these automatically work:
- `GET /api/v1/indicators/registry` returns your indicator
- `GET /api/v1/indicators/presets` includes your indicator
- `POST /api/v1/indicators/compute` can compute your indicator

### 8.2 Runtime Dynamic Registration

You can also register without modifying source code, at runtime:

```python
from app.indicator import registry
registry.register(MyCustomIndicator)
```

### 8.3 Checking Registration Status

```python
registry.has("KDJ")        # → True
registry.list_names()      # → ["ATR", "BOLL", "EMA", "KDJ", "MA", "MACD", "RSI"]
registry.get_spec("KDJ")   # → IndicatorSpec(...)
```

---

## 9. Output Configuration & Rendering

### 9.1 `get_meta()` — Global Rendering Metadata

Override `get_meta()` to control the indicator's overall rendering behavior:

```python
def get_meta(self) -> IndicatorMeta:
    return IndicatorMeta(
        name=f"KDJ({self._n})",        # Frontend display name
        category="Oscillator",          # Category
        pane=PaneType.SEPARATE,         # Separate sub-pane
        overlay=False,                  # Don't overlay on price chart
        precision=2,                    # 2 decimal places
        warmup_period=self._n,          # Tell frontend first N points are empty
    )
```

### 9.2 `_get_output_configs()` — Per-Line Rendering Configuration

Override `_get_output_configs()` to control each line's appearance:

```python
def _get_output_configs(self) -> dict[str, dict]:
    return {
        "k": {
            "display_name": "K",              # Legend name
            "color": "#f59e0b",               # Line color
            "line_width": 2,                  # Line width (default 2)
            "line_style": 0,                  # 0=solid, 2=dashed
            "series_type": SeriesType.LINE,   # LINE or HISTOGRAM
            "pane": PaneType.SEPARATE,        # Pane
        },
        "hist": {
            "display_name": "Histogram",
            "color": "#22c55e",
            "series_type": SeriesType.HISTOGRAM,  # Bar chart
            "pane": PaneType.SEPARATE,
        },
    }
```

Available configuration fields:

| Field | Type | Description |
|-------|------|-------------|
| `display_name` | str | Name shown in legend |
| `color` | str | Color (HEX) |
| `line_width` | int | Line width, default 2 |
| `line_style` | int | 0=solid, 1=dotted, 2=dashed, 3=large-dashed, 4=sparse-dotted |
| `series_type` | SeriesType | `LINE` or `HISTOGRAM` |
| `pane` | PaneType | `MAIN` / `SEPARATE` / `VOLUME` |
| `color_data` | list[dict] | Per-bar color data `[{timestamp, color}, ...]` |

### 9.3 Making Colors User-Configurable

Good practice is to expose colors as parameters so users can change them in the frontend:

```python
# Declare color parameter in param schema
IndicatorParam(key="color", label="Color", type="color", default="#f59e0b")

# Read parameter in _get_output_configs
"color": self.params.get("color", "#f59e0b")
```

---

## 10. Script Mode (Quick Experiments)

Besides writing full indicator classes, CandleScope also supports **script mode** — write a Python script snippet to compute an indicator, no registration needed.

### 10.1 Script Environment

The following pre-defined variables are available in scripts:

| Variable | Type | Description |
|----------|------|-------------|
| `open` | `numpy.ndarray` | Open prices |
| `high` | `numpy.ndarray` | High prices |
| `low` | `numpy.ndarray` | Low prices |
| `close` | `numpy.ndarray` | Close prices |
| `volume` | `numpy.ndarray` | Volumes |
| `time` | `list[int]` | Timestamp list (Unix seconds) |
| `params` | `dict` | User-provided parameters |
| `np` | `numpy` | NumPy library |
| `math` | `math` | Python math library |
| `add_line(...)` | function | Output function (see below) |

### 10.2 `add_line()` Function

```python
add_line(
    data,                    # numpy array or list, must match bar count
    color="#f59e0b",         # Color
    title="",                # Legend name
    line_width=2,            # Line width
    line_style=0,            # Line style
    overlay=True,            # True=main chart overlay, False=separate pane
    type="line",             # "line" or "histogram"
    pane=None,               # "main" / "separate" / "volume"
    color_data=None,         # Per-bar colors
)
```

### 10.3 Example Script

```python
# Custom VWAP (Volume Weighted Average Price)
period = params.get("period", 20)
color = params.get("color", "#e91e63")

typical_price = (high + low + close) / 3
vwap = np.full(len(close), np.nan)

for i in range(period - 1, len(close)):
    window_tp = typical_price[i - period + 1 : i + 1]
    window_vol = volume[i - period + 1 : i + 1]
    total_vol = np.sum(window_vol)
    if total_vol > 0:
        vwap[i] = np.sum(window_tp * window_vol) / total_vol

add_line(vwap, color=color, title=f"VWAP({period})")
```

### 10.4 Script Mode vs Engine Mode

| Feature | Script Mode | Engine Mode |
|---------|-------------|-------------|
| Complexity | Low (one script) | High (full class) |
| Incremental updates | ❌ Full recompute every time | ✅ O(1) incremental |
| Real-time preview | ❌ None | ✅ update_partial |
| Instance caching | ❌ None | ✅ Auto-deduplication |
| System registration | ❌ Not needed | ✅ Globally available |
| Best for | Quick prototypes / one-off analysis | Production / long-term use |

---

## 11. API Reference

### 11.1 List All Indicators

```
GET /api/v1/indicators/registry
```

**Response**:

```json
[
  {
    "name": "MA",
    "display_name": "Simple Moving Average",
    "description": "Simple Moving Average",
    "category": "Trend",
    "inputs": ["close"],
    "outputs": ["ma"],
    "params": {"period": 20, "source": "close", "color": "#f59e0b"},
    "paramSchema": [
      {"key": "period", "label": "Period", "type": "int", "default": 20, "min": 1, "max": 500},
      {"key": "source", "label": "Source", "type": "string", "default": "close",
       "options": ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"]},
      {"key": "color", "label": "Color", "type": "color", "default": "#f59e0b"}
    ],
    "is_builtin": true
  }
]
```

### 11.2 Compute Indicator

```
POST /api/v1/indicators/compute
```

**Request body (engine mode)**:

```json
{
  "name": "MACD",
  "params": {"fast": 12, "slow": 26, "signal": 9},
  "symbol": "BTCUSDT",
  "interval": "1m",
  "ohlcv": [
    {"time": 1710000000, "open": 65000, "high": 65100, "low": 64900, "close": 65050, "volume": 100},
    {"time": 1710000060, "open": 65050, "high": 65200, "low": 65000, "close": 65150, "volume": 120}
  ]
}
```

**Request body (script mode)**:

```json
{
  "script": "ma = np.convolve(close, np.ones(20)/20, 'full')[:len(close)]\nadd_line(ma, title='MA20')",
  "params": {},
  "ohlcv": [...]
}
```

**Response**:

```json
{
  "ok": true,
  "error": null,
  "lines": [
    {
      "name": "DIF",
      "color": "#3b82f6",
      "type": "line",
      "pane": "separate",
      "lineWidth": 2,
      "lineStyle": 0,
      "data": [{"time": 1710000000, "value": 123.45}]
    }
  ],
  "result": {
    "indicator_id": "BTCUSDT:1m:MACD:a3f1c8...",
    "name": "MACD",
    "outputs": { ... },
    "meta": { ... }
  }
}
```

- `lines`: Flat list for direct frontend rendering
- `result`: Full structured result (with metadata)

### 11.3 Preset Endpoints

These are frontend "indicator panel" compatible endpoints that internally map to the registry:

```
GET  /api/v1/indicators/presets          → List all presets
GET  /api/v1/indicators/presets/{id}     → Get single preset (with reference script)
```

---

## 12. FAQ & Troubleshooting

### Q: Output data length is wrong / frontend display is misaligned

**Cause**: Missing `_append_output` call in `init` or `update_closed` for some bars.

**Rule**: Every bar must call `_append_output` once for **every** output in `output_specs`, whether the value is `None` or not.

```python
# ❌ Wrong — skips output during warmup
if self._count >= self._period:
    self._append_output("value", bar.time, computed_value)
# Warmup has no append → output array shorter than bar array!

# ✅ Correct — output None during warmup
if self._count >= self._period:
    self._append_output("value", bar.time, computed_value)
else:
    self._append_output("value", bar.time, None)
```

### Q: Data goes haywire after `update_partial`

**Cause**: Internal state was modified in `update_partial`.

```python
# ❌ Wrong
def update_partial(self, bar):
    self._ema = self._alpha * bar.close + (1 - self._alpha) * self._ema  # State polluted!
    self._preview["ema"] = self._ema

# ✅ Correct
def update_partial(self, bar):
    preview = self._alpha * bar.close + (1 - self._alpha) * self._ema  # Temp variable
    self._preview["ema"] = preview
```

### Q: Indicator doesn't appear in registry list

Checklist:
1. Is the class imported in `indicators/__init__.py`?
2. Is the class in the `_BUILTINS` list in `indicator/__init__.py`?
3. Is the `name` class attribute set? (Must not be `"UNKNOWN"`)
4. Any import errors? (Check startup logs)

### Q: Data is wrong after `recompute`

`reset()` clears `_outputs` and `_preview`, and also calls your `_reset_state()`. Make sure `_reset_state()` clears **all** your internal state variables.

```python
def _reset_state(self):
    # Must clear all state variables!
    self._window.clear()
    self._rolling_sum = 0.0
    self._count = 0
    # Missing a variable here → recompute results will drift
```

### Q: Forgot to call `super().__init__()`

**Symptoms**: `self._outputs`, `self._preview` don't exist — various `AttributeError`.

**Fix**: First line of `__init__` must be `super().__init__(params)`.

### Q: `get_spec()` error — not a classmethod

`get_spec()` must be a `@classmethod`, not an instance method. The registry calls it during registration, before any instance exists.

```python
@classmethod
def get_spec(cls) -> IndicatorSpec:
    return IndicatorSpec(name="MY_IND", ...)
```

### Q: How to support indicator chaining (MA on MACD output)?

Use `DependencyGraph` and `build_synthetic_bars` from `dependency.py`:

```python
from app.indicator.dependency import DependencyGraph, build_synthetic_bars

# 1. Compute MACD first
macd_result = engine.compute("BTCUSDT", "1m", "MACD", {...}, bars)

# 2. Build "synthetic bars" from MACD's hist output (put hist values into close field)
synthetic = build_synthetic_bars(bars, macd_result, source_output="hist", target_input="close")

# 3. Compute MA on synthetic bars
ma_of_hist = engine.compute("BTCUSDT", "1m", "MA", {"period": 5}, synthetic)
```

---

## 13. Built-in Indicator Cheat Sheet

| Indicator | Class | Category | Input | Output | Pane | Parameters |
|-----------|-------|----------|-------|--------|------|------------|
| MA | `MAIndicator` | Trend | close | `ma` | Main | `period`(20), `source`(close), `color` |
| EMA | `EMAIndicator` | Trend | close | `ema` | Main | `period`(20), `source`(close), `color` |
| MACD | `MACDIndicator` | Trend | close | `dif`, `dea`, `hist` | Separate | `fast`(12), `slow`(26), `signal`(9), `source`(close) |
| RSI | `RSIIndicator` | Oscillator | close | `rsi` | Separate | `period`(14), `source`(close), `color` |
| BOLL | `BOLLIndicator` | Volatility | close | `middle`, `upper`, `lower` | Main | `period`(20), `mult`(2.0), `source`(close), `color_*`×3 |
| ATR | `ATRIndicator` | Volatility | high, low, close | `atr` | Separate | `period`(14), `color` |

### Computation Patterns per Indicator

| Indicator | Pattern | State Variables | Time Complexity |
|-----------|---------|-----------------|-----------------|
| MA | Rolling window | `deque` + `rolling_sum` | O(1) |
| EMA | Recursive state | `_ema` + `_sum` (for init) | O(1) |
| MACD | Recursive state ×3 | `fast_ema` + `slow_ema` + `signal_ema` | O(1) |
| RSI | Recursive state | `avg_gain` + `avg_loss` + `prev_val` | O(1) |
| BOLL | Rolling window | `deque` + `rolling_sum` + `rolling_sq_sum` | O(1) |
| ATR | Recursive state | `_atr` + `prev_close` | O(1) |

---

## Appendix: Base Class Utility Methods Quick Reference

| Method | Purpose |
|--------|---------|
| `self._get_field(bar, "close")` | Extract a field from BarData (supports derived fields like hl2, hlc3) |
| `self._append_output(name, ts, value)` | Append a data point to a named output series |
| `self._update_last_output(name, ts, value)` | Update the last data point (overwrites if same timestamp) |
| `self.get_latest()` | Get latest committed value for each output |
| `self.get_preview()` | Get current preview values |
| `self.get_series(name, limit)` | Get historical data series |
| `self.build_result(key)` | Package complete IndicatorResult |
| `self.reset()` | Reset all state (triggers `_reset_state()`) |
| `self.is_initialized` | Whether initialized |
| `self.bar_count` | Number of bars processed |
