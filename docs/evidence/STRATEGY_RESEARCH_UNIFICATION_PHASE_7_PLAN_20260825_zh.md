# 本地数据与策略研究统一 Phase 7 执行计划（2026-08-25）

## 身份与范围

- 基线：Phase 6 `fbbfbab7930f63f06c46d1c8f1c0959d4969f471`（功能提交 `3eb4d789`）
- 分支：`codex/strategy-research-unification`
- 让统一策略页对 IMPORTED_DATASET 达到现有 local.html 的图表/分析行为等价。
- 不实现 Frozen Run / chart-first 运行路径（Phase 8）。CURRENT_CHART 图表仍为槽位。
- 不改生产默认旗标；不静默联网补 K 线、插值、换周期或切换 revision。

## 漂移判断

Phase 6 StrategyResearchApp 的图表槽仍是文案占位。LocalApp 仍拥有 LocalChart、LocalDatasetWorkspace、指标/绘图/导出/分析装配。ResearchDataDrawer 在打开时自行 `useResearchDataLibrary`，与 App 并存会形成第二份资料库 store。LocalKlineApi 已返回空 stream URL，interval 政策已拒绝非整数倍，但统一页尚未复用。

## 实施顺序

1. 抽出 `useLocalIntervalSelection`：`dataset_id + data_epoch` 隔离的周期键与 15m→30m/1h/90m、拒绝 89m。
2. 新增 `StrategyResearchChart.tsx`：复用 SeriesDataFeed → SeriesWindowStore → SingleChartPanes；IMPORTED_DATASET 只用 LocalKlineApi；接入左翻页、range 定位、指标、绘图、导出、主题、价格轴、视口。
3. StrategyResearchApp 成为唯一 `useResearchDataLibrary` 所有者；选中资料库条目时 dispatch 真实 IMPORTED_DATASET 身份；drawer 只消费传入的 library。
4. StrategyResearchShell 接入 toolbar / interval / export / analysis 槽；CURRENT_CHART 仍占位。
5. LocalApp 改为兼容装配：调用抽出的图表，不再内嵌 LocalChart / LocalDatasetWorkspace。
6. 增加网络 allowlist 测试：禁止 exchange / symbols / stream / online indicators。
7. local-data 与 research-data 测试一并回归。

## 预计修改文件

- `frontend/src/features/strategy-research/StrategyResearchChart.tsx`
- `frontend/src/features/strategy-research/StrategyResearchApp.tsx`
- `frontend/src/features/strategy-research/StrategyResearchShell.tsx`
- `frontend/src/features/strategy-research/strategyResearch.css`
- `frontend/src/features/research-data/ResearchDataDrawer.tsx`
- `frontend/src/features/research-data/useResearchDataLibrary.ts`
- `frontend/src/features/local-data/LocalApp.tsx`
- `frontend/src/features/local-data/useLocalIntervalSelection.ts`
- `frontend/src/features/local-data/localAppShell.test.ts`
- `frontend/src/features/strategy-research/__tests__/*`
- `frontend/package.json`（`test:research-data` 纳入 local-data）

图表运行时文件（useLocalChartRuntime / useLocalIndicatorRuntime / localAnalysisStore / localIntervalPolicy / LocalKlineApi）以复用为主，仅在 allowlist 与装配需要时改测试。

## 退出标准

- unified workspace 对导入数据达到 local.html 功能等价。
- 同一 `dataset_id + data_epoch` 贯穿图表、指标、绘图和事件。
- 所有 local-data 测试迁移后仍通过。
- legacy local.html 只剩兼容装配，不拥有独立图表业务逻辑。
- 无 online kline / stream / indicator fallback。

## 回滚

关闭 `VITE_RESEARCH_DATA_LIBRARY_ENABLED`；`/local.html` 恢复 LocalApp 装配。磁盘 revision 与 `candlescope:local-interval:v1:` / `candlescope:local-analysis:v1:` / `candlescope:local-indicators:v1:` 旧键不变。
