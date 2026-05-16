# Indicator Engine

[English](README.md)

> CandleScope 的增量式、事件驱动指标计算模块。该模块支持内置 Python 指标类和后端托管的 Pyne 脚本，并在应用启动时桥接到 DataManager bar events。

## 架构

```text
DataManager DataEventBus
        │ BAR_UPDATED / BAR_CLOSED / BACKFILL_COMPLETED
        ▼
data_manager_bridge.py
        ▼
IndicatorEngine
        ├── built-in Indicator instances
        ├── instance cache / refcount
        ├── event listeners
        └── IndicatorResult / IndicatorEvent

HTTP / WS APIs
        ├── registry and presets
        ├── one-shot compute
        ├── custom indicator CRUD
        └── realtime indicator stream
```

## 主要文件

| 文件 | 职责 |
|---|---|
| [base.py](base.py) | 抽象 `Indicator` 生命周期契约和输出辅助 |
| [engine.py](engine.py) | `IndicatorEngine`：实例缓存、订阅、partial/closed 更新、事件分发 |
| [types.py](types.py) | `IndicatorKey`、metadata、output、result、registry spec 类型 |
| [registry.py](registry.py) | 内置指标全局 `IndicatorRegistry` |
| [events.py](events.py) | `IndicatorEvent` 和事件类型 |
| [data_manager_bridge.py](data_manager_bridge.py) | 将 DataManager bar events 接入 IndicatorEngine |
| [custom_store.py](custom_store.py) | 用户脚本本地 JSON 存储 |
| [serialization.py](serialization.py) | 内置和 Pyne 结果的前端标准 payload |
| [errors.py](errors.py) | 结构化错误 payload 辅助 |
| [indicators](indicators/) | 内置指标实现 |
| [pyne](pyne/) | Pine 风格 Python runtime |

## 内置指标

内置指标在 [__init__.py](__init__.py) 中自动注册。

| 名称 | 文件 | 输出 | 面板 | 说明 |
|---|---|---|---|---|
| `MA` | [ma.py](indicators/ma.py) | `ma` | 主图叠加 | rolling-sum 简单移动平均 |
| `EMA` | [ema.py](indicators/ema.py) | `ema` | 主图叠加 | SMA seed 后递归 EMA |
| `MACD` | [macd.py](indicators/macd.py) | `dif`, `dea`, `hist` | 副图 | `hist` 为 histogram |
| `RSI` | [rsi.py](indicators/rsi.py) | `rsi` | 副图 | Wilder smoothing，precision 2 |
| `BOLL` | [boll.py](indicators/boll.py) | `middle`, `upper`, `lower` | 主图叠加 | rolling mean/std |
| `ATR` | [atr.py](indicators/atr.py) | `atr` | 副图 | true range + Wilder smoothing |
| `VOL` | [vol.py](indicators/vol.py) | `volume` | 成交量面板 | 带涨跌颜色的 histogram |

每个类通过 `get_spec()` 暴露前端 registry metadata 和参数 schema。

## 指标生命周期

每个指标继承 `Indicator` 并实现：

```python
class MyIndicator(Indicator):
    def init(self, bars: list[BarData]) -> None:
        ...

    def update_partial(self, bar: BarData) -> None:
        ...

    def update_closed(self, bar: BarData) -> None:
        ...
```

语义：

- `init(bars)` 用按时间升序的历史 bars 初始化状态。
- `update_partial(bar)` 为 forming bar 计算 preview 值，不应推进已提交 rolling state。
- `update_closed(bar)` 提交 closed bar，并且只推进一次 rolling state。
- `recompute(bars)` 默认等于 `reset() + init(bars)`。
- `build_result(key)` 返回标准化 `IndicatorResult`。

## 身份和缓存

`IndicatorKey` 唯一标识一个指标实例：

```python
IndicatorKey(
    symbol="BTCUSDT",
    interval="1m",
    indicator_name="MA",
    params={"period": 20, "source": "close"},
    exchange="binance",
    market_type="spot",
)
```

规则：

- symbol 规范成大写。
- indicator name 规范成大写。
- exchange 和 market type 规范成小写。
- params 冻结并 hash。
- `uid` 包含 exchange 和 market type，例如 `binance:spot:BTCUSDT:1m:MA:<hash>`。
- `series_topic` 匹配 DataManager topic 语义，例如 `BTCUSDT@1m` 或 `okx:swap:BTC-USDT@1m`。

`IndicatorEngine` 按 key 缓存实例并维护引用计数。多个图表面板请求同一个 key 时共享同一个实例。

## Engine API

```python
from app.indicator import create_engine

engine = create_engine()

result = engine.compute(
    symbol="BTCUSDT",
    interval="1m",
    market_type="spot",
    indicator_name="MA",
    params={"period": 20},
    bars=bars,
    exchange="binance",
)

key, initial = engine.subscribe(
    symbol="BTCUSDT",
    interval="1m",
    market_type="spot",
    indicator_name="RSI",
    params={"period": 14},
    bars=bars,
)

engine.on_bar_updated("BTCUSDT", "1m", forming_bar)
engine.on_bar_closed("BTCUSDT", "1m", closed_bar)
engine.unsubscribe(key)
```

