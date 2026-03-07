# Bar Aggregator（K线聚合器）

[![English](https://img.shields.io/badge/Language-English-blue)](README.md) [![简体中文](https://img.shields.io/badge/语言-简体中文-red)](#)


> 从异构市场数据流构建 OHLCV 蜡烛图，采用分层、可扩展架构。

## 架构总览

```
MarketEvent / FetchedBar / 自定义数据
        │
        ▼
┌─ L1: EventRouter（事件路由）──────────────┐
│   规范化 → BarInput                        │
│   按 (symbol, target_interval) 分发        │
└───────────────┬────────────────────────────┘
                │  BarInput
                ▼
┌─ L2: TimeBucketEngine（时间桶引擎）────────┐
│   compute_bucket(时间戳) → 桶起始时间       │
│   对齐模式: epoch / midnight / custom       │
└───────────────┬────────────────────────────┘
                │  bucket_start_ms
                ▼
┌─ L3: BarStateEngine（K线状态引擎）─────────┐
│   apply(symbol, bucket, input) → BarState  │
│   合并策略: 标准OHLCV / Heikin-Ashi / …    │
└───────────────┬────────────────────────────┘
                │  BarState + BarStateChange
                ▼
┌─ L4: Finalizer（封口器）──────────────────┐
│   策略链评估                               │
│   source_close → composite → event → time  │
└───────────────┬────────────────────────────┘
                │  BarEvent（如果需要封口）
                ▼
┌─ L5: Publisher（发布器）──────────────────┐
│   发布(CREATED / UPDATED / CLOSED / ...)  │
│   → 回调函数 + 异步迭代器                  │
└───────────────────────────────────────────┘
```

## 快速开始

```python
from app.data_engine.bar_aggregator import BarAggregator

agg = BarAggregator()
agg.add_target("BTCUSDT", "1m")
agg.add_target("BTCUSDT", "5m")
agg.add_target("BTCUSDT", "91m")  # 自定义周期

# 订阅已封口的K线
agg.publisher.on_bar_closed(save_to_database)

# 启动后台超时检查器
await agg.start()

# 从 ingestion 接收实时数据
await agg.on_market_event(market_event)

# 从 backfill 接收历史数据
await agg.on_backfill_bars("BTCUSDT", "1m", historical_bars)
```

## 各层详解

### L1: EventRouter — 事件路由器 (`router.py`)

**职责**：接收来自不同数据源的原始事件，统一转换为 `BarInput`，然后分发到所有匹配的聚合管道。

- 接收 `MarketEvent`（来自 ingestion 实时推送）
- 接收 `FetchedBar`（来自 backfill 历史回填）
- 接收自定义数据（通过注册的 `BarInputAdapter`）
- 一条数据可同时分发到多个目标周期（如 1m → 1m, 5m, 91m）

**扩展点**：注册自定义适配器

```python
class MyExchangeAdapter:
    def adapt(self, raw_data):
        return BarInput(symbol=..., open=..., ...)

router.register_adapter("my_exchange", MyExchangeAdapter())
```

### L2: TimeBucketEngine — 时间桶引擎 (`time_bucket.py`)

**职责**：纯计算层，给定时间戳和目标周期，计算它属于哪个时间桶。

- **无状态、纯函数** — 无副作用，易于测试
- 支持对齐模式：
  - `epoch` — 对齐到 Unix 纪元 0（默认）
  - `midnight` — 对齐到 UTC 午夜
  - `custom` — 用户自定义锚点
- 支持自定义周期：91m、7h 等任意时间周期

**扩展点**：替换整个桶计算逻辑

```python
class SessionBucket:
    def compute_bucket(self, open_time_ms):
        # 按交易时段对齐
        ...
    def compute_bucket_range(self, bucket_start_ms):
        ...

engine = TimeBucketEngine(interval_ms=..., custom_calculator=SessionBucket())
```

### L3: BarStateEngine — K线状态引擎 (`bar_state.py`)

**职责**：维护每个时间桶的 OHLCV 累积状态。

- 默认合并规则：`O=第一个Open, H=最大High, L=最小Low, C=最后Close, V=累加Volume`
- 管理活跃（FORMING）K线和已封口（CLOSED）K线
- 自动驱逐过旧的K线，防止内存无限增长
- `max_active_bars` / `max_closed_bars_in_memory` 可配置

**扩展点**：自定义合并策略

```python
class HeikinAshiMerge:
    def apply(self, state, bar_input, is_new):
        # Heikin-Ashi 计算逻辑
        return state

pipeline = agg.get_pipeline("91m")
pipeline.bar_state.set_merge_strategy(HeikinAshiMerge())
```

### L4: Finalizer — 封口器 (`finalizer.py`)

**职责**：判断一个正在形成的K线是否应该被封口（FORMING → CLOSED）。

采用 **策略链模式**，按优先级依次评估，第一个返回 True 的策略触发封口：

| 策略 | 说明 | 适用场景 |
|---|---|---|
| `BatchFinalizer` | 立即封口 | backfill 数据 |
| `SourceCloseFinalizer` | 交易所 `is_closed=True`（x=true） | 标准周期实时 |
| `CompositeCloseFinalizer` | 最后一个组件K线封口 | 自定义周期 |
| `EventDrivenFinalizer` | 下一个桶的数据到达 | 通用回退 |
| `TimeBasedFinalizer` | 超时安全兜底 | 所有场景 |

**扩展点**：自定义封口策略

```python
class TickCountFinalizer:
    def __init__(self, max_ticks=100):
        self.max_ticks = max_ticks
    def should_close(self, state, trigger):
        return state.tick_count >= self.max_ticks

finalizer = agg.get_finalizer("1m")
finalizer.add_strategy("tick_count", TickCountFinalizer(50), priority=0)
```

### L5: Publisher — 发布器 (`publisher.py`)

**职责**：将K线生命周期事件广播给下游消费者。

**事件类型**：

| 事件 | 说明 |
|---|---|
| `CREATED` | 新K线开始形成 |
| `UPDATED` | K线 OHLCV 更新（可节流） |
| `CLOSED` | K线封口完成（**最重要！**） |
| `AMENDED` | 历史K线被修正（backfill 覆盖） |
| `EXPIRED` | K线从内存中驱逐 |

**消费模式**：

```python
# 回调模式
agg.publisher.on_bar_closed(save_bar)
agg.publisher.on_bar_updated(push_to_ws)

# 异步迭代器模式（支持过滤）
async for event in agg.publisher.subscribe(
    filter=BarEventFilter(
        symbols={"BTCUSDT"},
        event_types={BarEventType.CLOSED},
    )
):
    process(event)
```

## 扩展点总结

| 扩展能力 | 协议/接口 | 注册位置 |
|---|---|---|
| 自定义数据源 | `BarInputAdapter` | `router.register_adapter()` |
| 自定义桶计算 | `BucketCalculator` | `TimeBucketEngine(custom_calculator=...)` |
| 自定义合并逻辑 | `BarMergeStrategy` | `bar_state.set_merge_strategy()` |
| 自定义封口逻辑 | `FinalizerStrategy` | `finalizer.add_strategy()` |

## 配置参数

所有参数在 `BarAggregatorConfig` 中定义，有合理默认值。
可通过构造函数参数或环境变量（前缀 `BAR_AGG_`）覆盖：

| 参数 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `bar_source_mode` | `BAR_AGG_SOURCE_MODE` | `"kline"` | 数据源模式 |
| `default_alignment_mode` | `BAR_AGG_ALIGNMENT_MODE` | `"epoch"` | 桶对齐方式 |
| `max_active_bars` | `BAR_AGG_MAX_ACTIVE_BARS` | `3` | 每 key 最大活跃K线数 |
| `max_closed_bars_in_memory` | `BAR_AGG_MAX_CLOSED_BARS` | `500` | 已封口K线缓存 |
| `use_source_close_signal` | `BAR_AGG_USE_SOURCE_CLOSE` | `true` | 使用交易所封口信号 |
| `finalize_timeout_ms` | `BAR_AGG_FINALIZE_TIMEOUT_MS` | `5000` | 安全超时(ms) |
| `update_throttle_ms` | `BAR_AGG_UPDATE_THROTTLE_MS` | `250` | UPDATED 节流(ms) |

## 与其他模块的关系

```
┌─────────────┐     MarketEvent      ┌──────────────────┐
│  Ingestion  │ ──────────────────── │                  │
│  (实时推送)  │                      │   Bar Aggregator │
└─────────────┘                      │   (K线聚合器)     │
                                     │                  │
┌─────────────┐     FetchedBar       │   BarEvent       │
│  Backfill   │ ──────────────────── │   ──────────── → │ → Storage
│  (历史回填)  │                      │                  │ → WebSocket
└─────────────┘                      │                  │ → Indicators
                                     └──────────────────┘
```

## 文件结构

```
bar_aggregator/
├── __init__.py          # 公共 API 导出
├── aggregator.py        # 顶层编排器 (BarAggregator)
├── config.py            # 配置 (BarAggregatorConfig)
├── models.py            # 数据模型、枚举、协议接口
├── router.py            # L1: 事件路由器
├── time_bucket.py       # L2: 时间桶引擎
├── bar_state.py         # L3: K线状态引擎 + 标准OHLCV合并
├── finalizer.py         # L4: 封口器 + 内置策略
├── publisher.py         # L5: 发布器
├── README.md            # 英文文档
└── README_zh.md         # 本文件
```
