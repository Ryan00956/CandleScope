# Data Engine 边界收紧与减厚执行文档

本文用于下一轮对照执行。目标不是继续大拆重构，而是在当前已经形成的
`ingestion -> bar_aggregator -> data_manager -> API` 主链路上，收窄越界面、降低
`DataManager` 厚度、把隐式 `Any` 依赖整理成明确 contract。

当前判断：

- 主链路清晰，四个核心模块职责基本成立。
- `main.py` 已变薄，生产 wiring 已迁入 `data_engine/runtime.py`。
- 边界专项测试和全量后端测试当前通过。
- 仍需处理的主要问题是：`app.state` 暴露内部组件、`DataManager` 公开内部属性偏多、
  `MaintenanceService` / `BackfillCoordinator` 对门面和 engine 的依赖偏隐式。

本轮执行结果（2026-05-01）：

- 阶段一完成：API 不再从 `app.state` 读取 backfill/ingestion/transport 内部句柄，
  settings 改为通过 `DataEngineRuntime` facade 获取配置、更新配置、重启 transport、
  获取 backfill coordinator。
- 阶段二完成：`MaintenanceService` 不再持有完整 `DataManager`，改为注入
  storage provider、聚合器配置快照、cache invalidator、bars backfilled callback、
  active targets 和 warm-start seed callback。
- 阶段三完成：`BackfillCoordinator` 不再持有完整 `DataManager`，改为注入
  `bars_backfilled` 与 `emit_event` sink，并为 engine/storage 增加最小 Protocol。
- 阶段四完成：业务代码不再直接访问 `dm.cache`、`dm.event_bus`、`dm.coordinator`、
  `dm.query_engine`、`dm.bar_aggregator`、`dm.subscriptions`，runtime 和 subscriptions
  API 已改走 DataManager public facade。
- 阶段五完成：`data_manager/__init__.py` 包根导出已收窄到 facade、config、model、
  exception 和 enum；内部服务类需从具体模块导入。
- 阶段六完成：关键跨模块 hook 已从裸 `Any` 收紧为 `BackfillTrigger`、
  `BackfillReconcilerLike`、`PriceStreamControllerLike`、`RepairRequester`、
  `SubscriptionDataManagerLike` 等命名 contract。
- 当前验证：`python3 -m compileall app tests -q` 通过；`python3 -m pytest -q`
  通过，`87 passed`。

执行原则：

- 每阶段都必须能单独提交、单独回滚。
- 不改行情语义，不重写 ingestion/backfill/bar_aggregator 主逻辑。
- 先迁移调用方，再收窄导出；先加 facade，再隐藏内部对象。
- 每阶段完成后运行边界测试和相关业务测试，最后运行全量测试。

---

## 0. 基线确认

执行前先确认当前基线，避免在脏状态上判断架构问题。

```bash
cd backend
python3 -m compileall app tests -q
python3 -m pytest tests/test_data_engine_phase1_boundaries.py -q
python3 -m pytest -q
```

预期：

- `compileall` 无输出且退出码为 0。
- 边界测试通过。
- 全量测试通过，当前参考值为 `80 passed`。

额外检查：

```bash
rg -n "app\.data_engine\.services|data_engine\.services|app\.data_engine\.collectors|data_engine\.collectors" app tests -g '*.py'
rg -n "PriceTickerService|SubscriptionManager|kline_cache_service|kline_aggregator|spot_fetcher" app tests -g '*.py'
```

预期：无新的运行时代码命中。

---

## 1. 阶段一：收窄 `app.state` 暴露面

### 目标

API 层只直接依赖稳定入口：

```text
app.state.data_engine_runtime
app.state.data_manager
```

不再让 API 直接读取：

```text
app.state.ingestion_factory
app.state.backfill_transport
app.state.backfill_engine
app.state.backfill_coordinator
app.state.price_stream_source
app.state.gap_scan_task
```

