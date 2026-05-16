# 交易所插件模板

[English](README.md)

> 这个目录是新增交易所插件的模板。当前后端通过 `app.exchanges.registry` 注册交易所 adapter/plugin，API、symbols、ingestion、backfill 和 transport 都应通过 registry 能力查询交易所行为，而不是在业务代码里写交易所分支。

## 插件目录结构

```text
backend/app/exchanges/plugins/<exchange>/
├── __init__.py
├── adapter.py      # ExchangeAdapter 实现
├── normalizer.py   # ingestion payload normalizer
├── plugin.py       # ExchangePlugin / factory metadata
└── symbols.py      # symbol normalization and metadata helpers
```

模板文件：

| 文件 | 用途 |
|---|---|
| [adapter.py](adapter.py) | 实现交易所能力、REST/WS URL、请求参数、订阅 spec、payload extraction |
| [normalizer.py](normalizer.py) | 把交易所原始 payload 转成 ingestion 标准事件 |
| [plugin.py](plugin.py) | 插件入口，声明 adapter 和 normalizer 创建方式 |
| [symbols.py](symbols.py) | symbol 格式规范化和交易对列表转换 |

可参考内置实现：

- `backend/app/exchanges/plugins/binance/`
- `backend/app/exchanges/plugins/okx/`

## 核心接口

插件需要满足 `app.exchanges` 中的几个稳定契约：

| 契约 | 文件 | 说明 |
|---|---|---|
| `ExchangeAdapter` | `app/exchanges/base.py` | API 和 transport 使用的主要 adapter protocol |
| `ExchangePlugin` | `app/exchanges/plugin.py` | 插件创建 adapter/normalizer/symbol normalizer 的协议 |
| `ExchangeCapabilities` | `app/exchanges/models.py` | 描述 markets、intervals、features、limits |
| `WsSubscriptionSpec` | `app/exchanges/ws_protocol.py` | 描述 WS 是 path subscription 还是 message subscription |
| `RealtimePolicy` | `app/exchanges/realtime.py` | native interval、base fanout 或 polling 策略 |
| `RateLimitPolicy` | `app/exchanges/rate_limits.py` | REST/WS 限流默认值和 overrides |

## 添加新插件步骤

1. 复制 `_template` 为新目录，例如 `coinbase`。
2. 修改 package/module 名称，确保没有 `_template` 残留。
3. 在 `adapter.py` 中实现交易所能力和 URL/params 逻辑。
4. 在 `normalizer.py` 中实现 kline、ticker、trade 等 payload 标准化。
5. 在 `symbols.py` 中实现 symbol 规范化和 symbol metadata 转换。
6. 在 `plugin.py` 中返回 adapter、normalizer 和 symbol normalizer。
7. 在 `app/exchanges/registry.py` 的 `bootstrap_default_adapters()` 中注册，或接入后续动态发现机制。
8. 增加测试，至少覆盖 capabilities、symbol normalization、REST URL、WS URL/subscription spec、normalizer 和 backfill fetch 行为。

## Adapter 需要表达的能力

至少明确：

- `id`：交易所 id，例如 `binance`、`okx`。
- `capabilities()`：支持的 market types、intervals、REST/WS 特性。
- REST base URL selection：spot/futures/swap 等不同 market type 的 URL。
- WS URL selection：public/business/private 或 spot/futures endpoint。
- Historical kline params：symbol、interval、start/end、limit 的交易所参数名和格式。
- WebSocket subscription spec：通过 path 订阅还是 connect 后发送 subscribe message。
- Payload extraction：从交易所 response 中取出 kline/ticker arrays。
- Rate limit policy：并发、delay、429 backoff。
- Realtime policy：是否支持 native interval，或需要 base interval fanout/polling。
- Price stream type：ticker、mini ticker 或其他轻量价格流。

## Normalizer 要求

normalizer 输出必须对齐 ingestion 的 `MarketEvent.data` 约定：

- kline 需要提供 `open_time`、`close_time`、`open`、`high`、`low`、`close`、`volume`、`is_closed` 等字段。
- ticker/price 需要提供当前价格、时间戳和原始 payload 中可用的成交量/涨跌信息。
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
  tests/test_exchange_registry_plugins.py \
  tests/test_symbol_normalization.py \
  tests/test_transport_ws_urls.py \
  tests/test_ingestion_normalizers.py
```

新增交易所通常还需要自己的 fetcher/normalizer 测试，参考 `tests/test_okx_backfill_fetcher.py`。
