# 本地数据与策略研究统一 Phase 6 结果（2026-08-25）

## 结论

Phase 6 通过。canonical `/strategy.html` 可启动统一 StrategyResearchApp。`/local.html` 与 `/backtest.html` 改为同一 bootstrap：旗标开启时进入同一 App（local 默认资料库、backtest 默认高级研究），旗标关闭时保持 LocalApp / BacktestResearchApp。LocalApp 与 BacktestApp 未删除。drawer 有独立错误边界。五个视觉状态由 launch + state 推导。

## 测试

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm.cmd run test:research-data` | 0 | 32 passed |
| `npm.cmd run test:backtest` | 0 | 118 passed |
| `npm.cmd run typecheck` | 0 | 通过 |
| `npm.cmd run check:architecture` | 0 | 0 allowlist |

浏览器 1440×900：`/strategy.html` 两次哈希一致，首屏 `data-visual-state=first`；flag=0 时 `/local.html` 与 `/backtest.html` 仍为 Phase 0 兼容页哈希。

## 回滚

关闭 `VITE_RESEARCH_DATA_LIBRARY_ENABLED`；兼容入口走 legacy App。