### 修改范围

- `backend/app/data_engine/runtime.py`
- `backend/app/api/v1/settings.py`
- `backend/tests/test_data_engine_phase1_boundaries.py`
- 如有必要，补充 settings/runtime 单测

### 执行步骤

1. 在 `DataEngineRuntime` 增加明确 facade 方法：

   ```python
   def get_ingestion_config(self) -> IngestionConfig | None: ...
   def transports(self) -> list[TransportLayer]: ...
   async def restart_transports(self) -> None: ...
   def backfill_coordinator_handle(self) -> BackfillCoordinator: ...
   ```

   命名可以按实际代码调整，但必须表达业务意图，而不是暴露内部字段名。

2. 修改 `settings.py`：

   - `_get_ingestion_config()` 改为从 `data_engine_runtime` 取。
   - `_get_transports()` 删除或改为调用 runtime facade。
   - `_get_backfill_coordinator()` 改为从 runtime facade 取，或让 DataManager maintenance
     facade 不再需要 API 传入 coordinator。

3. 修改 `DataEngineRuntime.attach_to_app_state()`：

   - 第一轮可以保留旧字段但标注兼容。
   - 如果所有调用方已迁移，并且测试通过，再删除旧字段。

4. 加强边界测试：

   - `main.py` 不出现 `app.state.backfill_transport` 等旧字段。
   - `api/v1/settings.py` 不出现 `request.app.state.backfill_transport`、
     `request.app.state.ingestion_factory`、`request.app.state.backfill_coordinator`。

### 验收

```bash
cd backend
python3 -m pytest tests/test_data_engine_phase1_boundaries.py -q
python3 -m pytest tests/test_maintenance_facade.py -q
python3 -m pytest tests/test_klines_api.py tests/test_stream_api.py -q
```

通过标准：

- settings API 不直接摸 runtime 内部组件。
- `DataEngineRuntime` 成为启动 wiring 和运行期内部能力的唯一持有者。
- API 层仍能更新代理、重启 transport、触发 storage repair/gap scan。

---

## 2. 阶段二：Maintenance 依赖解耦

### 目标

`MaintenanceService` 不再持有整个 `DataManager` 并任意访问 `_dm.query_engine.storage`、
`_dm.bar_aggregator`、`_dm.cache_invalidate()`。

它只依赖明确能力：

```text
storage_provider
bar_aggregator
cache_invalidator
bars_backfilled_callback
backfill_runner/requester
retention/deletion helpers
```

### 修改范围

- `backend/app/data_engine/data_manager/maintenance.py`
- `backend/app/data_engine/data_manager/manager.py`
- `backend/app/data_engine/data_manager/backfill_coordinator.py`
- `backend/tests/test_maintenance_facade.py`
- `backend/tests/test_data_engine_phase1_boundaries.py`

### 执行步骤

1. 定义本地 Protocol 或 dataclass context，例如：

   ```python
   class MaintenanceContext(Protocol):
       def storage(self) -> StorageBackend | None: ...
       def aggregator_config_snapshot(self) -> dict: ...
       def aggregate_batch(...): ...
       def invalidate_cache(...): ...
       async def publish_backfilled(...): ...
   ```

   也可以拆成多个 callback，优先选择本 repo 现有风格中最简单的方式。

2. `DataManager.__init__()` 创建 `MaintenanceService` 时注入 context/callback，而不是
   `self` 整体。

3. `maintenance.py` 内部替换：

   - `self._dm.query_engine.storage` -> `storage_provider()`
   - `self._dm.bar_aggregator...` -> `bar_aggregator` public API 或 callback
   - `self._dm.cache_invalidate(...)` -> `cache_invalidator(...)`
   - `self._dm.on_bars_backfilled(...)` -> `bars_backfilled_callback(...)`

