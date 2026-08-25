# 本地数据与策略研究统一 Phase 10 执行计划（2026-08-25）

## 身份与范围

- 基线：Phase 9 `de15379d4927c666e7058aa6422ff909222c9435`（功能提交 `32edf2a4`）
- 分支：`codex/strategy-research-unification`
- 行情页只保留一个「策略」入口；`/backtest.html` URL 保留为兼容深链。
- 普通策略页与高级研究通过 launch context 传递草稿与不可变身份引用。
- 两个 runtime 继续隔离：StrategyResearchRuntime / ChartStrategyTesterRuntime 不与 useBacktestResearchRuntime 合并。
- 不实现 Phase 11 删除 LocalApp/BacktestApp。

## 漂移判断

TopBar 仍链到 `/backtest.html` 并显示「策略回测」。旗标开启时 `/backtest.html` 已进 StrategyResearchApp，但 advanced/deep-link 未挂载 BacktestResearchApp，五类任务入口进不去。chart-first 面板有无上下文的 `/backtest.html` 链接；CellBridge 已能创建 launch context。researchReturnHref 只回到 live `/?workspace=&cell=`，不会回到 `/strategy.html`。

## 实施顺序

1. TopBar 改为 `/strategy.html` + 「策略」文案；保留 backtest 入口旗标。
2. StrategyResearchApp 在 advanced/deep-link 时嵌入隔离的 BacktestResearchApp。
3. 脚本/结果面板提供「高级研究」，用现有 createResearchLaunchContext 传递 draft、session、range、dataset identity、最近 Run。
4. 导入数据不发明 snapshot hash；有完成 Run 才带 frozen identity。
5. researchReturnHref：strategy-research 工作区回到 `/strategy.html`。
6. 深链无效时显示可行动错误，不选中第一个 dataset。
7. 更新 isolation / launch 测试。

## 预计修改文件

- `frontend/src/app/TopBar.tsx`
- `frontend/src/features/backtest/__tests__/backtestIsolation.test.ts`
- `frontend/src/features/backtest/chart-tester/ChartStrategyTesterPanel.tsx`
- `frontend/src/features/backtest/research/backtestResearchLaunch.ts`
- `frontend/src/features/backtest/research/backtestResearchModel.ts`
- `frontend/src/features/strategy-research/StrategyResearchApp.tsx`
- `frontend/src/features/strategy-research/StrategyResearchScriptPanel.tsx`
- `frontend/src/features/strategy-research/StrategyResearchResultPanel.tsx`
- `frontend/src/features/strategy-research/strategyResearchLaunch.ts`
- `frontend/src/i18n/catalogs/en.ts` / `zh-CN.ts`
- `frontend/src/features/strategy-research/__tests__/*`

## 退出标准

- 产品导航不存在「本地模式 vs 策略回测」并列。
- 普通和高级共享同一脚本草稿与不可变上下文引用。
- 两个 runtime 仍然隔离。
- `/backtest.html?run=...` 仍可打开。

## 回滚

恢复 TopBar `/backtest.html` 链接；统一 StrategyResearchApp 与数据层无需回滚。
