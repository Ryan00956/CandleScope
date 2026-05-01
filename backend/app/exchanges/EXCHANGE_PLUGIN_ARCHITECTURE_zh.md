# 交易所插件化架构设计

本文档描述 CandleScope 如何把交易所接入从“注册几个 adapter”升级为更完整的插件化体系，使后续新增 Coinbase、Bybit、Kraken、Gate 等交易所时，主要工作集中在独立插件目录内，而不是修改 ingestion、backfill、data_manager 和 frontend 的主流程。

## 目标

新增交易所时，理想改动范围应接近：

1. 新增一个交易所插件包，例如 `app/exchanges/plugins/coinbase/`。
2. 实现该交易所的能力描述、REST/WS 协议、payload 解析、符号规范化。
3. 注册插件，或由自动发现机制加载插件。
4. 添加少量交易所专属测试。

主流程不应因为新增交易所继续膨胀 `if exchange == "xxx"` 分支。

## 当前状态

当前代码已经有比较好的基础：

- `ExchangeAdapter` 抽象了交易所能力、REST endpoint、WS endpoint、请求参数、订阅构造、HTTP payload 拆行。
- `ExchangeRegistry` 负责注册 Binance / OKX adapter。
- `TransportLayer` 已经通过 registry 调 adapter，而不是直接拼 Binance / OKX URL。
- symbol metadata API 已经按 registry 遍历 adapter。
- ingestion normalizer 已经拆成 Binance / OKX 文件。

但还没有完全插件化：

- 默认 adapter 注册写死在 `bootstrap_default_adapters()`。
- normalizer factory 仍是 `if okx else binance`。
- backfill 限速存在 Binance futures / OKX 特例。
- data_manager、bar_aggregator 中存在 OKX 专属实时流策略。
- frontend interval、symbol 推断、交易所展示仍有硬编码。
- WS 连接模型只抽象了 path subscription 和 message subscription，没有显式描述更复杂的连接拓扑。

## 设计原则

### 交易所差异下沉

凡是“不同交易所可能不同”的逻辑，都应属于交易所插件：

- symbol 格式和归一化规则。
- market / product / instrument 分类。
- REST path 和 query 参数。
- REST 返回结构拆解。
- WS URL、订阅消息、退订消息、ack/error 判断。
- WS payload 路由。
- kline / ticker / trade / depth payload 解析。
- 交易所原生 interval 映射。
- rate limit、并发、分页边界语义。
- 是否需要 1m base stream 驱动大周期实时更新。

ingestion / backfill / data_manager 只消费统一接口。

### 能力驱动，而不是交易所名驱动

主流程应判断 capability，不应判断 `exchange == "okx"`。

例如：

- 不要写 `if exchange == "okx": use shared ws`。
- 改成 `if adapter.capabilities().ws_connection_model == "shared_multiplex"`。

### 插件可小步接入

不是每个交易所都必须一次性支持所有功能。插件应能声明功能缺口：

- 只支持 REST 历史 K 线。
- 支持 REST + 单 symbol WS K 线。
- 支持 ticker，但不支持 all-symbol ticker。
- 支持 spot，不支持 futures。
- 支持 perpetual，不支持 delivery futures。

API 层应根据 capability 返回明确错误，而不是运行到深处才失败。

## 目标目录结构

建议把每个交易所收拢为一个插件包：

```text
backend/app/exchanges/
  base.py
  models.py
  registry.py
  plugin.py
  plugins/
    binance/
      __init__.py
      adapter.py
      normalizer.py
      symbols.py
      protocol.py
      rate_limits.py
      tests.md
    okx/
      __init__.py
      adapter.py
      normalizer.py
      symbols.py
      protocol.py
      rate_limits.py
    coinbase/
      __init__.py
      adapter.py
      normalizer.py
      symbols.py
      protocol.py
      rate_limits.py
```

旧的 `binance.py`、`okx.py` 可以先保留，后续迁移到 `plugins/binance/adapter.py` 和 `plugins/okx/adapter.py`。

## 插件入口

新增一个统一插件对象：

```python
class ExchangePlugin(Protocol):
    id: str
    name: str

    def adapter(self) -> ExchangeAdapter:
        ...

    def normalizer(self, descriptor: StreamDescriptor) -> ExchangeNormalizer:
        ...

    def symbol_normalizer(self) -> SymbolNormalizer:
        ...

    def protocol(self) -> ExchangeProtocol:
        ...

    def rate_limit_policy(self) -> RateLimitPolicy:
        ...
```

