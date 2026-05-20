# Data Engine 架构打磨路线图

> 这份文档描述如何把当前 Data Engine 打磨得更清晰、更容易扩展、更不容易误接线。它不是重写计划，而是围绕现有正确边界做的整理和加固计划。

当前架构的核心方向是对的：

- `ingestion` 负责交易所 I/O、WS/HTTP fallback、payload 标准化、continuity，以及输出 `MarketEvent`。
- `bar_aggregator` 负责 K 线语义：bucket routing、OHLCV merge、forming/closed/amended 生命周期，以及发布 `BarEvent`。
- `data_manager` 负责对外业务门面：查询、cache、event bus、stream 生命周期、backfill 协调、价格快照、订阅和维护。
- `backfill` 负责历史修复执行，并把精确写入范围回报给 DataManager。
- `runtime.py` 是组合根，负责把 Data Engine 接入 FastAPI app state。

打磨的原则是：**保留这些边界，把边界讲清楚，把旧名字和重文件拆薄，把路径级测试补强。**

## 实施状态

当前这轮打磨后的状态：

| 阶段 | 状态 | 已落地结果 |
|---|---|---|
| Phase 1：讲清当前事实 | 已完成 | `DATA_FLOW_PATHS_zh.md` 记录实时 K 线、backfill、price、内置指标、Pyne/custom 五条路径。callback 注释也明确了 `MarketEvent` 进入 `BarAggregator`，不会直接改 DataManager cache。 |
| Phase 2：拆薄 route 层 | 已完成 | `api/v1/stream.py` 已经是薄 route 壳。K 线 streaming 在 `stream_klines.py`；共享 WS helper 在 `stream_utils.py`；indicator WS 编排在 `stream_indicators.py`；payload/range 计算在 `stream_indicator_payloads.py`；Pyne/custom 订阅生命周期在 `stream_pyne_subscriptions.py`。 |
| Phase 3：退休兼容命名 | 已完成 | `BinanceIngestionFactory` 已删除；`ExchangeIngestionFactory` 是唯一受支持的 runtime ingestion factory export。 |
| Phase 4：明确交易所 WS capability routing | 已完成 | 测试已经断言 Binance kline 使用 `SessionLayer`，OKX kline 通过 capability routing 使用 `SharedWsSessionAdapter`。 |
| Phase 5：路径级测试加固 | 已完成本文列出的 guardrails | 测试覆盖 MarketEvent 进 aggregator、price update 不触碰 `BarAggregator`、旧 alias 不再暴露、session routing，以及主要 WS/indicator 路径。 |

当前完整 backend 验证：

```bash
cd backend
python -m compileall app tests -q
python -m pytest -q
```

最新结果：`187 passed`。

## 目标形态

一个新维护者应该不用翻完整个 route 文件，就能回答这些问题：

1. 某条数据路径由哪个模块负责？
2. 每个边界传递的事件类型是什么？
3. 谁可以启动或停止交易所实时流？
4. 谁可以修改 cache 或 storage？
5. 为什么 Binance 和 OKX 的 WS session 模型不同？
6. 新交易所、新指标模式、新订阅 tier 应该接到哪里？

目标主线应该始终长这样：

```text
Exchange WS/REST
  -> ingestion
  -> MarketEvent / GapMarker
  -> BarAggregator
  -> BarEvent
  -> AggregatorBridge
  -> DataManager cache / storage / EventBus
  -> API / WS / Indicator / Subscription consumers
```

并行路径也要明确：

- 历史修复通过 `DataManager.on_bars_backfilled()` 回来，不走实时 `MarketEvent` 路径。
- 价格流更新 `PriceSnapshotCache`，不进 `BarAggregator`。
- 指标流消费 DataManager 的 query/event 输出，不拥有行情接入。
- 交易所插件描述协议和能力差异，API/frontend 消费 capabilities，而不是硬编码交易所分支。

## 当前优点

