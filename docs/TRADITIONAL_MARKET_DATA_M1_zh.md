# 传统金融行情 M1：Twelve Data 历史接入

状态：已实现并默认 fail-closed。只有后端配置 `INGESTION_TWELVE_DATA_API_KEY` 后才会访问供应商；M1 不开启 Twelve Data 实时行情。

## 1. 能力边界

| 资产 | CandleScope `market_type` | 历史周期 | volume 语义 | M1 实时 |
|---|---|---|---|---|
| 股票 | `stock` | `1d`、`1w`、`1M` | `shares`，缺失即拒绝该行 | 禁用 |
| ETF | `etf` | `1d`、`1w`、`1M` | `shares`，缺失即拒绝该行 | 禁用 |
| 外汇 | `forex` | `1m`、`5m`、`15m`、`30m`、`1h`、`2h`、`4h`、`8h`、`1d`、`1w`、`1M` | `unavailable` | 禁用 |
| 指数 | `index` | `1d`、`1w`、`1M` | `unavailable` | 禁用 |
| 商品 | `commodity` | 与外汇相同 | `unavailable` | 禁用 |

股票、ETF、指数的盘中 K 线需要更精确的交易所 session、节假日、盘前盘后和 entitlement 验证，因此没有在 M1 中开放。外汇与商品按工作日 24x5 网格处理。空页只有在供应商请求成功时才会作为权威空档证据；网络、鉴权或限流失败不会被学习成“没有历史”。

## 2. 数据身份

传统金融 K 线不能只用 `exchange + market_type + symbol + interval` 区分。symbol search 返回的结果同时携带：

```text
provider_id      = twelvedata
venue            = 交易场所 MIC；例如 XNGS
asset_class      = stock / etf / forex / index / commodity
series_variant   = ohlcv
price_adjustment = raw
session_variant  = regular 或 continuous_24x5
volume_semantics = shares 或 unavailable
```

这些维度进入 Kline API、回填任务、SQLite 主键、内存窗口、图表 dataset key 和工作区持久化。原有加密货币默认身份继续使用旧 key，不发生缓存和存储迁移语义变化。

M1 对 `/time_series` 显式发送 `adjust=none`。这意味着当前保存的是 raw series，不会把拆股或分红调整序列与原始价格混在一起。

## 3. 配置

在启动后端的环境中设置：

```powershell
$env:INGESTION_TWELVE_DATA_API_KEY = "your-server-side-key"
$env:INGESTION_TWELVE_DATA_CONCURRENCY = "1"
$env:INGESTION_TWELVE_DATA_CREDITS_PER_MINUTE = "8"
```

可选覆盖：

```powershell
$env:INGESTION_TWELVE_DATA_HTTP_BASE_URLS = "https://api.twelvedata.com"
```

key 只进入 HTTP `Authorization: apikey ...` header；不应写入前端 `.env`、查询参数或可提交的配置文件。配置 snapshot 会将它替换成 `***`。历史请求和 symbol search 共用同一个 provider credit bucket，并读取 `api-credits-left` 响应头收紧本地额度。

## 4. 使用流程

1. 启动后端和前端。
2. 在 symbol picker 中选择 `Twelve Data`。
3. 输入关键词；该 provider 没有全量本地目录，前端停顿 250 ms 后调用服务端 query-only search。
4. 选择返回的 instrument。前端会把 provider symbol（例如 `AAPL:NASDAQ`）、MIC、entitlement 和完整 series identity 带入图表 session。
5. 图表只启动历史查询/回填，不启动 Twelve Data WebSocket 或 HTTP live polling。

服务端 symbol search 示例：

```text
GET /api/v1/symbols/exchange-info?exchange=twelvedata&market_type=stock&search=AAPL
```

返回结果中的 `providerId`、`venue`、`assetClass`、`seriesVariant`、`priceAdjustment`、`sessionVariant`、`volumeSemantics` 是 Kline 请求不可丢失的身份字段。正常 UI 会自动传递它们。

## 5. 供应商协议决策

- `/symbol_search` 使用 `show_plan=true`，把供应商返回的访问计划保存为 `entitlement`，但不把它误写成 CandleScope 自己保证的实时权限。
- `/time_series` 单次最多请求 5000 行；当范围更大时按最早返回 bar 向过去反向分页。
- 日线及更粗数据按供应商的 exchange-local date 接收，并稳定映射为 UTC 午夜的 provider date；这不是“交易所开盘时刻”。实测周线使用周一日期，月线使用自然月 1 日（即使是周末），专用日历按这两个锚点校验。
- 供应商未提供 volume 的外汇、指数、商品行会保留 OHLC，写入兼容数值 `0`，同时以 `volume_semantics=unavailable` 和 event `volume_available=false` 明确禁止误读。
- M1 不声称覆盖交易所官方全量历史、官方复权序列、盘前盘后或实时再分发权限。

供应商协议参考：[API overview](https://twelvedata.com/docs/introduction/overview)、[historical data](https://support.twelvedata.com/en/articles/5214728-getting-historical-data)、[credits](https://support.twelvedata.com/en/articles/5615854-credits)、[price adjustment](https://support.twelvedata.com/en/articles/5179064-are-the-prices-adjusted)、[April 2026 timezone update](https://twelvedata.com/news/april-2026-updates)。

## 6. 验证

```powershell
python -m pytest -q backend/tests/test_twelve_data_provider.py `
  backend/tests/test_exchange_plugin_contracts.py `
  backend/tests/test_exchange_registry_plugins.py `
  backend/tests/test_exchanges_api.py `
  backend/tests/test_kline_series_identity.py

Set-Location frontend
npx tsc --noEmit
npx tsx --test --test-concurrency=1 `
  "src/features/market-data/__tests__/klineSeriesIdentity.test.ts" `
  "src/features/chart-workspace/__tests__/chartWorkspaceStorage.test.ts" `
  "src/features/symbol-search/__tests__/symbolSearchKernels.test.ts"
```
