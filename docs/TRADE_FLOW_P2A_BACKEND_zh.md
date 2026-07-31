# TradeFlow P2A（后端）

## 目标与边界

P2A 在现有 K 线主链和 P1 高级行情状态主链旁，新增一条独立的 append-only 成交主链。首个垂直切片以 Binance Futures `aggTrade` 为生产验收目标：

- 浏览器接收 50ms 左右的原始聚合成交批次；
- 后端按 1 分钟增量计算主动买卖量、Volume Delta 和成交计数；
- 1 分钟汇总通过抽象存储接口落入 SQLite；
- 原始 `aggTrade` 可选择写入分区 Parquet，为未来成交驱动的 K 线回放准备数据；
- 原始归档和汇总存储都不进入现有 K 线表，也不修改 `market.v1` 或 K 线 WebSocket。

```text
K 线主链：Exchange -> Ingestion -> BarAggregator -> Kline cache/SQLite -> Kline API/WS

P1 状态主链：Exchange -> MarketDataService -> latest-wins Hub -> market.v1

P2A 成交主链：
Binance aggTrade WS -> ordered command queue -> TradeFlowEngine
                                         |-> append batch Hub -> tradeflow.v1
                                         |-> 1m rollup writer -> TradeFlowRollupStore
                                         `-> optional raw writer -> RawAggTradeArchive
```

这轮不包含 liquidation、订单簿、前端成交带或逐笔 CVD pane。绝对 CVD 也不会落库；调用方只能在一段连续且完整的 1 分钟 Delta 上做前缀和。

## 成交与汇总契约

归一化 `aggTrade` 保留：

- `agg_trade_id`；
- `first_trade_id` / `last_trade_id`；
- `price`、`quantity`、派生的 `quote_quantity`；
- `trade_time_ms`、`event_time_ms`、`received_at_ms`；
- `is_buyer_maker`、派生的 `aggressor_side`；
- exchange、market type、symbol 和 source。

Binance 的 `is_buyer_maker=true` 表示买方是挂单方，因此主动方向为卖；反之为买。

每个 1 分钟桶保存：

- 主动买/卖 base volume；
- 主动买/卖 quote volume；
- base/quote Volume Delta；
- `agg_trade_count`；
- 根据 `first_trade_id..last_trade_id` 累计的底层 `trade_count`；
- `max_agg_trade_quote`；
- 首尾 aggregate trade ID；
- `is_final`、`is_complete` 和单调 `revision`。

`aggTrade` 是交易所聚合成交，不等同于每一条原始撮合。它足以保留本阶段按成交驱动重建 OHLCV 和成交量所需的价格、数量、方向、时间与 ID 范围，但不会恢复同一 aggregate 内每条 fill 的独立顺序。若未来回放需要撮合级明细，应新增另一种 raw trade archive，而不是把本数据集改名冒充逐笔撮合。

## 顺序、缺口与完整性

单个 market identity 只有一个有序 engine writer。交易所回调只进入有界 FIFO；REST 修复、SQLite 和 Parquet I/O 都不在回调中执行。

- ID 重复会被幂等拒绝；
- 非缺口内的旧 ID 会被拒绝；
- 发现 `left_id + 1 < right_id` 时，受影响桶立即标为 `is_complete=false`；
- 修复使用 Binance `fromId`，每页最多 1000 条，并逐 ID 验证返回范围；
- 临时 REST 失败会进入有界重试；重试耗尽会在诊断中保持 degraded，而不是把缺口当成已修复；
- 页缺失、乱序、跨 identity 或超出修复预算都保持 incomplete；
- 精确补齐后桶可从 incomplete 恢复 complete；
- 后发现的缺口允许 complete 从 true 降为 false；
- 内存中的精确 gap 区间有硬上限；被折叠或超出保留窗口的历史缺口会留下永久 incomplete 标记，不能因明细淘汰而恢复成 complete；
- `is_final` 只能从 false 变 true，不能回退；
- 第一条实时成交通常出现在分钟中段，因此首个桶默认 incomplete，不能假装拥有分钟前缀。

慢 WebSocket 客户端或有界队列裁剪不会静默继续。下一批带 `continuity=false`、`resync_required=true` 和 `dropped_before`；浏览器端点发出显式重同步消息并以 1013 关闭连接。

## 存储抽象与 DuckDB 升级点

业务层只依赖两个接口：

1. `TradeFlowRollupStore`
   - `upsert_rollups`
   - `query_rollups`
   - `query_recent_rollups`
   - `diagnostics`
2. `RawAggTradeArchive`
   - `append`
   - `scan_range`
   - `coverage`
   - `diagnostics`

当前 `TRADE_FLOW_ROLLUP_BACKEND=sqlite` 使用独立的 `trade_flow_rollup_1m` 表。最终桶写入采用有界指数退避；瞬时 SQLite 错误恢复后正常确认，重试耗尽则 writer 保持 sticky degraded，不能静默把失败当成功。以后增加 DuckDB 时，应实现同一个异步 rollup store，并在 runtime factory 增加 `duckdb` 分支；TradeFlowEngine、HTTP 和 WS 不需要知道数据库类型。

回放读取方应依赖 `RawAggTradeArchive.scan_range()` 和 `coverage()`，不能依赖 Parquet 目录细节。这样未来可在接口后换成 DuckDB 扫描、DuckDB 管理的 Parquet view，或其他列式存储。

未知的 rollup/archive backend 会在启动时失败，不会悄悄回退成另一种存储。

## 可选原始 Parquet 归档

默认关闭：

```text
RAW_AGG_TRADE_ARCHIVE_ENABLED=0
```

启用前安装可选依赖：

```powershell
python -m pip install -r backend/requirements-parquet.txt
```

然后配置：

```text
RAW_AGG_TRADE_ARCHIVE_ENABLED=1
RAW_AGG_TRADE_ARCHIVE_BACKEND=parquet
RAW_AGG_TRADE_ARCHIVE_DIR=<data-dir>/raw-agg-live-spool
```

目录按 identity 和 UTC 日期分区：

```text
exchange=binance/
  market_type=futures/
    symbol=BTCUSDT/
      date=2026-07-14/
        part-<first-id>-<last-id>-<uuid>.parquet