## 事件类型

`IndicatorEventType` 包括：

- `INSTANCE_CREATED`
- `INSTANCE_INITIALIZED`
- `INSTANCE_DESTROYED`
- `INDICATOR_UPDATED`
- `INDICATOR_PREVIEW`
- `INDICATOR_RECOMPUTED`
- `INDICATOR_ERROR`

`IndicatorEvent.to_dict()` 会包含 identity fields、最新值或完整结果，以及错误详情。

## DataManager Bridge

`bridge_indicator_engine(data_manager)`：

1. 创建并启动 `IndicatorEngine`。
2. 订阅 DataManager `BAR_CLOSED` 和 `BAR_UPDATED` 事件。
3. 将 closed bars 路由到 `engine.on_bar_closed()`。
4. 将 forming updates 路由到 `engine.on_bar_updated()`。
5. 收到 `BACKFILL_COMPLETED` 后，查询最新 bars 并调用 `engine.on_bars_backfilled()` 重算受影响实例。

`app/main.py` 会把 bridged engine 挂到 `app.state.indicator_engine`。

## HTTP 和 WebSocket API

Router：`backend/app/api/v1/indicators.py`，挂载在 `/api/v1/indicators`。

主要 endpoints：

| Endpoint | 用途 |
|---|---|
| `GET /registry` | 列出注册指标 specs |
| `GET /registry/{name}` | 获取单个内置指标 spec |
| `GET /presets` / `GET /presets/{id}` | 前端 preset 兼容 |
| `GET /custom` | 列出保存的自定义指标 |
| `POST /custom` | 创建/更新自定义指标 |
| `DELETE /custom/{indicator_id}` | 删除自定义指标 |
| `GET /pyne/security` | 当前 Pyne security policy |
| `GET /diagnostics` | 指标诊断 |
| `POST /compute` | 内置或 Pyne 脚本一次性计算 |

实时 endpoint：

| Endpoint | 用途 |
|---|---|
| `WS /api/v1/stream/indicators` | 在一个连接中订阅/取消订阅多个内置或 Pyne 脚本指标 |

## Built-In 和 Script Compute

`POST /compute` 支持两条路径：

- 内置 engine mode：提供 `name` 和 `params`，或使用 `# __ENGINE__:MA` 这类 preset marker。
- Script mode：提供 `script` 和可选 `securityMode`，通过 Pyne 执行。

测试断言：script mode 即使带有内置名称也会执行脚本；built-in mode 会忽略脚本 body，走优化后的 engine 路径。

## Custom Indicator Store

`CustomIndicatorStore` 默认把本地 JSON 存在 `DATA_DIR / "custom_indicators.json"`。

payload 字段：

- `schemaVersion`
- `id`
- `kind`：`script` 或 `custom`
- `name`
- `description`
- `script`
- `params`
- `paramSchema`
- `renderHints`
- `securityMode`：`safe`、`research`、`unsafe` 或省略

写入通过临时文件原子替换。非法 ID、缺 name/script、非法 kind、非法 security mode 会被拒绝。

## 序列化契约

[serialization.py](serialization.py) 保留向后兼容的 `lines`，同时返回标准化输出：

- `series`
- `annotations`
- `fills`
- `paneLayout`
- 通过 `errorDetail` 返回结构化错误

schema 常量：

- `INDICATOR_PAYLOAD_SCHEMA_VERSION = 1`
- `INDICATOR_OUTPUT_SCHEMA_VERSION = 2`

Pyne 扩展输出包括 markers、fills、hlines、background colors、bar colors 和 signals。

## 添加内置指标

1. 创建 `backend/app/indicator/indicators/my_indicator.py`。
2. 继承 `Indicator`。
3. 实现 `init`、`update_partial`、`update_closed`、`get_meta`、output config 和 `get_spec`。
4. 在 [__init__.py](__init__.py) 的 `_BUILTINS` 加入该类。
5. 增加聚焦测试：warmup、partial update 不污染状态、closed update、输出 schema、registry spec。

骨架：

```python
from app.indicator.base import Indicator
from app.indicator.types import IndicatorMeta, IndicatorParam, IndicatorSpec, PaneType

class MyIndicator(Indicator):
    def init(self, bars):
        for bar in bars:
            self.update_closed(bar)

    def update_partial(self, bar):
        value = self._calculate_preview(bar)
        self._set_output("value", bar.time, value)

    def update_closed(self, bar):
        value = self._calculate_and_commit(bar)
        self._set_output("value", bar.time, value)

    def get_meta(self):
        return IndicatorMeta(name="MY", pane=PaneType.MAIN, overlay=True)

    @classmethod
    def get_spec(cls):
        return IndicatorSpec(
            name="MY",
            display_name="My Indicator",
            param_schema=[IndicatorParam(key="period", type="int", default=20, min=1)],
            default_params={"period": 20},
        )
```

## 测试

```bash
cd backend
python -m pytest -q tests/test_indicator_api.py
```

相关更广测试：

```bash
cd backend
python -m pytest -q \
  tests/test_indicator_api.py \
  tests/test_stream_api.py \
  tests/test_data_engine_phase1_boundaries.py
```