registry 注册的是 plugin，而不只是 adapter：

```python
registry.register(CoinbasePlugin())
```

短期也可以保持 `get_exchange_registry().get(exchange)` 返回 adapter，同时新增：

```python
get_exchange_registry().get_plugin(exchange)
get_exchange_registry().create_normalizer(config, descriptor)
get_exchange_registry().normalize_symbol(symbol, exchange, market_type)
```

这样可以渐进迁移，不需要一次改完所有调用方。

## 能力模型

现有 `ExchangeCapabilities` 建议扩展为更完整的能力描述。

```python
@dataclass(slots=True)
class ExchangeCapabilities:
    exchange: str
    name: str
    markets: list[ExchangeMarket]
    native_intervals: list[str]

    supports_symbol_search: bool
    supports_rest_history: bool
    supports_ws_streaming: bool
    supports_multi_symbol_ticker: bool

    ws_connection_model: str
    # "path_per_stream"
    # "message_per_stream"
    # "shared_multiplex"
    # "polling_only"

    realtime_update_policy: str
    # "native_interval"
    # "base_interval_fanout"
    # "polling"

    max_rest_limit: int
    default_rest_limit: int
```

`ExchangeMarket` 建议更明确区分商品类型：

```python
@dataclass(slots=True)
class ExchangeMarket:
    market_type: str        # "spot", "margin", "futures", "options"
    product_type: str       # "spot", "perpetual", "delivery", "option"
    label: str
    contract_family: str | None = None
    settlement_asset: str | None = None
    quote_assets: list[str] = field(default_factory=list)
```

这样 frontend 和 API 不需要猜“futures 到底是 USDT-M 永续还是交割合约”。

## 协议层

当前 adapter 同时承担 endpoint、参数、WS 订阅构造。为了兼容更多连接方式，建议拆出 `ExchangeProtocol`：

```python
class ExchangeProtocol(Protocol):
    def rest_base_urls(self, market_type: str, config: Any | None = None) -> list[str]:
        ...

    def ws_base_urls(self, descriptor: StreamDescriptor, config: Any | None = None) -> list[str]:
        ...

    def rest_endpoint(self, descriptor: StreamDescriptor) -> RestEndpoint | None:
        ...

    def ws_subscription(self, descriptor: StreamDescriptor) -> WsSubscriptionSpec:
        ...

    def extract_http_rows(self, payload: Any, descriptor: StreamDescriptor) -> list[Any]:
        ...

    def route_ws_payload(self, payload: Any) -> WsPayloadRoute:
        ...

    def is_subscribe_ack(self, payload: Any) -> bool:
        ...

    def is_error(self, payload: Any) -> bool:
        ...
```

`RestEndpoint`：

```python
@dataclass(slots=True)
class RestEndpoint:
    path: str
    params: dict[str, Any]
    method: str = "GET"
    weight: int = 1
```

`WsPayloadRoute`：

```python
@dataclass(slots=True)
class WsPayloadRoute:
    stream_type: StreamType
    symbol: str
    interval: str | None = None
    market_type: str = "spot"
```

这样可以支持：

- Binance 这种 URL path 一个 stream 一个连接。
- OKX 这种连接后发 subscribe message。
- Coinbase 这种频道 + product_ids 的订阅。
- Bybit / OKX 这种一个连接多 topic multiplex。
- 某些交易所只支持 REST polling。

## WS 连接模型

建议把 WS session 选择从交易所名分支改为 capability / protocol 驱动。

```python
class WsConnectionModel(str, Enum):
    PATH_PER_STREAM = "path_per_stream"
    MESSAGE_PER_STREAM = "message_per_stream"
    SHARED_MULTIPLEX = "shared_multiplex"
    POLLING_ONLY = "polling_only"
```

ingestion factory 根据模型创建 session：

```python
model = plugin.capabilities().ws_connection_model

if model == PATH_PER_STREAM:
    return DirectWsSession(...)
if model == MESSAGE_PER_STREAM:
    return DirectWsSession(...)
if model == SHARED_MULTIPLEX:
    return SharedMultiplexSession(...)
if model == POLLING_ONLY:
    return HttpPollingSession(...)
```

OKX 现在的 `OkxSharedKlineHub` 应改造成通用 `SharedMultiplexHub`，具体订阅格式和 payload 路由由 plugin protocol 提供。

