# 本地数据与策略研究统一 Phase 11 结果（2026-08-25）

## 结论

Phase 11 通过。BacktestApp 不再维护 listDatasets / Run setInterval 编排，改为薄兼容 bootstrap，挂载隔离的 BacktestResearchApp。LocalApp 仍是双旗标关闭后的独立本地资料库壳，使用共享 `useResearchDataLibrary`。统一壳在 `/local.html` 与 `/backtest.html` 显示一次性兼容说明，不阻挡使用，也不删除旧 localStorage。文档术语改为「策略中的本地资料库」和「策略 / 高级研究」；LOCAL_OFFLINE 仍是启动 profile。延期项（M9 RSI trace 窗格、decision/fill hash 行、旧 fills 表）写在 `strategyResearchLegacyMap.ts`，有 follow-up，未被静默删除。

## 测试

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm.cmd run test:research-data` | 0 | 86 passed |
| `npm.cmd run test:backtest` | 0 | 121 passed |
| `npm.cmd run typecheck` | 0 | 通过 |
| `npm.cmd run check:architecture` | 0 | 0 allowlist |

rg 级测试确认 import poll 只定义在 `useResearchDataLibrary`，Run poll 只在 `backtestRunClient` / `useBacktestResearchRuntime`。`/backtest.html?run=` 仍解析。旗标关闭仍选择 LocalApp 兼容壳。

## 回滚

恢复兼容 App 装配提交；旧存储键和磁盘数据未删除，可直接重新读取。
