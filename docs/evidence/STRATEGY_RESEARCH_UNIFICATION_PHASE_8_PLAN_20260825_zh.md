# 本地数据与策略研究统一 Phase 8 执行计划（2026-08-25）

## 身份与范围

- 基线：Phase 7 `5761cb6d93e6e00809df28a9820290178ee955ef`（功能提交 `8d0ddd7d`）
- 分支：`codex/strategy-research-unification`
- IMPORTED_DATASET 与 CURRENT_CHART 在 Run 创建前汇合到同一 FrozenResearchContextV1。
- 不实现 Phase 9 LOCAL_OFFLINE 产品入口，不补 CURRENT_CHART 实时图表可视化。
- 不在 Run schema 增加来源特判字段；snapshot_hash 只来自后端 preview/resolve。
- 不改生产默认旗标。

## 漂移判断

chart-first `runChartStrategyBacktest` 仍把 resolve/materialize 与 create 绑在一起，只服务 CURRENT_CHART。Phase 1 已有 FrozenResearchContext 合同，但 Run 路径未调用。统一页脚本/结果槽仍是占位。结果缓存 key 只有 run/report/chart hash，不含 frozen identity。tester stale reasons 没有 SOURCE_CHANGED / DATA_REVISION_CHANGED。

## 实施顺序

1. 把 run request 拆成 source resolve 与 frozen run。CURRENT_CHART 保持 chart-context resolve/materialize；IMPORTED_DATASET 只 preview，不 materialize、不联网补历史。
2. 两条路径都 `assembleFrozenResearchContext`，snapshot 来自后端。
3. 用 FrozenResearchContext 生成同一套 Run body；create/validate 继续校验 dataset/data_epoch/snapshot。
4. 结果缓存 key 加入 dataset/data_epoch/snapshot。
5. source/revision 变化同一帧 STALE 并隐藏旧 marker。
6. BAR_ONLY 导入数据强制 BAR_APPROX，UI 不声称高精度已可用。
7. 新增 StrategyResearchScriptPanel / ResultPanel，接入统一 App；复用 TradeExplanation、RUN_COMPARE、marker source。
8. 后端 `freeze_imported_research_context` + `test_backtest_research_source.py`。
9. 保持现有 chart-first `test:backtest` 验收。

## 预计修改文件

- `frontend/src/features/backtest/chart-tester/chartStrategyRunRequest.ts`
- `frontend/src/features/backtest/chart-tester/ChartStrategyTesterRuntime.ts`（marker 清场已有，补 identity stale）
- `frontend/src/features/backtest/chart-tester/chartStrategyTesterState.ts`
- `frontend/src/features/backtest/chart-tester/chartStrategyResultCache.ts`
- `frontend/src/features/strategy-research/StrategyResearchScriptPanel.tsx`
- `frontend/src/features/strategy-research/StrategyResearchResultPanel.tsx`
- `frontend/src/features/strategy-research/StrategyResearchApp.tsx`
- `backend/app/backtest/runtime.py`
- `backend/app/api/v1/backtests.py`（导入数据拒绝非 BAR_APPROX）
- `backend/tests/test_backtest_research_source.py`

## 退出标准

- 两种来源在 Run 创建前汇合到同一 FrozenResearchContext。
- Run schema 无来源特判分叉。
- 普通 UI 不要求用户选择 dataset ID。
- chart-first 全部现有验收继续通过。

## 回滚

关闭 `VITE_RESEARCH_DATA_LIBRARY_ENABLED`；CURRENT_CHART 继续现有 chart-context，导入数据回到只看图。
