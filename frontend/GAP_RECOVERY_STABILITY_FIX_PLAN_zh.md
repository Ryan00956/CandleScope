# Gap Recovery 图表稳定性修复方案

## 背景

当前前端图表会在数据更新或等待一小段时间后出现两个联动现象：

- 底部 `bars` 数量在较大数值和较小数值之间反复跳动。
- 图表横向位置跟随 `bars` 数量变化发生跳动。

现场观察到的典型序列是 `1722 bars -> 722 bars -> 1722 bars -> 722 bars`。同时控制台出现密集的 backfill completion 日志，以及 gap recovery 周期性日志：

- `Backfill completed for BTCUSDT@1h, reloading data...`
- `[GapFill] Detected 1 gap(s), ~5069 bars missing. Reloading full history for BTCUSDT@1h...`
- `[GapFill] All gaps filled successfully (721 total bars)`

这说明问题不是实时单根 tick 更新导致的，而是历史修复路径在周期性改变整份 K 线数据集。

## 根因判断

核心根因在 `frontend/src/features/market-data/useChartGapRecovery.js`：

1. gap recovery 每 `GAP_RECOVERY_SCAN_MS` 扫描当前缓存。
2. 这个缓存可能已经被 backfill 或 load-more-left 向左扩展，包含超出 `days` 历史窗口的旧数据。
3. 一旦 `detectGaps(...)` 在合并后的缓存里发现内部缺口，当前实现会调用 `fetchKlinesHistory(sym, intv, days, ...)`。
4. 返回结果随后通过 `replaceChartData(..., { cache: true, source: "gap-fill-history" })` 整段替换 active chart data 和 cache。

同一个破坏性模式还存在于 Tab 恢复路径：`visibilitychange` 回到可见后会调用 `fetchKlinesHistory(days)`，随后通过 `replaceChartData(..., { source: "tab-recovery-history" })` 整段替换。即使周期扫描修好，如果漏掉这条路径，用户切回标签页时仍可能发生一次截断和位置跳动。

`replaceChartData` 是破坏性替换；当 `fetchKlinesHistory(days)` 只返回最近 `days` 窗口时，会截断已经通过 backfill/load-more-left 扩展出来的左侧历史。随后 backfill 或 load-more-left 又通过 `commitMergedChartData` 把旧数据合并回来，于是形成：

```text
backfill/load-more merge -> bars 增加
gap recovery history replace -> bars 减少
backfill/load-more merge -> bars 再增加
gap recovery history replace -> bars 再减少
```

底部 `barCount` 来自 `chartData.length`，所以用户看到的 `bars` 数量会反复跳。

图表位置跳动是下游结果：`SingleChartPanes` 只有在尾部追加或尾部更新时才走 `series.update(...)`。当数据集被整段替换、左侧历史被截断、首尾时间域变化时，`canUseTrailingCandleUpdate(...)` 返回 false，图表会走 `series.setData(...)`。这会触发 lightweight-charts 重算时间轴，可见时间不再存在或被钳制时，位置恢复逻辑也无法稳定保住原位置。

## 当前未提交改动的问题

当前未提交修改能缓解部分症状，但没有移除破坏性替换。

### `SingleChartPanes.jsx` 可见区间快照恢复

新增的 `readVisibleRangeSnapshot` / `restoreVisibleRangeSnapshot` 是下游抢救策略。它不能阻止数据集被替换成更短集合，因此不能阻止 `barCount` 跳动。

当 gap recovery 截断左侧历史后，原可见时间可能已经不在数据域内，`setVisibleRange(...)` 会失败或被轻图库钳制。即使 rAF 二次恢复，也只能尽力缓和，不能稳定修复。

### 移除 backfill completion 的 `setDatasetKey`

移除 `setDatasetKey(version + 1)` 可以减少 backfill 完成后的整图重置，但不影响 gap recovery 的 `replaceChartData(...)`。因此主循环仍然存在。

同时 `datasetKey` 也是指标重算相关逻辑的触发信号之一。移除后必须确认 backfill 新增区间是否完全由 `requestIndicatorRangeInChunks(...)` 覆盖，否则可能出现新增历史区间没有指标数据或指标延迟刷新。

### `handleVisibleLogicalRangeChange` gate 回归

把整个 `handleVisibleLogicalRangeChange` 放到 `userInteractedRef.current` 后面，会让 `onNeedMoreLeft` 自动触发也依赖用户交互。保存可见区间可以依赖用户交互，但 load-more-left 的触发不应该被一起 gate，否则首屏未交互时可能无法自动向左补数据。

## 修复目标

1. gap recovery 不再周期性缩短 active chart data。
2. `barCount` 在 backfill/load-more-left 扩展后保持单调或稳定，不被 `days` 窗口覆盖截断。
3. gap recovery 对可修复缺口只补缺口，不整段覆盖已经扩展过的历史。
4. 对无法由 `days` history 修复的持久性缺口建立退避或忽略机制，避免每 10 秒重复触发。
5. 保留必要的指标刷新，避免删除 `datasetKey` 后产生指标数据缺失。
6. 恢复 load-more-left 的自动触发语义，不把它绑定到 `userInteractedRef`。

