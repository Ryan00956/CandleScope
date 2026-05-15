# 前端历史 K 线与指标加载错位排查报告

日期：2026-05-15

## 结论

当前“指标已经加载，但 K 线没有加载”的现象，不是指标计算直接阻塞了 K 线加载，而是大改指标系统后，前端形成了两条不同步的数据通路：

- K 线图只认 `App.jsx` 里的 `chartData`，由 `/klines/latest`、`/klines/history`、`/klines/history/before` 和 K 线 WS 更新。
- 指标现在主要走 `/api/v1/stream/indicators`，后端直接从 `DataManager.query_latest()` 或 IndicatorEngine 快照生成指标数据。

因此，只要后端 DataManager 已经有数据或回填刚完成，指标 WS 就可能先把快照推给前端；但 K 线图仍可能卡在 `chartData` 未重拉、重拉窗口不覆盖目标历史段、或 backfill_completed 事件被去重/错过的状态。刷新页面能恢复，是因为刷新会重新走一次完整初始历史查询和订阅流程。

补充排查后，当前更具体的判断是：

- 后端 backfill 主链路暂时没有证据显示是根因。目标后端测试 `test_backfill_coordinator.py`、`test_query_engine_paths.py`、`test_klines_api.py` 在设置 `PYTHONPATH=backend` 后通过。
- 真正可证明的 bug 在前端消费 backfill 结果的位置：前端没有使用后端 `BACKFILL_COMPLETED` 携带的精确修复范围，并且左侧分页 pending retry 的 `attempts` 计数会被 safety retry 提前耗尽，导致真正 backfill_completed 到达时跳过补拉。

## 本次已修复

修改文件：`frontend/src/App.jsx`

已做两处短期修复：

1. `backfill_completed` 现在优先读取 `msg.detail.range_start_ms` / `range_end_ms`，调用已有的 `fetchKlinesRange()` 精确回读刚刚回填完成的区间，并使用 `repair=none` 避免再次触发回填循环。之后仍保留默认 `/klines/history` 刷新作为兜底；单个请求失败不会阻断后续恢复步骤。
2. `pendingLoadMoreLeftRef` 的计数从单一 `attempts` 拆成 `safetyAttempts` 和 `completionAttempts`。安全定时器不再消耗 backfill 完成事件的补拉机会，也不会因为一次 safety retry 仍返回 0 bars 就删除 pending cursor。

这次修的是已经能证明的前端竞态。它不能替代长期的 range-based K 线状态机，但应该能解决“后端已经完成回填/指标已重算，主 K 线没有按原历史位置补拉”的主要路径。

## 已验证的后端链路

后端 backfill 到前端事件的链路是：

```text
QueryEngine / ingestion gap
  -> DataManager._submit_missing_ranges()
  -> BackfillCoordinator.request()
  -> BackfillEngine.run()
  -> Reconciler 写 storage
  -> BackfillCoordinator._load_backfilled_to_cache()
  -> DataManager.on_bars_backfilled()
  -> EventBus BACKFILL_COMPLETED
  -> /stream/klines_multi
```

关键代码位置：

- `backend/app/data_engine/data_manager/manager.py:318`：DataManager 注入 backfill trigger。
- `backend/app/data_engine/data_manager/manager.py:434`：DataManager 把 `QueryResult.missing_ranges` 显式提交给 backfill trigger。
- `backend/app/data_engine/data_manager/backfill_coordinator.py:521`：Coordinator 调用 BackfillEngine。
- `backend/app/data_engine/data_manager/backfill_coordinator.py:630`：Coordinator 按实际 `written_ranges` 从 storage 回读。
- `backend/app/data_engine/data_manager/manager.py:1038`：DataManager 回灌 cache 并发布 `BACKFILL_COMPLETED`。
- `backend/app/api/v1/stream.py:292`：K 线 WS 把 `BACKFILL_COMPLETED` 转发给前端。

后端事件 detail 已经包含可用于精确重拉的范围：

