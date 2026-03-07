# 回补引擎 (Backfill Engine)

[![English](https://img.shields.io/badge/Language-English-blue)](README.md) [![简体中文](https://img.shields.io/badge/语言-简体中文-red)](#)


> CandleScope 的历史数据自动检测与修复系统。

回补引擎能够自动检测数据库中缺失的 K 线数据，从交易所 REST API 拉取补全，去重、聚合自定义周期、批量写入存储并推送到缓存 —— 一行代码搞定：`await engine.run("BTCUSDT")`。

---

## 架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        BackfillEngine                            │
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────────┐   │
│  │  Gap Detector │──▶│   Planner    │──▶│ Historical Fetcher │   │
│  │  (缺口检测)    │   │  (计划生成)   │   │   (历史数据拉取)    │   │
│  └──────────────┘   └──────────────┘   └────────┬───────────┘   │
│                                                  │               │
│                                        ┌─────────▼───────────┐  │
│                                        │     Reconciler      │  │
│                                        │  (去重 + 聚合 + 写入) │  │
│                                        └─────────┬───────────┘  │
│                                                  │               │
│                                        ┌─────────▼───────────┐  │
│                                        │  Repair Publisher    │  │
│                                        │    (修复报告发布)     │  │
│                                        └─────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 流水线阶段

| # | 阶段 | 组件 | 说明 |
|---|------|------|------|
| 1 | **检测** | `GapDetector` | 对比实时边界（来自 ingestion 第六层）与数据库，发现尾部/头部/内部缺口 |
| 2 | **规划** | `BackfillPlanner` | 分解自定义周期、对齐桶边界、生成拉取任务 |
| 3 | **拉取** | `HistoricalFetcher` | 分页 REST 调用，并发控制 + 重试 |
| 4 | **调和** | `Reconciler` | 去重、自定义周期聚合、批量写库、缓存推送 |
| 5 | **发布** | `RepairPublisher` | 日志 + 回调，输出 `RepairReport` |

---

## 快速开始

```python
from app.data_engine.backfill import BackfillEngine, BackfillConfig

config = BackfillConfig(fetch_concurrency=5)
engine = BackfillEngine(
    config=config,
    storage=my_storage_backend,   # 实现 StorageBackend 协议
    transport=my_transport_layer, # ingestion TransportLayer
    cache=my_cache_backend,       # 可选，实现 CacheBackend 协议
)

# 一键补全
report = await engine.run("BTCUSDT")

# 指定自定义周期和时间范围
report = await engine.run(
    symbol="BTCUSDT",
    intervals=["1m", "5m", "91m"],
    range_start_ms=1700000000000,
    range_end_ms=1700100000000,
)

# 干跑模式 —— 仅检测缺口
gaps = await engine.detect_only("BTCUSDT")

# 干跑模式 —— 检测 + 规划（查看预估成本）
plan = await engine.plan_only("BTCUSDT", intervals=["1m", "91m"])
print(f"预计拉取 ~{plan.estimated_bars} 根K线, ~{plan.estimated_requests} 次请求")
```

---

## 自定义周期分解

Planner 会自动将非标准周期分解为标准周期以提高拉取效率。

**示例：91m**（5,460,000 毫秒）
```
贪心分解：
  91m → 1×60m + 1×30m + 1×1m
  （3 个组件，而非 91 次 1m 请求）
```

### 分解策略

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| `greedy_descending` | 从最大标准周期开始贪心填充 | 默认，速度快 |
| `min_requests` | 最小化 REST 请求总数 | 大规模回补 |
| `single_base` | 只用一个基础周期 | 简单场景 |

### 对齐模式

| 模式 | 说明 |
|------|------|
| `epoch` | 对齐到固定纪元时间戳（默认：Unix 0） |
| `midnight` | 对齐到 UTC 午夜边界 |
| `market` | 对齐到交易所开盘时间 |
| `none` | 不对齐，从缺口起始处开始 |

---

## 存储与缓存协议

引擎与存储解耦，通过 Protocol 接口适配任意数据库：

### StorageBackend（必需）

```python
class MyStorage:
    async def get_latest_time(self, symbol: str, interval: str) -> int | None: ...
    async def get_earliest_time(self, symbol: str, interval: str) -> int | None: ...
    async def query_time_range(self, symbol, interval, start_ms, end_ms) -> list[dict]: ...
    async def upsert_bars(self, symbol, interval, bars, source="backfill") -> int: ...
    async def count_bars(self, symbol, interval, start_ms, end_ms) -> int: ...
    async def get_existing_open_times(self, symbol, interval, start_ms, end_ms) -> set[int]: ...
```

### CacheBackend（可选）

```python
class MyCache:
    async def push_bars(self, symbol: str, interval: str, bars: list[dict]) -> int: ...
    async def invalidate(self, symbol, interval, start_ms, end_ms) -> None: ...
```

---

## 配置参数

所有参数都有合理默认值，支持三种覆盖方式：
1. 构造函数：`BackfillConfig(fetch_concurrency=10)`
2. 环境变量：`BACKFILL_FETCH_CONCURRENCY=10`
3. 运行时更新：`config.update(fetch_concurrency=10)`

完整参数列表见 [`config.py`](config.py)。

### 关键参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `gap_scan_intervals` | `["1m","5m","15m","1h","4h","1d"]` | 扫描的周期列表 |
| `gap_tolerance_bars` | `1` | 容忍缺失几根K线才报告缺口 |
| `gap_scan_interior` | `True` | 是否检测内部空洞 |
| `decomposition_strategy` | `"greedy_descending"` | 自定义周期分解策略 |
| `custom_alignment_mode` | `"epoch"` | 桶边界对齐模式 |
| `fetch_concurrency` | `3` | 最大并发 REST 请求数 |
| `fetch_batch_size` | `1000` | 每页K线数 |
| `fetch_rate_limit_delay` | `0.1` | 请求间隔（秒） |
| `fetch_max_retries` | `3` | 单次请求最大重试次数 |
| `reconcile_dedup_strategy` | `"overwrite"` | 重复数据处理策略 |
| `reconcile_enable_cache_push` | `True` | 是否推送近期数据到缓存 |
| `publish_mode` | `"both"` | `"log"` / `"callback"` / `"both"` |

---

## 扩展点

每个子组件都暴露了钩子函数，方便用户自定义：

### Gap Detector（缺口检测器）
```python
# 自定义参考时间（如从 ingestion 获取）
engine.detector.set_reference_time_provider(my_async_fn)

# 过滤小缺口
engine.detector.set_gap_filter(lambda g: g.missing_bars >= 5)

# 每个缺口的回调
engine.detector.on_gap_detected(my_async_handler)

# 从 ingestion 推送实时边界
engine.detector.update_ingestion_reference("BTCUSDT", "1m", open_time_ms)
```

### Planner（计划生成器）
```python
# 硬编码分解方案
from app.data_engine.backfill.models import IntervalComponent
engine.planner.add_interval_mapping("91m", [
    IntervalComponent("1h", 1, 3_600_000),
    IntervalComponent("30m", 1, 1_800_000),
    IntervalComponent("1m", 1, 60_000),
])

# 自定义分解函数
engine.planner.set_decomposition_fn(my_decomp_fn)

# 自定义对齐函数
engine.planner.set_alignment_fn(my_align_fn)
```

### Fetcher（历史数据拉取器）
```python
# 进度追踪
engine.fetcher.on_fetch_progress(async_progress_handler)

# 错误处理
engine.fetcher.on_fetch_error(async_error_handler)

# 自定义限流器
engine.fetcher.set_rate_limiter(my_token_bucket)
```

### Reconciler（数据调和器）
```python
# 自定义 OHLCV 聚合逻辑
engine.reconciler.set_custom_aggregator(my_agg_fn)

# 自定义去重逻辑
engine.reconciler.set_dedup_fn(my_dedup_fn)

# 每批写入后的回调
engine.reconciler.on_write_batch(async_batch_handler)
```

### Publisher（修复报告发布器）
```python
# Webhook / 通知
engine.publisher.on_report(async_webhook_handler)

# 自定义格式化
engine.publisher.set_report_formatter(my_formatter)

# 过滤报告（如只发布失败的）
engine.publisher.set_report_filter(lambda r: r.status != BackfillStatus.COMPLETED)
```

---

## 文件结构

```
backfill/
├── __init__.py          # BackfillEngine 编排器 + 公共 API
├── config.py            # BackfillConfig（所有可调参数）
├── models.py            # 数据模型、枚举、Protocol 接口
├── gap_detector.py      # 缺口检测器
├── planner.py           # 回补计划器（分解 + 对齐）
├── fetcher.py           # 历史数据拉取器（REST + 分页）
├── reconciler.py        # 数据调和器（去重 + 聚合 + 写入）
├── publisher.py         # 修复报告发布器（日志 + 回调）
├── README.md            # 英文文档
└── README_zh.md         # 本文件
```

---

## 指标与诊断

每个组件通过 `LayerMetrics` 记录运行指标：

```python
# 引擎级快照
snapshot = engine.snapshot()

# 各组件指标
engine.detector.metrics.snapshot()
engine.planner.metrics.snapshot()
engine.fetcher.metrics.snapshot()
engine.reconciler.metrics.snapshot()
engine.publisher.metrics.snapshot()
```
