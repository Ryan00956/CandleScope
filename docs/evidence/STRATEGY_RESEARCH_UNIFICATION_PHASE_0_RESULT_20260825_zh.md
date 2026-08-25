# 本地数据与策略研究统一 Phase 0 结果（2026-08-25）

## 结论

Phase 0 工程门禁通过。本阶段只新增 ADR 与证据，未修改运行时代码、默认 flags、主工作树脏文件、旧 local-offline 工作树，也未 push / merge / deploy。

ADR-BACKTEST-014 以用户授权的执行文档为产品决定，状态为 **Accepted for implementation**。独立人工视觉复审未另行伪造为“用户已签字”；行情页策略首次打开沿用已批准的 chart-first Phase 4 实拍，完成结果沿用已批准的 Phase 0 视觉合同稿。`/local.html` 与 `/backtest.html` 在当前 HEAD 上由 Playwright 重新捕获。

## 身份

| 项 | 值 |
| --- | --- |
| 文档基线 | `144e748cc881220565cd5aa07fc494cba9a4133c` |
| 当前 HEAD（提交前） | 同上，无 SHA 漂移 |
| 新分支 | `codex/strategy-research-unification` |
| 新工作树 | `H:\program\CandleScope-strategy-research` |
| origin/main | `26298d38a41c80f9f91a5a43e861a543da74ca49`（main 超前 31） |
| 原工作树脏路径 | `?? docs/LOCAL_DATA_STRATEGY_RESEARCH_UNIFICATION_EXECUTION_zh.md`（未触碰） |
| 旧分支 | `codex/local-offline-mode@d3c2fe37`；merge-base `e642125f`；落后 284 / 独有 9；脏状态 37 项未改 |

## 合同冻结

[ADR-BACKTEST-014](../adr/ADR-BACKTEST-014-LOCAL-DATA-AS-RESEARCH-SOURCE.md) 冻结：

1. 本地数据是策略研究来源，不是并列产品。
2. LOCAL_OFFLINE 是进程级技术 profile，不是页面开关。
3. 第一版不做 LiveChartCell 实时/CSV 热切换。
4. 禁止整枝 merge `codex/local-offline-mode`，禁止清理其 37 项脏状态。
5. Run 创建前必须有后端校验的 `dataset_id + data_epoch + snapshot_hash`。
6. 两个研究资料库旗标开发期默认 0。

## 自动化

| 门禁 | 结果 | 说明 |
| --- | --- | --- |
| `pytest` local_data service/api/jobs | PASS 23 | 11.46s |
| `pytest` offline main_profile + network_guard | 首次 FAIL 2 / 再跑 PASS 3 | 首次：anaconda 子进程缺少 `candlescope_plugin_sdk`（setup failure）。设置仓库 `PYTHONPATH`（plugin-sdk / backtest-sdk / pyne）后 3 passed。**既有环境问题，非产品回归，非本方案阻断。** |
| `pytest` chart_context + quick_presets | PASS 14 | 10.50s |
| `npm.cmd run test:backtest` | PASS 118 | 6.09s；3 suites |
| `npm.cmd run typecheck` | PASS | 94.3s |
| 旧 local-offline 工作树 | 未修改 | 仍 37 项脏状态 |
| 本 Phase 运行时 diff | 空 | 只有 docs/adr 与 docs/evidence |

完整命令日志：scratch `phase0-tests.txt`。

## 四个 UI 基线（1440×900，SHA-256）

| 状态 | 文件 | SHA-256 | 来源 |
| --- | --- | --- | --- |
| 行情页策略首次打开 | [chart-strategy-first-open-1440x900.png](strategy-research-unification-phase-0/chart-strategy-first-open-1440x900.png) | `7e6e206adca4b78d47db85eba0e310d9ae9060a04810a4bbb5ff9bcf0e441b34` | chart-first Phase 4 实拍；当前 main 已默认开启该 UI |
| 完成结果 | [chart-strategy-completed-visual-contract-1440x900.png](strategy-research-unification-phase-0/chart-strategy-completed-visual-contract-1440x900.png) | `c426cc09cdc824cafcd896c2798013f3f3fe038accd5c7a7fa915618fd4f5a41` | 已批准视觉合同稿 |
| `/backtest.html` | [backtest-first-open-1440x900.png](strategy-research-unification-phase-0/backtest-first-open-1440x900.png) | `34520884de1b3ebf03e3ded4781bf092099ae1df7d2560ef82c8f41e86900d7d` | 当前 HEAD + LOCAL_OFFLINE 18086 / Vite 15176 实拍 |
| `/local.html` | [local-first-open-1440x900.png](strategy-research-unification-phase-0/local-first-open-1440x900.png) | `b433421895b8c8e9716c11018351e4c17babc6bfaf56165ff682298e6d96b30a` | 同上；空资料库。`local-import-form` 等 class 在当前 main **没有对应 CSS 规则**，属既有外观，不是本 Phase 引入 |

附加：`chart-strategy-completed-1440x900.png` 为 chart-first Phase 5 完成面板实拍，但当时 LIVE 图在 LOCAL_OFFLINE 下失败，不作为行情页完成态主基线。

本环境没有启动 LIVE 行情后端（避免触碰生产数据与外网），因此行情页两态使用已冻结的同产品实拍/视觉合同，而不是空白 LIVE 失败页。

## 包体与运行时基线

当前 HEAD 对应原工作树 `frontend/dist`（未在本工作树重建）：

- `live-*.js` 382.92 KiB
- `local-*.js` 63.45 KiB
- `BacktestApp-*.js` 69.54 KiB
- 共享 `index-*.js` 495.72 KiB / `index-*.css` 296.89 KiB

chart-first Phase 0 已冻结的 WebSocket 基线（SHA `f8a195e7`，本 HEAD 为其后继且默认开启 chart-first）仍有效：默认 frontend batch flag 未设置时物理 WS=0；显式 flag-on 单图 1 物理 WS。本 Phase 的 LOCAL_OFFLINE 实拍没有行情 WebSocket。

隔离 `/health`：`runtime_mode=LOCAL_OFFLINE`，`network.installed=true`，`blocked_attempts=0`，`datasets=0`。

## 回滚

删除本 Phase 文档即可。无数据迁移。

## 未解决问题

- ADR 的独立产品签字页未另走人工会议；执行文档与 Objective 授权本方案继续。
- `/local.html` 导入表单缺少专用 CSS（既有）。
- 未在本环境启动 LIVE 行情后端重拍策略首次打开/完成结果。
- 两个研究资料库旗标保持关闭，Phase 12 前不改生产默认。
