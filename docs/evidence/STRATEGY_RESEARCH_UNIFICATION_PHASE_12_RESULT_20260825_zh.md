# 本地数据与策略研究统一 Phase 12 结果（2026-08-25）

## 结论

Phase 12 工程资格完成，**不是生产启用**。生产旗标仍为 0。Verifier、smoke、双旗标 rollback 源码门禁、LOCAL_OFFLINE 60 分钟 API soak、安全矩阵 scoped 测试通过。旧 `codex/local-offline-mode` worktree 只读审计完成，未删除、未归档、未 merge。

未通过或未跑的门禁不得标 PASS：

- 全量后端 pytest：约 58–65% 处出现大量失败/错误后挂起，不能签署 full backend PASS。
- 全量前端 `npm test`：3473 passed，1 failed（`scripts/pine-language.test.mjs` monaco ESM 导入，既有失败）。
- `npm run lint`：约 185 个既有 eslint 错误；本阶段仅修复 smoke 脚本未使用变量。
- LIVE 浏览器 mixed soak：无交互式浏览器、无 LIVE 行情进程，ENV_STOP。
- `smoke:backtest`：`127.0.0.1:8000` ECONNREFUSED，ENV_STOP。

## 测试

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| scoped pytest（文档列出 + unification release） | 0 | 89 passed |
| `npm.cmd run test:research-data` | 0 | 88 passed |
| `npm.cmd run test:backtest` | 0 | 121 passed |
| `npm.cmd run typecheck` | 0 | 通过 |
| `npm.cmd run check:architecture` | 0 | 0 allowlist |
| `npm.cmd run smoke:strategy-research` | 0 | ok |
| `npm.cmd run build` | 0 | 通过；BacktestApp chunk 0.72 kB |
| 60 min LOCAL_OFFLINE soak | 0 | 711 cycles, 3600131 ms |
| `npm.cmd test` | 1 | 3473 pass / 1 fail pine-language |
| `npm.cmd run lint` | 1 | 既有 eslint 错误 |
| full pytest | hung/fail | 58–65% 失败簇后挂起 |
| `npm.cmd run smoke:backtest` | 1 | 无后端 8000 |

## 回滚

关闭 `VITE_RESEARCH_DATA_LIBRARY_ENABLED` 与 `CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED`。不删除磁盘数据与旧键。未改变生产默认值。