- `backend/app/data_engine/data_manager/backfill_coordinator.py:665`
- `backend/app/data_engine/data_manager/backfill_coordinator.py:666`
- `backend/app/data_engine/data_manager/backfill_coordinator.py:667`
- `backend/app/data_engine/data_manager/backfill_coordinator.py:668`

字段包括：

- `range_start_ms`
- `range_end_ms`
- `request_start_ms`
- `request_end_ms`
- `verified_contiguous`
- `remaining_missing_bars`

也就是说，后端已经把“修了哪一段”发出来了。

## 关键证据

### 1. 指标已不再严格依赖前端 K 线数组

`frontend/src/hooks/useIndicators.js` 中，前端只要 `chartData` 非空就建立指标 WS 订阅：

- `chartDataRef.current.length > 0` 是启动条件。
- `historyLimit` 只用当前前端数据长度作为请求参数。
- 真正的指标历史数据由后端订阅处理。

对应代码：

- `frontend/src/hooks/useIndicators.js:567`
- `frontend/src/hooks/useIndicators.js:598`
- `frontend/src/hooks/useIndicators.js:602`

后端收到订阅后不是使用前端传来的 OHLCV，而是直接查询 DataManager：

- `backend/app/api/v1/stream.py:727`
- `backend/app/api/v1/stream.py:728`
- `backend/app/api/v1/stream.py:736`

回填完成后，IndicatorEngine 也会直接从 DataManager 重算：

- `backend/app/indicator/data_manager_bridge.py:31`
- `backend/app/indicator/data_manager_bridge.py:37`
- `backend/app/indicator/data_manager_bridge.py:45`

这说明指标显示和主 K 线显示已经不是同一个前端状态源。

### 2. K 线图只由 `chartData` 驱动

主图蜡烛由 `ChartPane` 的 `data` prop 更新：

- `frontend/src/components/ChartPane.jsx:555`
- `frontend/src/components/ChartPane.jsx:585`

如果 `chartData` 没被 `App.jsx` 成功更新，主图不会因为指标 WS 有数据而显示 K 线。

### 3. 初始加载阶段允许“只有 quick tail 数据，但 loading 仍未解除”

`loadData()` 会并行请求：

- `/klines/latest`，只取 5 根。
- `/klines/history`，取完整历史窗口。

quick result 会写入 `chartData`，但没有缓存命中时不会解除 loading：

- `frontend/src/App.jsx:924`
- `frontend/src/App.jsx:936`
- `frontend/src/App.jsx:954`

这会产生一个窗口：`chartData` 已非空，指标 WS 可以启动；但主图仍显示加载遮罩，完整历史还没成功进入 `chartData`。

如果此时 `/klines/history` 返回空并触发后台 backfill，前端进入 retry/safety timer 路径：

- `frontend/src/App.jsx:988`
- `frontend/src/App.jsx:1000`
- `frontend/src/App.jsx:1028`
- `frontend/src/App.jsx:1033`

这解释了“指标看起来加载了，K 线没加载，刷新又好”的随机性。

### 4. 左侧历史加载和缺口修复补丁仍是局部状态机

左侧加载失败时，前端把请求记入 `pendingLoadMoreLeftRef`：

- `frontend/src/App.jsx:1758`
- `frontend/src/App.jsx:1775`
- `frontend/src/App.jsx:1782`

backfill_completed 后再尝试补一次 `fetchKlinesBefore()`：

- `frontend/src/App.jsx:1301`
- `frontend/src/App.jsx:1317`
- `frontend/src/App.jsx:1359`
- `frontend/src/App.jsx:1367`

修复前这里有一个具体 bug：`PENDING_LOAD_MORE_LEFT_MAX_ATTEMPTS = 1`，但 safety timer 和 backfill_completed 共享同一个 `pending.attempts` 计数。

当前时序可以变成：