4. 保留 DataManager public facade：

   ```python
   await dm.repair_custom_storage(...)
   await dm.scan_and_fill_storage_gaps(...)
   await dm.delete_storage_data(...)
   ```

   API 层不感知 MaintenanceService 内部变化。

### 验收

```bash
cd backend
python3 -m pytest tests/test_maintenance_facade.py -q
python3 -m pytest tests/test_data_engine_phase1_boundaries.py -q
```

通过标准：

- `MaintenanceService` 不再接收 `data_manager: Any`。
- `maintenance.py` 不直接访问 `query_engine`、`bar_aggregator`、`cache` 等 DataManager
  公开属性。
- settings API 行为不变。

---

## 3. 阶段三：BackfillCoordinator contract 收紧

### 目标

`BackfillCoordinator` 当前负责 request 去重、合并、执行 backfill、回读 storage、
回灌 cache 和发事件。职责可以保留，但依赖需要从 `Any` 收紧为明确 contract。

### 修改范围

- `backend/app/data_engine/data_manager/backfill_coordinator.py`
- `backend/app/data_engine/data_manager/models.py`
- `backend/app/data_engine/backfill/models.py`
- `backend/tests/test_backfill_coordinator.py`
- `backend/tests/test_backfill_reconciler.py`

### 执行步骤

1. 定义最小 Protocol：

   ```python
   class BackfillEngineLike(Protocol):
       async def run(...) -> RepairReport: ...

   class BackfillCacheSink(Protocol):
       async def on_bars_backfilled(...) -> None: ...

   class BackfillEventSink(Protocol):
       async def emit_backfill_event(...) -> None: ...
   ```

   如果事件仍通过 `DataManager.event_bus.emit()`，也应封装成 callback。

2. `BackfillCoordinator.__init__()` 改为接收：

   - `storage: StorageBackend`
   - `engine: BackfillEngineLike`
   - `bars_sink` 或 `on_bars_backfilled`
   - `event_sink` 或 `emit_event`

3. 替换内部 `_dm.on_bars_backfilled()` 和 `_dm.event_bus.emit()` 访问。

4. 保持 `trigger()` 和 `request()` 外部接口兼容，避免影响 QueryEngine/DataManager。

### 验收

```bash
cd backend
python3 -m pytest tests/test_backfill_coordinator.py tests/test_backfill_reconciler.py -q
python3 -m pytest tests/test_query_engine_paths.py -q
```

通过标准：

- `BackfillCoordinator` 不再持有完整 `DataManager`。
- 回补完成后 cache 回灌和事件发布语义不变。
- request 合并、重试、`written_ranges` 精确回读测试继续通过。

---

## 4. 阶段四：DataManager 公开属性降级

### 目标

`DataManager` 继续作为唯一业务门面，但减少外部代码绕过门面的机会。

当前公开属性可分批降级：

```text
cache
event_bus
coordinator
query_engine
bar_aggregator
aggregator_bridge
warm_start
retention
stream_policy
daily_open
price_cache
maintenance
subscriptions
```

### 执行步骤

1. 先找外部调用：

   ```bash
   rg -n "\.cache|\.event_bus|\.coordinator|\.query_engine|\.bar_aggregator|\.subscriptions" app tests -g '*.py'
   ```

2. 为真实外部需求补 facade 方法：

   - 查询 bounds：`dm.get_bounds(...)`
   - 订阅管理：`dm.subscription_service()` 或 `dm.set_subscription_tier(...)`
   - 诊断：`dm.snapshot()`
   - 事件订阅：`dm.subscribe()` / `dm.subscribe_iter()`
   - 维护：`dm.repair_custom_storage()` 等

3. 迁移 API/indicator/runtime 调用方。

4. 将内部属性改为 `_cache`、`_event_bus`、`_query_engine` 等。

5. 对仍需兼容的属性，短期保留 `@property` 只读代理，并在注释中标明兼容用途。

### 验收

