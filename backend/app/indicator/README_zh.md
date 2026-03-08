# 指标开发指南

> **目标读者**：想要为 CandleScope 编写自定义指标的开发者。  
> **阅读完成后你将能够**：理解指标系统的完整运行逻辑，独立编写、注册并使用一个新指标。

---

## 目录

1. [总览](#1-总览)
2. [架构速览](#2-架构速览)
3. [核心概念](#3-核心概念)
4. [数据类型参考](#4-数据类型参考)
5. [指标生命周期详解](#5-指标生命周期详解)
6. [手把手写一个 KDJ 指标](#6-手把手写一个-kdj-指标)
7. [四种典型模式](#7-四种典型模式)
8. [注册与暴露](#8-注册与暴露)
9. [输出配置与渲染控制](#9-输出配置与渲染控制)
10. [脚本模式（免注册快速实验）](#10-脚本模式免注册快速实验)
11. [API 接口参考](#11-api-接口参考)
12. [常见问题 & 排错](#12-常见问题--排错)
13. [内置指标速查表](#13-内置指标速查表)

---

## 1. 总览

**指标模块**是 CandleScope 的增量计算引擎。它接收 K 线数据（`BarData`），通过注册过的指标类进行计算，输出标准化的 `IndicatorResult`，供前端图表渲染、策略引擎和告警系统使用。

整个系统围绕一个核心循环运转：

```
K 线数据 → 引擎调度 → 指标实例计算 → 标准化输出 → 消费者
```

---

## 2. 架构速览

```
indicator/
├── __init__.py          # 自动注册内置指标 + 导出公共 API
├── types.py             # 所有数据类型定义
├── base.py              # Indicator 抽象基类
├── events.py            # 指标事件（引擎 → 消费者）
├── registry.py          # 注册中心（全局单例: registry）
├── dependency.py         # 依赖图（指标链式组合）
├── engine.py            # IndicatorEngine（调度 + 缓存 + 生命周期）
└── indicators/          # 内置指标实现
    ├── __init__.py
    ├── ma.py            # MA  — 简单移动平均线
    ├── ema.py           # EMA — 指数移动平均线
    ├── macd.py          # MACD — 指数平滑异同移动平均线
    ├── rsi.py           # RSI — 相对强弱指数
    ├── boll.py          # BOLL — 布林带
    └── atr.py           # ATR — 平均真实波幅
```

**职责分工**：

| 文件 | 管什么 |
|------|--------|
| `base.py` | 定义指标的「必须实现什么」和「自带哪些工具方法」 |
| `types.py` | 定义所有数据结构：Key、Meta、Param、Spec、Output、Result 等 |
| `registry.py` | 知道系统中有哪些指标可用（注册 / 查找 / 列表） |
| `engine.py` | 接收 K 线事件，创建/缓存指标实例，调度计算，分发结果 |
| `events.py` | 定义引擎对外发出的事件类型 |
| `dependency.py` | 支持指标接其他指标的输出作为输入（如 MA(MACD.hist, 5)） |

---

## 3. 核心概念

### 3.1 指标是实例，不是函数

`MA(close, 20)` 和 `MA(close, 60)` 是两个独立的对象。每个实例维护自己的滚动状态（窗口、累加器等），互不干扰。

实例通过 `IndicatorKey` 唯一标识：

```python
key = IndicatorKey("BTCUSDT", "1m", "MA", {"period": 20, "source": "close"})
# key.uid → "BTCUSDT:1m:MA:a3f1c8..."
```

**同一个 Key = 同一个实例**。多个订阅者（图表窗口、策略、告警）共享同一个实例的计算结果，不会重复计算。

### 3.2 两阶段更新

每根 K 线有两种状态：**正在形成（未收盘）** 和 **已收盘**。指标用两个方法分别处理：

| 方法 | 触发时机 | 行为 | 结果用途 |
|------|----------|------|----------|
| `update_partial(bar)` | K 线每次 tick 更新 | 计算临时预览值，**不修改内部状态** | 前端实时展示 |
| `update_closed(bar)` | K 线收盘确认 | 计算最终值，**推进内部状态** | 策略/告警/存储 |

为什么要分开？因为一根 K 线在收盘前可能被更新几十上百次。如果每次都推进状态，状态就乱了。分开之后：

- `update_partial` 可以放心调用任意多次，不会污染状态
- `update_closed` 只在收盘时调用一次，干净利落地推进状态

### 3.3 O(1) 增量更新

内置指标维护滚动状态（累加和、EMA 值等），每来一根新 bar 只需要**常数时间**处理。

以 MA(20) 为例：
- 维护一个 `deque(maxlen=20)` 和一个 `rolling_sum`
- 新 bar 来了：`rolling_sum += new_val - oldest_val`，`ma = rolling_sum / 20`
- 不需要每次遍历 20 个值重新求和

### 3.4 实例缓存与去重

引擎内部用一个字典 `{IndicatorKey → Indicator}` 缓存所有活跃实例。

- 第一次请求某个 Key → 创建新实例
- 后续请求相同 Key → 直接复用已有实例
- 引用计数归零 → 自动销毁实例

### 3.5 标准化输出

所有指标的输出都遵循同一格式：

```
IndicatorResult
  └── outputs: dict[str, IndicatorOutput]
       └── data: list[OutputPoint(timestamp, value)]
```

不管你的指标是输出一条线（MA）还是三条线（MACD），格式完全一致。前端可以统一渲染，无需为每种指标写特殊逻辑。

### 3.6 注册中心驱动

所有指标通过 `IndicatorRegistry` 注册。注册时会暴露：

- 指标名称、描述、分类
- 参数 schema（前端自动生成配置表单）
- 输出定义（前端知道要画几条线）

---

## 4. 数据类型参考

### 4.1 `BarData` — K 线数据

这是指标接收到的输入。来自 `app.data_engine.data_manager.models`。

```python
@dataclass
class BarData:
    time: int        # Unix 秒
    open: float
    high: float
    low: float
    close: float
    volume: float
```

### 4.2 `IndicatorKey` — 指标实例的唯一标识

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

- `symbol` 自动转大写
- `params` 被冻结为不可变形式（用于哈希）
- `uid` 是人类可读的唯一 ID

### 4.3 `IndicatorMeta` — 指标元数据

控制指标的渲染位置和行为。

```python
@dataclass
class IndicatorMeta:
    name: str                             # 显示名，如 "MA(20)"
    category: str = ""                    # 分类："Trend" / "Oscillator" / "Volatility"
    description: str = ""                 # 描述文本
    pane: PaneType = PaneType.MAIN        # 主图 or 副图
    overlay: bool = True                  # 是否叠加在价格图上
    precision: int = 8                    # 小数位数
    warmup_period: int = 0                # 预热期（前 N 根 bar 输出 None）
    version: str = "1.0"
```

**`PaneType` 枚举**：

| 值 | 含义 |
|----|------|
| `PaneType.MAIN` | 主图（叠加在 K 线上，如 MA、BOLL） |
| `PaneType.SEPARATE` | 独立副图（如 MACD、RSI） |
| `PaneType.VOLUME` | 成交量面板 |

### 4.4 `IndicatorParam` — 参数 Schema

定义一个参数的类型、范围、默认值，供前端自动生成表单。

```python
@dataclass
class IndicatorParam:
    key: str                    # 参数名，如 "period"
    label: str = ""             # 显示标签，如 "周期"
    type: str = "int"           # 类型："int" / "float" / "color" / "string" / "bool"
    default: Any = None         # 默认值
    min: float | None = None    # 最小值
    max: float | None = None    # 最大值
    step: float | None = None   # 步进
    options: list[str] | None = None  # 下拉选项（用于 select）
```

**示例**：

```python
IndicatorParam(key="period", label="Period", type="int", default=20, min=1, max=500)
IndicatorParam(key="source", label="Source", type="string", default="close",
               options=["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"])
IndicatorParam(key="color", label="Color", type="color", default="#f59e0b")
```

### 4.5 `IndicatorSpec` — 指标完整规格

注册中心存储的就是这个。前端通过 API 获取到的也是这个的 dict 形式。

```python
@dataclass
class IndicatorSpec:
    name: str                                   # 唯一名称，如 "MA"
    display_name: str = ""                      # 显示名，如 "Simple Moving Average"
    description: str = ""                       # 说明文字
    category: str = ""                          # 分类
    input_specs: list[str] = ["close"]          # 需要的输入字段
    output_specs: list[str] = ["value"]         # 输出系列名列表
    param_schema: list[IndicatorParam] = []     # 参数 schema
    default_params: dict = {}                   # 默认参数值
    meta: IndicatorMeta | None = None           # 可选的元数据
    is_builtin: bool = True                     # 是否内置
```

### 4.6 `OutputPoint` — 输出数据点

```python
@dataclass
class OutputPoint:
    timestamp: int        # Unix 秒
    value: float | None   # 指标值（预热期为 None）
```

### 4.7 `IndicatorOutput` — 一条输出线

```python
@dataclass
class IndicatorOutput:
    name: str                                    # 内部名，如 "ma", "dif"
    display_name: str = ""                       # 显示名，如 "MA(20)"
    series_type: SeriesType = SeriesType.LINE    # 线型：LINE 或 HISTOGRAM
    pane: PaneType = PaneType.MAIN               # 渲染面板
    color: str = "#f59e0b"                       # 颜色
    line_width: int = 2                          # 线宽
    line_style: int = 0                          # 0=实线, 1=点线, 2=虚线, 3=长虚线, 4=稀疏点线
    data: list[OutputPoint] = []                 # 数据点
    color_data: list[dict] | None = None         # 逐柱颜色（柱状图用）
```

**`SeriesType` 枚举**：

| 值 | 含义 |
|----|------|
| `SeriesType.LINE` | 折线 |
| `SeriesType.HISTOGRAM` | 柱状图 |

### 4.8 `IndicatorResult` — 完整结果信封

引擎最终返回给消费者的就是这个。

```python
@dataclass
class IndicatorResult:
    key: IndicatorKey
    meta: IndicatorMeta
    outputs: dict[str, IndicatorOutput] = {}     # 名称 → 输出线
    error: str | None = None                     # 错误信息

    def to_dict(self) -> dict: ...               # JSON 序列化
    def lines(self) -> list[dict]: ...           # 扁平列表（前端直接渲染用）
    def get_latest(self) -> dict: ...            # 最新值
```

---

## 5. 指标生命周期详解

### 5.1 完整流程

```
                       ┌─────────────────────────────────────────┐
                       │            IndicatorEngine              │
                       ├─────────────────────────────────────────┤
                       │                                         │
  用户请求 compute()   │  1. 构造 IndicatorKey                   │
  ─────────────────►   │  2. 从 registry 获取指标类              │
                       │  3. 创建实例 cls(params=...)            │
                       │  4. 调用 instance.recompute(bars)       │
                       │     └─► reset() + init(bars)            │
                       │  5. 调用 instance.build_result(key)     │
                       │  6. 返回 IndicatorResult                │
                       │                                         │
  BAR_CLOSED 事件      │  找到所有订阅此 (symbol,interval) 的实例 │
  ─────────────────►   │  └─► instance.update_closed(bar)        │
                       │      └─► 发出 INDICATOR_UPDATED 事件    │
                       │                                         │
  BAR_UPDATED 事件     │  找到所有订阅此 (symbol,interval) 的实例 │
  ─────────────────►   │  └─► instance.update_partial(bar)       │
                       │      └─► 发出 INDICATOR_PREVIEW 事件    │
                       │                                         │
  BACKFILL 事件        │  找到所有订阅此 (symbol,interval) 的实例 │
  ─────────────────►   │  └─► instance.recompute(bars)           │
                       │      └─► 发出 INDICATOR_RECOMPUTED 事件 │
                       └─────────────────────────────────────────┘
```

### 5.2 四个生命周期方法的详细说明

#### `init(bars: list[BarData]) -> None`

**调用时机**：实例首次拿到历史数据时。

**你需要做什么**：
1. 重置内部状态（调用 `_reset_state()`）
2. 遍历所有历史 bar，逐个处理
3. 对每个 bar，调用 `self._append_output("输出名", bar.time, value)` 添加结果
4. 预热期内（数据不够算的时候）输出 `None`
5. 设置 `self._bar_count = len(bars)` 和 `self._initialized = True`

```python
def init(self, bars: list[BarData]) -> None:
    self._reset_state()
    for bar in bars:
        val = self._get_field(bar, self._source)
        # ... 计算逻辑 ...
        self._append_output("ma", bar.time, result_or_none)
    self._bar_count = len(bars)
    self._initialized = True
```

#### `update_partial(bar: BarData) -> None`

**调用时机**：当前 K 线每次 tick 更新时（一根 K 线内会被调用很多次）。

**你需要做什么**：
1. 用当前内部状态 + 新 bar 的值，计算出一个**临时预览值**
2. 把结果写入 `self._preview["输出名"]`
3. ⚠️ **绝对不要修改任何内部状态变量**（不要改 `self._ema`、`self._window` 等）

```python
def update_partial(self, bar: BarData) -> None:
    if self._ema is None:
        self._preview["ema"] = None
        return
    val = self._get_field(bar, self._source)
    # 只读 self._ema，不写！
    self._preview["ema"] = self._alpha * val + (1 - self._alpha) * self._ema
```

**关键原则**：`update_partial` 是一个「只读」操作。它可以读取内部状态来计算预览值，但**在方法返回后，指标实例的状态必须和调用前完全一样**。

#### `update_closed(bar: BarData) -> None`

**调用时机**：K 线确认收盘时（每根 K 线只调用一次）。

**你需要做什么**：
1. 用新 bar 的值更新内部状态（窗口、累加器、EMA 等）
2. 计算新的最终值
3. 调用 `self._append_output("输出名", bar.time, value)` 添加结果
4. 递增 `self._bar_count += 1`

```python
def update_closed(self, bar: BarData) -> None:
    val = self._get_field(bar, self._source)
    # 推进状态
    if len(self._window) == self._period:
        self._rolling_sum -= self._window[0]
    self._window.append(val)
    self._rolling_sum += val
    self._bar_count += 1
    # 输出
    if len(self._window) >= self._period:
        self._append_output("ma", bar.time, self._rolling_sum / self._period)
    else:
        self._append_output("ma", bar.time, None)
```

#### `recompute(bars: list[BarData]) -> None`（可选覆写）

**调用时机**：历史数据被修正或回补时。

**默认行为**：`reset()` + `init(bars)`，通常不需要覆写。

只有在重算成本极高、你能做增量修正时才考虑覆写。

### 5.3 预热期（Warmup Period）

大多数指标在前 N 根 K 线时数据不足，无法计算出有意义的值。这段时间叫做预热期。

**规则**：预热期内必须输出 `None`，不能输出 0 或者随便一个值。

**示例**：MA(20) 需要 20 根 bar 才能算出第一个值，所以前 19 根 bar 输出 `None`：

```python
if len(self._window) >= self._period:
    self._append_output("ma", bar.time, self._rolling_sum / self._period)
else:
    self._append_output("ma", bar.time, None)  # 预热期
```

---

## 6. 手把手写一个 KDJ 指标

我们从零开始写一个 KDJ（随机指标），涵盖你会遇到的所有关键步骤。

KDJ 的算法：
1. `RSV = (close - lowest_low_N) / (highest_high_N - lowest_low_N) × 100`
2. `K = α × RSV + (1 - α) × K_prev`（α 通常取 1/3）
3. `D = α × K + (1 - α) × D_prev`
4. `J = 3K - 2D`

### 第 1 步：创建文件

在 `backend/app/indicator/indicators/` 下创建 `kdj.py`：

```python
# -*- coding: utf-8 -*-
"""
KDJ -- 随机指标。

多输出 + 滚动窗口 + 递归状态的组合模式。
"""
from __future__ import annotations

from collections import deque
from typing import Any

from app.data_engine.data_manager.models import BarData

from ..base import Indicator
from ..types import IndicatorMeta, IndicatorParam, IndicatorSpec, PaneType
```

### 第 2 步：定义类和类级元数据

```python
class KDJIndicator(Indicator):
    # ── 类级元数据（必须设置） ────────────────────────
    name = "KDJ"                            # 指标唯一名称（大写）
    version = "1.0"
    input_specs = ["high", "low", "close"]  # 需要的输入字段
    output_specs = ["k", "d", "j"]          # 输出系列名
    warmup_period = 9                       # 会在 __init__ 中被动态覆盖
```

- `name`：注册中心用这个名字查找你的指标。大小写不敏感，但推荐用大写。
- `input_specs`：声明你需要 BarData 的哪些字段。这主要是文档作用。
- `output_specs`：**非常重要**。每个名称都会在 `self._outputs` 中创建一个空列表。你后续 `_append_output` 时必须用这些名称。

### 第 3 步：`__init__` — 初始化参数和内部状态

```python
    def __init__(self, params: dict[str, Any] | None = None) -> None:
        super().__init__(params)  # ⚠️ 必须调用 super().__init__

        # 从 params 读取用户配置
        self._n: int = int(self.params.get("n", 9))         # RSV 周期
        self._m1: int = int(self.params.get("m1", 3))       # K 平滑周期
        self._m2: int = int(self.params.get("m2", 3))       # D 平滑周期

        # 动态设置预热期
        self.warmup_period = self._n

        # 内部计算状态
        self._high_window: deque[float] = deque(maxlen=self._n)
        self._low_window: deque[float] = deque(maxlen=self._n)
        self._k: float = 50.0    # K 的初始值
        self._d: float = 50.0    # D 的初始值
        self._count: int = 0
```

**注意事项**：
- 必须调用 `super().__init__(params)`。基类会初始化 `self.params`、`self._outputs`、`self._preview` 等。
- 用 `self.params.get(...)` 读取参数，提供合理的默认值。
- 所有内部状态变量都在这里声明。

### 第 4 步：`_reset_state` — 可选但强烈推荐

```python
    def _reset_state(self) -> None:
        """重置自定义的内部状态。被 reset() 自动调用。"""
        self._high_window.clear()
        self._low_window.clear()
        self._k = 50.0
        self._d = 50.0
        self._count = 0
```

基类的 `reset()` 会自动调用 `_reset_state()`（如果你定义了的话）。它已经帮你清空了 `_outputs` 和 `_preview`，你只需要清理自己的私有变量。

### 第 5 步：`init(bars)` — 历史全量计算

```python
    def init(self, bars: list[BarData]) -> None:
        self._reset_state()

        for bar in bars:
            self._high_window.append(bar.high)
            self._low_window.append(bar.low)
            self._count += 1

            if self._count < self._n:
                # 预热期：数据不够，输出 None
                self._append_output("k", bar.time, None)
                self._append_output("d", bar.time, None)
                self._append_output("j", bar.time, None)
            else:
                # 计算 RSV
                highest = max(self._high_window)
                lowest = min(self._low_window)
                if highest == lowest:
                    rsv = 50.0
                else:
                    rsv = (bar.close - lowest) / (highest - lowest) * 100

                # 平滑递推
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

**关键规则**：
- 每个 bar 必须为**每个**输出调用 `_append_output`。漏了的话，输出长度就对不上了。
- 预热期输出 `None`。
- 最后设置 `_bar_count` 和 `_initialized = True`。

### 第 6 步：`update_partial(bar)` — 预览值（只读！）

```python
    def update_partial(self, bar: BarData) -> None:
        if self._count < self._n:
            self._preview.update({"k": None, "d": None, "j": None})
            return

        # 模拟加入新 bar 后的窗口最高/最低（不真正修改 window）
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
        k_preview = alpha1 * rsv + (1 - alpha1) * self._k  # 读 self._k，不写！
        d_preview = alpha2 * k_preview + (1 - alpha2) * self._d  # 读 self._d，不写！
        j_preview = 3 * k_preview - 2 * d_preview

        self._preview["k"] = k_preview
        self._preview["d"] = d_preview
        self._preview["j"] = j_preview
```

⚠️ 注意这里创建了 `temp_highs` / `temp_lows` 的**副本**，而不是直接修改 `self._high_window`。这就是「只读」的含义。

### 第 7 步：`update_closed(bar)` — 收盘确认

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
            self._k = alpha1 * rsv + (1 - alpha1) * self._k  # 写 self._k ✓
            self._d = alpha2 * self._k + (1 - alpha2) * self._d  # 写 self._d ✓
            j = 3 * self._k - 2 * self._d

            self._append_output("k", bar.time, self._k)
            self._append_output("d", bar.time, self._d)
            self._append_output("j", bar.time, j)
```

对比 `update_partial`：这里**直接修改** `self._k` 和 `self._d`，因为收盘值是确认的。

### 第 8 步：`get_meta()` — 元数据

```python
    def get_meta(self) -> IndicatorMeta:
        return IndicatorMeta(
            name=f"KDJ({self._n},{self._m1},{self._m2})",
            category="Oscillator",
            description=f"KDJ Stochastic ({self._n},{self._m1},{self._m2})",
            pane=PaneType.SEPARATE,    # 副图显示
            overlay=False,
            precision=2,
            warmup_period=self._n,
        )
```

### 第 9 步：`_get_output_configs()` — 渲染配置

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

### 第 10 步：`get_spec()` — 注册规格

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

**`param_schema` 的作用**：前端会根据这个 schema 自动生成参数配置面板。用户修改参数后，新值通过 `params` 传回来。

### 第 11 步：注册到系统

打开 `backend/app/indicator/indicators/__init__.py`，添加导入：

```python
from .kdj import KDJIndicator
```

打开 `backend/app/indicator/__init__.py`，在 `_BUILTINS` 列表中添加：

```python
from .indicators.kdj import KDJIndicator

_BUILTINS = [
    MAIndicator,
    EMAIndicator,
    MACDIndicator,
    RSIIndicator,
    BOLLIndicator,
    ATRIndicator,
    KDJIndicator,  # ← 新增
]
```

**完成！** 重启后端服务后，KDJ 将出现在指标列表中，可以在前端直接使用。

---

## 7. 四种典型模式

### 模式 1：滚动窗口（MA、BOLL）

**适用场景**：需要最近 N 根 bar 的数据来计算。

**核心思路**：用 `deque(maxlen=N)` 维护窗口，用累加变量避免重复求和。

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

### 模式 2：递归状态（EMA）

**适用场景**：当前值只依赖上一个值和新输入 ——  `V_t = f(V_{t-1}, input_t)`。

**核心思路**：维护一个状态变量，每次用递推公式更新。

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
                self._value = self._sum / self._period  # 用 SMA 初始化
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

### 模式 3：多输出（MACD、BOLL、KDJ）

**适用场景**：一个指标产出多条线。

**核心差异**：
- `output_specs` 列多个名称
- `init`/`update_closed` 中为每个输出都调用 `_append_output`
- `update_partial` 中为每个输出都设置 `self._preview`
- `_get_output_configs` 为每个输出配置颜色/类型

```python
class MyMultiOutput(Indicator):
    name = "MY_MULTI"
    output_specs = ["upper", "middle", "lower"]  # ← 三条线

    def init(self, bars):
        for bar in bars:
            # ... 计算 ...
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

### 模式 4：多输入（ATR）

**适用场景**：需要 OHLCV 中多个字段（不只是 close）。

**核心差异**：
- `input_specs` 列出所有需要的字段
- 直接从 `bar.high`、`bar.low`、`bar.close` 取值，或使用 `self._get_field(bar, "字段名")`

```python
class MyMultiInput(Indicator):
    name = "MY_INPUT"
    input_specs = ["high", "low", "close"]  # ← 声明需要多个字段
    output_specs = ["value"]

    def init(self, bars):
        for bar in bars:
            hl = bar.high - bar.low             # 直接访问
            val = self._get_field(bar, "hlc3")  # 或者用工具方法取派生值
            # ...
```

`_get_field` 支持的字段：

| 字段名 | 值 |
|--------|-----|
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

## 8. 注册与暴露

### 8.1 注册内置指标

1. 在 `indicators/` 下创建你的 `.py` 文件
2. 在 `indicators/__init__.py` 中导入你的类
3. 在 `indicator/__init__.py` 中把类加入 `_BUILTINS` 列表

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

注册后自动生效：
- `GET /api/v1/indicators/registry` 会返回你的指标
- `GET /api/v1/indicators/presets` 会包含你的指标
- `POST /api/v1/indicators/compute` 可以计算你的指标

### 8.2 运行时动态注册

也可以不修改源码，在运行时注册：

```python
from app.indicator import registry
registry.register(MyCustomIndicator)
```

### 8.3 检查注册状态

```python
registry.has("KDJ")        # → True
registry.list_names()      # → ["ATR", "BOLL", "EMA", "KDJ", "MA", "MACD", "RSI"]
registry.get_spec("KDJ")   # → IndicatorSpec(...)
```

---

## 9. 输出配置与渲染控制

### 9.1 `get_meta()` — 全局渲染元数据

覆写 `get_meta()` 来控制指标的整体渲染行为：

```python
def get_meta(self) -> IndicatorMeta:
    return IndicatorMeta(
        name=f"KDJ({self._n})",        # 前端显示的名字
        category="Oscillator",          # 分类
        pane=PaneType.SEPARATE,         # 独立副图（不叠加在K线上）
        overlay=False,                  # 不覆盖价格图
        precision=2,                    # 输出值保留 2 位小数
        warmup_period=self._n,          # 告诉前端前 N 个点是空的
    )
```

### 9.2 `_get_output_configs()` — 逐线渲染配置

覆写 `_get_output_configs()` 来控制每条线的外观：

```python
def _get_output_configs(self) -> dict[str, dict]:
    return {
        "k": {
            "display_name": "K",              # 图例名
            "color": "#f59e0b",               # 线的颜色
            "line_width": 2,                  # 线宽（默认 2）
            "line_style": 0,                  # 0=实线, 2=虚线
            "series_type": SeriesType.LINE,   # LINE 或 HISTOGRAM
            "pane": PaneType.SEPARATE,        # 面板
        },
        "hist": {
            "display_name": "Histogram",
            "color": "#22c55e",
            "series_type": SeriesType.HISTOGRAM,  # 柱状图
            "pane": PaneType.SEPARATE,
        },
    }
```

可配置的字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `display_name` | str | 图例上显示的名称 |
| `color` | str | 颜色（HEX） |
| `line_width` | int | 线宽，默认 2 |
| `line_style` | int | 0=实线, 1=点线, 2=虚线, 3=长虚线, 4=稀疏点线 |
| `series_type` | SeriesType | `LINE` 或 `HISTOGRAM` |
| `pane` | PaneType | `MAIN` / `SEPARATE` / `VOLUME` |
| `color_data` | list[dict] | 逐柱颜色数据 `[{timestamp, color}, ...]` |

### 9.3 让颜色可由用户配置

好的做法是把颜色作为参数，让用户可以在前端修改：

```python
# 参数 schema 中声明颜色参数
IndicatorParam(key="color", label="Color", type="color", default="#f59e0b")

# _get_output_configs 中读取参数
"color": self.params.get("color", "#f59e0b")
```

---

## 10. 脚本模式（免注册快速实验）

除了编写完整的指标类，CandleScope 还支持**脚本模式** — 直接写一段 Python 脚本来计算指标，无需注册。

### 10.1 脚本环境

脚本中可以使用以下预定义变量：

| 变量 | 类型 | 说明 |
|------|------|------|
| `open` | `numpy.ndarray` | 开盘价数组 |
| `high` | `numpy.ndarray` | 最高价数组 |
| `low` | `numpy.ndarray` | 最低价数组 |
| `close` | `numpy.ndarray` | 收盘价数组 |
| `volume` | `numpy.ndarray` | 成交量数组 |
| `time` | `list[int]` | 时间戳列表（Unix 秒） |
| `params` | `dict` | 用户传入的参数 |
| `np` | `numpy` | NumPy 库 |
| `math` | `math` | Python math 库 |
| `add_line(...)` | function | 输出函数（见下方） |

### 10.2 `add_line()` 函数

```python
add_line(
    data,                    # numpy 数组或 list，长度必须与 K 线数据一致
    color="#f59e0b",         # 颜色
    title="",                # 图例名称
    line_width=2,            # 线宽
    line_style=0,            # 线型
    overlay=True,            # True=主图叠加, False=副图
    type="line",             # "line" 或 "histogram"
    pane=None,               # "main" / "separate" / "volume"
    color_data=None,         # 逐柱颜色
)
```

### 10.3 示例脚本

```python
# 自定义 VWAP（成交量加权平均价）
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

### 10.4 脚本模式 vs 引擎模式

| 特性 | 脚本模式 | 引擎模式 |
|------|----------|----------|
| 编写复杂度 | 低（一段脚本） | 高（完整类） |
| 增量更新 | ❌ 每次全量计算 | ✅ O(1) 增量 |
| 实时预览 | ❌ 无 | ✅ update_partial |
| 实例缓存 | ❌ 无 | ✅ 自动去重 |
| 注册到系统 | ❌ 不需要 | ✅ 全局可用 |
| 适用场景 | 快速原型/一次性分析 | 生产环境/长期使用 |

---

## 11. API 接口参考

### 11.1 列出所有指标

```
GET /api/v1/indicators/registry
```

**响应**：

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

### 11.2 计算指标

```
POST /api/v1/indicators/compute
```

**请求体（引擎模式）**：

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

**请求体（脚本模式）**：

```json
{
  "script": "ma = np.convolve(close, np.ones(20)/20, 'full')[:len(close)]\nadd_line(ma, title='MA20')",
  "params": {},
  "ohlcv": [...]
}
```

**响应**：

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

- `lines`：扁平列表，前端直接用来渲染
- `result`：完整的结构化结果（含元数据）

### 11.3 Preset 端点

这些是为前端「指标面板」兼容的端点，底层映射到注册中心：

```
GET  /api/v1/indicators/presets          → 列出所有预设
GET  /api/v1/indicators/presets/{id}     → 获取单个预设（含参考脚本）
```

---

## 12. 常见问题 & 排错

### Q: 输出数据长度不对 / 前端显示错位

**原因**：`init` 或 `update_closed` 中漏掉了某个 bar 的 `_append_output` 调用。

**规则**：每个 bar 必须为**每个** `output_specs` 中的输出调用一次 `_append_output`，不管值是 `None` 还是有值。

```python
# ❌ 错误 — 预热期跳过了输出
if self._count >= self._period:
    self._append_output("value", bar.time, computed_value)
# 预热期没有 append → 输出数组比 bar 数组短！

# ✅ 正确 — 预热期也输出 None
if self._count >= self._period:
    self._append_output("value", bar.time, computed_value)
else:
    self._append_output("value", bar.time, None)
```

### Q: `update_partial` 后数据变乱了

**原因**：在 `update_partial` 中修改了内部状态。

```python
# ❌ 错误
def update_partial(self, bar):
    self._ema = self._alpha * bar.close + (1 - self._alpha) * self._ema  # 污染了状态！
    self._preview["ema"] = self._ema

# ✅ 正确
def update_partial(self, bar):
    preview = self._alpha * bar.close + (1 - self._alpha) * self._ema  # 临时变量
    self._preview["ema"] = preview
```

### Q: 指标没有出现在 registry 列表里

检查清单：
1. 类名是否在 `indicators/__init__.py` 中导入？
2. 类是否在 `indicator/__init__.py` 的 `_BUILTINS` 列表中？
3. `name` 类属性是否设置了？（不能是 `"UNKNOWN"`）
4. 导入链有没有报错？（检查启动日志）

### Q: `recompute` 后数据不对

`reset()` 会清空 `_outputs` 和 `_preview`，还会调用你的 `_reset_state()`。确保 `_reset_state()` 清除了你的**所有**内部状态变量。

```python
def _reset_state(self):
    # 必须清除所有状态变量！
    self._window.clear()
    self._rolling_sum = 0.0
    self._count = 0
    # 如果漏了某个变量，recompute 的结果就会偏
```

### Q: 忘了调用 `super().__init__()`

**症状**：`self._outputs`、`self._preview` 不存在，各种 `AttributeError`。

**解决**：`__init__` 第一行必须是 `super().__init__(params)`。

### Q: `get_spec()` 报错 — 不是 classmethod

`get_spec()` 必须是 `@classmethod`，不是普通方法。因为注册中心在注册时就会调用它，此时还没有实例。

```python
@classmethod
def get_spec(cls) -> IndicatorSpec:
    return IndicatorSpec(name="MY_IND", ...)
```

### Q: 如何支持指标链（MA 套 MACD 的输出）？

使用 `dependency.py` 中的 `DependencyGraph` 和 `build_synthetic_bars`：

```python
from app.indicator.dependency import DependencyGraph, build_synthetic_bars

# 1. 先计算 MACD
macd_result = engine.compute("BTCUSDT", "1m", "MACD", {...}, bars)

# 2. 用 MACD 的 hist 输出构造 "合成 bar"（把 hist 值塞到 close 字段）
synthetic = build_synthetic_bars(bars, macd_result, source_output="hist", target_input="close")

# 3. 在合成 bar 上计算 MA
ma_of_hist = engine.compute("BTCUSDT", "1m", "MA", {"period": 5}, synthetic)
```

---

## 13. 内置指标速查表

| 指标 | 类名 | 分类 | 输入 | 输出 | 面板 | 参数 |
|------|------|------|------|------|------|------|
| MA | `MAIndicator` | Trend | close | `ma` | 主图 | `period`(20), `source`(close), `color` |
| EMA | `EMAIndicator` | Trend | close | `ema` | 主图 | `period`(20), `source`(close), `color` |
| MACD | `MACDIndicator` | Trend | close | `dif`, `dea`, `hist` | 副图 | `fast`(12), `slow`(26), `signal`(9), `source`(close) |
| RSI | `RSIIndicator` | Oscillator | close | `rsi` | 副图 | `period`(14), `source`(close), `color` |
| BOLL | `BOLLIndicator` | Volatility | close | `middle`, `upper`, `lower` | 主图 | `period`(20), `mult`(2.0), `source`(close), `color_*`×3 |
| ATR | `ATRIndicator` | Volatility | high, low, close | `atr` | 副图 | `period`(14), `color` |

### 每个指标的计算模式

| 指标 | 模式 | 状态变量 | 时间复杂度 |
|------|------|----------|-----------|
| MA | 滚动窗口 | `deque` + `rolling_sum` | O(1) |
| EMA | 递归状态 | `_ema` + `_sum`(初始化用) | O(1) |
| MACD | 递归状态×3 | `fast_ema` + `slow_ema` + `signal_ema` | O(1) |
| RSI | 递归状态 | `avg_gain` + `avg_loss` + `prev_val` | O(1) |
| BOLL | 滚动窗口 | `deque` + `rolling_sum` + `rolling_sq_sum` | O(1) |
| ATR | 递归状态 | `_atr` + `prev_close` | O(1) |

---

## 附录：基类提供的工具方法速查

| 方法 | 用途 |
|------|------|
| `self._get_field(bar, "close")` | 从 BarData 提取字段值（支持派生字段如 hl2, hlc3） |
| `self._append_output(name, ts, value)` | 向指定输出追加一个数据点 |
| `self._update_last_output(name, ts, value)` | 更新最后一个数据点（同时间戳则覆盖） |
| `self.get_latest()` | 获取每个输出的最新 committed 值 |
| `self.get_preview()` | 获取每个输出的预览值 |
| `self.get_series(name, limit)` | 获取历史数据序列 |
| `self.build_result(key)` | 打包完整的 IndicatorResult |
| `self.reset()` | 重置所有状态（会触发 `_reset_state()`） |
| `self.is_initialized` | 是否已初始化 |
| `self.bar_count` | 已处理的 bar 数量 |