1. `/history/before` 返回 0 bars + `has_more=true`。
2. 前端记录 `pending = { before, attempts: 0 }`。
3. 6 秒 safety timer 先触发，把 `attempts` 加到 1，并再试一次 `fetchKlinesBefore()`。
4. 如果这时后端仍未完成回填，第二次仍是 0 bars + `has_more=true`，pending 保持 `attempts = 1`。
5. 真正的 `backfill_completed` 随后到达。
6. backfill_completed handler 看到 `pending.attempts >= 1`，直接删除 pending 并 `return`，不会执行 `fetchKlinesBefore()`。

修复后对应逻辑：

- safety timer 只增加 `safetyAttempts`，达到上限后保留 pending，等待真正的 `backfill_completed`。
- backfill_completed 只检查 `completionAttempts`，仍会按原 `before` cursor 调用 `fetchKlinesBefore()`。
- backfill_completed 还会先用事件 detail 的精确毫秒范围调用 `fetchKlinesRange()`，避免默认 history 窗口不覆盖旧历史段。

这是一个确定的竞态 bug。它会直接造成：后端完成了、指标收到 backfill 后重算了，但主图没有再按原 before cursor 拉取左侧 K 线。

除此之外，这里仍只是某一种路径的补丁，不是统一的数据提交机制。只要以下任一情况发生，K 线仍可能不更新：

- backfill_completed 事件先于前端 K 线 WS 订阅到达。
- backfill_completed 被 `backfillReloadInFlightRef` 去重跳过。
- `/klines/history` 的默认 days 窗口不覆盖用户滚到的更老历史段。
- `pendingLoadMoreLeftRef` 只允许一次额外尝试，后端仍在更深层回填时就被清掉或不再触发。
- 多个 recovery 入口同时运行，互相覆盖缓存、loading、hasMoreLeft 状态。

### 5. 前端缺口检测仍依赖“默认历史窗口重拉”

`recoverGaps()` 检测到缺口后只调用 `fetchKlinesHistory(symbol, interval, days)`：

- `frontend/src/App.jsx:1581`
- `frontend/src/App.jsx:1604`
- `frontend/src/App.jsx:1605`

这对当前屏幕附近的 tail gap 有用，但对用户已经左滑到很早以前的历史缺口不可靠，因为默认 days 窗口可能根本不覆盖那个缺口。

这个问题在仓库已有设计文档里也被指出过：`backend/app/data_engine/ZERO_VISIBLE_GAP_REPAIR_DESIGN_zh.md` 提到前端 `recoverGaps()` 只重拉默认 days，不能精准请求缺口范围。

### 6. 前端没有使用后端 backfill 精确范围

后端 `BACKFILL_COMPLETED` 已经通过 `msg.detail` 携带 `range_start_ms` / `range_end_ms` / `request_start_ms` / `request_end_ms`。

修复前，前端 `frontend/src/App.jsx` 对这些字段没有任何引用。验证命令：

```bash
rg -n "range_start_ms|range_end_ms|request_start_ms|request_end_ms" frontend/src
```

结果：无业务代码命中。

同时，`frontend/src/services/api.js` 已经有 `fetchKlinesRange()`，但修复前 `App.jsx` 没有导入也没有使用它：

- `frontend/src/services/api.js:77`

所以修复前 backfill_completed 消费逻辑只能：

- 重拉默认 `/klines/history?days=...`。
- 在存在 pending left cursor 时额外补一次 `/history/before`。

它不能基于后端事件精确修复主图当前缺失的那段历史。这就是为什么缺口/左侧历史位置更容易出问题。本次修复已经把 `fetchKlinesRange()` 接入 `backfill_completed`。

## 典型竞态时序

### 场景 A：初始历史为空或后端正在回填

1. `loadData()` 开始，`chartData` 先清空，loading=true。
2. `/klines/latest` 返回最近 5 根，写入 `chartData`，但 loading 仍然不解除。
3. `useIndicators` 发现 `chartData.length > 0`，建立指标 WS。
4. 指标 WS 后端从 DataManager 查询并返回指标快照。
5. `/klines/history` 返回空或 backfill 中，K 线主图仍等待 retry/backfill_completed。
6. 用户看到“指标/指标窗格有内容，但 K 线仍加载中或缺历史段”。