```

写入采用不可变 micro-batch 文件，先写同目录临时文件再原子替换，不会随着数据增长反复重写整日大文件。原子性以单个 Parquet 文件及其 sidecar manifest 为边界，不承诺跨日期、多文件整批事务。失败批次会有界重试；若前一尝试已经落下部分文件，读取侧会按 `agg_trade_id` 去重，并优先保留较新的 `received_at_ms`，最终幂等收敛。重试耗尽后 archive 进入粘性的 degraded 状态，并将 failure marker 原子保存到 archive 根目录；重启不会自动遗忘事故，覆盖查询也不会继续宣称精确回放完整。只有修复并校验缺口后，运维流程才可以显式清除此标记。后续可以离线 compact 小文件，但不能改变 archive 接口和 schema 语义。

这里的 durable acknowledgement 表示后端已接受并完成应用层文件提交；本阶段不承诺断电级 `fsync` 或跨文件事务。若将来把该归档提升为严格灾难恢复数据源，应在 backend contract 中增加可配置的 fsync/事务 durability level，而不是悄悄改变当前延迟语义。

启用归档但缺少 PyArrow 时启动失败；关闭时没有 PyArrow 依赖。归档覆盖查询只有同时提供期望首尾 aggregate ID 才会返回确定的 `complete=true|false`，否则为 `null`，避免仅凭现有文件误判完整。

查询会先按 UTC 日期、sidecar 中的时间和 ID 范围裁剪文件，再以 PyArrow batch 流式扫描。`expected_start_agg_trade_id..expected_end_agg_trade_id` 同时也是 coverage 的目标 ID 区间；文件裁剪、行过滤和完整性判断都只针对这个区间，不会拿局部请求去和全历史首尾比较。单次查询分别限制候选文件数、目标区间匹配行数和候选文件物理总行数；物理行预算会在打开 Parquet 前通过 sidecar 汇总检查，避免大量重叠 retry 文件用很小的 ID 区间绕过硬上限。任一预算超限时，`coverage` 返回 `status=scan_limit_exceeded`、对应的 `limit_kind`、`truncated=true`、`complete=false`，而不是扫描全历史或返回不可靠结论。调用方应缩小时间或 ID 范围再查。

若只在用户打开 TradeFlow 页面时需要归档，保持下面配置为空即可；此时仅归档已有业务订阅租约对应的流。若希望后台持续采集、不依赖浏览器连接，可配置长期 archive 租约：

```text
RAW_AGG_TRADE_ARCHIVE_STREAMS=binance:futures:BTCUSDT,binance:futures:ETHUSDT
```

配置项仅在 archive 启用时生效；格式错误或无法建立明确请求的长期归档流会使启动失败，避免误以为数据正在持续保存。

## HTTP API

短期原始成交 ring：

```http
GET /api/v1/trade-flow/recent?exchange=binance&market_type=futures&symbol=BTCUSDT&limit=500
```

响应除成交和 cursor 外还包含 `continuity`、`resync_required` 与内部缺口范围；如果 ring 覆盖区间存在未解决缺口，会 fail closed，调用方不能把它当作连续回放源。

1 分钟汇总历史：

```http
GET /api/v1/trade-flow/history?exchange=binance&market_type=futures&symbol=BTCUSDT&period=1m&limit=500
```

可选 `start_ms`、`end_ms`。只有 `period=1m`；响应的 `coverage.all_rows_complete` 在空结果或任一桶 incomplete 时都为 false。

原始归档覆盖：

```http
GET /api/v1/trade-flow/archive/coverage?exchange=binance&market_type=futures&symbol=BTCUSDT&expected_start_agg_trade_id=100&expected_end_agg_trade_id=200
```

可同时传 `start_time_ms`、`end_time_ms`。响应列出内部 ID gaps，并明确 archive 是否启用和给定期望边界下是否完整。

## 浏览器 WebSocket

连接：

```text
ws://localhost:8000/api/v1/stream/trade-flow
```

首条有效命令必须固定本连接的订阅集合：

```json
{
  "action": "subscribe",
  "request_id": "tf-1",
  "recent_limit": 500,
  "streams": [
    {
      "exchange": "binance",
      "market_type": "futures",
      "symbol": "BTCUSDT",
      "channel": "agg_trade"
    }
  ]
}
```

服务端先发送 `subscribed`，再发送原子交接时取得的 `recent`，之后才发送：

```json
{
  "type": "trade.batch",
  "protocol": "tradeflow.v1",
  "sequence": 1,
  "continuity": true,
  "resync_required": false,
  "dropped_before": 0,
  "data": []
}
```

单连接最多 32 个 stream，单 stream recent 最多 2000 条，所有 stream 的 recent 总预算为 5000 条。为保持 snapshot-to-live 交接简单且无缺口，建立后不能动态变更集合；需要变化时重连。`unsubscribe` 会结束本连接的订阅并释放所有逻辑租约。

## 配置

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| `TRADE_FLOW_ROLLUP_BACKEND` | `sqlite` | 1m 汇总存储实现 |
| `TRADE_FLOW_DB_PATH` | `KLINES_DB_PATH` | SQLite 文件；表与 K 线隔离 |
| `TRADE_FLOW_RAW_RING_SIZE` | `20000` | 每 identity 的原始内存 ring |
| `TRADE_FLOW_MAX_STREAMS` | `64` | 最大物理成交流；达到后拒绝新 identity |
| `TRADE_FLOW_EVENT_QUEUE_SIZE` | `20000` | 有序 ingest command queue |
| `TRADE_FLOW_BATCH_INTERVAL_SECONDS` | `0.05` | 浏览器 batch flush 周期 |
| `TRADE_FLOW_MAX_BATCH_SIZE` | `1000` | 单个 append batch 最大成交数 |
| `TRADE_FLOW_GAP_REPAIR_MAX_TRADES` | `20000` | 单缺口自动修复预算 |
| `RAW_AGG_TRADE_ARCHIVE_ENABLED` | `0` | 是否保存原始 aggTrade |
| `RAW_AGG_TRADE_ARCHIVE_BACKEND` | `parquet` | 原始归档实现 |
| `RAW_AGG_TRADE_ARCHIVE_DIR` | `data/raw-agg-live-spool` | 仅实时采集使用的 Parquet 根目录；回放读取独立的 `REPLAY_AGG_TRADE_ARCHIVE_DIR` |
| `RAW_AGG_TRADE_ARCHIVE_STREAMS` | 空 | 逗号分隔的长期归档流，格式 `exchange:market_type:symbol`；空时仅采集已有租约 |
| `RAW_AGG_TRADE_ARCHIVE_FLUSH_SECONDS` | `1.0` | archive writer 合批等待 |
| `RAW_AGG_TRADE_ARCHIVE_MAX_PENDING_BATCHES` | `16` | archive durable queue 上限 |
| `RAW_AGG_TRADE_ARCHIVE_MAX_ROWS_PER_BATCH` | `10000` | 单次归档最大行数 |

诊断入口仍为 `GET /debug/snapshot`，新增 `trade_flow` 节点，包含物理/逻辑租约、engine gaps、队列高水位、repair、append Hub、rollup writer 和 archive writer 指标。服务关闭会先停止接受输入，再以有界期限并行停止物理 feed；即使某个 feed 的 `stop()` 挂死，也会记录 degraded 并继续排空 rollup/archive durable queue，避免停机永久卡在数据落盘之前。

## 后续回放阶段的入口

未来实现 K 线回放时，推荐新增独立 ReplayService：

1. 用 archive `coverage()` 验证请求区间和 aggregate ID 边界；
2. 不完整时拒绝“精确回放”或明确进入 best-effort 模式；
3. 用 `scan_range()` 按 `(trade_time_ms, agg_trade_id)` 读取；
4. 将每条 aggregate trade 送入独立 replay bar builder；
5. 生成临时 K 线流，不写入或污染生产 K 线主链；
6. 若换 DuckDB，只替换 archive/store 实现和查询规划。

本阶段只建立可验证的数据与接口边界，不提前把回放状态机塞进实时 TradeFlowEngine。
