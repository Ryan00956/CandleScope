# 本地数据与策略研究统一 Phase 9 执行计划（2026-08-25）

## 身份与范围

- 基线：Phase 8 `a669b3b08b390e2847fdaa48dbfb2e40010e0258`（功能提交 `4e3cfe3f`）
- 分支：`codex/strategy-research-unification`
- LOCAL_OFFLINE 与 LIVE 使用同一个 StrategyResearchApp。
- 技术 profile 不是页面 toggle；live 来源不可用并给原因；不静默联网。
- 导入数据仍走同一 FrozenResearchContext / BAR Run。
- 不实现 Phase 10 高级入口收敛，不改默认生产旗标。

## 漂移判断

start-local-offline 仍打开 `/local.html`。StrategyResearchRuntime 默认 `runtimeMode=LIVE`，统一 App 不读 `/health`。Drawer 已在 LOCAL_OFFLINE 禁用 CURRENT_CHART，但 App 未从进程健康状态写入该模式。network guard 已在 `/health.local_offline.network`，结果可信度详情未展示。LOCAL_OFFLINE 资料库路由始终挂载；前端导入入口仍受 `VITE_RESEARCH_DATA_LIBRARY_ENABLED` 控制。

## 实施顺序

1. start-local-offline 默认打开 `/strategy.html?source=imported`，并启用资料库旗标；`/local.html` 文件保留。
2. StrategyResearchApp 读取 `/health` 的 `runtime_mode`，写入 Runtime，不做页面切换。
3. LOCAL_OFFLINE 禁止 CURRENT_CHART 选择、materialize 与 live reference。
4. 结果可信度展示 network guard diagnostics。
5. 扩展 offline profile 测试：klines/stream/replay/plugin 拒绝，local/backtests 可用。
6. 前端证明无 toggle、无静默 materialize、BAR 导入仍可运行。

## 预计修改文件

- `start-local-offline.ps1`
- `start-local-offline.sh`
- `frontend/src/features/strategy-research/StrategyResearchApp.tsx`
- `frontend/src/features/strategy-research/StrategyResearchShell.tsx`
- `frontend/src/features/strategy-research/useStrategyResearchRun.ts`
- `frontend/src/features/strategy-research/StrategyResearchResultPanel.tsx`
- `frontend/src/features/strategy-research/__tests__/*`
- `backend/app/local_data/runtime.py`（诊断保持；必要时对齐 health）
- `backend/tests/test_local_offline_main_profile.py`

## 退出标准

- LOCAL_OFFLINE 与 LIVE 使用同一个 StrategyResearchApp。
- 技术 profile 没有变成页面 toggle。
- offline network tests 通过；live 来源不可点击运行。

## 回滚

启动脚本恢复打开 `/local.html`；LocalOfflineBoundary 和磁盘数据不变。