### 场景 B：左侧滚动触发历史分页

1. 用户滚到左边，`fetchKlinesBefore()` 返回 0 bars + `has_more=true`。
2. 前端记录 pending cursor。
3. 后端继续 backfill。
4. IndicatorEngine 收到 backfill_completed 后直接重算并推指标快照。
5. K 线图需要前端收到 backfill_completed，再用同一个 before cursor 补拉。
6. 如果事件错过、被去重、或补拉窗口仍未命中，就会出现指标先恢复而 K 线不恢复。

### 场景 C：safety retry 早于 backfill_completed

1. 用户左滑，`fetchKlinesBefore()` 返回 0 bars + `has_more=true`。
2. 前端设置 pending，`attempts = 0`。
3. 6 秒 safety retry 触发，`attempts = 1`，并再次请求 `/history/before`。
4. backfill 还没完成，第二次请求仍返回 0 bars + `has_more=true`。
5. backfill 稍后完成，指标系统通过后端 DataManager 更新。
6. K 线 WS 收到 `backfill_completed`，但 handler 因为 `attempts >= 1` 删除 pending 并跳过 `fetchKlinesBefore()`。
7. 主图左侧 K 线仍然缺失，刷新后恢复。

## 当前补丁为什么没有根治

这些补丁都在处理症状：

- 初始加载增加一次 3 秒 retry 和 10 秒 safety timer。
- backfill_completed 后重拉默认历史窗口。
- 对左侧 pending cursor 再补一次 `fetchKlinesBefore()`。
- 定期扫描本地缓存缺口并重拉默认 history。

但根问题是：前端没有一个统一的“历史数据段请求状态机”。K 线、指标、缺口扫描、backfill_completed、左侧分页、tab recovery 各自都能触发查询和写缓存。指标链路已经后端托管，K 线链路仍是多个前端局部 effect 拼起来的。

## 测试与验证记录

### 后端目标测试

命令：

```bash
env PYTHONPATH=backend pytest backend/tests/test_backfill_coordinator.py backend/tests/test_query_engine_paths.py backend/tests/test_klines_api.py -q
```

结果：

```text
18 passed in 3.47s
```

这不能证明后端永远没有运行时问题，但至少说明当前目标单测没有支持“backfill 主链路坏了”的判断。

### 前端构建

命令：

```bash
cd frontend && npm run build
```

结果：通过。

```text
✓ built in 3.10s
```

### 前端 lint

命令：

```bash
cd frontend && npm run lint
```

结果：失败，但失败点在 `WatchlistSidebar.jsx` 的既有 lint 问题；和本次 K 线/backfill 消费链路无直接关系。`App.jsx` 仍有 hook 依赖 warning，其中 `handleNeedMoreLeft` 缺 `chartData` 依赖，这会进一步增加异步闭包不稳定性，但不是上面那个 pending attempts bug 的必要条件。

### pending attempts 状态机模拟

用 Node 模拟当前源码的 pending 逻辑：

```text
case safetyBeforeBackfill=false
pending set attempts=0 before=1000
backfill_completed fetchBefore, attempts=1
fetchBeforeCalls=1 pending= { before: 1000, attempts: 1 }

case safetyBeforeBackfill=true
pending set attempts=0 before=1000
safety retry fetchBefore, attempts=1
pending kept attempts=1
backfill_completed deletes pending due to attempts>=MAX; no fetchBefore
fetchBeforeCalls=1 pending= null
```

这证明：只要 safety retry 早于真正的 backfill_completed，backfill_completed handler 就可能不再执行补拉。

## 建议修复方向

### P0：先统一前端 K 线数据提交口

新增一个明确的 chart data store 或 reducer，所有入口只能 dispatch 事件，不能各自直接 `setChartData()`：

- `INITIAL_HISTORY_LOADED`
- `LATEST_PATCH_LOADED`
- `BEFORE_PAGE_LOADED`
- `BACKFILL_COMPLETED`
- `GAP_RANGE_REPAIRED`
- `WS_BAR_UPDATED`

