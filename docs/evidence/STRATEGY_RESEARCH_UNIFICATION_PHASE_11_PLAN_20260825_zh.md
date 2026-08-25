# 本地数据与策略研究统一 Phase 11 执行计划（2026-08-25）

## 身份与范围

- 基线：Phase 10 `a88a8ee7584e3d40fdce93c15f468c14a1b83039`（功能提交 `8b680c9d`）
- 分支：`codex/strategy-research-unification`
- 删除重复页面编排，保留 `/local.html` 与 `/backtest.html` 至少一个发布周期。
- LocalApp 继续作为双旗标关闭后的独立本地资料库壳；BacktestApp 改为薄兼容 bootstrap。
- 旧 localStorage 只读，不删除。
- 不实现 Phase 12 verifier、soak、双旗标发布演练或旧分支归档。

## 漂移判断

旗标开启时三个 HTML 已进 StrategyResearchApp。LocalApp 已装配共享图表/资料库，无独立 import poll。BacktestApp 仍有 `listDatasets` + `setInterval` Run 轮询，与 `useBacktestResearchRuntime` / `pollBacktestRunToTerminal` 重复。兼容 URL 无一次性说明。`docs/local-offline-mode.md` 仍写默认 `/local.html` 与「本地分析模式」。README 仍用「本地回测 / Local backtesting」。M9 表单工作台中 RSI trace 等表面只存在于 BacktestApp，需映射后延期而非静默删除。

## 实施顺序

1. 写下 legacy-to-unified 功能映射（含延期项与 follow-up）。
2. BacktestApp 改为薄 bootstrap，挂载已隔离的 BacktestResearchApp。
3. 统一壳在 `/local.html` 与 `/backtest.html` 显示一次性兼容说明，不阻挡使用。
4. 兼容说明与 workspace 恢复不得 `removeItem` 旧键。
5. 更新 README、local-offline-mode、chart-first 文档术语。
6. 用源码 rg 测试证明 import poll / dataset 选择 / Run poll 只有一套实现。

## 预计修改文件

- `frontend/src/features/local-data/LocalApp.tsx`
- `frontend/src/features/backtest/BacktestApp.tsx`
- `frontend/src/features/strategy-research/StrategyResearchApp.tsx`
- `frontend/src/features/strategy-research/strategyResearchBootstrap.tsx`
- `frontend/src/local-main.tsx` / `frontend/src/backtest-main.tsx`（若只需注释则保持入口）
- `frontend/vite.config.js`
- `docs/local-offline-mode.md`
- `docs/BACKTEST_CHART_FIRST_UX_EXECUTION_zh.md`
- `README.md` / `README_zh.md`
- `frontend/src/i18n/catalogs/en.ts` / `zh-CN.ts`

## 退出标准

- 业务编排只有一套。
- 兼容 URL 无数据丢失。
- 文档和 UI 使用同一产品术语。
- 延期能力有明确 follow-up，不被静默删除。
- 旗标关闭仍恢复 LocalApp 兼容壳与 chart-first 高级研究。

## 回滚

恢复兼容 App 装配提交；旧存储键和磁盘数据未删除，可直接重新读取。