## 修改方案

### Phase 1：禁止 gap recovery 破坏性截断

目标：先消除 `barCount` 反复跳动的主因。

建议改动：

- 在 `useChartGapRecovery.js` 中停止直接使用 `replaceChartData(...)` 覆盖 active chart data。
- 同时处理周期扫描分支和 `visibilitychange` Tab 恢复分支；两处都不能再用较短 `days` history 直接 replace active chart。
- 对每个 detected gap 优先调用范围接口拉取缺口区间，例如缺口 `[gap.from, gap.to]` 内的 missing window。
- 成功获取缺口数据后，使用 `mergeCacheData(...)` 更新 cache。
- 如果修复目标是当前 active series，再调用 `commitMergedChartData(...)` 合并到 chart data。
- 合并前后要保证不会缩短当前 active chart data；可以用当前 cache 与 incoming 合并后的长度、首尾时间做断言式保护。

期望行为：

- gap recovery 只添加或更新缺失 bar，不用较短的 `days` history 替换完整数据。
- 如果范围接口返回空数据，不能触发 active chart data 缩短。

### Phase 2：保留全历史 reload 作为兜底，但必须 merge

目标：如果某些场景仍需要 `fetchKlinesHistory(days)` 兜底，也不能截断左侧历史。

建议改动：

- 如果需要继续调用 `fetchKlinesHistory(days)`，不要把结果直接传给 `replaceChartData(...)`。
- 先读取当前 cache：`currentCache = getCache(symbol, intv, { marketType, exchange })`。
- 使用 `mergeByTime(result.data, currentCache)` 或等价封装合并。
- 将合并结果写回 cache。
- 对 active chart 使用 `commitMergedChartData(...)` 或新增一个明确的 `replaceWithMergedHistory(...)` helper，但 helper 必须保证 `firstTime` 不向右移动，除非这是明确的 session 切换或用户手动刷新。
- Tab 恢复路径也适用同样规则：`tab-recovery-history` 只能 merge 当前 cache，不能把当前 active chart 截回最近 `days` 窗口。
- 如果合并结果与当前 active chart 在时间和值上等价，应跳过 `setChartData(...)` 或复用当前引用，避免制造无意义的新数组触发下游渲染判断。即使 `canUseTrailingCandleUpdate(...)` 通常能把等价尾部更新降级为 `series.update(...)`，实现上仍应尽量避免无变化 commit。

保护条件：

- 如果 `result.data.length < currentCache.length` 且 `result.data[0].time > currentCache[0].time`，禁止直接替换。
- 如果 `result.data` 不能覆盖当前可见范围，不允许通过 replace 改变 active chart data。

### Phase 3：持久性缺口退避与记录

目标：避免同一无法修复的缺口每 10 秒重复触发。

这一阶段是缓解策略，不是对天然闭市缺口的完整根治。在没有交易日历或后端连续性 metadata 前，`detectGaps(...)` 仍可能把周末、停盘、维护时段识别为缺口；退避只能避免它高频重试和全量 reload。

建议改动：

- 为 gap recovery 增加 `unresolvedGapsRef`，key 可以包含 `exchange/marketType/symbol/interval/from/to`。
- 当一次 gap 修复后 `detectGaps(...)` 仍然发现相同缺口，记录失败次数和下次允许重试时间。
- 对失败次数增加指数退避，例如 10 秒、30 秒、2 分钟、10 分钟。
- 对非 24/7 市场的天然 session gap，后续可以接入交易日历或后端返回的连续性 metadata；在没有交易日历前，至少不要无限频繁全量 reload。

期望行为：

- 可修复缺口被补上。
- 不可修复或后端暂时没有数据的缺口不会持续打扰 active chart。

### Phase 4：恢复 load-more-left 触发语义

目标：修复未提交 diff 中引入的行为回归。

建议改动：

- `scheduleVisibleRangeSave()` 可以继续只在 `userInteractedRef.current` 为 true 时调用。
- `onNeedMoreLeft` 判断应独立于 `userInteractedRef`，仍然在 visible logical range 靠近左边缘时触发。

目标逻辑形态：

```text
if (userInteractedRef.current) {
  scheduleVisibleRangeSave()
}

if (onNeedMoreLeftRef.current && canLoadMoreLeftRef.current && range.from <= LEFT_EDGE_TRIGGER_BARS) {
  onNeedMoreLeftRef.current(currentData[0].time)
}
```

### Phase 5：指标刷新策略复核

目标：确保移除 backfill completion 的 `setDatasetKey` 后，指标仍然覆盖新增历史区间。

检查点：

