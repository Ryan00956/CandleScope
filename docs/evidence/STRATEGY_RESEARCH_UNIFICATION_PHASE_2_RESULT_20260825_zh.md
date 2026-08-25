# 本地数据与策略研究统一 Phase 2 结果（2026-08-25）

## 结论

Phase 2 通过。LocalApp 不再内嵌导入表单、资料库列表和管理实现；这些能力提取到 `frontend/src/features/research-data`。`useResearchDataLibrary` 拥有加载、选择、import job polling 与取消。`researchDataApi` 只再导出 `localDataApi`，不复制 HTTP。`candlescope:local-interval:v1:` 键未改。新增 `npm.cmd run test:research-data`。

## 测试

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm.cmd run test:research-data` | 0 | 16 passed |
| `tsx --test src/features/local-data/**/*.test.{ts,tsx}` | 0 | 28 passed |
| `npm.cmd run test:backtest` | 0 | 118 passed |
| `npm.cmd run typecheck` | 0 | 通过 |
| `npm.cmd run build` | 0 | 通过 |
| `npm.cmd run lint` | 1 | 仓库全量 eslint 已有约 150 个既有错误（含 SingleChartPanes 等）。Phase 2 文件继承 LocalApp 原有 `set-state-in-effect` 模式，未为过 lint 而改行为。 |

页面行为未改；Phase 0 `/local.html` 基线仍有效。

## 回滚

还原本提交；无数据迁移。
