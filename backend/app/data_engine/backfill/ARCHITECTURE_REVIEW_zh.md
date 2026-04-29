# Backfill 架构评审与修改建议

本文只讨论 `backend/app/data_engine/backfill` 模块及它和 `DataManager`、`ingestion`、`bar_aggregator` 的边界关系。

结论先说：

`backfill` 自身不是纯粹屎山。它的主流程是清楚的：

```text
GapDetector -> BackfillPlanner -> HistoricalFetcher -> Reconciler -> RepairPublisher
```

真正的问题在边界：

- 历史修复入口分散在太多地方。
- backfill fetcher 直接复用 ingestion 内部模型，耦合偏深。
- Reconciler 同时负责写库、去重、缓存推送、自定义周期聚合、调用实时 BarAggregator。
- DataManager / main / settings API 重复承担“回填完成后把数据灌回缓存并发事件”的逻辑。
- custom interval 的时间规则在 backfill、bar_aggregator、core.market 多处重复。

所以当前更像是：

```text
backfill 内部有管线；
外部调度和边界开始长毛；
Reconciler 是最胖、最容易变成屎山的节点。
```

---

## 1. 理想职责

建议把四个数据模块的职责定死：

```text
ingestion:
  负责实时接入、解析、连续性标记。
  可以发现 gap，但不做历史修复。

backfill:
  负责历史缺口修复。
  输入 RepairRequest / GapInfo。
  输出 RepairReport / repaired bars。

bar_aggregator:
  负责 K 线生命周期、bucket、merge、finalize。
  可以提供 batch aggregation API，但不查 storage，不管 backfill 调度。

DataManager / BackfillCoordinator:
  负责查询触发、去重调度、缓存回灌、事件通知、重试策略。
```

backfill 最好是一个历史修复能力模块，而不是应用级后台任务调度器。

---

## 2. 当前模块内部结构

当前 backfill 目录是：

```text
backfill/
├── __init__.py       # BackfillEngine 顶层编排
├── gap_detector.py   # 缺口检测
├── planner.py        # 任务规划和 custom interval 分解
├── fetcher.py        # REST 历史数据拉取
├── reconciler.py     # 去重、写库、custom 聚合、缓存推送
├── publisher.py      # report 构建和发布
├── models.py         # 模型、Protocol、interval helpers
└── config.py         # 配置
```

这个分层方向是合理的。`BackfillEngine.run()` 也确实按检测、规划、拉取、调和、发布走，不是无序函数堆。

比较好的点：

- `StorageBackend` / `CacheBackend` 使用 Protocol，backfill 不直接写死 SQLite。
- `BackfillTask`、`FetchResult`、`ReconcileResult`、`RepairReport` 的模型边界基本清楚。
- `HistoricalFetcher` 有并发、分页、限流、重试。
- `Planner` 把标准周期和自定义周期任务拆开。
- `Publisher` 没有直接依赖 WebSocket 或 FastAPI。

但它有几个架构味道已经变重。

---

## 3. 主要问题

### 3.1 历史修复入口太分散

现在缺口检测和 backfill 触发至少存在这些路径：

- `GapDetector.detect()` 自己扫描 storage。
- `DataManager.QueryEngine.query()` 检测查询结果不完整后触发 backfill。
- `DataManager.QueryEngine.fetch_before()` 左滚加载不足时触发 backfill。
- `DataManager.on_bars_backfilled()` 回灌缓存后再次检查内部 gap，并继续触发 follow-up backfill。
- `ingestion.ContinuityLayer` 仍然有 `_backfill_kline_gap()`。
- `main.py` 启动时跑 `_startup_gap_scan()`。
- `settings.py` 的 `/storage/gap-scan` 端点手写一套 tail gap / interior gap 扫描和修复。

这不是 backfill 目录内部混乱，而是系统层面的 backfill 编排重复。

风险：

- 同一个缺口可能被多个入口重复触发。
- 重试策略分散：`main.py` 有一套重试，fetcher 内部有一套重试，manual repair 又直接同步跑。
- “什么算缺口”的规则不统一。
- 回填完成后的缓存回灌和事件通知也被各处手写。
- 后续要做队列、去重、取消、限速、可观测性，会找不到唯一落点。

建议：

新增或明确 `BackfillCoordinator`：

```text
QueryEngine / StartupScan / Settings API / Ingestion GapMarker
        |
        v
BackfillCoordinator
  - request dedup
  - per series in-flight guard
  - retry/backoff
  - range coalescing
  - call BackfillEngine
  - load repaired bars into DataManager cache
  - emit BACKFILL_COMPLETED
```

这样 `BackfillEngine` 保持纯 pipeline，应用级调度集中到一个地方。

