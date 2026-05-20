# Backfill 交易所限流架构

> 目标：让历史 REST backfill 按交易所、market type、endpoint 和请求权重独立限流。业务调度仍归 `BackfillCoordinator`，交易所额度归 exchange plugin 和 `RateLimitManager`，避免 Binance、OKX 或不同 endpoint 之间错误叠加。

## 1. 架构边界

```text
BackfillCoordinator
  - 业务优先级
  - request 合并 / 去重
  - chunk 调度
  - 同一 (exchange, market_type, symbol, interval) 串行
  - 跨 series 并发
  - 不理解交易所 REST quota

BackfillEngine
  - detect / plan / fetch / reconcile / publish
  - 不决定交易所配额

HistoricalFetcher
  - 构造历史 REST 请求
  - 每次 HTTP 请求前调用 RateLimitManager.acquire()
  - 请求完成或出错后把 response metadata 反馈给 RateLimitManager
  - 不硬编码 Binance / OKX 额度

ExchangePlugin
  - 拥有 pagination policy
  - 拥有 symbol / market 规范化
  - 拥有 endpoint-aware rate-limit policy

RateLimitManager
  - 执行 token bucket / cooldown
  - 按 exchange + endpoint + scope 分桶
  - 处理 Retry-After、X-MBX-USED-WEIGHT-*、OKX 50011
```

核心原则：

- 业务优先级不进入 exchange plugin。
- 交易所限流规则不进入 `BackfillCoordinator`。
- Binance 和 OKX 的额度不叠加。
- Binance spot 和 futures 的额度不默认叠加。
- OKX `/api/v5/market/candles` 和 `/api/v5/market/history-candles` 不默认叠加。
- 全局 fetch 并发只作为本机资源保护，不作为交易所额度模型。

## 2. 核心模型

### HistoricalRequest

`HistoricalFetcher` 会把 `BackfillTask` 和 `TransportRequest` 转成限流器可理解的 `HistoricalRequest`：

```python
HistoricalRequest(
    exchange="binance",
    market_type="futures",
    endpoint="/fapi/v1/klines",
    symbol="BTCUSDT",
    interval="1m",
    start_ms=...,
    end_ms=...,
    limit=1000,
)
```

这个对象只描述 REST 请求，不携带业务优先级。

### RateLimitRule

`RateLimitRule` 是 exchange plugin 声明的 endpoint 规则：

```python
RateLimitRule(
    name="binance_futures_klines",
    bucket_key="binance:futures:request_weight:ip",
    endpoint="/fapi/v1/klines",
    market_types=("futures",),
    capacity=2400,
    refill_interval_seconds=60.0,
    cost=binance_futures_kline_cost,
    max_concurrency=1,
    cooldown_seconds=60.0,
)
```

`bucket_key` 必须表达真实限流作用域。不同交易所、不同 endpoint 或不同额度池应使用不同 bucket key。

### RateLimitManager

`RateLimitManager` 在 fetcher 内部维护 bucket 状态：

- `acquire(rule, request)`：请求前消耗 token，不足时等待。
- `record_response(...)`：请求后记录响应状态、header 和交易所 body code。
- `record_cooldown(...)`：对指定 bucket 设置 cooldown。
- `snapshot()`：输出运行时 bucket 状态给 diagnostics。

## 3. 当前交易所规则

### Binance spot klines

- Endpoint: `/api/v3/klines`
- Bucket: `binance:spot:request_weight:ip`
- 默认容量: `BACKFILL_RATE_LIMIT_BINANCE_SPOT_WEIGHT_PER_MINUTE`
- 默认成本: 每次请求 `2`
- 响应反馈: `X-MBX-USED-WEIGHT-*` 会校正 bucket 剩余额度

### Binance USD-M futures klines

- Endpoint: `/fapi/v1/klines`
- Bucket: `binance:futures:request_weight:ip`
- 默认容量: `BACKFILL_RATE_LIMIT_BINANCE_FUTURES_WEIGHT_PER_MINUTE`
- 请求成本按 `limit` 计算：

```text
limit < 100       -> 1
100 <= limit < 500 -> 2
500 <= limit <= 1000 -> 5
limit > 1000      -> 10
```

当前 backfill 默认 page size 通常是 `1000`，所以 futures 每页默认成本是 `5`，不是 `1`。

### OKX market candles

- Endpoint: `/api/v5/market/candles`
- Bucket: `okx:market-candles:ip`
- 默认容量: `BACKFILL_RATE_LIMIT_OKX_CANDLES_REQUESTS_PER_2S`
- 窗口: `2s`
- 请求成本: `1`

### OKX history candles

- Endpoint: `/api/v5/market/history-candles`
- Bucket: `okx:history-candles:ip`
- 默认容量: `BACKFILL_RATE_LIMIT_OKX_HISTORY_CANDLES_REQUESTS_PER_2S`
- 窗口: `2s`
- 请求成本: `1`

OKX 返回 body code `50011` 时，会被视为限流信号，只冷却匹配的 endpoint bucket。

## 4. 配置语义

新限流结构把“本机并发保护”和“交易所 quota”分开：

