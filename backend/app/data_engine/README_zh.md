# Data Engine 架构总览

> CandleScope 后端行情数据层。当前正式路径已经收口为：

```text
交易所 WS/REST
        │
        ▼
ingestion
        │ MarketEvent / GapMarker
        ▼
bar_aggregator
        │ BarEvent
        ▼
data_manager
        │ QueryResult / DataEvent / PriceSnapshot
        ▼
API / WebSocket / Indicator / Subscription / Settings

历史缺口：
QueryEngine / Settings / Ingestion GapMarker
        ▼
DataManager.BackfillCoordinator
        ▼
backfill
        ▼
storage
        ▼
DataManager cache + EventBus
```

## 模块边界

| 模块 | 负责 | 不负责 |
|---|---|---|
| `ingestion` | 连接交易所、WS/HTTP 故障转移、原始 payload 标准化、去重和 `GapMarker` 输出 | 不生成最终 K 线、不写 storage、不执行历史回补 |
| `bar_aggregator` | 统一 bucket、OHLCV merge、forming/closed 生命周期、`BarEvent` 发布 | 不连交易所、不读写 storage、不管理订阅 |
| `data_manager` | 唯一业务门面：query/cache/event/stream/backfill coordination/price/subscription/maintenance | 不直接实现交易所协议、不手写历史 fetch pipeline |
| `backfill` | detect/plan/fetch/reconcile/publish 历史修复 pipeline，输出 `RepairReport.written_ranges` | 不管理 API/WS、不直接回灌 DataManager cache |
| `storage` | SQLite adapter 和基础持久化能力 | 不作为业务数据门面暴露 |

## 当前关键协作

- **实时 K 线**：`DataManager.ensure_stream()` 通过 `StreamEnsurePlanner` 决定目标和前置 base stream，注册 `BarAggregator` target，再由 `StreamCoordinator` 启动 ingestion。
- **OKX 高周期刷新**：OKX `1m` realtime 可扇出到更大标准周期，`BarAggregator` 使用显式 `MergeMode.PRICE_ONLY`，只更新 OHLC，不污染 volume/trades。
- **自定义周期**：实时、query、backfill、settings repair 统一走 `IntervalPolicy` 和 `BarAggregator` batch/replay 能力。
- **历史修复**：`QueryEngine` 返回结构化 `MissingRange`；DataManager 显式提交 `BackfillCoordinator`；Backfill 写库后报告 `written_ranges`；Coordinator 按实际写入范围从 storage 回读并回灌 cache。
- **价格流**：订阅等级和 price WS/REST 都走 `DataManager.PriceSnapshotCache` 和 `DataEventType.PRICE_UPDATED`。`DailyOpenService` 优先从 storage 当前 `1d` bar 取 daily open，缺失时触发 `1d` backfill。
- **ticker fan-out**：`IngestionPriceSource` 支持具备 `start_price_many` 的 factory 用单个 multi-symbol ticker stream 服务多个 watched symbols；不支持的交易所继续 per-symbol。

## 启动组合根

生产启动通过 `app/data_engine/runtime.py` 统一 wiring：

```text
KlinesRepoAdapter       -> DataManager storage
BinanceIngestionFactory -> StreamCoordinator / IngestionPriceSource
BackfillEngine          -> BackfillCoordinator
BackfillCoordinator     -> DataManager backfill trigger
SubscriptionService     -> DataManager subscriptions
```

`main.py` 只负责初始化 storage、启动 `DataEngineRuntime`、挂载稳定的 `app.state` 句柄以及 shutdown。

## 当前验证

```bash
cd backend
python3 -m compileall app tests -q
python3 -m pytest -q
```

当前本机结果：`80 passed`。
