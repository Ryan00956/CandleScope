# Data Engine 架构总览

> CandleScope 后端行情数据层。当前后端已经收口为模块化 Data Engine：`ingestion` 负责接入行情，`bar_aggregator` 负责统一 K 线生命周期，`data_manager` 作为唯一业务门面，`backfill` 负责历史缺口修复，`storage` 负责 SQLite 持久化。

对应英文文档见 [README.md](README.md)。

## 总体数据流

```text
交易所 WS / REST
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
FastAPI / WebSocket / Indicator / Subscription / Settings

历史缺口修复：
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
| `ingestion` | 交易所 HTTP/WS I/O、WS 生命周期、HTTP fallback、payload 标准化、去重、`GapMarker` 输出 | 不生成业务 K 线、不写 storage、不执行历史修复 |
| `bar_aggregator` | 统一 bucket、OHLCV merge、forming/closed 生命周期、custom interval 聚合、`BarEvent` 发布 | 不连接交易所、不读写 storage、不管理订阅 |
| `data_manager` | 统一 query/cache/event/stream/backfill coordination/price/subscription/maintenance 门面 | 不直接实现交易所协议、不手写 backfill pipeline |
| `backfill` | detect/plan/fetch/reconcile/publish 历史修复 pipeline，输出 `RepairReport` 和 `written_ranges` | 不管理 API/WS、不直接回灌 DataManager cache |
| `storage` | SQLite K 线表、gap ledger、同步/异步 adapter、范围查询和缺口扫描 | 不作为业务数据门面暴露 |
| `interval_policy.py` | 标准/自定义周期解析、bucket 对齐、周/月周期处理、fetch plan 辅助 | 不访问网络、不访问 storage |
| `runtime.py` | 应用组合根：构造、注入、启动、关闭 Data Engine | 不承载业务查询逻辑 |

## 启动组合根

生产启动由 [runtime.py](runtime.py) 统一完成，`app/main.py` 只负责调用 `start_data_engine()` 并将稳定句柄挂到 FastAPI `app.state`：

```text
DataEngineRuntime
├── DataManager
├── KlinesRepoAdapter / AsyncKlinesRepoAdapter
├── GapLedger
├── ExchangeIngestionFactory
├── TransportLayer(IngestionConfig)       # backfill REST transport
├── BackfillEngine
├── BackfillCoordinator
├── IngestionPriceSource
└── SubscriptionService
```

稳定 app state 句柄：

- `app.state.data_engine_runtime`
- `app.state.data_manager`
- `app.state.indicator_engine` 由 Indicator bridge 创建

不要在 API 层直接持有 `BackfillEngine`、`BarAggregator`、`TransportLayer` 等内部对象。边界测试会保护这一点。

## 运行时职责

`start_data_engine()` 的主要步骤：

1. 创建 `DataManager()`。
2. 创建 `KlinesRepoAdapter()`、`AsyncKlinesRepoAdapter()` 和 `GapLedger()`。
3. 将 storage 注入 DataManager。
4. 创建并注入 `ExchangeIngestionFactory`。
5. 启动 backfill 专用 `TransportLayer(IngestionConfig())`。
6. 创建 `BackfillEngine(storage=async_storage, transport=transport, ingestion_config=ingestion_cfg)`。
7. 创建 `BackfillCoordinator`，显式注入 `bars_backfilled=dm.on_bars_backfilled` 和 `emit_event=dm.emit_event`。
8. 设置 `dm.set_backfill_trigger(backfill_coordinator.trigger)`。
9. 启动 DataManager。
10. 启动 price/subscription workflows。
11. 延迟启动 startup gap scan，并启动 background gap audit。

关闭顺序：

1. 取消 gap scan / gap audit 后台任务。
2. 关闭 `BackfillCoordinator`。
3. 停止 price source。
4. 关闭 `DataManager`。
5. 关闭 ingestion factory。
6. 停止 backfill transport。

## 实时 K 线链路

```text
DataManager.ensure_stream()
        ▼
StreamEnsurePlanner
        ▼
