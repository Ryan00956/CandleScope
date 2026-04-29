# Ingestion 六层架构评审与修改建议

本文只讨论 `backend/app/data_engine/ingestion` 模块，不讨论 `DataManager`、`BackfillEngine`、`BarAggregator` 的整体重构。

目标是把三件事说清楚：

1. 理论上六层架构应该是什么样。
2. 现在代码实际是什么样。
3. 当前有哪些职责越界，以及建议如何调整。

---

## 1. 模块定位

`ingestion` 应该是 CandleScope 后端最底层的数据接入层。

它的理想职责是：

- 连接交易所 WebSocket。
- 在 WebSocket 不可用时通过 HTTP 获取同类原始数据。
- 把交易所原始 payload 统一转换成 `MarketEvent`。
- 做实时流级别的去重、乱序识别、缺口标记。
- 把稳定事件流分发给下游。

它不应该负责：

- 生成最终 K 线。
- 聚合自定义周期。
- 写数据库。
- 修复数据库历史缺口。
- 计算指标。
- 管理前端订阅状态。

---

## 2. 理论上的六层架构

理论上的六层应该是严格单向、职责单一的管道。

```text
Exchange WS / REST
      |
      v
L1 Transport
      |
      v
L2 Session
      |
      v
L3 FeedControl
      |
      v
L4 Normalize
      |
      v
L5 Continuity
      |
      v
L6 Delivery
      |
      v
Downstream consumers
```

### L1 Transport

理论职责：

- 建立原始 WebSocket 连接。
- 发送 HTTP GET 请求。
- 处理 proxy、timeout、endpoint 轮换。
- 返回原始消息或原始响应。

理论输入：

- URL、HTTP 参数、WS 连接参数。

理论输出：

- 原始 WS 消息。
- 原始 HTTP JSON。

理论上不应该做：

- 判断某个 stream type 对应哪个 REST path。
- 构造交易所订阅 payload。
- 拆分交易所响应行。
- 理解 K 线、成交、ticker、depth 的业务含义。

### L2 Session

理论职责：

- 管理单个 WebSocket 会话。
- 连接、读取消息、断线重连。
- stale 检测。
- 健康状态上报。

理论输入：

- L1 打开的 WS 连接能力。
- `StreamDescriptor` 或等价的连接描述。

理论输出：

- `RawMessage`。
- `SessionHealth`。

理论上不应该做：

- HTTP fallback。
- 数据解析。
- 缺口检测。
- 业务层订阅管理。

### L3 FeedControl

理论职责：

- 决定当前使用 WebSocket 还是 HTTP polling。
- 当 L2 报告不健康时切到 HTTP。
- 在 HTTP 模式下探测 WS 是否恢复。
- 恢复后切回 WS。

理论输入：

- L2 的 `RawMessage` 和健康状态。
- L1 的 HTTP fetch 能力。

理论输出：

- 来源统一的 `RawMessage`。

理论上不应该做：

- 解析 payload。
- 判断 K 线缺口。
- 写缓存或数据库。
- 维护具体交易所的特殊连接模型。

### L4 Normalize

理论职责：

- 把不同交易所、不同来源的原始 payload 转换成统一 `MarketEvent`。

理论输入：

- `RawMessage`。

理论输出：

- `MarketEvent`。

理论上不应该做：

- 连接交易所。
- HTTP backfill。
- 去重。
- 维护会话状态。
- 分发给消费者。

### L5 Continuity

理论职责：

- 基于 `MarketEvent.dedup_key` 去重。
- 基于 `MarketEvent.continuity_key` 判断乱序和缺口。
- 发出 `GapMarker`。

理论输入：

- `MarketEvent`。

理论输出：

- 过滤后的 `MarketEvent`。
- `GapMarker`。

理论上不应该做：

- 自己 HTTP 拉历史数据。
- 创建 normalizer。
- 写入 storage。
- 替代 `backfill` 模块做历史修复。

### L6 Delivery

理论职责：

- 把 `MarketEvent` / `GapMarker` 包成 `IngestionEvent`。
- 分发给 callback 和 async iterator。
- 控制队列容量，避免消费者无限堆积。