这个 reducer 负责：

- 按 `exchange + marketType + symbol + interval` 隔离状态。
- 维护 `loadedRanges`、`pendingRanges`、`backfillingRanges`。
- 合并、去重、排序 K 线。
- 决定 loading/hasMoreLeft，而不是让多个 effect 分散设置。

### P0：backfill_completed 不应只重拉默认 days

backfill_completed 消息应带可修复范围，前端优先按 exact range 或 pending cursor 重拉：

- 有 pending left cursor：执行 `/history/before`。
- 有 missing_ranges：执行 `/klines/range` 或等价精确区间查询。
- 没有范围时，才 fallback 到 `/history` 默认窗口。

当前后端已经带了精确范围，所以短期前端可以直接使用 `msg.detail.range_start_ms` / `range_end_ms` 调 `fetchKlinesRange()`，再 merge 到 `chartData`。

### P0：修正 pending attempts 语义

`attempts` 不应该同时表示 safety retry 次数和 backfill_completed 消费次数。

建议短期改法：

- pending 记录拆成 `safetyAttempts` 和 `completionAttempts`。
- 或者 backfill_completed 不检查 safety retry 的 attempts，只要 pending cursor 仍存在，就至少补拉一次。
- safety retry 如果仍返回 0 bars + `has_more=true`，不能因为达到 1 次就删除 pending；应该等待 backfill_completed 或按 request id/range 判断超时。

### P1：指标订阅应绑定前端可见历史版本

指标 WS 不一定要依赖前端 OHLCV，但应携带一个明确的 `chartDataVersion` 或 `loadedRange`：

- 当前端 K 线历史段尚未提交，不应让指标 pane 给用户造成“这段历史已经可见”的错觉。
- 指标快照返回后可标注其 `sourceRange`，前端能判断是否覆盖当前主图 loaded range。

### P1：移除前端多套 gap repair 入口

保留一个缺口修复调度入口，其余入口只提交“发现缺口”的事件：

- 左侧分页短缺。
- 本地 detectGaps。
- tab visibility recovery。
- WS reconnect recovery。
- backfill_completed。

由同一个调度器决定是否请求、请求哪个范围、何时重试。

## 推荐验证用例

1. 清空某交易对某周期一段历史存储，只保留最新几根，打开前端观察：
   - 指标不应先于主 K 线历史段进入“已完成”状态。
   - 初始 backfill 完成后，主图必须自动补上历史。

2. 左滑到超过默认 `getIntervalDays()` 的历史位置，触发 `/history/before` 短缺：
   - backfill_completed 后必须用原 before cursor 补拉。
   - 默认 `/history` 不应被当成唯一恢复方式。

3. 人为丢弃一次 backfill_completed WS：
   - pending range 应仍能通过统一 retry 恢复。
   - 不应依赖刷新页面。

4. 同时打开多个指标和自定义 Pyne：
   - 指标 sourceRange 与主图 loadedRange 应一致或明确显示 pending。
   - 主图没有对应 K 线时，不应只显示指标历史。

## 总体判断

指标系统和 K 线加载系统“计算职责”可以独立，但“用户当前看到的历史数据版本”不能独立。现在的问题正是指标显示面已经接入后端 DataManager，而主 K 线显示面仍依赖前端多个松散补丁来追赶 DataManager。缺口检测和回填场景更容易触发，是因为那里本来就是异步、分段、可能返回 0 bars 的路径。

短期两个明确 bug 已在本次修改中处理：

1. backfill_completed 使用 `msg.detail` 精确范围重拉，而不是只重拉默认 days。
2. 修正 `pendingLoadMoreLeftRef` 的 attempts 语义，避免 safety retry 抢占 backfill_completed 的补拉机会。

长期应该把前端 K 线历史加载收敛成一个 range-based 状态机，让指标只作为同一数据版本上的派生视图，而不是另一个可先行显示的历史数据源。
