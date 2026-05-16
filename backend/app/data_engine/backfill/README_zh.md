# Backfill

[English](README.md)

> CandleScope 的历史数据修复 pipeline。`BackfillEngine` 负责检测缺口、规划 REST 拉取、获取历史 bars、调和写入 storage，并发布 `RepairReport`。

## 在 Data Engine 中的位置

```text
DataManager.BackfillCoordinator
        ▼
BackfillEngine.run()
        │ detect -> plan -> fetch -> reconcile -> publish
        ▼
RepairReport.written_ranges
        ▼
DataManager 精确回读 storage + cache merge
```

`backfill` 只负责修复 pipeline。它不负责 API endpoint、WebSocket 推送、DataManager cache 更新或 request 生命周期协调。这些由 `DataManager.BackfillCoordinator` 处理。

## Pipeline

| 阶段 | 组件 | 职责 |
|---|---|---|
| Detect | `GapDetector` | 对比请求范围、storage 范围和 live reference，输出 `GapInfo` |
| Plan | `BackfillPlanner` | 将缺口转为 fetch tasks，并生成自定义周期分解 |
| Fetch | `HistoricalFetcher` | 带并发、retry、429 cooldown 的交易所 REST 分页拉取 |
| Reconcile | `Reconciler` | 去重、聚合自定义周期、批量写 storage、记录 `WrittenRange` |
| Publish | `RepairPublisher` | 通过日志/callback 发布最终 `RepairReport` |

## 快速开始

```python
from app.data_engine.backfill import BackfillConfig, BackfillEngine

engine = BackfillEngine(
    config=BackfillConfig(fetch_concurrency=2),
    storage=async_storage,      # 实现 StorageBackend
    transport=transport_layer,  # ingestion TransportLayer
    ingestion_config=ingestion_cfg,
)

report = await engine.run(
    symbol="BTCUSDT",
    intervals=["1m", "5m", "91m"],
    range_start_ms=1700000000000,
    range_end_ms=1700100000000,
    exchange="binance",
    market_type="spot",
)
```

干跑辅助：

```python
gaps = await engine.detect_only("BTCUSDT", intervals=["1m"])
plan = await engine.plan_only("BTCUSDT", intervals=["91m"])
```

生产代码应优先通过 DataManager/BackfillCoordinator 提交修复请求，不要在 API 层直接调用 `BackfillEngine.run()`。

## 核心模型

| 类型 | 说明 |
|---|---|
| `GapInfo` | 单个 `(exchange, market_type, symbol, interval)` 的缺失范围 |
| `IntervalComponent` / `IntervalDecomposition` | 自定义周期到标准组件的分解 |
| `BackfillTask` | 单个标准周期 REST fetch task |
| `BackfillPlan` | gaps、tasks、预计 requests/bars、自定义周期 |
| `FetchedBar` / `FetchResult` | 历史 REST 拉取返回的 bars |
| `ReconcileResult` | 写入数量、写入错误、失败批次、写入范围 |
| `WrittenRange` | 成功写入 storage 的精确范围 |
| `RepairReport` | BackfillCoordinator 消费的最终报告 |
| `StorageBackend` | detector/reconciler 需要的 storage protocol |
| `CacheBackend` | 保留给独立使用场景的可选 protocol |

## RepairReport 契约

`RepairReport.written_ranges` 是回交 DataManager 的权威信息：

```python
report.status                 # completed / partial / failed / cancelled
report.errors                 # 顶层错误
report.reconcile_result       # bars_written, write_errors, failed_batches
report.written_ranges         # 写入 storage 的精确范围
```

BackfillCoordinator 会按每个 `WrittenRange` 从 storage 回读，再调用 `DataManager.on_bars_backfilled()`。这样不会按原始请求范围盲读，能正确处理分页、去重、自定义聚合和部分失败后的实际写入范围。

## 自定义周期

Planner 会把自定义周期拆成标准组件。例如：

```text
91m -> 1h + 30m + 1m
```

支持的分解策略：

| 策略 | 含义 |
|---|---|
| `greedy_descending` | 优先使用能放下的最大标准周期 |
| `min_requests` | 最小化预计 REST 请求数 |
| `single_base` | 只使用一个基础周期 |

对齐模式：

| 模式 | 含义 |
|---|---|
| `epoch` | 对齐到 `alignment_epoch_ms` |
| `midnight` | 对齐 UTC 午夜 |
| `market` | 使用可用的市场开盘语义 |
| `none` | 直接从缺口起点开始 |

自定义周期写入复用 `BarAggregator.aggregate_batch()`，因此批量修复不会污染 live aggregator targets 或 active state。

## 拉取和限流

`HistoricalFetcher` 使用交易所感知的并发和延迟配置：

- 通用 fetch concurrency 默认值保守。
- Binance futures 默认更严格地串行化请求。
- OKX 默认保守，测试覆盖超过 300 行 page cap 的分页拉取。
- HTTP 429 会优先使用 `Retry-After`，并应用 exchange/market 级 cooldown。

## 去重策略

`DeduplicationStrategy`：

- `skip`：保留已有行。
- `overwrite`：总是写入本次拉取的修复行。
- `backfill_wins`：本次修复数据覆盖重复行。
- `newer_wins`：兼容旧名，行为等同 `backfill_wins`。

写入失败会进入 `ReconcileResult.write_errors` 和 `failed_batches`。存在部分写入失败时，run 返回 `PARTIAL`，不会返回 `COMPLETED`。

## 配置

`BackfillConfig` 支持构造参数、`BACKFILL_*` 环境变量和运行时 `update()`。

| 环境变量 | 用途 |
|---|---|
| `BACKFILL_GAP_SCAN_INTERVALS` | 未指定 intervals 时默认扫描的周期 |
| `BACKFILL_GAP_MAX_SCAN_RANGE_MS` | 单次检测最大范围 |
| `BACKFILL_GAP_TOLERANCE_BARS` | 报告缺口前允许缺失的 bars 数 |
| `BACKFILL_GAP_SCAN_INTERIOR` | 是否扫描内部缺口 |
| `BACKFILL_STANDARD_INTERVALS` | 用于分解的标准周期 |
| `BACKFILL_DECOMPOSITION_STRATEGY` | 自定义周期分解策略 |
| `BACKFILL_CUSTOM_ALIGNMENT_MODE` | 自定义周期对齐模式 |
| `BACKFILL_FETCH_CONCURRENCY` | 通用 REST 拉取并发 |
| `BACKFILL_FETCH_BINANCE_FUTURES_CONCURRENCY` | Binance futures override |
| `BACKFILL_FETCH_OKX_CONCURRENCY` | OKX override |
| `BACKFILL_FETCH_RATE_LIMIT_DELAY` | 通用 REST 请求间隔 |
| `BACKFILL_FETCH_429_BACKOFF_SECONDS` | HTTP 429 后 cooldown |
| `BACKFILL_RECONCILE_DEDUP_STRATEGY` | 写入冲突策略 |
| `BACKFILL_RECONCILE_WRITE_BATCH_SIZE` | storage 写入批大小 |
| `BACKFILL_RECONCILE_GENERATE_CUSTOM` | 是否生成自定义周期 rows |
| `BACKFILL_PUBLISH_MODE` | `callback`、`log` 或 `both` |
| `BACKFILL_EXCHANGE` | 默认 exchange |

## 测试

```bash
cd backend
python -m pytest -q \
  tests/test_backfill_coordinator.py \
  tests/test_backfill_gap_detector.py \
  tests/test_backfill_rate_limit.py \
  tests/test_backfill_reconciler.py \
  tests/test_okx_backfill_fetcher.py
```