- 实时 K 线路径语义干净：标准化后的 `MarketEvent` 进入 `BarAggregator`，只有聚合后的 `BarEvent` 通过 `AggregatorBridge` 修改 cache/events。
- `ExchangeIngestionFactory` 已经是交易所通用入口；旧的 `BinanceIngestionFactory` 别名已经退休。
- `StreamEnsurePlanner` 把自定义周期和 base stream prerequisite 从 route handler 里拿出来了。
- `BackfillCoordinator` 统一负责 priority、去重、调度、retry、cancel 和 completion event 语义。
- `SharedMultiplexHub` 是 capability 驱动的通用能力。声明 `shared_multiplex` 的交易所可以共享一条上游 WS；Binance 当前仍建模为 `path_per_stream`。

## 当前摩擦点

| 区域 | 摩擦 | 打磨方向 |
|---|---|---|
| 旧命名 | 旧的 `BinanceIngestionFactory` 名字会暗示一个已经不存在的 Binance 专属 owner。 | 已完成：测试和代码使用 `ExchangeIngestionFactory`，旧 alias 已删除。 |
| route 文件过重 | `api/v1/stream.py` 过去同时处理 K 线 WS、多周期 WS、指标 WS、Pyne/custom、range patch、heartbeat、queue。 | 已完成：route handler 已经变成薄 adapter；长生命周期 stream 逻辑按职责拆分。 |
| WS session 模型不直观 | `SharedMultiplexHub` 是通用能力，但只有 capability opt-in 的交易所会使用。 | 已完成：capability routing 已文档化，并由 session-factory 测试保护。 |
| 价格流不如 K 线主线显眼 | 价格流和 K 线流本来就是平行体系，但文档存在感弱一些。 | 已完成：price flow 已文档化，并用测试保护价格更新不触碰 K 线聚合。 |
| 子系统文档分散 | 各 README 基本准确，但缺少一份跨模块的打磨 checklist。 | 已完成：子系统 README 链接到这份路线图和具体数据流地图。 |

## 打磨阶段

### Phase 1：把当前事实讲清楚

状态：已完成。

1. 补齐五条活动路径图：
   - 实时 K 线
   - 历史修复/backfill
   - 价格快照/subscription
   - 内置指标
   - Pyne/custom 指标
2. 明确边界事件：
   - `RawMessage`：transport/session 输出
   - `MarketEvent`：ingestion 标准化后的行情事件
   - `GapMarker`：ingestion continuity 信号
   - `BarEvent`：`BarAggregator` 的 K 线语义输出
   - `DataEvent`：DataManager event bus 输出
   - `PriceSnapshot`：轻量价格状态
3. 明确退休兼容名字：
   - `BinanceIngestionFactory` 已删除。
   - 新代码应该导入 `ExchangeIngestionFactory`。
4. 只在容易误读的边界加短注释，尤其是 callback handoff 点。

退出标准：

- 维护者能从 API 入口追踪五条路径到最终 cache/event 副作用。
- 文档和代码都明确：`MarketEvent` 进入 `BarAggregator`，不是直接进入 DataManager cache。

### Phase 2：拆薄 route 层

目标：route handler 只做命令校验、调用 DataManager/Indicator 服务、序列化响应，不拥有长期运行的数据语义。

状态：已完成。

建议拆分：

| 当前集中点 | 候选归属 |
|---|---|
| `_dm_single_stream`、`_dm_multi_stream`、event forwarding helpers | `api/v1/stream_klines.py` 或 `app/streaming/klines.py` |
| indicator WS command loop | `app/indicator/streaming.py` |
| Pyne/custom indicator subscription tasks | `app/indicator/pyne_streaming.py` |
| 共享 WS send/heartbeat/error helpers | 小型 `app/api/ws_utils.py` |

规则：

- FastAPI route 文件保持 adapter 定位。
- DataManager 仍是行情数据门面。
- `IndicatorEngine` 和 Pyne runtime 逻辑不要混进 K 线 WS handler。
- 不引入新的全局 event bus；bar/price 更新继续以 DataManager event bus 为源。

退出标准：