---

### 3.2 Reconciler 过胖，是当前最大膨胀点

`Reconciler` 现在承担了太多职责：

- 收集 fetch results。
- 去重。
- 写标准周期 bars。
- 生成 custom interval bars。
- 调 BarAggregator。
- 从 BarAggregator state 读 recent bars。
- 再写 custom bars。
- 推缓存。
- 执行 callbacks。

这已经超过“调和器”的合理边界。

尤其是 custom interval 路径：

```text
Reconciler
  -> bar_aggregator.add_target()
  -> bar_aggregator.on_backfill_bars()
  -> bar_aggregator.get_recent_bars()
  -> storage.upsert_bars()
```

这个方向短期能复用聚合规则，但问题明显：

- backfill 批处理会污染或占用 realtime aggregator 的主状态。
- `add_target()` 可能改变 DataManager 当前订阅目标。
- `on_backfill_bars()` 可能触发正常 publisher/event 路径。
- `get_recent_bars(limit=10000)` 是从实时状态里反查结果，不是明确的 batch return。
- backfill 的 correctness 依赖主 aggregator recent memory 的保留策略。

这和 `bar_aggregator` 评审里的结论一致：短期可以复用，长期应该使用 isolated batch aggregator 或 public batch API。

建议拆成：

```text
Reconciler:
  - dedup
  - write repaired base bars
  - return written ranges

CustomBarRepairer:
  - 使用 BarAggregator batch API 生成 custom bars
  - 不使用 realtime aggregator 主状态

CacheNotifier / Coordinator:
  - 从 storage 读最终 bars
  - 调 DataManager.on_bars_backfilled()
```

短期最小改法：

- 保留 `set_bar_aggregator()`，但标注为 legacy / temporary。
- 给 BarAggregator 增加 `aggregate_batch(..., emit_events=False)`。
- Reconciler 不再调用 `get_recent_bars()`，而是使用 batch API 返回的 bars。

---

### 3.3 “回填完成后通知前端”不在 backfill 内闭环

`RepairPublisher` 只负责日志和 callbacks。真正让前端知道回填完成，是外层手动做：

```text
main.py:
  backfill_engine.run()
  _load_backfilled_to_cache()
  dm.on_bars_backfilled()

settings.py:
  backfill_engine.run()
  storage.query_bars()
  dm.on_bars_backfilled()
```

这导致同一段逻辑重复出现：

1. backfill 写库。
2. 再查 storage。
3. 转成 `BarData`。
4. 灌入 DataManager cache。
5. 发 `BACKFILL_COMPLETED` 事件。

风险：

- 有的 backfill 路径可能忘记通知 DataManager。
- custom interval 和 standard interval 的回灌策略不一致。
- 回填成功但前端不刷新，或者重复刷新。
- `RepairPublisher` 名义上是发布器，但它发布的不是应用层数据事件。

建议：

把“回填完成后的应用集成”移到 `BackfillCoordinator`，不要散在 `main.py` 和 API endpoint。

`BackfillEngine` 输出：

```text
RepairReport:
  written_ranges:
    - exchange
    - market_type
    - symbol
    - interval
    - start_ms
    - end_ms
    - bars_written
```

Coordinator 根据 `written_ranges` 统一回灌 cache 和 emit event。

---

### 3.4 Fetcher 对 ingestion 内部耦合偏深

`HistoricalFetcher` 直接依赖：

- `TransportLayer`
- `IngestionConfig`
- `StreamDescriptor`
- `TransportRequest`
- `RawMessage`
- `NormalizeLayer`
- `DataSource.HTTP_BACKFILL`

这比“复用底层 HTTP client”更深。它已经在拿 ingestion pipeline 的模型来做历史 REST backfill。

短期这是可以接受的，因为 ingestion 已经封装了交易所 HTTP 请求和解析逻辑。但长期会有问题：

- ingestion 的 `NormalizeLayer` 一变，backfill fetcher 跟着变。
- backfill 需要的历史 REST 语义和 realtime ingestion 语义并不完全一样。
- OKX / Binance 的历史分页、边界、limit、rate limit 规则会继续往 fetcher 和 config 里塞。
- ingestion 评审已经指出 L5 自动 HTTP backfill 应该移出 ingestion；那 backfill 也不应该反过来深度依赖 ingestion 的中间层。

建议抽一个窄接口：

```python
class HistoricalMarketDataClient(Protocol):
    async def fetch_klines(
        self,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        limit: int,
    ) -> list[FetchedBar]: ...
```

实现可以继续复用 `TransportLayer + NormalizeLayer`，但 backfill 只依赖这个窄接口。

这样边界变成：