理论输入：

- `MarketEvent`。
- `GapMarker`。

理论输出：

- 面向下游消费者的稳定事件流。

理论上不应该做：

- 解析数据。
- 判断缺口。
- 修复数据。
- 触碰交易所连接。

---

## 3. 当前代码的实际架构

当前代码的主链路是：

```text
MarketDataIngress
  owns shared TransportLayer
  owns SharedWsHubRegistry
  creates StreamPipeline

StreamPipeline
  FeedControlLayer -> NormalizeLayer -> ContinuityLayer -> DeliveryLayer
```

对应代码：

- `MarketDataIngress`: `backend/app/data_engine/ingestion/__init__.py`
- `StreamPipeline`: `backend/app/data_engine/ingestion/__init__.py`
- L1 `TransportLayer`: `transport.py`
- L2 `SessionLayer`: `session.py`
- L3 `FeedControlLayer`: `feed_control.py`
- L4 `NormalizeLayer`: `normalize.py`
- L5 `ContinuityLayer`: `continuity.py`
- L6 `DeliveryLayer`: `delivery.py`
- OKX shared WS: `shared_ws.py`
- DataManager 桥接: `factory.py`

实际链路可以画成：

```text
                       +---------------------+
                       | SharedWsHubRegistry |
                       | OKX shared WS path  |
                       +----------+----------+
                                  |
                                  v
TransportLayer -----> FeedControlLayer -----> NormalizeLayer -----> ContinuityLayer -----> DeliveryLayer
     ^                    |
     |                    v
     |              SessionLayer
     |              normal WS path
     |
     +---- HTTP fetch used by FeedControl and Continuity
```

也就是说，当前不是一个纯粹的 `L1 -> L2 -> L3 -> L4 -> L5 -> L6` 串联模型。

更准确地说：

- L1 是共享底座。
- L2 在普通 WS 模式下由 L3 内部创建。
- OKX shared WS 绕过标准 L2，自己做了类似 L2 的事情。
- L3 同时负责 WS/HTTP 切换和 shared WS 分支。
- L5 也会调用 L1 做 HTTP backfill。

---

## 4. 当前不合理行为清单

### 4.1 L1 Transport 声称不懂市场语义，但实际懂交易所协议

当前 `transport.py` 文件头写着：

> This layer knows NOTHING about market-data semantics.

但实际 `TransportLayer` 会做这些事情：

- 从 exchange registry 获取 adapter。
- 调用 `adapter.get_rest_path(...)`。
- 调用 `adapter.build_http_params(...)`。
- 调用 `adapter.extract_http_rows(...)`。
- 调用 `adapter.build_ws_subscription(...)`。
- 处理 message-based WS subscribe/unsubscribe handshake。

这些行为说明 L1 当前并不是纯 I/O 层，而是：

```text
Transport + ExchangeProtocolGateway
```

这不一定马上导致 bug，但文档和实现不一致，会让后续设计判断变混乱。

风险：

- 加交易所时，Transport 可能继续膨胀。
- 测试纯 I/O 行为变难。
- “协议适配”到底属于 exchanges 还是 ingestion 变模糊。

建议：

- 短期：更新文档，承认 `TransportLayer` 是 transport + protocol gateway。
- 中期：拆出 `ExchangeProtocolGateway` 或把 path/params/subscription/row extraction 完全下沉到 exchange adapter。
- 长期：L1 只接受已经构造好的 request spec，返回 raw response。

---

### 4.2 OKX shared WS 绕过标准 L2 Session

普通 WS 模式：

```text
FeedControlLayer -> SessionLayer -> TransportLayer.ws_connect()
```

OKX shared WS 模式：

```text
FeedControlLayer -> SharedWsHub -> TransportLayer.ws_connect()
```

`SharedWsHub` 自己实现了：

- 订阅者管理。
- WS 连接。
- combined subscribe。
- read loop。
- stale timeout。
- reconnect backoff。
- health change。

这些本质上都是 L2 Session 的职责。

