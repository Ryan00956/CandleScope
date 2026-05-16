# Bar Aggregator

[English](README.md)

> 将标准化行情事件和历史 bars 转成带生命周期的 OHLCV K 线。它是 Data Engine 中唯一负责 bucket 计算、merge 语义、forming/closed 状态和 `BarEvent` 发布的模块。

## 在 Data Engine 中的位置

```text
ingestion.MarketEvent / backfill bars / manual BarInput
        ▼
bar_aggregator
        │ BarEvent
        ▼
data_manager
```

`bar_aggregator` 不连接交易所、不读写 storage、不管理 API 订阅。它只接收输入并输出 K 线生命周期事件。

## 五层架构

| 层 | 组件 | 职责 |
|---|---|---|
| L1 | `EventRouter` | 将 `MarketEvent` 转为 `BarInput`，并分发给已注册的 `(exchange, market_type, symbol, interval)` target |
| L2 | `TimeBucketEngine` | 计算标准、自定义、周、月周期的 bucket start/end |
| L3 | `BarStateEngine` | 维护 forming/closed `BarState`，应用 merge strategy |
| L4 | `Finalizer` | 按 source-close、event-driven、composite、batch、timeout 等规则判断收盘 |
| L5 | `BarAggregatorPublisher` | 向 callback/queue 发布 `CREATED`、`UPDATED`、`CLOSED`、`AMENDED`、`EXPIRED` 事件 |

## 公共门面

```python
from app.data_engine.bar_aggregator import BarAggregator

agg = BarAggregator()
agg.add_target("BTCUSDT", "1m", exchange="binance", market_type="spot")
agg.add_target("BTCUSDT", "91m")
agg.publisher.on_bar_closed(save_bar)

await agg.start()
await agg.on_market_event(market_event)
await agg.stop()
```

`BarAggregator` 常用方法：

| 方法 | 用途 |
|---|---|
| `add_target()` / `remove_target()` | 注册或移除目标序列 |
| `on_market_event()` | 接收 ingestion 的实时标准事件 |
| `on_backfill_bars()` | 接收历史修复 bars |
| `ingest_bar_input()` | 直接注入标准化 `BarInput` |
| `seed_active_bar()` | 用 warm-start 数据预置 forming 状态 |
| `replay_components()` | 用 component bars 重建 buckets |
| `aggregate_batch()` | 给 backfill/custom storage repair 使用的无状态批量聚合 |
| `get_bucket_state()` / `get_latest_bar()` | 查看当前内存状态 |
| `get_active_bars()` / `get_recent_bars()` | 调试和诊断 |
| `snapshot()` | JSON 诊断快照 |

## 核心模型

| 类型 | 说明 |
|---|---|
| `BarInput` | 来自 realtime、backfill、manual、adapter 的统一输入；时间戳为毫秒 |
| `BarState` | 单个 bucket 的当前 OHLCV 状态 |
| `BarEvent` | 带 identity、status 和 bar payload 的生命周期事件 |
| `BarEventFilter` | subscriber 侧过滤 |
| `FinalizeTrigger` | 触发 finalizer 检查的原因 |
| `BarInputSource` | `realtime`、`backfill`、`manual`、`adapter` |
| `BarSourceMode` | `kline`、`trade`、`auto` |
| `MergeMode` | `snapshot`、`incremental`、`component`、`price_only` |
| `BarStatus` | `forming`、`closed`、`expired` |
| `BarEventType` | `bar.created`、`bar.updated`、`bar.closed`、`bar.amended`、`bar.expired` |
| `AlignmentMode` | `epoch`、`midnight`、`market`、`custom`、`none` |

## Merge Modes

- `SNAPSHOT`：交易所目标周期 kline snapshot。累计字段按当前 source snapshot 替换。
- `INCREMENTAL`：trade/tick 类增量更新。累加型字段会累积。
- `COMPONENT`：用于重建更大自定义 bucket 的组件 bar。
- `PRICE_ONLY`：只更新 open/high/low/close，不改 volume、quote volume、trades。用于 OKX realtime fan-out，避免高周期价格刷新污染累加字段。

## 自定义、周、月周期

周期解析走共享 interval policy。`7m`、`45m`、`3h`、`91m` 等固定自定义周期使用毫秒 bucket 计算。周周期按周一对齐。`1M`、`2M`、`3M` 等月周期使用日历感知的 monthly bucket calculator，不假设一个月固定 30 天。

backfill 和 storage repair 需要隔离批量结果时，优先使用 `aggregate_batch()`。测试断言它不会注册 target，也不会留下 active bars。

## 收盘判断

Finalizer 会组合多个收盘信号：

- 交易所 kline payload 的 source close signal。
- 新 bucket 到达时触发上一 bucket event-driven close。
- 自定义周期最后一个 component close 后 composite close。
- 交易所 close signal 丢失时的 time-based timeout。
- 历史批量聚合使用的 batch finalization。

## 配置

`BarAggregatorConfig` 支持构造参数、`BAR_AGG_*` 环境变量和运行时 `update()`。

| 环境变量 | 用途 |
|---|---|
| `BAR_AGG_SOURCE_MODE` | `kline`、`trade` 或 `auto` |
| `BAR_AGG_ACCEPTED_STREAMS` | 接受的 stream types |
| `BAR_AGG_ALIGNMENT_MODE` | 默认自定义周期对齐方式 |
| `BAR_AGG_ALIGNMENT_EPOCH_MS` | 自定义对齐 epoch |
| `BAR_AGG_MAX_ACTIVE_BARS` | 每个序列最多 forming buckets |
| `BAR_AGG_MAX_CLOSED_BARS` | 内存保留的 recent closed bars |
| `BAR_AGG_USE_SOURCE_CLOSE` | 使用交易所 close signal |
| `BAR_AGG_FINALIZE_TIMEOUT_MS` | 强制收盘 timeout |
| `BAR_AGG_USE_EVENT_DRIVEN_CLOSE` | 新 bucket 到达时关闭上一 bucket |
| `BAR_AGG_USE_COMPOSITE_CLOSE` | 根据 component close 状态关闭自定义周期 |
| `BAR_AGG_UPDATE_THROTTLE_MS` | `UPDATED` 事件节流 |
| `BAR_AGG_PUBLISHER_QUEUE_SIZE` | subscriber queue 大小 |

## 测试

```bash
cd backend
python -m pytest -q tests/test_bar_aggregator_contracts.py
```

contract tests 覆盖 exchange/market identity、OKX `PRICE_ONLY` fan-out、事件匹配、隔离 replay 和无状态批量聚合。