## Normalizer

normalizer factory 应 registry 化。

当前：

```python
if exchange == "okx":
    return OkxNormalizer(...)
return BinanceNormalizer(...)
```

目标：

```python
return get_exchange_registry().get_plugin(descriptor.exchange).normalizer(descriptor)
```

每个 normalizer 只负责把交易所 raw payload 转成统一 `MarketEvent`：

```python
class ExchangeNormalizer(Protocol):
    def parse(self, msg: RawMessage) -> MarketEvent | None:
        ...
```

统一输出字段至少保持：

```python
{
    "interval": "1m",
    "open_time": 0,
    "close_time": 0,
    "open": 0.0,
    "high": 0.0,
    "low": 0.0,
    "close": 0.0,
    "volume": 0.0,
    "quote_volume": 0.0,
    "trades": 0,
    "taker_buy_base": 0.0,
    "taker_buy_quote": 0.0,
    "is_closed": True,
}
```

如果交易所没有某些字段，填默认值，但应在插件测试里明确覆盖。

## Symbol 规范化

当前 symbol 推断对 `BTC-USD` 这类格式有风险，因为 `-` 会被推成 OKX。插件化后应避免靠 symbol 字符串猜 exchange。

建议：

1. 内部 key 永远显式携带 `exchange + market_type + symbol`。
2. Binance 旧 key 可以继续兼容，但新 key 统一使用三段式。
3. symbol normalizer 由插件提供。

```python
class SymbolNormalizer(Protocol):
    def normalize(self, symbol: str, market_type: str) -> str:
        ...

    def display(self, symbol: str, market_type: str) -> str:
        ...

    def parse_base_quote(self, raw: dict[str, Any]) -> tuple[str, str]:
        ...
```

推荐统一 key：

```text
{exchange}:{market_type}:{symbol}
```

例如：

```text
binance:spot:BTCUSDT
okx:spot:BTC-USDT
coinbase:spot:BTC-USD
```

为了兼容旧数据，可以保留读取旧 key 的 parser，但写入新 watchlist / subscriptions 时使用新格式。

## Backfill 与限速

backfill 不应硬编码 Binance futures / OKX 限速。插件提供 `RateLimitPolicy`：

```python
@dataclass(slots=True)
class RateLimitPolicy:
    default_concurrency: int = 2
    default_delay_seconds: float = 0.5
    market_overrides: dict[str, RateLimitOverride] = field(default_factory=dict)

@dataclass(slots=True)
class RateLimitOverride:
    concurrency: int
    delay_seconds: float
    retry_429_backoff_seconds: float
```

HistoricalFetcher 使用：

```python
policy = registry.get_plugin(task.exchange).rate_limit_policy()
limit = policy.concurrency_for(task.market_type)
delay = policy.delay_for(task.market_type)
```

分页边界也应下沉到 protocol，因为不同交易所对 `start/end/before/after` 的含义不一致：

```python
class HistoricalPagination(Protocol):
    def initial_cursor(self, task: BackfillTask) -> PaginationCursor:
        ...

    def build_request(self, task: BackfillTask, cursor: PaginationCursor) -> TransportRequest:
        ...

    def next_cursor(self, bars: list[FetchedBar], cursor: PaginationCursor) -> PaginationCursor | None:
        ...
```

短期可以先保留当前通用倒序分页，但为 OKX / Coinbase 这种边界语义差异预留插件覆盖点。

## 实时聚合策略

当前 OKX 大周期实时更新通过 1m fanout 特例实现。建议变成 capability：

```python
class RealtimeUpdatePolicy(str, Enum):
    NATIVE_INTERVAL = "native_interval"
    BASE_INTERVAL_FANOUT = "base_interval_fanout"
    POLLING = "polling"
```

adapter 声明：

```python
realtime_update_policy="base_interval_fanout"
base_realtime_interval="1m"
```

`StreamEnsurePlanner` 和 `bar_aggregator.router` 根据 policy 处理，不再判断 OKX。

## Frontend 能力下发

前端不应维护完整 `EXCHANGE_INTERVALS` 常量。后端 `/api/v1/exchanges` 已经返回能力信息，建议扩展后由前端动态使用：