风险：

- WS 生命周期逻辑有两套。
- 普通 WS 和 OKX shared WS 的行为很难保持一致。
- 以后修复 reconnect/stale/health bug，需要检查 `session.py` 和 `shared_ws.py` 两处。
- `FeedControlLayer` 被迫知道 shared WS 特例。

建议：

- 短期：接受 shared WS 作为特殊通道，但文档里明确它是“共享会话实现”，不是普通 L2。
- 中期：定义统一的 `SessionLike` 接口：

```python
class SessionLike(Protocol):
    def on_message(...)
    def on_health_change(...)
    async def start(...)
    async def stop(...)
    def snapshot(...)
```

- 长期：让 `SessionLayer` 和 `SharedWsHubSession` 都实现这个接口，L3 只依赖 `SessionLike`，不知道 OKX 特例。

---

### 4.3 L4 Normalize 过大，交易所解析全部堆在一个类里

当前 `NormalizeLayer` 同时负责：

- Binance WS kline。
- Binance WS aggTrade。
- Binance WS trade。
- Binance WS ticker。
- Binance WS depth。
- Binance HTTP kline。
- Binance HTTP aggTrade。
- Binance HTTP trade。
- Binance HTTP ticker。
- Binance HTTP depth。
- OKX WS kline。
- OKX HTTP kline。
- OKX interval 映射。
- OKX futures/swap volume 字段差异。
- interval close time 计算。

这导致 `normalize.py` 已经超过 800 行。

风险：

- 加第三个交易所时文件会继续膨胀。
- 交易所字段规则和 ingestion 管道逻辑混在一起。
- 某个交易所的修复可能影响其他交易所。
- 单元测试会变粗，难以按交易所隔离。

建议：

- 短期：按交易所拆内部 parser 文件，例如：

```text
ingestion/normalizers/
  __init__.py
  base.py
  binance.py
  okx.py
```

- 中期：`NormalizeLayer` 只做分发：

```python
parser = normalizer_registry.get(descriptor.exchange)
event = parser.parse(raw_message, descriptor)
```

- 长期：把 normalizer 放到 `app.exchanges` adapter 内，让 exchange adapter 同时负责：

```text
build_ws_subscription
build_http_params
extract_http_rows
normalize_ws_payload
normalize_http_payload
```

这样 ingestion 只依赖统一接口，不内置交易所细节。

---

### 4.4 L5 Continuity 直接做 HTTP backfill，和 backfill 模块职责重叠

当前 `ContinuityLayer` 不只是发 `GapMarker`。

它在发现 K 线缺口后，如果满足配置条件，会：

1. 构造 `TransportRequest`。
2. 调用 `TransportLayer.http_fetch()`。
3. 创建临时 `NormalizeLayer`。
4. 把 HTTP 回补数据解析成 `MarketEvent`。
5. 直接 `_emit()` 回事件流。
6. 再发一个 `filled=True` 的 `GapMarker`。

这实际上让实时 ingestion 管道承担了局部 backfill 职责。

风险：

- 和 `data_engine/backfill` 的职责重复。
- 实时流处理被 HTTP 请求阻塞。
- 事件顺序更复杂：缺口事件、回补事件、当前事件混在同一层里处理。
- 回补策略分散：一部分在 ingestion continuity，一部分在 backfill engine，一部分在 DataManager query trigger。
- 未来想统一限流、重试、失败告警，会发现有多套回补入口。

建议：

- 短期：把 `continuity_auto_fill_gaps` 默认改为 `False`，只发 `GapMarker`。
- 中期：删除或废弃 `ContinuityLayer._backfill_kline_gap()`。
- 中期：由上层 `BackfillCoordinator` 订阅 `GapMarker`，决定是否调用 `BackfillEngine`。
- 长期：所有历史修复统一走 `backfill` 模块，ingestion 只负责实时流完整性标记。

理想流向：

```text
ContinuityLayer detects gap
      |
      v
Delivery emits GapMarker
      |
      v
BackfillCoordinator subscribes gap
      |
      v
BackfillEngine repairs storage/cache
      |
      v
DataManager/EventBus emits BACKFILL_COMPLETED
```

