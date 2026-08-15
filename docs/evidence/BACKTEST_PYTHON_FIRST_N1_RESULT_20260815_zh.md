# Backtest Python First N1 仓库级集成收口（2026-08-15）

## 结论

Plugin Platform v2 冻结合同已从非法 `onBacktestRun` activation 恢复。历史 Phase 0/1
fixture hash 未改写。Python First 不经过 plugin activation。

完整后端套件：`3798 passed, 0 failed, 3 errors`。3 个 error 均已分类，不是
`onBacktestRun` 合同漂移，也不能通过改写冻结性能基线或 rust lock 来“修绿”。

## 实现

- 从 Plugin SDK constants / manifest-v2 / manifest-v3 删除 `onBacktestRun`。
- 恢复 SDK 测试中的历史 schema hash（`adf8d3bc…` / `sha256:16bc9cb9…`）。
- Pyne workbench 策略入口改回合法 `onCommand`；Host 仍通过内部 registry 加载
  `strategy-provider/1`。
- 测试进程强制使用本工作树 SDK，驱逐其它 worktree 的 `candlescope_plugin_sdk`。
- Plugin Platform hello 参考 wheel 不再打包 `strategy_provider_v1`，因此 Phase 1
  历史 bundle hash 恢复，无需重写 `phase1_contract_v1.json`。
- 去掉 `strategy_provider.py` 尾部空行；更新过期 release/runbook 状态。

## 验证

| 门禁 | 结果 |
| --- | --- |
| 代表失败红转绿：Phase 0/1 合同 | PASS |
| Phase 0～9 合同 fixture | PASS（17/17 contract-only） |
| 历史 v1 fixture 未被改写 | PASS |
| Pyne workbench 合法 activation | PASS |
| SDK frozen schema hash | PASS |
| 完整后端套件 | 3798 passed, 0 failed, 3 errors |
| 前端 typecheck / lint | PASS / PASS |
| 前端全量测试 | 3252 passed |
| 前端 build | PASS |
| `git diff --check` | PASS |

## 已分类、未改写锁的 3 个 error

1. `test_phase2_gate_runs_v2_dual_path_v3_python_and_budgets`
   本机 first install ≈ 14500–15000 ms，Phase 0 预算为 9724.601 × 1.25 = 12155.751 ms。
   未放宽因子。
2. `test_phase9_real_second_project_gate`
   rustc/cargo 1.97.1 与锁一致，两次隔离构建彼此一致，但二进制为
   `sha256:fe1a8f1a…`，锁为 `sha256:293b93c7…`，size 同为 426496。未改 supply-chain lock。
3. `test_phase9_install_check_and_rollback_gate`
   与上项同一 rebuild lock。

## 默认开关

全部生产 flags 保持 `0`。未 merge，未 push。

## 回滚

`git revert` 本 N1 提交。生产代码身份回到 N0。