```json
{
  "exchange": "coinbase",
  "name": "Coinbase",
  "markets": [
    {
      "market_type": "spot",
      "product_type": "spot",
      "label": "Spot"
    }
  ],
  "native_intervals": ["1m", "5m", "15m", "1h", "6h", "1d"],
  "default_history_days": {
    "1m": 1,
    "5m": 3,
    "1h": 30
  },
  "supports_symbol_search": true,
  "supports_ws_streaming": true
}
```

前端只保留 fallback：

- 后端不可用时使用 Binance 默认。
- localStorage 里旧 key 读入后迁移为三段式 key。

交易所 label、badge、market selector、interval selector 都由 capability 驱动。

## API 行为

API 层应做明确能力校验：

```python
plugin = registry.get_plugin(exchange)
cap = plugin.capabilities()

if market_type not in cap.market_types:
    raise HTTPException(400, f"{exchange} does not support market_type={market_type}")

if interval not in cap.native_intervals and not is_valid_custom_interval(interval):
    raise HTTPException(400, f"{exchange} does not support interval={interval}")

if needs_ws and not cap.supports_ws_streaming:
    raise HTTPException(400, f"{exchange} does not support WebSocket streaming")
```

这样新增交易所不完整时，用户看到的是清楚的“不支持”，不是空图或内部异常。

## 测试要求

每个交易所插件至少应提供以下测试：

1. `capabilities` 输出包含预期 market 和 interval。
2. symbol list 可以把交易所原始 instrument 映射成 `SymbolInfo`。
3. symbol normalizer 覆盖常见输入格式。
4. REST kline params 正确。
5. REST kline response 能 parse 成统一 `MarketEvent`。
6. WS subscription payload / path 正确。
7. WS kline payload 能 parse 成统一 `MarketEvent`。
8. ticker payload 能 parse 成统一 price event。
9. backfill 分页边界不会漏首尾 candle。
10. 不支持的 market / stream_type 会明确报错。

## 迁移计划

### 第一阶段：消除新增交易所的硬分支

目标是新增 Coinbase 时不需要修改 normalizer factory 和 backfill 限速分支。

改动：

1. 新增 `ExchangePlugin` 协议。
2. registry 同时管理 plugin 和 adapter。
3. normalizer 创建改为 registry lookup。
4. symbol normalize 改为 registry lookup。
5. backfill rate limit 改为 plugin policy。

### 第二阶段：统一 WS protocol gateway

目标是支持更多 WS 连接拓扑。

改动：

1. 抽出通用 `ExchangeProtocol`。
2. 把 adapter 中 WS URL / subscribe / ack / payload routing 迁入 protocol。
3. 把 `OkxSharedKlineHub` 泛化为 `SharedMultiplexHub`。
4. session 创建按 `ws_connection_model` 选择。

### 第三阶段：实时策略 capability 化

目标是移除 OKX 大周期实时更新特例。

改动：

1. capability 增加 `realtime_update_policy`。
2. `StreamEnsurePlanner` 根据 policy 添加 base interval prerequisite。
3. `bar_aggregator.router` 根据 policy 做 base interval fanout。

### 第四阶段：前端完全能力驱动

目标是前端新增交易所不再改 `EXCHANGE_INTERVALS`。

改动：

1. `/api/v1/exchanges` 返回完整 interval / history / market / feature 信息。
2. frontend 启动时加载 capabilities。
3. interval selector、market selector、exchange badge 全部使用后端 capability。
4. watchlist / subscriptions key 写入三段式 `{exchange}:{market_type}:{symbol}`。

## 新增 Coinbase 的目标流程

完成上述迁移后，新增 Coinbase 应只需要：

```text
backend/app/exchanges/plugins/coinbase/
  __init__.py
  adapter.py
  normalizer.py
  protocol.py
  symbols.py
  rate_limits.py
```

并在插件入口声明：

```python
class CoinbasePlugin:
    id = "coinbase"
    name = "Coinbase"

    def adapter(self) -> ExchangeAdapter:
        return CoinbaseAdapter()

    def normalizer(self, descriptor: StreamDescriptor) -> ExchangeNormalizer:
        return CoinbaseNormalizer(descriptor)

    def protocol(self) -> ExchangeProtocol:
        return CoinbaseProtocol()

    def symbol_normalizer(self) -> SymbolNormalizer:
        return CoinbaseSymbolNormalizer()

    def rate_limit_policy(self) -> RateLimitPolicy:
        return CoinbaseRateLimitPolicy()
```