- `api/v1/stream.py` 变成索引/router 或很薄的兼容壳。
- 现有 WS 测试仍通过，公开 endpoint 行为不变。

### Phase 3：退休旧兼容名

目标：移除旧 Binance-only 世界留下的命名暗示。

状态：已完成。

步骤：

1. 把测试里的 `BinanceIngestionFactory` import 替换为 `ExchangeIngestionFactory`。
2. 把文档和注释里暗示 runtime factory 是 Binance 专属的说法改掉。
3. 确认下游导入迁移后删除 alias。
4. 在历史说明里保持清楚：`ExchangeIngestionFactory` 是受支持名称。

退出标准：

- 源码和测试不再导入 `BinanceIngestionFactory`。
- `ExchangeIngestionFactory` 是唯一 runtime factory export 和被宣传的 factory 名称。

### Phase 4：明确交易所 WS capability routing

目标：session 选择来自交易所 capability，而不是经验记忆。

状态：已完成。

当前模型：

```text
plugin.capabilities().ws_connection_model
  path_per_stream     -> SessionLayer
  shared_multiplex   -> SharedWsSessionAdapter / SharedMultiplexHub
  polling_only       -> HTTP fallback only
```

约定：

- Binance 当前使用 `path_per_stream`；重复保护主要靠 pipeline/key 复用。
- OKX 使用 `shared_multiplex`；一个 hub 可以合并同一 `(exchange, market_type, symbol)` 组下的多个 descriptor。
- 未来如果要启用 Binance combined stream，应该作为明确的 capability/protocol 变更引入，而不是在 DataManager 里写 Binance 特判。
- `SharedMultiplexHub` 应保持交易所无关，只依赖 plugin protocol 的 `build_combined_subscribe()` 和 `payload_matches_descriptor()` 等方法。

退出标准：

- 测试覆盖 `path_per_stream` 和 `shared_multiplex` 两种 routing 决策。
- 新交易所插件只通过 capabilities 就能选择 WS 模型。

### Phase 5：补强路径级测试

状态：本文列出的 guardrails 已完成。

已新增或加强这些测试：

- ingestion 产出的 `MarketEvent` 会调用 `BarAggregator.on_market_event`。
- 实时 `BarEvent` 修改 K 线 cache 的唯一入口是 `AggregatorBridge`。
- backfill completion 走 `DataManager.on_bars_backfilled()` 并发出 `BACKFILL_COMPLETED`。
- price update 进入 `PriceSnapshotCache` 并发出 `PRICE_UPDATED`，不触碰 `BarAggregator`。
- indicator subscription 消费 DataManager bars/events，除了 `dm.ensure_stream()` 外不直接启动交易所接入。
- Binance 使用 `SessionLayer`；OKX kline 使用 `SharedWsSessionAdapter`。

建议验证集：

```bash
cd backend
python -m compileall app tests -q
python -m pytest -q \
  tests/test_data_engine_phase1_boundaries.py \
  tests/test_ingestion_session_types.py \
  tests/test_stream_api.py \
  tests/test_price_subscription_services.py \
  tests/test_indicator_api.py
```

## 后续开发规则

- 新行情入口默认通过 DataManager，除非是 runtime 组合根内部 wiring。
- 新交易所协议差异放在 exchange plugin 和 capabilities 里。
- 新 K 线语义放在 `bar_aggregator` 或 `interval_policy.py`，不要放在 API route。
- 新历史修复行为通过 `BackfillCoordinator`，不要直接改 cache。
- 新实时输出到前端前，应先成为 `DataEvent`。
- 新 price-only 行为留在 price snapshot 路径，除非它真的需要 OHLCV bar。

## 非目标

- 不替换现有 Data Engine pipeline。
- 不把 price snapshot 合并进 `BarAggregator`。
- 不让 API route handler 持有交易所协议细节。
- 不让前端决定 priority 或 scheduling；前端选择语义意图，后端负责优先级和执行。
- 不在通用 DataManager 或 ingestion orchestration 里加入 Binance 特判。
