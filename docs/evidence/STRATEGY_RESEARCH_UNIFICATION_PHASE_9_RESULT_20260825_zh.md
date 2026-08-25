# 本地数据与策略研究统一 Phase 9 结果（2026-08-25）

## 结论

Phase 9 通过。LOCAL_OFFLINE 启动脚本默认打开 `/strategy.html?source=imported`，与 LIVE 共用 StrategyResearchApp。统一 App 读取 `/health` 的 `runtime_mode`，不提供页面 toggle。CURRENT_CHART 在离线时不可运行并给出原因；导入数据仍走 FrozenResearchContext / BAR Run。network guard 诊断进入结果可信度。`/local.html` 文件保留兼容。

## 测试

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm.cmd run test:research-data` | 0 | 75 passed |
| `npm.cmd run test:backtest` | 0 | 121 passed |
| `npm.cmd run typecheck` | 0 | 通过 |
| `npm.cmd run check:architecture` | 0 | 0 allowlist |
| `pytest` local_offline_main_profile + network_guard | 0 | 3 passed |

`/health` 返回 LOCAL_OFFLINE；`/api/v1/klines`、stream、replay、plugin 403；`/api/v1/local` 与 `/api/v1/backtests/capabilities` 可用。DNS/TCP/UDP 非 loopback 被 guard 阻断。

## 回滚

启动脚本恢复打开 `/local.html`；LocalOfflineBoundary 和磁盘数据不变。