主流程不再修改：

- `TransportLayer`
- `NormalizeLayer`
- `HistoricalFetcher`
- `StreamEnsurePlanner`
- `bar_aggregator.router`
- frontend exchange constants

最多只改插件自动发现配置。

## 推荐优先级

如果目标是尽快让“新增第三个交易所”变轻，优先做：

1. normalizer registry 化。
2. symbol normalizer registry 化。
3. frontend capabilities 动态化。
4. backfill rate limit policy 插件化。

如果目标是长期支持很多交易所，继续做：

1. `ExchangeProtocol` 独立出来。
2. WS shared multiplex 泛化。
3. realtime update policy capability 化。
4. pagination policy 插件化。

这样可以先把新增交易所成本从“多处改主流程”降到“新增插件 + 少量注册”，再逐步把复杂连接方式也收拢到插件内。

## 交易所模块升级执行手册

本节是实际执行用的手册。核心原则是：不要新建一个绕开 `app/exchanges` 的平级模块，而是把现有 `app/exchanges` 升级成后端唯一的交易所统一层。

目标依赖关系：

```text
api / data_manager / backfill / ingestion / frontend API
              |
              v
        app.exchanges
  registry + plugin + protocol + normalizer
  symbols + rate limits + realtime policy
              |
              v
     binance / okx / coinbase / bybit / ...
```

完成后，主流程只问 `app.exchanges`：

```python
plugin = get_exchange_registry().get_plugin(exchange)

plugin.capabilities()
plugin.protocol()
plugin.normalizer(config, descriptor)
plugin.symbol_normalizer()
plugin.rate_limit_policy()
plugin.realtime_policy()
```

### 0. 执行前基线

改造前先确认现有行为可回归：

```bash
cd backend
pytest tests/test_ingestion_normalizers.py \
       tests/test_transport_ws_urls.py \
       tests/test_symbol_normalization.py \
       tests/test_okx_backfill_fetcher.py \
       tests/test_backfill_reconciler.py
```

如果这些测试本来就有失败，先记录失败项。插件化改造不应该扩大失败范围。

### 1. 新增插件基础接口

新增文件：

```text
backend/app/exchanges/plugin.py
backend/app/exchanges/protocol.py
backend/app/exchanges/rate_limits.py
backend/app/exchanges/realtime.py
```

`plugin.py` 放统一插件协议：

```python
class ExchangePlugin(Protocol):
    id: str
    name: str

    def adapter(self) -> ExchangeAdapter:
        ...

    def capabilities(self) -> ExchangeCapabilities:
        ...

    def protocol(self) -> ExchangeProtocol:
        ...

    def normalizer(
        self,
        config: IngestionConfig,
        descriptor: StreamDescriptor,
    ) -> ExchangeNormalizer:
        ...

    def symbol_normalizer(self) -> SymbolNormalizer:
        ...

    def rate_limit_policy(self) -> RateLimitPolicy:
        ...

    def realtime_policy(self) -> RealtimePolicy:
        ...
```

`protocol.py` 放 REST / WS 协议抽象。第一阶段不要一次迁太多逻辑，先提供兼容 wrapper，让旧 adapter 仍然能工作：

```python
class AdapterBackedProtocol:
    def __init__(self, adapter: ExchangeAdapter) -> None:
        self._adapter = adapter

    def rest_base_urls(self, market_type: str, config: Any | None = None) -> list[str]:
        return self._adapter.get_http_base_urls(market_type, config=config)

    def ws_base_urls(self, descriptor: StreamDescriptor, config: Any | None = None) -> list[str]:
        return self._adapter.get_ws_base_urls(descriptor.market_type, config=config)

    def rest_path(self, stream_type: StreamType, market_type: str) -> str | None:
        return self._adapter.get_rest_path(stream_type, market_type)

    def build_http_params(self, req: TransportRequest) -> dict[str, Any]:
        return self._adapter.build_http_params(req)

    def build_ws_subscription(self, descriptor: StreamDescriptor) -> WsSubscriptionSpec:
        return self._adapter.build_ws_subscription(descriptor)

    def extract_http_rows(self, payload: Any, stream_type: StreamType) -> list[Any]:
        return self._adapter.extract_http_rows(payload, stream_type)
```

第一阶段的目标不是完美抽象，而是给 `TransportLayer` 之外的模块一个统一入口。

### 2. Registry 从 adapter registry 升级为 plugin registry

