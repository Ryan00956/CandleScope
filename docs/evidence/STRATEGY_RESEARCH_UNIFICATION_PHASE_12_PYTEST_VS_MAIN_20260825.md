# Phase 12 全量 pytest 基线判定（2026-08-25）

## 本轮结果

- 全量后端：2334 passed 后在 `tests/test_plugin_platform_multi_runtime_phase1.py::test_phase1_contract_rebuilds_exact_v2_and_v3_generations` 失败。
- 当前分支相对 `main` 没有改动该历史 schema/fixture 路径；fixture 受 byte-stability 保护，不应为让全量测试变绿而重写。
- marketplace 的“index has expired”时间漂移已通过注入 clock 修复，相关测试 31 passed。
- 排除 Phase 1 契约测试后，另一次全量运行在 `test_runtime_materializes_study_beyond_active_run_ceiling` 提前失败；该节点单独运行 PASS，与相邻的两个 `test_backtest_runtime` 用例一起运行也为 2 passed。因此它按仓库级 collection/order contamination 记录，而不是统一策略路径回归。

## 结论

统一策略路径的 scoped 后端测试 91 passed，未发现该路径的新回归；但 full backend gate 仍必须写 **FAIL**，不能用“main 也失败”替代通过。

Phase 1 的历史契约漂移和测试顺序污染应独立治理，不能在本候选的 evidence-only 提交里修改运行时代码或不可变 fixture。
