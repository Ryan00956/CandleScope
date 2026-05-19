# CandleScope 后端

[English](README.md)

> CandleScope 的 FastAPI 后端。提供 K 线数据、实时 WebSocket、交易所元数据、指标计算、自定义 Pyne 脚本、proxy/settings 管理、订阅和 storage 修复工具。

## 运行栈

- Python FastAPI app：`app/main.py`
- 核心异步基础设施：`app/core/executors.py`、`app/core/runtime_metrics.py`
- 行情数据 runtime：`app/data_engine/runtime.py`
- 交易所 registry/plugins：`app/exchanges`
- 指标引擎和 Pyne runtime：`app/indicator`
- SQLite K 线存储：`app/data_engine/storage`

## 快速启动

```bash
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

默认 API base：

```text
http://localhost:8000
```

交互式文档：

```text
http://localhost:8000/docs
```

健康检查：

```bash
curl http://localhost:8000/health
curl http://localhost:8000/debug/snapshot
```

## 启动流程

`app/main.py` 会：

1. 启动 event-loop lag 监控。
2. 初始化 SQLite K 线 storage。
3. best-effort 刷新交易所 symbol metadata。
4. 通过 `start_data_engine()` 启动 Data Engine。
5. 将稳定 runtime 句柄挂到 `app.state`。
6. 将 IndicatorEngine 桥接到 DataManager events。

关闭时先停止 lag monitor，再停止 IndicatorEngine，最后关闭 Data Engine runtime。

## API 总览

所有应用 API 挂载在 `/api/v1`。

| 领域 | Endpoints |
|---|---|
| K 线 | `GET /klines/`, `/latest`, `/history`, `/range`, `/history/before`, `/resolve`, `/storage/meta`, `/continuity`, `DELETE /klines/storage` |
| Streams | `WS /stream/klines`, `WS /stream/klines_multi`, `WS /stream/indicators`, `WS /stream/prices` |
| Indicators | `GET /indicators/registry`, presets, custom CRUD, Pyne security, diagnostics, `POST /indicators/compute` |
| Exchanges | `GET /exchanges/`, `GET /exchanges/diagnostics`, `GET /exchanges/{exchange}/capabilities` |
| Symbols | `GET /symbols/exchange-info`, `POST /symbols/exchange-info/refresh` |
| Settings | proxy get/update/test、storage repair、gap scan、storage health、cache limits |
| Subscriptions | list、sync、prices snapshot、get/set/delete symbol tier |

`/api/v1` 外的系统 endpoints：

- `GET /`
- `GET /health`
- `GET /debug/snapshot`

## Data Engine

后端数据路径：

```text
Exchange WS/REST
        ▼
ingestion
        ▼
bar_aggregator
        ▼
data_manager
        ▼
API / WS / Indicator
```

历史修复路径：

```text
Query/Settings/GapMarker
        ▼
BackfillCoordinator
        ▼
BackfillEngine
        ▼
storage
        ▼
DataManager cache + events
```

详细文档：

- [app/data_engine](app/data_engine/)
- [app/data_engine/ingestion](app/data_engine/ingestion/)
- [app/data_engine/bar_aggregator](app/data_engine/bar_aggregator/)
- [app/data_engine/backfill](app/data_engine/backfill/)
- [app/data_engine/data_manager](app/data_engine/data_manager/)

## 并发模型

后端把 FastAPI event loop 作为编排层。阻塞或重计算任务不会直接跑在 event loop 上，而是进入有边界的基础设施。

```text
FastAPI event loop
  -> 请求 / WebSocket 编排
  -> 不直接跑阻塞 storage query
  -> 不直接跑重指标计算
  -> 不直接等待 Pyne 子进程

Core executors
  -> indicator executor：内置指标 HTTP/range compute
  -> pyne-wait executor：Pyne process wait 和 Pyne snapshot
  -> storage executor：SQLite/DataManager 同步 storage 路径

DataEventBus
  -> emit() 只做过滤和入队
  -> 每个 callback subscriber 一个 bounded queue + worker
  -> iterator subscriber 也使用 bounded queue

BackfillScheduler
  -> priority queue
  -> 单 series single flight
  -> 全局并发上限
  -> token bucket 限流
  -> rate-limit skip 后 delayed drain 自唤醒