修改文件：

```text
backend/app/exchanges/registry.py
backend/app/exchanges/__init__.py
```

保持向后兼容：

```python
registry.get(exchange)          # 继续返回 adapter，旧调用不破
registry.get_plugin(exchange)   # 新入口
registry.list()                 # 继续返回 adapters，旧 API 不破
registry.list_plugins()         # 新入口
```

推荐 registry 内部结构：

```python
class ExchangeRegistry:
    def __init__(self) -> None:
        self._plugins: dict[str, ExchangePlugin] = {}

    def register(self, plugin: ExchangePlugin) -> None:
        self._plugins[plugin.id] = plugin

    def get_plugin(self, exchange: str) -> ExchangePlugin:
        key = exchange.strip().lower()
        if key not in self._plugins:
            raise KeyError(f"Unknown exchange: {exchange}")
        return self._plugins[key]

    def get(self, exchange: str) -> ExchangeAdapter:
        return self.get_plugin(exchange).adapter()

    def list(self) -> list[ExchangeAdapter]:
        return [plugin.adapter() for plugin in self.list_plugins()]

    def list_plugins(self) -> list[ExchangePlugin]:
        return sorted(self._plugins.values(), key=lambda plugin: plugin.id)
```

为了降低风险，先把现有 Binance / OKX 包成 plugin，不搬文件：

```python
class BinancePlugin:
    id = "binance"
    name = "Binance"

    def __init__(self) -> None:
        self._adapter = BinanceExchangeAdapter()

    def adapter(self) -> ExchangeAdapter:
        return self._adapter
```

`bootstrap_default_adapters()` 可以暂时保留名字，但内部改成注册 plugin。后续再改名为 `bootstrap_default_plugins()`。

验收：

- `/api/v1/exchanges` 返回不变。
- 所有 `get_exchange_registry().get("binance")` 旧调用继续可用。
- `get_exchange_registry().get_plugin("binance")` 可用。

### 3. Normalizer 创建迁入 exchanges

修改文件：

```text
backend/app/data_engine/ingestion/normalizers/__init__.py
backend/app/exchanges/plugin.py
backend/app/exchanges/registry.py
```

目标是移除：

```python
if exchange == "okx":
    return OkxNormalizer(...)
return BinanceNormalizer(...)
```

改为：

```python
def create_normalizer(config: IngestionConfig, descriptor: StreamDescriptor) -> ExchangeNormalizer:
    bootstrap_default_adapters()
    return get_exchange_registry().get_plugin(descriptor.exchange).normalizer(config, descriptor)
```

BinancePlugin / OkxPlugin 内部分别返回现有 normalizer：

```python
def normalizer(self, config: IngestionConfig, descriptor: StreamDescriptor) -> ExchangeNormalizer:
    return BinanceNormalizer(config, descriptor)
```

验收：

```bash
cd backend
pytest tests/test_ingestion_normalizers.py
```

新增交易所时，normalizer factory 不应再修改。

### 4. Symbol normalizer 迁入 exchanges

修改文件：

```text
backend/app/exchanges/symbols.py
backend/app/data_engine/data_manager/subscriptions.py
frontend/src/utils/symbolKey.js
```

后端先做 registry 化：

```python
def normalize_symbol(symbol: str, exchange: str = "binance", market_type: str = "spot") -> str:
    bootstrap_default_adapters()
    plugin = get_exchange_registry().get_plugin(exchange)
    return plugin.symbol_normalizer().normalize(symbol, market_type)
```

短期保留现有 Binance 逻辑作为 `BinanceSymbolNormalizer`，OKX 使用 passthrough。

然后把 subscription key 的写入逐步统一为：

```text
{exchange}:{market_type}:{symbol}
```

兼容策略：

- 读取旧 key：`spot:BTCUSDT` 仍解释为 `binance:spot:BTCUSDT`。
- 写入新 key：统一写 `binance:spot:BTCUSDT`。
- 前端选择 symbol 时必须带 exchange，不再靠 `BTC-USD` 是否包含 `-` 推断交易所。

验收：

```bash
cd backend
pytest tests/test_symbol_normalization.py tests/test_settings_api.py
```

### 5. Backfill 限速迁入 plugin policy

修改文件：

```text
backend/app/exchanges/rate_limits.py
backend/app/data_engine/backfill/fetcher.py
backend/app/data_engine/backfill/config.py
```