StreamCoordinator
        ├── BarAggregator.add_target()
        └── IngestionFactory.start_kline()
                ▼
ingestion.MarketEvent
        ▼
BarAggregator.on_market_event()
        ▼
BarEvent
        ▼
DataManager.on_bar_event()
        ▼
storage upsert + cache merge + EventBus
```

要点：

- 标准周期和自定义周期统一由 `IntervalPolicy` 和 `BarAggregator` 处理。
- `BarData.time` 给前端使用，单位是秒；storage 和内部逻辑使用毫秒。
- 非默认 exchange 或非 spot market 会进入 key/topic，例如 `okx:swap:BTC-USDT@1m`。
- OKX `1m` realtime 可以 fan out 到更大标准周期；这类更新使用 `MergeMode.PRICE_ONLY`，只更新 OHLC，不累加 volume/trades。

## 历史缺口修复链路

```text
QueryEngine / Settings / GapMarker
        ▼
BackfillCoordinator.trigger()
        ▼
BackfillEngine.run()
        │ detect -> plan -> fetch -> reconcile -> publish
        ▼
RepairReport.written_ranges
        ▼
storage 精确回读
        ▼
DataManager.on_bars_backfilled()
        ▼
cache merge + BACKFILL_COMPLETED / BACKFILL_FAILED
```

关键约定：

- `BackfillEngine` 只做 pipeline，不直接操作 DataManager cache。
- `BackfillCoordinator` 负责 request 去重、range 合并、retry、cancel、gap ledger 状态和事件映射。
- `RepairReport.written_ranges` 是回灌 cache 的权威范围，避免按原始请求范围盲读。
- `PARTIAL` 代表有批次失败，不会伪装成 completed。

## 价格流和订阅

价格链路由 `IngestionPriceSource`、`PriceSnapshotCache` 和 `SubscriptionService` 共同提供：

- watchlist sync 会把新增 symbol 注册为 `price` tier。
- `full` tier 会保留完整 K 线流和价格流。
- `price` tier 只维持轻量价格流。
- `none` tier 会停止相关实时任务。
- 支持具备 `start_price_many` 的 ingestion factory 使用 multi-symbol ticker stream；不支持的交易所退回 per-symbol。

## 维护任务

后端暴露的维护入口主要在 settings API：

- `POST /api/v1/settings/storage/repair`：从权威 base interval 重建 custom interval storage。
- `POST /api/v1/settings/storage/gap-scan`：扫描已存标准周期缺口并提交 backfill。
- `GET /api/v1/settings/storage/health`：查看 gap ledger、audit series 和 backfill coordinator 状态。
- `POST /api/v1/settings/cache-limits`：更新保留策略和 ephemeral series 限制。

## 目录索引

| 路径 | 文档 |
|---|---|
| [ingestion](ingestion/) | 实时行情接入六层 pipeline |
| [bar_aggregator](bar_aggregator/) | K 线聚合、bucket、finalizer、事件发布 |
| [data_manager](data_manager/) | 统一业务门面、查询、缓存、订阅、事件 |
| [backfill](backfill/) | 历史缺口修复 pipeline |
| [storage](storage/) | SQLite repo 和 gap ledger，当前没有单独 README |
| [interval_policy.py](interval_policy.py) | 周期解析与 bucket 策略 |
| [runtime.py](runtime.py) | Data Engine 组合根 |

## 验证命令

```bash
cd backend
python -m compileall app tests -q
python -m pytest -q
```

针对 Data Engine 边界和核心链路：

```bash
cd backend
python -m pytest -q \
  tests/test_data_engine_phase1_boundaries.py \
  tests/test_ingestion_delivery.py \
  tests/test_ingestion_normalizers.py \
  tests/test_ingestion_session_types.py \
  tests/test_bar_aggregator_contracts.py \
  tests/test_backfill_coordinator.py \
  tests/test_backfill_gap_detector.py \
  tests/test_backfill_rate_limit.py \
  tests/test_backfill_reconciler.py \
  tests/test_okx_backfill_fetcher.py \
  tests/test_data_manager_warm_start_bridge.py
```
