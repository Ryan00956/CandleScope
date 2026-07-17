# 交易所插件模板

[English](README.md)

> 这个目录是新增交易所插件的模板。后端通过 `app.exchanges.registry` 注册交易所插件；API、symbols、ingestion、backfill 和 transport 代码应该查询 registry/plugin 暴露的能力，而不是在业务模块里写交易所分支。

## 插件目录结构

```text
backend/app/exchanges/plugins/<exchange>/
├── __init__.py
├── adapter.py      # legacy facade / 可选 symbol metadata helper
├── normalizer.py   # ingestion payload normalizer
├── pagination.py   # 可选历史分页策略
├── plugin.py       # ExchangePlugin / factory metadata
├── protocol.py     # REST/WS request spec 和 payload routing
└── symbols.py      # symbol normalization and metadata helpers
```

模板文件：

| 文件 | 用途 |
|---|---|
| [adapter.py](adapter.py) | 旧 adapter 兼容门面，以及可选 symbol metadata helper |
| [normalizer.py](normalizer.py) | 把交易所原始 payload 转成 ingestion 标准事件 |
| [pagination.py](pagination.py) | 当默认倒序时间分页不适用时，声明交易所历史分页策略 |
| [plugin.py](plugin.py) | 插件入口，组合 protocol、normalizer、symbol、rate limit、pagination、realtime 策略 |
| [protocol.py](protocol.py) | REST/WS request spec、subscription spec、payload routing |
| [symbols.py](symbols.py) | symbol 格式规范化和交易对列表转换 |

可参考内置实现：

- `backend/app/exchanges/plugins/binance/`
- `backend/app/exchanges/plugins/okx/`

## 核心契约

| 契约 | 文件 | 说明 |
|---|---|---|
| `ExchangeAdapter` | `app/exchanges/base.py` | 旧兼容门面，不是新增能力入口 |
| `ExchangePlugin` | `app/exchanges/plugin.py` | 交易所组合根，提供 protocol、normalizer 和各类 policy |
| `ExchangeProtocol` | `app/exchanges/protocol.py` | REST/WS request spec 和 raw payload routing |
| `ExchangeCapabilities` | `app/exchanges/models.py` | 描述 markets、intervals、features、limits、limitations |
| `WsSubscriptionSpec` | `app/exchanges/ws_protocol.py` | 描述 WS 是 path subscription 还是 message subscription |
| `HistoricalPaginationPolicy` | `app/exchanges/pagination.py` | 交易所历史分页边界语义 |
| `RealtimePolicy` | `app/exchanges/realtime.py` | native interval、base fanout 或 polling 策略 |
| `RateLimitPolicy` | `app/exchanges/rate_limits.py` | REST/WS 限流默认值和 overrides |
| `ExchangeContractCase` | `app/exchanges/contracts.py` | protocol、policy、normalizer 契约测试 fixture |
| `NormalizerContractSample` | `app/exchanges/contracts.py` | 必须解析成 schema-valid `MarketEvent` 的 raw payload 样本 |

## 添加新插件步骤

1. 复制 `_template` 为新目录，例如 `coinbase`。
2. 修改 package/module 名称，确保没有 `_template` 占位残留。
3. 在 `adapter.py` 中保留兼容门面和可选 symbol metadata 行为。
4. 在 `protocol.py` 中实现 REST/WS request spec、subscription spec 和 payload routing。
5. 在 `normalizer.py` 中实现 kline、ticker、trade 等 payload 标准化。
6. 在 `symbols.py` 中实现 symbol 规范化和 symbol metadata 转换。
7. 如果默认倒序时间分页不适用，在 `pagination.py` 中实现交易所分页策略。
8. 在 `plugin.py` 中返回 protocol、normalizer、symbol normalizer 和各类 policy。
9. 保持 `plugin_api_version="1.0"`；`capability_schema_version` 应选择插件完整实现的最高版本（内置模板示范 schema v3）。
10. 通过 `bootstrap_default_adapters()` 注册内置插件，或用 `CANDLESCOPE_EXCHANGE_PLUGINS=module.path,module.path:factory` 显式加载外部插件。
11. 在 `tests/fixtures/exchanges/` 下增加 `ExchangeContractCase` 和 `NormalizerContractSample` 契约 fixture。
12. 覆盖 capabilities、symbol normalization、REST spec、WS spec/subscription、normalizer、pagination 和 backfill fetch 行为。

## Plugin 需要表达的能力

至少明确：

- `id`：交易所 id，例如 `binance`、`okx`。
- `capabilities()`：支持的 market types、intervals、REST/WS 特性。
- `plugin_api_version`：`ExchangeRegistry` 消费的插件主契约版本。
- `capability_schema_version`：能力元数据 schema 版本。
- schema v3 `markets`：声明 `calendar_id` 和 `timezone`。
- schema v3 历史 `channels`：在 `history_policy` 中声明强类型 cadence、空页语义、calendar identity 和有限历史边界。
- `protocol_features`：稳定 feature flags，例如 `rest.kline`、`ws.shared_multiplex`、`pagination.reverse_time`。
- `limits`：机器可读限制，例如 `rest.kline.max_limit`。
- `known_limitations`：前端或 diagnostics 可以展示的真实限制。
- REST request spec：spot/futures/swap 等不同 market type 的 URL、path、params。
- WS connection spec：public/business/private 或 spot/futures endpoint。
- Historical kline params 和 pagination boundary：symbol、interval、start/end、limit 的交易所参数名和格式。
- WebSocket subscription spec：通过 path 订阅还是 connect 后发送 subscribe message。
- Payload extraction/routing：从交易所 response 中取出 kline/ticker arrays，并把 WS payload 匹配到 descriptor。
- Rate limit policy：并发、delay、429 backoff。
- Realtime policy：是否支持 native interval，或需要 base interval fanout/polling。
- Price stream type：ticker、mini ticker 或其他轻量价格流。

## Normalizer 要求

normalizer 输出必须对齐 ingestion 的 `MarketEvent.data` 约定：

- kline 需要提供 `open_time`、`close_time`、`open`、`high`、`low`、`close`、`volume`、`is_closed` 等字段。
- ticker/price 需要提供当前价格、时间戳和原始 payload 中可用的成交量、涨跌信息。
- 所有时间戳使用毫秒。
- symbol 应使用该交易所在后端内部的 canonical 格式。
- 不要在 normalizer 中写 storage 或触发 backfill。

## Symbol 规则

不同交易所的 symbol 规则可以不同：

- Binance 内部通常使用 `BTCUSDT`。
- OKX 内部保留 hyphenated 格式，例如 `BTC-USDT` 或 `BTC-USDT-SWAP`。
- 如果用户输入跨交易所格式，`normalize_symbol(symbol, exchange, market_type)` 应转换为目标交易所 canonical 格式。

相关测试应覆盖常见别名、swap/futures 后缀、大小写和无效输入。

## 测试建议

```bash
cd backend
python -m pytest -q \
  tests/test_exchange_plugin_contracts.py \
  tests/test_exchange_registry_plugins.py \
  tests/test_symbol_normalization.py \
  tests/test_transport_ws_urls.py \
  tests/test_ingestion_normalizers.py
```

新增交易所通常还需要自己的 fetcher/normalizer 测试；可参考 `tests/test_okx_backfill_fetcher.py`。

contract fixtures 应包含：

- 每个支持的数据流对应的 descriptor/request。
- 用于 `protocol.extract_http_rows()` 的 REST sample payload。
- 必须解析成 schema-valid `MarketEvent.data` 的 normalizer raw payload sample。
- 某个交易所额外暴露语义时，对应的 exchange-specific required data fields。
