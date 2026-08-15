# Backtest Python First N10 未合并发布验收（2026-08-15）

## 结论

**不能**报告 `VALIDATED_CLEAN_SHA_UNMERGED`。

干净候选（代码/门禁）：`325830e244ef649d317c9f4b5608595375b4bfb9`  
分支：`codex/backtest-foundation`  
`merged=false` `pushed=false` `productionEnabled=false`

N10 把门禁落到了 Host 真实路径：默认 flags、disabled boot、runner 隔离、
BAR/aggTrade lifecycle、v6→v5→v4 回滚、detached revert、manifest 校验。
1 小时公开 API soak 与 4 小时浏览器 soak **未在本候选上重跑**；完整后端套件
仍有已分类的 Phase 9 rust lock 环境误差。因此状态是
`RELEASE_GATES_OPEN`，不是 `VALIDATED_CLEAN_SHA_UNMERGED`。

## 已关闭的门禁

| 门禁 | 结果 |
| --- | --- |
| Python SDK / contract / bundle / runtime / attack / Host / Studio / templates / basket / scale | PASS（聚焦套件 74 passed；N10 10 passed；SDK 19 passed） |
| Host BAR + aggTrade lifecycle | PASS；3 循环 soak 0.91 s；decision hash `cfb9445e…` 双时钟一致 |
| Frontend typecheck / lint / tests / build | PASS / PASS / 3267 passed 0 failed / PASS |
| `git diff --check` | PASS |
| Disabled boot | PASS：默认进程无 `/api/v1/backtests`；flags=0 时 config 不要求 SDK |
| Sandbox attack / runner 隔离 | PASS：不导入 service/repository/sqlite3/plugin_host |
| Checkpoint / fault injection | PASS：`test_backtest_recovery_m10.py` |
| Schema v6→v5→v4 | PASS：空 bundle 可回滚；有 bundle 行 fail-closed；M10 v5 脚本未放宽 |
| Detached exact revert | PASS：worktree 回退 N2–N9，保留 N1 插件合同修复；built-in 15 passed |
| 200k 默认 / 1M 仅 scale flag / 2M aggTrade 上限 | PASS（合同测试 + N8 1M 证据未改写） |
| 生产 flags | 全部默认 `0`，包括 Python / TRUSTED / SCALE / MULTI_MARKET |

## 完整后端套件

`3853 passed, 6 failed, 2 errors`（约 37 min）。事后分类：

- 2 errors：Phase 9 rust rebuild lock，与 N1 相同环境残差（未改 supply-chain lock）
- 3 failed（architecture + 2 local-offline）：本阶段已修，隔离复跑 21 passed
- 3 failed（alerts soak / phase0 baseline / replay golden）：隔离复跑均通过，属全量并行争用，不是产品回归

未把上述残差改写成 0 failed / 0 errors，也未重写冻结 lock。

## 仍未关闭

- 1h Python 公开 API soak（脚本 `backend/scripts/soak_python_first_n10.py --duration-ms 3600000` 已具备，未跑满 3600 s）
- 4h Python 浏览器/lifecycle soak
- 完整后端套件 `0 failed / 0 errors`（Phase 9 环境残差仍在）
- 独立人工 full-feature review（本阶段为自动化审查 + 上述套件，不是第二人签署）

## 回滚

```text
git revert --no-commit 52c108c1..325830e2
```

保留 N1 插件合同修复。独立 Run/report/bundle 只读保留。禁止 `git reset --hard`。
关闭全部生产 flags。然后重跑 built-in BAR/aggTrade、local、replay、plugin 健康检查。