```bash
cd backend
python3 -m pytest tests/test_data_engine_phase1_boundaries.py -q
python3 -m pytest tests/test_price_subscription_services.py tests/test_stream_api.py -q
```

通过标准：

- API/indicator 不直接访问 DataManager 内部组件。
- 测试中可允许白盒访问，但业务代码中不能新增绕行路径。
- `DataManager` public API 列表能从 `manager.py` 一眼看清。

---

## 5. 阶段五：收紧 `data_manager/__init__.py` 导出

### 目标

包根只导出稳定外部 API，不再默认暴露所有内部组件。

推荐保留：

```text
DataManager
DataManagerConfig / CacheConfig / QueryConfig / EventBusConfig / CoordinatorConfig
PrewarmTarget
BarData / SeriesKey / QueryResult / QuerySource / MissingRange
DataEvent / DataEventType / SubscriptionHandle / StreamInfo / StreamStatus
StorageBackend
MaintenanceBusyError / MaintenanceUnavailableError
SubscriptionTier
```

推荐从包根移除：

```text
BarCache
BarSeries
DataEventBus
DailyOpenService
QueryEngine
StreamCoordinator
IngestionFactory
IngestionPriceSource
MaintenanceService
PriceSnapshotCache
SubscriptionService
```

这些内部类仍可通过具体模块导入，测试需要白盒时使用具体模块路径。

### 执行步骤

1. 搜索包根导入：

   ```bash
   rg -n "from app\.data_engine\.data_manager import" app tests -g '*.py'
   ```

2. 将内部组件导入改为具体模块路径，例如：

   ```python
   from app.data_engine.data_manager.query import QueryEngine
   ```

3. 缩小 `__all__`。

4. 更新 README 示例，避免示例继续鼓励从包根导入内部实现。

### 验收

```bash
cd backend
python3 -m pytest tests/test_data_engine_phase1_boundaries.py -q
python3 -m pytest -q
```

通过标准：

- 外部业务代码只从包根拿 facade、config、model、exception、enum。
- 内部测试如需白盒，可以从具体模块导入。

---

## 6. 阶段六：`Any` 到 Protocol 的清理

### 目标

减少架构边界处的隐式耦合。不是全项目类型洁癖，只处理跨模块 contract。

优先处理：

- `MaintenanceService`
- `BackfillCoordinator`
- `IngestionPriceSource`
- price stream controller
- storage/backend interfaces

### 执行步骤

1. 每个服务只定义自己实际使用的最小 Protocol。

2. Protocol 放置原则：

   - 只被一个模块使用：放在该模块文件顶部。
   - 多个 data_manager 子模块共享：放在 `data_manager/models.py` 或单独 `contracts.py`。
   - backfill 公共报告类型继续优先复用 `backfill.models`。

3. 避免为了类型而引入反向 import。必要时使用 `TYPE_CHECKING`。

4. 不强行上 mypy；以测试和 import 边界为准。

### 验收

```bash
cd backend
python3 -m compileall app tests -q
python3 -m pytest -q
```

通过标准：

- 跨模块构造函数里的关键依赖不再是裸 `Any`。
- 没有新增循环导入。
- 行为测试不变。

---

## 7. 新增/强化边界测试清单

在 `tests/test_data_engine_phase1_boundaries.py` 中逐步增加以下断言。

### API 不读 runtime 内部字段

禁止 `app/api/v1` 直接出现：

```text
request.app.state.backfill_transport
request.app.state.backfill_engine
request.app.state.backfill_coordinator
request.app.state.ingestion_factory
request.app.state.price_stream_source
```

允许：

```text
request.app.state.data_manager
request.app.state.data_engine_runtime
```

### Settings 只走 facade

禁止：

```text
BackfillEngine(
TransportLayer(
BinanceIngestionFactory(
backfill_engine.run
query_engine._storage
BarAggregator
RepairRequest
```

### DataManager 内部属性不被业务代码访问

业务代码范围：