---

### 4.5 L6 Delivery 的 callback 会阻塞 ingestion 主链路

当前 `DeliveryLayer.deliver_event()` 的顺序是：

1. `await _fire_market_event_callbacks(...)`
2. `await _fire_event_callbacks(...)`
3. `_enqueue(event)`

这意味着任意 callback 慢，都会拖住整个 ingestion 管道。

优点：

- 顺序简单。
- 下游处理完成后才继续，语义明确。
- 对 BarAggregator 这种强顺序消费者友好。

风险：

- 多个消费者时，一个慢消费者会影响所有消费者。
- 下游偶发卡顿会造成实时事件延迟。
- 如果 callback 里又做 I/O，风险更大。

建议：

- 短期：保留当前行为，但文档明确 callback 是同步反压模型。
- 中期：区分两类订阅：

```text
ordered callback     强顺序，允许反压，用于 BarAggregator
side-effect callback 异步旁路，不阻塞主链路，用于日志/监控/UI辅助事件
```

- 长期：Delivery 内部统一通过队列分发，消费者各自 task 消费；强顺序消费者可以显式使用一个专用队列。

---

### 4.6 Factory 命名和职责不够准确

`BinanceIngestionFactory` 当前方法签名已经支持：

```python
start(symbol, interval, on_bar, exchange="binance", market_type="spot")
```

也就是说它不再只是 Binance。

它还负责：

- 创建 `StreamDescriptor`。
- 复用或创建 ingestion pipeline。
- 注册 L6 callback。
- 把 `MarketEvent` 转成 `bar_dict`。

这些职责更像：

```text
KlineIngestionBridge
```

风险：

- 名字和行为不一致。
- 以后支持更多 stream type 时，factory 会继续膨胀。
- `MarketEvent -> bar_dict` 转换规则散落在 bridge 里，不够正式。

建议：

- 短期：改名或新增别名 `KlineIngestionFactory`，旧名保留兼容。
- 中期：把 `MarketEvent -> bar input` 转换抽成独立函数或 adapter。
- 长期：让 BarAggregator 直接消费 `MarketEvent`，减少 `bar_dict` 中间格式。

---

## 5. 建议的目标架构

建议目标不是推翻六层，而是把六层边界重新收紧。

```text
                           +-------------------+
                           | Exchange Adapters |
                           | protocol + parse  |
                           +---------+---------+
                                     |
                                     v
L1 Transport  ----------------> raw I/O only
                                     |
                                     v
L2 Session / SharedSession ----> unified SessionLike
                                     |
                                     v
L3 FeedControl ---------------> WS/HTTP source switching only
                                     |
                                     v
L4 Normalize -----------------> call exchange normalizer only
                                     |
                                     v
L5 Continuity ----------------> dedup + gap marker only
                                     |
                                     v
L6 Delivery ------------------> ordered / async fan-out
                                     |
                                     v
Downstream:
  - BarAggregator
  - BackfillCoordinator
  - Metrics/monitoring
```

核心原则：

- `ingestion` 可以发现缺口，但不修复历史。
- `ingestion` 可以提供 HTTP fallback，但不承担数据库 backfill。
- `ingestion` 可以统一数据格式，但交易所字段细节最好由 adapter 管。
- L3 不应该知道 OKX 特例，只应该面对统一 session 抽象。

---

## 6. 分阶段修改建议

### 阶段 1：先收敛文档和开关，不大改代码

目标：降低误解，减少实时管道副作用。

建议改动：

1. 更新 ingestion README，说明当前 L1 是 transport + exchange protocol gateway。
2. 明确 OKX shared WS 是 shared session 特例。
3. 将 `continuity_auto_fill_gaps` 默认值改为 `false`。
4. 在 `ContinuityLayer` 文档中标记 `_backfill_kline_gap()` 为 legacy / deprecated。
5. 给 Delivery callback 反压行为写清楚。

收益：

- 风险低。
- 不影响主要行情链路。
- 先把架构语义拉回清楚。