```text
backfill -> historical client protocol -> exchange/ingestion adapter
```

而不是：

```text
backfill -> ingestion L1/L4/L models
```

---

### 3.5 custom interval 时间规则重复

backfill 自己有：

- `models.STANDARD_INTERVAL_MS`
- `models.parse_interval_ms()`
- `models.is_standard_interval()`
- monthly interval 的近似毫秒值
- `planner.py` 中 monthly 特判
- `reconciler.py` 中 `compute_bucket_start_ms()`

bar_aggregator 也有一套 interval helpers。`core.market` 又提供 weekly/monthly bucket 逻辑。

这会带来规则漂移：

- 一个模块认为 `1M` 是标准周期，另一个模块按日历月算。
- `1w` 是 7 天毫秒，还是交易所周线边界。
- custom interval 对齐模式到底由 backfill 还是 bar_aggregator 定义。

建议：

把 interval / bucket 规则集中到一个模块，例如：

```text
app.core.interval_policy
  parse_interval()
  is_exchange_native_interval(exchange, market_type, interval)
  compute_bucket_start()
  next_bucket_start()
  decompose_for_historical_fetch()
```

backfill 和 bar_aggregator 都调用同一套规则。

---

### 3.6 部分失败可能被报告成成功

`Reconciler._dedup_and_write()` 写 batch 失败时只是 log 和 metric，没有把错误返回到 `ReconcileResult.errors`。

custom bar 写入失败也是类似处理。

结果是：

- fetch 成功。
- 部分 DB write 失败。
- `ReconcileResult.errors` 仍可能为空。
- `BackfillEngine.run()` 可能把整体状态判为 `COMPLETED`。

这不是纯架构问题，但会直接影响上层调度判断。上层看到 completed，就会尝试 cache reload 或停止重试。

建议：

- 写入错误要进入 `ReconcileResult.errors`。
- `ReconcileResult` 增加 `write_errors` / `failed_batches`。
- `BackfillEngine` 根据写入错误返回 `PARTIAL`。

---

### 3.7 `NEWER_WINS` 去重策略名不副实

`DeduplicationStrategy.NEWER_WINS` 的语义是“保留 updated_at 更新的那条”，但当前 `_should_replace()` 没有查询 existing row，只是默认返回 True。

这会让配置项看起来比实际能力强。

建议：

- 短期：删除或改名为 `BACKFILL_WINS`。
- 中期：如果真要 `NEWER_WINS`，storage protocol 需要返回 existing row 的 `updated_at/source`。

---

## 4. 和前两份评审的对应关系

### 对 ingestion 评审

ingestion 评审的关键结论是：

```text
ingestion 可以发现 gap，但不要自己做历史修复。
```

当前 `ingestion.ContinuityLayer._backfill_kline_gap()` 仍然存在。这和 backfill 模块职责重叠。

建议：

- `ContinuityLayer` 只 emit `GapMarker`。
- `BackfillCoordinator` 订阅或接收 `GapMarker`。
- 所有历史修复统一走 `BackfillEngine`。

### 对 bar_aggregator 评审

bar_aggregator 评审的关键结论是：

```text
backfill custom aggregation 短期可复用 BarAggregator，
长期使用 isolated batch aggregator。
```

当前 `Reconciler` 直接使用主 `dm.bar_aggregator`。这正是需要收紧的边界。

建议：

- BarAggregator 提供 batch API。
- Reconciler 只调用 batch API。
- batch API 默认 `emit_events=False`，状态隔离。
- legacy fallback 聚合逐步废弃。

---

## 5. 建议目标架构

推荐目标：

```text
                 QueryEngine / StartupScan / Settings API / Ingestion GapMarker
                                      |
                                      v
                             BackfillCoordinator
                    request dedup / retry / range coalescing
                                      |
                                      v
                              BackfillEngine
          detect -> plan -> fetch -> reconcile/write -> report ranges
                                      |
                                      v
                             BackfillCoordinator
                 reload storage -> DataManager cache -> event bus

HistoricalFetcher:
  depends on HistoricalMarketDataClient protocol

Custom interval generation:
  depends on BarAggregator batch API / isolated builder
```

这样每层边界更稳定：

- backfill 不知道 FastAPI、WebSocket、DataManager event bus。
- DataManager 不知道 fetcher/reconciler 内部阶段。
- ingestion 不做历史修复。
- BarAggregator 不被 batch backfill 污染 realtime state。

---

## 6. 分阶段修改建议

### 阶段 1：先收敛触发入口

目标：停止到处手写 backfill 调度。

建议改动：