- `useBackfillCompletionRuntime.js` 中 backfill exact range 和 history range 是否都调用了 `requestIndicatorRangeInChunks(...)`。
- load-more-left 的 older page 是否请求了对应指标区间。
- gap recovery merge 缺口后是否请求缺口范围内的指标。
- `indicatorComputeController.js` 对 `datasetKey` 变化的依赖是否只是强制重算，还是还有清理旧结果、重建订阅等副作用。

建议：

- 如果 `requestIndicatorRangeInChunks(...)` 已经覆盖所有新增数据区间，可以保留减少 `datasetKey` bump 的方向。
- 如果仍有遗漏，新增一个更细粒度的指标 range refresh 事件，不要用整图 dataset reset 来掩盖。

### Phase 6：可见区间恢复降级为防线

目标：保留位置恢复能力，但不把它作为主修复。

建议：

- `SingleChartPanes` 的 snapshot/restore 可以作为最后防线保留或简化。
- 修复重点应放在让 chart data 不被缩短。
- 如果保留 rAF 二次 restore，需要确认它不会和 `hasRestoredRangeRef` 保护的 restore effect 竞争。

## 验证方案

### 静态验证

- 搜索 `replaceChartData(` 的调用点，确认 gap recovery 的周期扫描和 Tab 恢复路径都不再用较短 history 覆盖 active chart。
- 确认 session 切换、初始加载、显式刷新仍可以合法 replace。
- 确认 `handleVisibleLogicalRangeChange` 中 save visible range 与 load-more-left 触发已经解耦。

### 浏览器现场验证

使用 Chrome 打开 `http://127.0.0.1:5173`，观察至少 60 秒。

通过页面文本和 console 验证：

- `bars` 不再在大数和小数之间周期性跳动。
- console 不再每 10 秒重复出现同一个 `[GapFill] Detected ... Reloading full history ...`。
- 如果出现 gap recovery 日志，应表现为 range merge 或退避记录，而不是整段 replace。
- 切到其他标签页或最小化一段时间后再切回，`tab-recovery-history` 不应把 `bars` 截回最近 `days` 窗口。
- 拖动或滚动到左侧触发 load-more-left 后，bar 数可以增长，但不应被下一轮 gap recovery 截断。

### 事件级验证

建议临时观察或测试以下事件：

- `chart.data.commit` 中不应出现由 gap recovery 导致的 bars 明显减少。
- `chart.candleSeries.setData` 次数应显著下降；正常实时 tick 应主要走尾部 update。
- 如果新增 debug 输出，记录每次 data commit 的 `source/bars/firstTime/lastTime`，确认 `gap-fill-history` 不再让 `firstTime` 向右移动。

### 自动化建议

建议补充单元测试或 hook 级测试：

1. 当前 cache 有 1700 根，`fetchKlinesHistory(days)` 返回最近 700 根。
2. gap recovery 触发后，最终 active chart data 不能缩短到 700 根。
3. 缺口 range 拉取返回有效数据时，最终数据应该合并并保持排序去重。
4. 缺口 range 拉取返回空数据时，不应改变 active chart data 长度。
5. 同一 unresolved gap 重复失败时，下一次扫描应命中退避，不应立即再次请求全量 history。

## 风险点

- 如果当前后端缺口 range 接口不能稳定返回历史，需要兜底 merge history，但禁止直接 replace。
- 如果某些市场天然有交易时段缺口，单纯 `detectGaps` 会继续把正常闭市识别为缺口，需要后续接入 session-aware 判断。
- 在未接入交易日历前，持久性缺口退避只能降低重试频率，不能从语义上区分真实缺口和正常闭市。
- 如果完全移除 `datasetKey` bump，指标刷新必须由 range request 完整接管。
- 如果保留 visible range snapshot/restore，需要避免它掩盖数据层问题，验证时仍应以 `barCount` 稳定为主。

## 推荐执行顺序

1. 先改 `useChartGapRecovery.js`，取消周期扫描和 Tab 恢复路径里的破坏性 `replaceChartData`。
2. 增加缺口 range merge 或 history merge 兜底保护。
3. 恢复 `handleVisibleLogicalRangeChange` 中 load-more-left 的自动触发。
4. 复核 backfill/load-more/gap recovery 三条路径的指标 range refresh。
5. 再决定是否保留当前 `SingleChartPanes` 的 visible range snapshot patch。
6. 最后用 Chrome 现场观察 60 秒以上，确认 `bars` 不再周期性缩短。

## 验收标准

- 在 BTCUSDT 当前默认 interval 下，`bars` 在 60 秒内不再出现类似 `1722 -> 722 -> 1722 -> 722` 的周期性跳动。
- backfill/load-more-left 扩展左侧历史后，gap recovery 不会把 `firstTime` 向右截断。
- 实时 tick 更新不触发整段 `series.setData`。
- 未交互首屏仍能在接近左边缘时触发 load-more-left。
- 新增历史区间的指标数据能够按 range 刷新，不依赖整图 dataset reset。