```text
app/api
app/indicator
app/main.py
```

禁止新增：

```text
.query_engine
.bar_aggregator
.coordinator
.event_bus
.cache
```

测试代码可以白盒访问，但应尽量从具体模块导入。

---

## 8. 推荐执行顺序

严格按下面顺序推进：

1. 阶段一：收窄 `app.state`。
2. 阶段二：Maintenance 解耦。
3. 阶段三：BackfillCoordinator contract 收紧。
4. 阶段四：DataManager 公开属性降级。
5. 阶段五：收紧 `data_manager/__init__.py`。
6. 阶段六：剩余 `Any` 清理。

不要跳过阶段一。当前最大的越界风险就在 API 通过 `app.state` 拿内部组件。

---

## 9. 每阶段完成后的固定检查

```bash
cd backend
python3 -m compileall app tests -q
python3 -m pytest tests/test_data_engine_phase1_boundaries.py -q
python3 -m pytest -q
```

同时执行搜索：

```bash
rg -n "request\.app\.state\.(backfill_transport|backfill_engine|backfill_coordinator|ingestion_factory|price_stream_source)" app tests -g '*.py'
rg -n "app\.data_engine\.services|data_engine\.services|app\.data_engine\.collectors|data_engine\.collectors" app tests -g '*.py'
rg -n "PriceTickerService|SubscriptionManager|kline_cache_service|kline_aggregator|spot_fetcher" app tests -g '*.py'
```

预期：

- 第一条在阶段一完成后无业务代码命中。
- 第二、三条始终无运行时代码命中。
- 全量测试通过。

---

## 10. 风险与回滚

### 风险一：一次性隐藏 DataManager 属性导致调用方大面积破坏

处理：

- 先加 facade，再迁移调用方。
- 短期保留只读 `@property` 兼容。
- 最后再缩 `__all__` 和属性可见性。

### 风险二：Maintenance/Backfill 解耦后事件语义变化

处理：

- 保持 `BACKFILL_COMPLETED`、`BACKFILL_FAILED`、`BAR_AMENDED` 等事件 payload 不变。
- 先用 callback 封装原有调用，不同时改事件结构。
- 对 storage repair、gap scan、query missing range 分别跑测试。

### 风险三：Protocol 抽取引入循环导入

处理：

- Protocol 放在使用方模块顶部，优先本地定义。
- 只把真正共享的 contract 移入 `models.py` 或 `contracts.py`。
- 使用 `from __future__ import annotations` 和 `TYPE_CHECKING`。

### 风险四：runtime facade 过度业务化

处理：

- Runtime 只管运行期 wiring、config、transport restart、shutdown、内部协调器句柄。
- 数据查询、订阅、维护业务仍通过 DataManager facade。
- 如果某能力既可以放 runtime 又可以放 DataManager，优先放 DataManager，除非它明显是运行期基础设施能力。

---

## 11. 完成定义

本轮优化完成时，应满足：

- API 层只依赖 `DataManager` / `DataEngineRuntime` 的明确 public 方法。
- `app.state` 不再暴露 backfill/ingestion/transport 细节给 API。
- `MaintenanceService` 不持有完整 DataManager。
- `BackfillCoordinator` 不持有完整 DataManager。
- `DataManager` 公开属性减少，业务调用方不绕过 facade。
- `data_manager/__init__.py` 不鼓励从包根导入内部服务类。
- 边界测试覆盖上述约束。
- 后端全量测试通过。

完成后的架构目标：

```text
FastAPI / WebSocket / Indicator / Settings
        |
        v
DataManager public facade        DataEngineRuntime public facade
        |                         |
        |                         +-- runtime config / transport restart / shutdown
        |
        +-- query/cache/event/stream/price/subscription/maintenance
        |
        +-- BackfillCoordinator via explicit contract
        +-- MaintenanceService via explicit contract
        +-- ingestion/bar_aggregator/storage via internal wiring
```
