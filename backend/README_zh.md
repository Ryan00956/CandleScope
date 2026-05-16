# CandleScope 后端

[English](README.md)

> CandleScope 的 FastAPI 后端。提供 K 线数据、实时 WebSocket、交易所元数据、指标计算、自定义 Pyne 脚本、proxy/settings 管理、订阅和 storage 修复工具。

## 运行栈

- Python FastAPI app：`app/main.py`
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

1. 初始化 SQLite K 线 storage。
2. best-effort 刷新交易所 symbol metadata。
3. 通过 `start_data_engine()` 启动 Data Engine。
4. 将稳定 runtime 句柄挂到 `app.state`。
5. 将 IndicatorEngine 桥接到 DataManager events。

关闭时先停止 IndicatorEngine，再关闭 Data Engine runtime。

## API 总览

所有应用 API 挂载在 `/api/v1`。

| 领域 | Endpoints |
|---|---|
| K 线 | `GET /klines/`, `/latest`, `/history`, `/range`, `/history/before`, `/resolve`, `/storage/meta`, `/continuity`, `DELETE /klines/storage` |
| Streams | `WS /stream/klines`, `WS /stream/klines_multi`, `WS /stream/indicators`, `WS /stream/prices` |
| Indicators | `GET /indicators/registry`, presets, custom CRUD, Pyne security, diagnostics, `POST /indicators/compute` |
| Exchanges | `GET /exchanges/`, `GET /exchanges/{exchange}/capabilities` |
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

## 交易所插件

内置交易所通过 `app.exchanges.registry` 注册：

- Binance
- OKX

插件模板：

- [app/exchanges/plugins/_template](app/exchanges/plugins/_template/)

Exchange adapter 暴露 capabilities、symbol normalization、REST/WS endpoint policy、subscription specs、realtime policy、rate limits 和 payload extraction。

## 指标和 Pyne

指标文档：

- [app/indicator](app/indicator/)
- [app/indicator/pyne](app/indicator/pyne/)

内置指标包括 `MA`、`EMA`、`MACD`、`RSI`、`BOLL`、`ATR` 和 `VOL`。

Pyne 脚本通过 `execute_pyne_script()` 执行，默认使用 process executor。Security modes 为 `safe`、`research`、`unsafe`。

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
  tests/test_exchange_registry_plugins.py \
  tests/test_data_engine_phase1_boundaries.py
```
