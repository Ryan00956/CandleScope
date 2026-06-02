# K 线加载问题排查记录

本文件记录 CandleScope 中"K 线有时加载不出来"相关 bug 的根因分析与修复。

---

## Bug #1：冷启动首屏 K 线空白（已修复）

### 现象

首次打开某个尚未缓存的 symbol / interval 时，图表偶尔长时间空白，需要等待
若干秒后才出现 K 线；快速切换 symbol 时更容易复现"K 线加载不出来"。

### 根因

冷启动数据流存在一个"空白窗口"：

1. 前端 `useChartInitialLoad` 并行请求 `/klines/latest`（快速 seed 几根）和
   `/klines/history`（主历史）。
2. 在**冷缓存**下：
   - `/klines/latest` 用 `auto_backfill=False`，直接返回空（`source=empty, count=0`）。
   - `/klines/history` 也立即返回**空数组**，只在后台**异步**触发 backfill。
3. 因此首屏没有任何数据，完全依赖两条恢复机制补救：
   - 前端**每 3s 一次的重试轮询**（`INITIAL_BACKFILL_RETRY_MS`）。
   - WebSocket 的 **backfill 完成事件**。
4. 一旦这两条恢复链被打断（快速切换 symbol 触发 `AbortController.abort()`、
   WS 抖动、backfill 偏慢于代理网络），图表就持续空白。

实测：清空数据库后冷启动 7 个 symbol，首次 `/klines/history` 请求 **0/7** 返回数据；
backfill 实际完成耗时约 0.6–3s。

### 修复

`backend/app/api/v1/klines.py` 的 `GET /klines/history` 增加**有界冷启动等待**
（参考已有 `/klines/range` 的 `repair=wait` 模式）：

- 新增查询参数 `max_wait_ms`（默认 `2500`，范围 `0..8000`）。
- 仅当**首次查询返回空且触发了 backfill**（即冷启动）时，在预算内每 200ms
  轮询一次，直到拿到首批数据或超时。
- 轮询的复查使用 `auto_backfill=False`，**只等待已调度的 backfill**，避免重复
  触发 backfill 请求。
- `backfill_triggered` 标志用首次查询结果保留，保证响应语义不变。
- 暖查询（已有缓存）与 `max_wait_ms=0` 时行为不变，立即返回。

### 验证

- 冷启动首屏带数据：**7/7**（修复前 0/7）。
- 暖查询仍约 0.15s 即时返回，无回归。
- `backend/tests/test_klines_api.py` 全部通过（7 passed）。

### 残留

极端慢的 backfill（超过 `max_wait_ms`）仍由前端原有的重试轮询 / WS backfill
事件兜底，但空白窗口已基本消除。

---

## Bug #2：向右拖看历史时"指标画出来了但 K 线没画出来"（已修复）

### 现象

把图表向右拖动加载更早的历史数据（load-more-left / drag-left）时，经常出现
指标线已经延伸绘制、但对应区间的 K 线蜡烛缺失，持续数秒。

### 根因

这是 Bug #1 的"分页版"，叠加上**指标走服务端流式计算**这一关键事实：

1. 拖动触发 `useChartLoadMoreLeft` 调 `GET /klines/history/before` 拉更早的蜡烛。
2. 该更早区间**未缓存**时，后端 `dm.query_before` 立即返回**空**
   （`count=0, has_more=true, backfill_triggered=true`），只调度**异步** backfill。
   前端因此进入 `else if (result.has_more)` 分支：**不提交蜡烛**，仅安排 6s 后重试。
3. 与此同时，**指标是服务端计算并通过 WebSocket 推送的**
   （`indicatorStreamController` 订阅 → 服务端用自己的 K 线算指标 → snapshot/patch）。
   服务端的 backfill 约 2s 就把更早 K 线补好，指标流随即重算并把这段更早区间的
   指标点推给前端、绘制出来。
4. 结果：服务端约 2s 就有数据（指标先画出来），而前端蜡烛要等到 6s 的重试才补上
   ——这段约 4s 的窗口里就是"指标有、K 线无"。

实测：清库后拖动加载，第一次 `/klines/history/before` 对冷区间稳定返回
`count=0`，约 2s 后才有数据。

### 修复

给 `backend/app/api/v1/klines.py` 的 `GET /klines/history/before` 增加与 Bug #1
相同的**有界冷启动等待**，让首个 drag-left 请求就带回蜡烛，与服务端指标流的时间线对齐：

- 新增查询参数 `max_wait_ms`（默认 `2500`，范围 `0..8000`）。
- 仅当首次查询为空且触发了 backfill 时，在预算内每 200ms 轮询；轮询用
  `auto_backfill=False`，只等待已调度的 backfill，不重复触发。
- 为支持上述"只读不重触发"的轮询，给 `auto_backfill` 参数补齐了下游链路：
  `DataManager.query_before`（`manager.py`）→ `QueryEngine.query_before`（`query.py`）。
- **保留语义**：`backfill_triggered` 用首次结果保留；`has_more` 在等待超时仍为空时
  强制保持 `True`（数据仍在路上），避免 `auto_backfill=False` 的复查把它误报成
  `False` 而让前端以为"没有更多历史"。

### 验证

- 冷区间首个 drag-left 请求：多数情况下直接返回 500 根蜡烛（修复前恒为 0）。
- 等待超时（极深历史、网络偏慢）时 `has_more` 仍为 `True`，前端原有重试兜底。
- `backend/tests/` 全量 **187 passed**，无回归。

### 残留与后续可选项

若 backfill 偶尔超过 `max_wait_ms`，仍可能出现短暂的"指标先于蜡烛"。更彻底的
前端侧加固（可选）：在 chart-adapter 渲染指标 overlay 时，按主蜡烛序列的时间范围
裁剪指标点，确保指标永不画到没有蜡烛的区间。本次未改动，以保持改动面最小。