目标是移除 `HistoricalFetcher` 中的交易所名判断：

```python
if key == ("binance", "futures"):
    ...
elif key[0] == "okx":
    ...
```

改为：

```python
policy = get_exchange_registry().get_plugin(task.exchange).rate_limit_policy()
limit = policy.concurrency_for(task.market_type)
delay = policy.delay_for(task.market_type)
backoff = policy.retry_429_backoff_for(task.market_type)
```

`BackfillConfig` 中现有字段先不要删：

- `fetch_binance_futures_concurrency`
- `fetch_okx_concurrency`
- `fetch_binance_futures_rate_limit_delay`
- `fetch_okx_rate_limit_delay`

第一阶段让 BinancePlugin / OkxPlugin 的 policy 从 `BackfillConfig` 读取这些值。等行为稳定后，再把这些交易所专属配置迁到插件配置。

验收：

```bash
cd backend
pytest tests/test_okx_backfill_fetcher.py \
       tests/test_backfill_rate_limit.py \
       tests/test_backfill_reconciler.py
```

### 6. TransportLayer 逐步改用 protocol

修改文件：

```text
backend/app/data_engine/ingestion/transport.py
backend/app/exchanges/protocol.py
```

当前 `TransportLayer` 调 adapter：

```python
adapter.get_rest_path(...)
adapter.build_http_params(...)
adapter.get_http_base_urls(...)
adapter.build_ws_subscription(...)
adapter.extract_http_rows(...)
```

目标改成调 protocol：

```python
plugin = self._registry.get_plugin(exchange)
protocol = plugin.protocol()

rest_path = protocol.rest_path(desc.stream_type, market_type)
params = protocol.build_http_params(req)
http_urls = protocol.rest_base_urls(market_type, config=self._cfg)
rows = protocol.extract_http_rows(data, desc.stream_type)
```

这一步可以先使用 `AdapterBackedProtocol`，所以行为应完全不变。

验收：

```bash
cd backend
pytest tests/test_transport_ws_urls.py tests/test_ingestion_normalizers.py
```

### 7. WS shared multiplex 泛化

修改文件：

```text
backend/app/data_engine/ingestion/shared_ws.py
backend/app/data_engine/ingestion/session.py
backend/app/exchanges/protocol.py
backend/app/exchanges/models.py
```

目标是移除：

```python
if descriptor.exchange != "okx":
    return None
```

改为：

```python
plugin = registry.get_plugin(descriptor.exchange)
if plugin.capabilities().ws_connection_model != "shared_multiplex":
    return None
```

把 `OkxSharedKlineHub` 改成通用：

```text
OkxSharedKlineHub      -> SharedMultiplexHub
SharedWsHubRegistry    -> MultiplexHubRegistry
```

通用 hub 不负责知道 OKX payload 结构，只调用 protocol：

```python
subscribe_payload = protocol.build_combined_subscribe(descriptors)
route = protocol.route_ws_payload(payload)
```

OKX 插件提供具体 channel / instId 规则。未来 Coinbase / Bybit 如果也是 multiplex，只实现 protocol，不再复制一套 hub。

验收：

```bash
cd backend
pytest tests/test_transport_ws_urls.py tests/test_ingestion_normalizers.py
```

同时手动验证 OKX 多周期图表实时更新仍正常。

### 8. 实时更新策略 capability 化

修改文件：

```text
backend/app/data_engine/data_manager/stream_policy.py
backend/app/data_engine/bar_aggregator/router.py
backend/app/exchanges/realtime.py
backend/app/exchanges/models.py
```

目标是移除 OKX 特例：

```python
if requested.exchange != "okx":
    return False
```

改为：

```python
policy = registry.get_plugin(requested.exchange).realtime_policy()
if policy.update_mode != "base_interval_fanout":
    return False
```

`bar_aggregator.router` 中也不要判断 `exchange == "okx"`，改为：

```python
policy = registry.get_plugin(exchange).realtime_policy()
if policy.should_fanout_realtime_base(src, interval):
    ...
```

验收：

```bash
cd backend
pytest tests/test_interval_policy_consistency.py \
       tests/test_bar_aggregator_contracts.py \
       tests/test_stream_api.py
```

### 9. Frontend 改为后端 capability 驱动

修改文件：