1. 新增 `BackfillCoordinator`。
2. 把 `main.py` 里的 `_backfill_trigger()` 移进去。
3. 把 `_load_backfilled_to_cache()` 移进去。
4. QueryEngine 继续只依赖一个 `backfill_trigger` callback。
5. settings API 调 coordinator，不直接调 `backfill_engine.run()`。

收益：

- 去重和重试有唯一位置。
- 回填完成通知前端有唯一位置。
- 后续接队列或取消任务更容易。

### 阶段 2：修正 Reconciler 错误语义

目标：不要把写入失败伪装成 completed。

建议改动：

1. `_dedup_and_write()` 返回 errors。
2. custom write errors 进入 `ReconcileResult.errors`。
3. `ReconcileResult` 增加 failed batch 计数。
4. `BackfillEngine` 对 write errors 返回 `PARTIAL`。

收益：

- 上层重试判断可靠。
- 手动修复接口结果可信。

### 阶段 3：抽 HistoricalMarketDataClient

目标：backfill 不直接绑定 ingestion 内部层。

建议改动：

1. 定义 `HistoricalMarketDataClient` Protocol。
2. 现有 `TransportLayer + NormalizeLayer` 包成 `IngestionHistoricalClient`。
3. `HistoricalFetcher` 只依赖 client。
4. exchange-specific rate limit / pagination policy 放到 client 或 exchange adapter。

收益：

- backfill fetcher 更稳定。
- 交易所扩展不会继续污染 fetcher。

### 阶段 4：替换主 BarAggregator 依赖

目标：batch backfill 和 realtime aggregation 状态隔离。

建议改动：

1. BarAggregator 增加 `aggregate_batch()` 或 `replay_batch()`。
2. 支持 `emit_events=False`。
3. Reconciler 不再调用 `add_target()` / `get_recent_bars()`。
4. fallback `_aggregate_to_custom()` 标记 legacy，最终删除或改为调用同一批处理规则。

收益：

- custom bars 规则统一。
- realtime state 不被 backfill 污染。
- 大批量 backfill 内存更可控。

### 阶段 5：统一 interval policy

目标：消除周期和桶规则漂移。

建议改动：

1. 抽 `app.core.interval_policy`。
2. backfill / bar_aggregator / data_manager 统一调用。
3. 明确 `1M` 是 exchange native monthly，不是固定 30 天。
4. 明确 weekly/monthly 的 bucket 边界。

收益：

- custom interval 行为更可预测。
- 月线、周线、OKX/Binance 差异更容易维护。

---

## 7. 建议优先级

如果只做最关键的三件事：

1. **先做 `BackfillCoordinator`，收敛触发、重试、缓存回灌和事件通知。**
2. **修正 Reconciler 的错误上报，让写库失败变成 `PARTIAL`。**
3. **给 BarAggregator 补 isolated batch API，替换 Reconciler 对主 realtime aggregator 的直接操作。**

原因：

- 触发入口分散是当前最明显的系统级混乱来源。
- 错误语义不准会直接导致上层调度误判。
- 主 aggregator 状态被 batch backfill 复用，是长期 correctness 和内存风险。

---

## 8. 需要讨论的问题

1. backfill 是否应该拥有自己的后台队列？
   - 建议：队列属于 `BackfillCoordinator`，不是 `BackfillEngine`。

2. ingestion 是否还允许 `_backfill_kline_gap()`？
   - 建议：不允许。只 emit gap marker。

3. Reconciler 是否应该推 cache？
   - 建议：不直接推 DataManager cache。它可以返回 written ranges，由 Coordinator 统一回灌。

4. custom interval 是否允许 fallback `_aggregate_to_custom()`？
   - 短期保留。
   - 长期统一到 BarAggregator batch API。

5. `NEWER_WINS` 是否真需要？
   - 如果需要，storage protocol 必须暴露 existing row metadata。

---

## 9. 简短结论

`backfill` 不是没有架构的屎山。它的五段 pipeline 是清楚的，模型也基本合理。

但它正在往“系统胶水层”膨胀：

- 触发散在 QueryEngine、main、settings API、DataManager、ingestion。
- Reconciler 变成写库、聚合、缓存、状态同步的大杂烩。
- Fetcher 深依赖 ingestion 内部层。
- custom interval 规则多处复制。
- 部分失败语义不够可靠。

建议不要推倒重来，而是按这个原则收紧：

```text
BackfillEngine 只做历史修复 pipeline；
BackfillCoordinator 负责调度、去重、回灌缓存和事件；
HistoricalFetcher 依赖窄的历史数据 client；
custom aggregation 统一走 isolated BarAggregator batch API；
ingestion 只标记 gap，不修复历史。
```

按这个方向改，backfill 可以继续保留现有结构，不需要大拆。