```

新增核心模块：

- `app/core/executors.py`：负责专用线程池，以及 executor queue/run 统计。
- `app/core/runtime_metrics.py`：负责 event-loop lag 采样，以及 WebSocket send/heartbeat 聚合指标。

职责边界保持清晰：API 层做编排，DataEventBus 做事件投递，BackfillScheduler 做修复调度，core 模块提供共享运行时基础设施。

## 交易所插件

内置交易所通过 `app.exchanges.registry` 注册：

- Binance
- OKX

插件模板：

- [app/exchanges/plugins/_template](app/exchanges/plugins/_template/)

架构说明：

- [app/exchanges](app/exchanges/)

Exchange plugin 暴露 capabilities、symbol normalization、REST/WS protocol specs、subscription specs、realtime policy、rate limits、pagination policy 和 payload normalization。adapter 仅保留为旧调用兼容门面。

长期稳定边界：

- `ExchangeCapabilities` 包含 `plugin_api_version`、`capability_schema_version`、protocol features、limits 和 known limitations。
- `ExchangeRegistry.register()` 会拒绝当前后端不支持的 plugin API major version 或 capability schema version。
- `GET /api/v1/exchanges/diagnostics` 会返回每个插件的加载状态、protocol class、adapter facade 和 policy classes。
- `app.exchanges.contracts` 提供可复用契约测试 harness，用于验证 REST specs、WS specs、payload extraction、历史分页和 normalizer 输出 schema。
- 内置 contract fixtures 放在 `tests/fixtures/exchanges/`；新增交易所应先补 fixture，再接入 runtime。
- 外部插件可通过 `CANDLESCOPE_EXCHANGE_PLUGINS=module.path,module.path:factory` 显式加载。内置插件仍先加载，外部插件加载失败会进入 diagnostics，而不是静默污染 runtime。
- 前端通过 `/api/v1/exchanges/` 消费 interval list、market availability、WS mode 和用户可见 limitations。新增交易所 UI 行为应放在 capabilities 中，而不是写新的前端硬编码分支。

## 指标和 Pyne

指标文档：

- [app/indicator](app/indicator/)
- [app/indicator/pyne](app/indicator/pyne/)

内置指标包括 `MA`、`EMA`、`MACD`、`RSI`、`BOLL`、`ATR` 和 `VOL`。

Pyne 脚本通过 `execute_pyne_script()` 执行，默认使用 process executor。Security modes 为 `safe`、`research`、`unsafe`。

HTTP 指标计算通过专用 executor 隔离：

- 内置指标 HTTP compute 使用 one-shot engine，不会修改全局实时 `IndicatorEngine`。
- Pyne HTTP 和 range snapshot 路径通过 Pyne wait executor 包装 process runtime。
- 两条路径都受 `INDICATOR_HTTP_TIMEOUT_SECONDS` 保护。

## 可观测性和压测

诊断信息挂在现有 endpoints 上：

```bash
curl http://localhost:8000/health
curl http://localhost:8000/debug/snapshot
curl http://localhost:8000/api/v1/indicators/diagnostics
curl http://localhost:8000/api/v1/settings/storage/health
```

重要字段：

| 字段 | 含义 |
|---|---|
| `event_loop_lag` | `/health` 中的 event-loop 调度延迟摘要 |
| `runtime.event_loop_lag` | `/debug/snapshot` 中完整 event-loop lag 快照 |
| `runtime.websocket.heartbeat_delay` | WebSocket heartbeat 调度延迟 |
| `runtime.websocket.send_timeouts` | 按 payload 类型统计的 WS send timeout |
| `executors.*` | 每类 executor 的 submitted/active/pending 和 queue/run timing |
| `event_bus.callback_lag` | callback subscriber queue lag 和 drops |
| `event_bus.queue_lag` | async-iterator subscriber queue lag 和 drops |
| `ready_chunks` / `running_chunks` / `next_drain_in_ms` | backfill scheduler 状态 |

对运行中的后端执行并发压测：

```bash
cd backend
python scripts/bench_concurrency.py --base-url http://127.0.0.1:8000
```

压测会覆盖 K 线 latest 查询、内置指标 compute、Pyne compute、可见区间 repair 和主要 WebSocket 流，并输出延迟分位数以及压测前后的 diagnostics。

## 配置

环境变量通过 `python-dotenv` 加载。

常用变量：

| 变量 | 用途 |
|---|---|
| `CANDLE_HOST` | 后端 host，默认 `0.0.0.0` |
| `CANDLE_PORT` | 后端端口，默认 `8000` |
| `CANDLE_DATA_DIR` | 数据目录，默认 `backend/data` |
| `KLINES_DB_PATH` | SQLite DB 路径 |
| `CORS_ORIGINS` | 逗号分隔的前端 origins |
| `INGESTION_*` | 实时接入 endpoints、timeout、proxy、WS/fallback 参数 |
| `BACKFILL_*` | 历史修复 intervals、fetch limits、dedup、publish mode |
| `BAR_AGG_*` | 聚合 source mode、alignment、finalization、event throttling |
| `PYNE_*` | Pyne security、executor mode、timeouts、output limits |
| `INDICATOR_HTTP_TIMEOUT_SECONDS` | HTTP 指标计算等待上限 |
| `INDICATOR_THREAD_WORKERS` | 内置指标 executor 大小 |
| `PYNE_HTTP_THREAD_WORKERS` | Pyne wait executor 大小 |
| `STORAGE_THREAD_WORKERS` | storage executor 大小 |
| `WS_SEND_TIMEOUT_SECONDS` | WebSocket send timeout |
| `EVENT_LOOP_LAG_INTERVAL_SECONDS` | event-loop lag 采样周期 |

proxy settings 也可以通过 API 更新，并持久化到：

```text
DATA_DIR/proxy_settings.json
```

## Storage

K 线 storage 基于 SQLite。内部时间戳使用毫秒。API 图表 bars 的 `BarData.time` 使用秒，以兼容 `lightweight-charts`。

维护 endpoints 可以：

- 从 base intervals 重建自定义周期；
- 扫描并修复缺口；
- 查看 gap ledger health；
- 更新 retention limits。

## 测试

运行所有后端测试：

```bash
cd backend
python -m pytest -q
```

编译检查：

```bash
cd backend
python -m compileall app tests -q
```

聚焦 smoke set：

```bash
cd backend
python -m pytest -q \
  tests/test_klines_api.py \
  tests/test_stream_api.py \
  tests/test_indicator_api.py \
  tests/test_exchanges_api.py \
  tests/test_exchange_plugin_contracts.py \
  tests/test_exchange_registry_plugins.py \
  tests/test_data_engine_phase1_boundaries.py
```

并发压测脚本编译检查：

```bash
cd backend
python -m py_compile scripts/bench_concurrency.py app/core/executors.py app/core/runtime_metrics.py
```