```text
frontend/src/App.jsx
frontend/src/services/api.js
frontend/src/components/SymbolSearchModal.jsx
frontend/src/components/WatchlistSidebar.jsx
frontend/src/utils/symbolKey.js
```

目标是把 `EXCHANGE_INTERVALS` 从主要配置降级为 fallback。正常情况下：

1. App 启动时请求 `/api/v1/exchanges`。
2. interval selector 使用后端 `native_intervals`。
3. market selector 使用后端 `markets`。
4. exchange label / badge 使用后端 `name`。
5. watchlist key 写入 `{exchange}:{market_type}:{symbol}`。

后端不可用时才 fallback 到本地 Binance 默认配置。

验收：

```bash
cd frontend
npm run lint
npm run build
```

手动验证：

- Binance spot / futures 仍可选。
- OKX spot / futures 仍可选。
- 搜索结果切换交易所后，watchlist key 不冲突。
- 旧 localStorage watchlist 能读，新保存项为三段式 key。

### 10. 插件目录化

当前行为稳定后，再移动文件。不要在前面阶段边改抽象边搬文件，容易把行为回归和路径问题混在一起。

目标结构：

```text
backend/app/exchanges/plugins/binance/
  __init__.py
  plugin.py
  adapter.py
  normalizer.py
  symbols.py
  protocol.py
  rate_limits.py
  realtime.py

backend/app/exchanges/plugins/okx/
  __init__.py
  plugin.py
  adapter.py
  normalizer.py
  symbols.py
  protocol.py
  rate_limits.py
  realtime.py
```

兼容导入：

```python
# backend/app/exchanges/binance.py
from .plugins.binance.adapter import BinanceExchangeAdapter
```

这样旧 import 不会立刻断。

验收：

```bash
cd backend
pytest
```

## 每阶段提交建议

推荐按下面顺序拆 PR / commit：

1. `exchanges: add plugin protocols and compatibility wrappers`
2. `exchanges: register binance and okx as plugins`
3. `ingestion: create normalizers through exchange registry`
4. `exchanges: move symbol normalization behind plugins`
5. `backfill: use exchange rate limit policies`
6. `ingestion: route transport protocol calls through plugins`
7. `ingestion: generalize shared websocket multiplexing`
8. `data-manager: drive realtime fanout from exchange policy`
9. `frontend: load exchange capabilities from backend`
10. `exchanges: move built-in exchanges into plugin packages`

不要把所有阶段放进一个大提交。每个阶段都应该能单独跑测试并保持 Binance / OKX 行为不变。

## 执行中的风险点

### 旧 key 兼容

Binance 旧 key 如 `spot:BTCUSDT` 已经存在于 watchlist / subscriptions / localStorage。迁移时必须读旧写新，不能直接改 parser。

### OKX 实时体验

OKX 大周期目前依赖 1m fanout。把特例改 capability 时，要确保：

- 订阅 4H / 1D 时仍会启动 1m prerequisite。
- 1m 实时更新仍能推到大周期当前未收盘 candle。
- 历史 backfill 的闭合 candle 不被实时 price-only 逻辑污染。

### Backfill 分页边界

OKX 的 `before/after` 语义和 Binance `startTime/endTime` 不一样。改 protocol 时不要把分页逻辑“一刀切”抽象过度。第一阶段先只迁限速，分页后续单独抽。

### Frontend capability 缓存

前端加载 capabilities 失败时必须有 fallback，否则后端暂时没启动会导致 UI 空白。

### 自动发现不要太早做

自动扫描插件目录可以最后做。早期手动注册更容易调试，也能避免循环 import 和启动顺序问题。

## 完成标准

当以下条件满足，可以认为交易所模块升级完成：

1. 新增一个交易所不需要修改 `NormalizeLayer` / normalizer factory。
2. 新增一个交易所不需要修改 `HistoricalFetcher` 的限速分支。
3. 新增一个交易所不需要修改 `StreamEnsurePlanner` 的交易所名判断。
4. 新增一个交易所不需要修改 `bar_aggregator.router` 的交易所名判断。
5. 新增一个交易所不需要修改 frontend interval 常量。
6. REST / WS / symbol / rate limit / realtime policy 都能从 `ExchangePlugin` 获取。
7. Binance / OKX 原有测试保持通过。
8. Coinbase 这类 `BTC-USD` symbol 不会被错误推断成 OKX。

达到这个标准后，`app/exchanges` 就不再只是 adapter 集合，而是真正的交易所插件运行时。