### 阶段 2：拆 L4 normalizer

目标：防止解析层继续膨胀。

建议改动：

```text
backend/app/data_engine/ingestion/normalizers/
  base.py
  binance.py
  okx.py
```

`NormalizeLayer` 变成薄壳：

```python
class NormalizeLayer:
    def _parse(self, msg):
        parser = self._registry.get(self._descriptor.exchange)
        return parser.parse(msg, self._descriptor)
```

收益：

- Binance/OKX 互不影响。
- 加新交易所更清楚。
- 单测更容易写。

### 阶段 3：统一 Session 抽象

目标：消除普通 WS 和 OKX shared WS 两套生命周期。

建议改动：

```text
session.py
  SessionLike Protocol
  DirectSession
  SharedSessionHandle or SharedSessionAdapter
```

`FeedControlLayer` 只做：

```python
self._session = session_factory.create(descriptor)
self._session.on_message(...)
self._session.on_health_change(...)
```

收益：

- L3 不再知道 OKX shared WS。
- reconnect/stale/health 语义统一。
- 排查 WS 问题更容易。

### 阶段 4：移除 L5 内部 backfill

目标：历史修复只走一个系统。

建议改动：

1. `ContinuityLayer` 只发 `GapMarker`。
2. 新增或复用上层 `BackfillCoordinator` 订阅 gap。
3. 由 `BackfillEngine` 做 HTTP 拉取、重试、限流、写库。
4. `DataManager` 或事件总线负责通知回补完成。

收益：

- 职责清晰。
- 回补策略集中。
- 实时 ingestion 不被历史 HTTP 请求阻塞。

### 阶段 5：优化 Delivery 反压模型

目标：慢消费者不拖死实时流。

建议改动：

- 保留强顺序 callback 给 BarAggregator。
- 新增 async subscriber queue 给普通消费者。
- 普通 callback 通过内部 task 调度，不阻塞主链路。

收益：

- 更适合多个消费者。
- 行情延迟更稳定。

---

## 7. 建议优先级

如果只做最关键的三件事：

1. **先禁用或废弃 L5 自动 HTTP backfill。**
2. **拆分 L4 Normalize。**
3. **把 OKX shared WS 收进统一 Session 抽象。**

原因：

- L5 自动回补是职责重叠最明显的地方。
- L4 解析膨胀会越来越严重。
- OKX shared WS 平行生命周期会让后续连接问题越来越难排查。

---

## 8. 需要讨论的问题

后续具体改代码前，建议先确认这些问题：

1. `ingestion` 是否允许做任何形式的 HTTP gap fill？
   - 建议：不允许。只允许 HTTP fallback 实时补当前数据源，不做历史修复。

2. `GapMarker` 应该由谁消费？
   - 建议：上层 `BackfillCoordinator` 或 `DataManager` 订阅。

3. `NormalizeLayer` 应该属于 ingestion 还是 exchange adapter？
   - 短期可留在 ingestion 内拆文件。
   - 长期更适合放到 exchange adapter。

4. OKX shared WS 是临时优化还是正式能力？
   - 如果是正式能力，需要变成统一 Session 抽象的一种实现。

5. Delivery 是否必须保证 callback 完成后才处理下一条事件？
   - 对 BarAggregator 可能需要。
   - 对监控、日志、UI 辅助事件不一定需要。

---

## 9. 简短结论

`ingestion` 的六层方向是对的，当前实现也不是完全混乱。

但现在的实际问题是：

- L1 比文档说的更懂交易所协议。
- L2 被 OKX shared WS 绕出了一套平行实现。
- L4 交易所解析过度集中。
- L5 把缺口检测和 HTTP 回补混在一起。
- L6 callback 分发有潜在反压风险。

最重要的原则是：

```text
ingestion 负责发现和输出稳定实时事件流；
backfill 负责历史修复；
bar_aggregator 负责生成/聚合 K 线；
DataManager 负责对外编排。
```

只要按这个原则收紧边界，六层架构可以继续保留，不需要推倒重来。