| 配置 | 语义 |
|---|---|
| `BACKFILL_FETCH_CONCURRENCY` | 兼容保留的通用 REST 并发 fallback |
| `BACKFILL_FETCH_GLOBAL_CONCURRENCY` | 进程级 REST fetch 总并发，本机资源保护 |
| `BACKFILL_FETCH_BINANCE_SPOT_CONCURRENCY` | Binance spot endpoint 并发 |
| `BACKFILL_FETCH_BINANCE_FUTURES_CONCURRENCY` | Binance futures endpoint 并发 |
| `BACKFILL_FETCH_OKX_CONCURRENCY` | OKX endpoint 并发 |
| `BACKFILL_FETCH_429_BACKOFF_SECONDS` | 兼容 fallback cooldown |
| `BACKFILL_RATE_LIMIT_SAFETY_FACTOR` | 对交易所额度应用的保守系数 |
| `BACKFILL_RATE_LIMIT_BINANCE_SPOT_WEIGHT_PER_MINUTE` | Binance spot request-weight 额度 |
| `BACKFILL_RATE_LIMIT_BINANCE_FUTURES_WEIGHT_PER_MINUTE` | Binance futures request-weight 额度 |
| `BACKFILL_RATE_LIMIT_OKX_CANDLES_REQUESTS_PER_2S` | OKX market candles 请求窗口 |
| `BACKFILL_RATE_LIMIT_OKX_HISTORY_CANDLES_REQUESTS_PER_2S` | OKX history candles 请求窗口 |

`BACKFILL_FETCH_RATE_LIMIT_DELAY`、`BACKFILL_FETCH_BINANCE_FUTURES_RATE_LIMIT_DELAY` 和 `BACKFILL_FETCH_OKX_RATE_LIMIT_DELAY` 仍保留为 legacy fallback，用于未声明 endpoint rules 的交易所或自定义 limiter。

并发配置会在 exchange policy 内归一化到至少 `1`。负数 cooldown 会归一化为 `0`；
OKX endpoint 规则仍会保留最小 `2s` cooldown，因为这是该 endpoint 的请求窗口。

## 5. 运行时反馈

`TransportLayer` 会把 HTTP metadata 传回 fetcher：

- HTTP status
- HTTP headers
- exchange body code

处理规则：

- HTTP `429` / `418`：进入对应 bucket cooldown。
- `Retry-After`：优先作为 cooldown 时长。
- Binance `X-MBX-USED-WEIGHT-*`：校正对应 request-weight bucket token。
- OKX `50011`：进入对应 OKX endpoint bucket cooldown。

这样 Binance spot cooldown 不会影响 OKX，OKX history-candles cooldown 也不会影响 OKX market-candles。

## 6. 诊断

### Backfill engine snapshot

`HistoricalFetcher.snapshot()` 暴露 `exchange_rate_limits`：

```json
{
  "exchange_rate_limits": {
    "binance:spot:request_weight:ip": {
      "rule": "binance_spot_klines",
      "algorithm": "header_weight",
      "capacity": 960,
      "refill_interval_seconds": 60.0,
      "max_concurrency": 2,
      "tokens": 948,
      "cooldown_remaining_seconds": 0,
      "last_wait_seconds": 0,
      "last_status_code": 200,
      "last_headers": {
        "x-mbx-used-weight-1m": "12"
      }
    }
  }
}
```

`/api/v1/settings/storage/health` 会同时返回 coordinator snapshot 和 backfill engine snapshot，因此可以同时排查业务调度和交易所限流。

### Exchange diagnostics

`/api/v1/exchanges/diagnostics` 暴露 plugin 声明的 `rate_limit_rules`，用于在 backfill 未运行时检查 exchange plugin 的限流配置。

### Scheduler buckets

`BackfillCoordinator` 仍有本地 dispatch bucket，用来解释 chunk 派发节奏。它不是交易所 REST quota。诊断字段为：

- `scheduler_buckets`：推荐读取的新字段。
- `buckets`：兼容旧诊断字段。

## 7. 新交易所接入要求

新增 exchange plugin 时，应在 `rate_limit_policy(config)` 中声明：

- endpoint path
- market type
- bucket key
- capacity / refill interval
- request cost
- endpoint max concurrency
- cooldown seconds

如果某个交易所或 endpoint 暂时没有明确规则，`RateLimitPolicy.rule_for()` 会退回 legacy delay/concurrency 行为，但这只应作为兼容兜底。

## 8. 验证清单

关键测试：

- `tests/test_backfill_rate_limit.py`
- `tests/test_transport_http_rate_limit_metadata.py`
- `tests/test_exchanges_api.py`
- `tests/test_settings_api.py`
- `tests/test_backfill_coordinator.py`

完整后端回归：

```bash
cd backend
python -m pytest tests -q
```

## 9. 官方规则来源

这些默认值来自交易所公开文档和保守配置。交易所规则可能调整，修改默认额度前应重新核对官方文档。

- Binance Spot REST API limits: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits
- Binance Spot market data endpoints: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints
- Binance USD-M futures kline endpoint: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data
- Binance USD-M futures exchange information: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information
- OKX API v5 candlesticks: https://app.okx.com/docs-v5/en/

## 10. 结论

这次升级没有推翻 backfill 架构。`BackfillCoordinator` 继续负责业务调度，`BackfillEngine` 继续负责修复流水线，交易所规则被收进 exchange plugin，限流执行集中在 `RateLimitManager`。

最终边界是：

```text
业务调度：BackfillCoordinator / Scheduler
交易所规则：ExchangePlugin.rate_limit_policy()
执行限流：RateLimitManager
实际请求：TransportLayer
```
