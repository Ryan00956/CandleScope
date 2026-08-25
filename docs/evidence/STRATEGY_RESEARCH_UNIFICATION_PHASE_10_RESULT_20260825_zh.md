# 本地数据与策略研究统一 Phase 10 结果（2026-08-25）

## 结论

Phase 10 通过。行情 TopBar 只保留一个「策略」入口到 `/strategy.html`，不再并列「策略回测」。普通策略页通过 launch context 把草稿、会话、范围、已完成 Run 的不可变身份交给高级研究；导入数据不发明 `snapshot_hash`。`/backtest.html` 与 `/backtest.html?run=...` 仍是兼容深链，统一 App 以隔离的 `BacktestResearchApp` 承接五类任务。返回只写 `/strategy.html` 引用，不复用可变 runtime。无效深链显示可行动错误，不选中任意 dataset。

## 测试

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm.cmd run test:research-data` | 0 | 81 passed |
| `npm.cmd run test:backtest` | 0 | 121 passed |
| `npm.cmd run typecheck` | 0 | 通过 |
| `npm.cmd run check:architecture` | 0 | 0 allowlist |

TopBar 源码不再链接 `/backtest.html`。`/backtest.html` 解析为 advanced，`?run=` 解析为 deep-link。普通 `/strategy.html` 首屏不挂载 advanced runtime。strategy-research 工作区返回 `/strategy.html`（imported 带 `source=imported`）。

## 回滚

恢复 TopBar `/backtest.html` 链接；统一 StrategyResearchApp 与数据层无需回滚。
