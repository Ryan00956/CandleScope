# Backtest Python First N10 未合并发布验收（2026-08-15）

## 结论

**不能**报告 `VALIDATED_CLEAN_SHA_UNMERGED`。

干净候选（代码/门禁）：`325830e244ef649d317c9f4b5608595375b4bfb9`
分支：`codex/backtest-foundation`
`merged=false` `pushed=false` `productionEnabled=false`

N10 把门禁落到了 Host 真实路径：默认 flags、disabled boot、runner 隔离、
BAR/aggTrade lifecycle、v6→v5→v4 回滚、detached revert、manifest 校验、
1h Host soak 与 4h 浏览器 soak。完整后端套件仍有已分类的 Phase 9 rust lock
环境误差。因此状态是 `RELEASE_GATES_OPEN`，不是
`VALIDATED_CLEAN_SHA_UNMERGED`。

## 已关闭的门禁

| 门禁 | 结果 |
| --- | --- |
| Python SDK / contract / bundle / runtime / attack / Host / Studio / templates / basket / scale | PASS（聚焦套件 74 passed；N10 10 passed；SDK 19 passed） |
| Host BAR + aggTrade lifecycle | PASS；1h soak 3600.125 s / 13068 循环；decision hash `cfb9445e…` 双时钟一致 |
| 4h Python 浏览器 soak | PASS；14400015 ms / 240 循环；studio 每轮存在；console 0 |
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

## 1h soak

`PASS`：`soak_python_first_n10.py --duration-ms 3600000` 跑满 3600.125 s，
13068 个 Host Python BAR+aggTrade 循环，全部 COMPLETED，decision hash
`cfb9445e…` 双时钟一致。证据：scratch `n10-1h-soak.json`。

## 4h 浏览器 soak

`PASS`：Playwright + 本机 Chrome 打开 shipped `backtest.html`，跑满
14400015 ms，240 个 reload 循环，Python studio 每轮存在，console 0，
heap 18.9 MB → 26.8 MB（峰值 28.1 MB，无单调失控）。
脚本：`frontend/scripts/backtest-python-n10-browser-soak.mjs`（`13e8943d`）。
完整样本：scratch `n10-4h-soak.json`（sha256 `9914a324…`）。
摘要：`docs/evidence/backtest-python-first-n10-4h-soak-20260815.json`。

## 仍未关闭

- 完整后端套件 `0 failed / 0 errors`：Phase 9 rust lock 环境残差（见 hard-stop）
- 独立人工 full-feature review

### Phase 9 hard-stop（不能安全修到 0/0）

`rustc`/`cargo` 字符串与锁一致。仓库内 `runtime/adapter.exe` 已是
`sha256:293b93c7…`。本机隔离重编彼此一致，但得到 `sha256:fe1a8f1a…`，
size 同为 426496。改 lock 会掩盖冻结 supply-chain；本机没有锁机器上的
MSVC/link.exe。未删测试、未放宽门禁。

## 回滚

```text
git revert --no-commit 52c108c1..325830e2
```

保留 N1 插件合同修复。独立 Run/report/bundle 只读保留。禁止 `git reset --hard`。
关闭全部生产 flags。然后重跑 built-in BAR/aggTrade、local、replay、plugin 健康检查。
