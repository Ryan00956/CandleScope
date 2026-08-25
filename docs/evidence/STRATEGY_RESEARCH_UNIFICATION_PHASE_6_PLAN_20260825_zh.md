# 本地数据与策略研究统一 Phase 6 执行计划（2026-08-25）

## 身份与范围

- 基线：Phase 5 `c0eb95f6c0b75cb6a34550f91dbf8ec66e3ca947`（SHA 记录 `56867f4b`）
- 分支：`codex/strategy-research-unification`
- 建立 canonical `/strategy.html`，让 `/local.html` 与 `/backtest.html` 在旗标开启时共用同一个 StrategyResearchApp。
- 不删除 LocalApp / BacktestApp；旗标关闭时兼容入口走 legacy fallback。
- 不实现导入图表等价（Phase 7）或 Frozen Run（Phase 8）。图表/策略/结果只放槽位。
- 不改后端、不改生产默认旗标。

## 漂移判断

Phase 5 已有 source/script/result slice、drawer 与 `StrategyResearchRuntime`。三个 HTML 入口仍各自挂 LocalApp / BacktestResearchApp。`vite.config.js` 尚无 strategy entry。旧 deep link 解析在 `backtestDeepLink.ts` / `parseBacktestResearchEntry`。

## 实施顺序

1. 冻结 launch intent 解析（restore / imported / import / advanced / deep-link）。
2. 新增 strategy.html + strategy-main.tsx。
3. StrategyResearchShell：数据抽屉、图表槽、策略槽、结果槽；独立 drawer 错误边界。
4. local-main / backtest-main 改为同一 bootstrap；flag=0 保留 legacy。
5. vite 增加 strategy 入口。
6. 测试：三入口同一 App、deep link、flag fallback、首屏不加载 Monaco/Study/Python、单一资料库 runtime。

## 预计修改文件

- `frontend/strategy.html`
- `frontend/src/strategy-main.tsx`
- `frontend/src/local-main.tsx`
- `frontend/src/backtest-main.tsx`
- `frontend/src/features/strategy-research/*`
- `frontend/vite.config.js`
- `frontend/src/i18n/catalogs/en.ts` / `zh-CN.ts`

## 退出标准

- `/strategy.html` canonical 可启动。
- `/local.html` 默认本地资料库（flag on）。
- `/backtest.html` 默认高级研究（flag on）。
- 三入口同一 StrategyResearchApp。
- 旧 run/compare/context deep link 可解析。
- LocalApp/BacktestApp 仍在，flag=0 可回退。
- 同一个 App 不创建两份资料库 store。

## 回滚

关闭 `VITE_RESEARCH_DATA_LIBRARY_ENABLED`；local.html / backtest.html 恢复 legacy App。
