# 传统金融行情 M2：Twelve Data Basic 实时与美股盘中历史

状态：已实现，面向 Twelve Data Basic（免费）额度。M2 继承 M1 的 symbol search、完整 series identity、raw 历史序列和 fail-closed 鉴权，并新增美股/ETF 盘中历史和实时价格订阅。

## 1. 免费版可用能力

| 能力 | CandleScope 行为 | 免费版边界 |
|---|---|---|
| 美股/ETF 盘中历史 | `/time_series`，`1m`、`5m`、`15m`、`30m`、`45m`、`1h`、`2h`、`4h`、`8h` | 仅美国 venue identity、常规交易时段、raw 价格；单页最多 5000 根 |
| 股票/ETF 日线及更粗 | 沿用 M1 的 `1d`、`1w`、`1M` | provider exchange date |
| 外汇/商品历史 | 沿用 M1 的分钟至月线 | 商品是否可取仍由供应商 entitlement 决定 |
| 实时报价 | 一个服务端共享 WebSocket，ticker 事件进入价格订阅/自选链路 | 最多 8 个唯一 symbol；不是实时 K 线 |
| 报价快照 | 每个 WebSocket generation 用 `/quote` 补 open/high/low/change/volume | 与历史和搜索共用 REST credit bucket |
| 故障恢复 | 自动重连；达到 unhealthy 阈值后进入 REST quote fallback；WS 恢复后切回 | 不把断线期间缺失 tick 伪造成完整成交历史 |

Twelve Data WebSocket 当前只给 price tick 和可选 day volume，不给 OHLC、bid/ask 或技术指标。因此 M2 明确声明 `KLINE.realtime=false`；图表中的历史分钟 K 线来自 REST，实时 WebSocket 只更新价格列、自选和其他 ticker 消费者。

## 2. 美国交易日历

美股/ETF 的盘中完整性检查使用 `exchange_calendars==4.13.2` 的 XNYS schedule，并映射到 `America/New_York`：

- 正常日为 09:30–16:00；
- 美国交易所节假日不生成期望 bar；
- 半日市按真实提前收盘时间截断；
- 夏令时转换后 UTC 开盘时间自动变化；
- 日线、周线、月线继续保留 M1 的 provider date 语义。

当前内置 schedule 范围为 2000-01-01 至 2045-12-31。股票/ETF 盘中请求还必须携带美国 venue（例如 `XNGS`、`XNAS`、`XNYS`、`ARCX`）；非美国 venue 会在请求前 fail-closed，不会套用错误日历。

## 3. WebSocket 运行模型

后端为同一配置池化一条物理连接：

```text
最多 8 个逻辑 ticker 订阅
        ↓ subscribe / unsubscribe 引用计数
1 条 Twelve Data WebSocket
        ↓ price tick
各自的 CandleScope ticker pipeline
```

- 重连时在一条 subscribe frame 中恢复当前 desired symbol set；
- 每 10 秒发送供应商建议的应用层 heartbeat，同时保留协议级 ping/pong；
- 相同 symbol 的多个消费者共用一个供应商订阅 credit；
- 配置值即使大于 8，也会按 Basic 契约硬性封顶 8；
- 诊断同时报告 physical websocket、logical subscribers、generation、reconnect、heartbeat 和 receive-gap 指标，但不列出 API key；
- 供应商要求 WebSocket key 位于握手 query。URI 仅在后端 sidecar 内临时构造，握手 logger 被限制，异常会脱敏，配置和运行时 snapshot 不保存明文 key。

## 4. 配置

必需：

```powershell
$env:INGESTION_TWELVE_DATA_API_KEY = "your-server-side-key"
```

M2 可选配置及默认值：

```powershell
$env:INGESTION_TWELVE_DATA_WS_ENABLED = "true"
$env:INGESTION_TWELVE_DATA_WS_BASE_URL = "wss://ws.twelvedata.com/v1/quotes/price"
$env:INGESTION_TWELVE_DATA_WS_MAX_SYMBOLS = "8"
$env:INGESTION_TWELVE_DATA_WS_QUEUE_SIZE = "512"
$env:INGESTION_TWELVE_DATA_WS_HEARTBEAT_INTERVAL = "10"
$env:INGESTION_TWELVE_DATA_CREDITS_PER_MINUTE = "8"
```

`WS_BASE_URL` 不允许自带 query 或 fragment，避免通过配置旁路 secret 处理。关闭 `WS_ENABLED` 后 ticker 会走现有 REST polling 路径；历史查询不受影响。

## 5. 明确不做的能力

- 不从 price tick 拼接并宣称供应商级实时 OHLC K 线；
- 不开放 Basic 未包含的盘前盘后；
- 不把指数盘中、全球股票盘中、一般商品 entitlement 或完整 fundamentals 伪装成免费能力；
- 不接供应商技术指标 endpoint；CandleScope 指标继续基于已获取 K 线本地计算；
- 不声称免费 key 具有对外再分发行情的法律授权。

## 6. 验证

2026-08-30 使用进程环境中的 Basic key 做过真实冒烟，key 未写入仓库：

- `/quote`：AAPL 返回一个有效报价，share volume 可用；
- `/time_series`：AAPL 常规时段 `1min` 返回连续 5 根；
- WebSocket：一条 EUR/USD 连接收到真实 price 事件，并成功发送应用层 heartbeat；
- 完整 `ExchangeIngestionFactory.start_price()`：价格订阅回调收到正价格更新；
- 配置和运行时诊断快照均不含明文 key。

专项与相关回归命令：

```powershell
$env:PYTHONPATH = "backend"
python -m pytest -q `
  backend/tests/test_twelve_data_provider.py `
  backend/tests/test_exchange_plugin_contracts.py `
  backend/tests/test_exchange_capabilities_v2.py `
  backend/tests/test_ingestion_session_types.py `
  backend/tests/test_price_subscription_services.py

ruff check `
  backend/app/exchanges/plugins/twelvedata `
  backend/tests/test_twelve_data_provider.py
```

供应商边界以官方当前说明为准：[Basic trial](https://support.twelvedata.com/en/articles/5335783-trial)、[WebSocket streaming](https://support.twelvedata.com/en/articles/5620516-how-to-stream-the-data)、[WebSocket FAQ](https://support.twelvedata.com/en/articles/5194610-websocket-faq)、[historical prices](https://support.twelvedata.com/en/articles/5656039-how-to-get-historical-prices)。
