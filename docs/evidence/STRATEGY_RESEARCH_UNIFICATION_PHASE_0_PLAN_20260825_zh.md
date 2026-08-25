# 本地数据与策略研究统一 Phase 0 执行计划（2026-08-25）

## 身份与范围

- 文档基线：`main@144e748cc881220565cd5aa07fc494cba9a4133c`
- 当前 HEAD：与文档基线一致，无 SHA 漂移
- 新分支：`codex/strategy-research-unification`
- 隔离工作树：`H:\program\CandleScope-strategy-research`
- 原工作树：`H:\program\CandleScope`（`main`，ahead origin/main 31）
- 原工作树脏路径（只读保护，不复制、不暂存、不提交）：
  - `?? docs/LOCAL_DATA_STRATEGY_RESEARCH_UNIFICATION_EXECUTION_zh.md`
- 参考旧树：`H:\program\CandleScope-local-offline` / `codex/local-offline-mode@d3c2fe37`
  - merge-base：`e642125f9132eb3774101f11bae38a263865eb69`
  - 相对当前 main：落后 284，独有 9
  - 工作区脏状态：37 项（33 tracked + 4 untracked）
- 本阶段只冻结合同、ADR、测试基线和四个 UI 基线，不修改运行时代码。
- 不 push、不 merge、不 deploy、不开启生产 flag、不删除旧 worktree/分支。

## 漂移判断

执行文档描述与当前代码一致：

- `backend/app/local_data` 已有不可变资料库、jobs、quality、resampling、network_guard。
- `LocalOfflineRuntime` 同时拥有 `LocalDatasetService`、`LocalImportJobManager`、`OfflineNetworkGuard`。
- `BacktestRuntime.__init__` 仍用 `local_data_dir` 隐式创建第二个 `LocalDatasetService`，`BacktestWorker` 再创建一次。
- `/api/v1/local` 仅在 `RUNTIME_MODE == LOCAL_OFFLINE` 挂载；`_service()` 硬编码拒绝 LIVE。
- 产品层仍分裂：`LocalApp`、行情页 chart-first、`BacktestApp`/`BacktestResearchApp`；TopBar 仍有独立“策略回测”。
- 旧 local-offline 工作树 37 项脏状态仍在，未清理。

无产品决定冲突；本 Phase 不实现后续运行时。

## 实施顺序

1. 从当前 `main` 新建独立工作树与 `codex/` 前缀分支（已完成）。
2. 记录 SHA、worktree、origin/main、旧分支 ahead/behind 与脏路径。
3. 新增 ADR-BACKTEST-014，冻结：本地数据是策略研究来源；LOCAL_OFFLINE 是技术 profile；第一版不做 LiveChartCell 热切换；禁止整枝 merge 旧分支。
4. 运行文档规定的 local-data / offline / chart-context / chart-first 测试。
5. 捕获四个 UI 基线（行情页策略首次打开、完成结果、`/backtest.html`、`/local.html`）并计算 SHA-256。
6. 记录现有前端包体、首屏、WebSocket 与 console 基线（沿用 chart-first Phase 0/12 已冻结数字，并标注来源 SHA）。
7. 写 RESULT 与 JSON 证据；仅提交 `docs/adr` 与 `docs/evidence`。

## 预计修改文件

- `docs/adr/ADR-BACKTEST-014-LOCAL-DATA-AS-RESEARCH-SOURCE.md`
- `docs/evidence/STRATEGY_RESEARCH_UNIFICATION_PHASE_0_PLAN_20260825_zh.md`
- `docs/evidence/STRATEGY_RESEARCH_UNIFICATION_PHASE_0_RESULT_20260825_zh.md`
- `docs/evidence/strategy-research-unification-phase-0-20260825.json`
- `docs/evidence/strategy-research-unification-phase-0/` 下的基线截图（如成功捕获）

工作树中的执行文档副本保持未跟踪，本 Phase 不提交。

## 验证命令

```powershell
git status --short --branch
git rev-parse HEAD
git worktree list --porcelain

Set-Location H:\program\CandleScope-strategy-research\backend
D:\anaconda\python.exe -m pytest -q tests/test_local_data_service.py tests/test_local_data_api.py tests/test_local_data_jobs.py
D:\anaconda\python.exe -m pytest -q tests/test_local_offline_main_profile.py tests/test_local_offline_network_guard.py
D:\anaconda\python.exe -m pytest -q tests/test_backtest_chart_context.py tests/test_backtest_quick_presets.py

Set-Location H:\program\CandleScope-strategy-research\frontend
npm.cmd run test:backtest
npm.cmd run typecheck
```

原工作树无 `.venv`；与 chart-first Phase 0 相同，使用 `D:\anaconda\python.exe`。前端通过 junction 复用原工作树 `node_modules`，不修改原树文件。

## 退出标准

- ADR 以执行文档为授权产品决定，状态为 Accepted for implementation。
- 基线失败被明确区分为既有失败或本方案阻断。
- 四个 UI 状态有截图和 SHA-256。
- 旧分支没有任何修改。
- 本 Phase 只有 `docs/adr` 与 `docs/evidence` 改动。

## 回滚

删除本 Phase 新增文档即可；不涉及运行时、数据库或用户数据。
