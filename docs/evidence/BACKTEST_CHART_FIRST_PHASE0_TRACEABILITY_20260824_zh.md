# Backtest Chart-first 需求—测试追踪矩阵（Phase 0 冻结）

状态含义：`PASS_BASELINE` 是 Phase 0 已执行的现有合同；`PLANNED` 是后续阶段必须实现的测试
身份，不能解释为功能已完成。

| Test ID | 阶段 | 冻结需求 | 当前载体 / 后续落点 | Phase 0 状态 |
| --- | --- | --- | --- | --- |
| BCF-P0-ARCH-001 | P0 | BacktestRun、Study、TrainingRun 三对象隔离 | `backend/tests/test_backtest_architecture.py`、`frontend/.../backtestIsolation.test.ts`、ADR-013 | PASS_BASELINE |
| BCF-P0-ARCH-002 | P0 | 共享 chart capability，不共享页面 runtime/WebSocket refs | `npm run check:architecture`、`MarketWorkspaceFrame.tsx` 审计、ADR-013 | PASS_BASELINE |
| BCF-P0-UX-001 | P0 | 首次打开、完成、错误、stale 四状态同视口评审 | `docs/assets/backtest-chart-first-phase0/visual-*.png` | PASS_BASELINE |
| BCF-P0-BASE-001 | P0 | 主图/replay/旧 backtest 浏览器基线 | `baseline-*.png`、Phase 0 JSON | PASS_BASELINE |
| BCF-P0-PERF-001 | P0 | bundle、单/四图就绪、batch lease、cleanup | Phase 0 JSON；`/debug/capacity` | PASS_BASELINE |
| BCF-P0-SMOKE-001 | P0 | 公开 HTTP API snapshot→Run→report→export hash | `npm run smoke:backtest`；隔离 LOCAL_OFFLINE runtime | PASS_BASELINE |
| BCF-P0-CONTRACT-001 | P0 | TradeExplanationV1、JCS_SHA256_V1 与预算冻结 | ADR-013 §4；Phase 7 contract fixture 预留 | PASS_BASELINE |
| BCF-P0-CONTRACT-002 | P0 | comparison context、RUN_COMPARE_V3、V2 fingerprint 多重集冻结 | ADR-013 §5；Phase 7 compare fixture 预留 | PASS_BASELINE |
| BCF-P1-FLAG-001 | P1 | 新入口/高级页/解释/compare flags 默认 0，组合 fail-closed | `chartStrategyTesterFlags.test.ts`、backend flag contract | PLANNED |
| BCF-P1-ROLLBACK-001 | P1 | 关闭 flag 后 DOM、bundle 与 API 回到基线 | static audit + build manifest diff | PLANNED |
| BCF-P2-PLATFORM-001 | P2 | source-neutral chart capability 与 platform contract | `chartPlatformContract.test.ts` | PLANNED |
| BCF-P2-ISOLATION-001 | P2 | live/replay/backtest/advanced runtime 不共享 mutable store | frontend architecture/isolation tests | PLANNED |
| BCF-P3-STATE-001 | P3 | 每 cell 状态机与所有 stale transition | `chartStrategyTesterMachine.test.ts` | PLANNED |
| BCF-P3-GENERATION-001 | P3 | 20 次快速切换只允许最后 generation 提交 | state-machine race test | PLANNED |
| BCF-P3-RESOURCE-001 | P3 | 未附着 cell 零 runtime，detach/close 清理 | runtime lifecycle test | PLANNED |
| BCF-P4-UI-001 | P4 | 首次打开三入口且不加载 Monaco | browser + lazy chunk assertion | PLANNED |
| BCF-P4-UI-002 | P4 | 唯一主操作“运行”，错误定位行列并保留草稿 | component/browser tests | PLANNED |
| BCF-P4-A11Y-001 | P4 | tabs、编辑器、问题列表、resize 键盘可用 | axe + keyboard browser test | PLANNED |
| BCF-P5-RUN-001 | P5 | 一个运行按钮串联 save/compile/resolve/validate/create | API orchestration integration test | PLANNED |
| BCF-P5-DATA-001 | P5 | 未授权不联网；materialize 后重新 resolve | Host facade contract + network audit | PLANNED |
| BCF-P5-IDEMPOTENCY-001 | P5 | 相同内容/上下文不产生 revision/Run 风暴 | idempotency concurrency test | PLANNED |
| BCF-P6-CONTEXT-001 | P6 | ResultContextBar 只读已完成 Run 身份 | result projection test | PLANNED |
| BCF-P6-STALE-001 | P6 | context 变化同帧隐藏旧标记 | render-frame browser test | PLANNED |
| BCF-P6-MULTI-001 | P6 | 四图结果不串格 | four-cell browser test | PLANNED |
| BCF-P7-EXPLAIN-001 | P7 | Python/TS/Rust 对同 fixture 复算同 evidence hash | cross-language contract fixture | PLANNED |
| BCF-P7-BUDGET-001 | P7 | 稳定截断为 PARTIAL，非法/hash mismatch 为 UNAVAILABLE | budget/property tests | PLANNED |
| BCF-P7-COMPARE-001 | P7 | context hash 缺失/不同不得方向性比较 | RUN_COMPARE_V3 contract tests | PLANNED |
| BCF-P7-FINGERPRINT-001 | P7 | V2 fingerprint occurrence multiset，不丢同毫秒多交易 | deterministic multiset fixture | PLANNED |
| BCF-P8-SCHED-001 | P8 | latest-wins、防抖、限流与 over-capacity 可重试 | scheduler fake-clock tests | PLANNED |
| BCF-P9-ADV-001 | P9 | 高级页复用 platform，首次只显示研究任务 | route/browser/platform tests | PLANNED |
| BCF-P10-ADV-002 | P10 | Study/Python/可信度迁移且不污染普通页 | advanced research integration tests | PLANNED |
| BCF-P11-MIGRATE-001 | P11 | 旧工作台渐进迁移，无重复 mutable owner | architecture diff + browser parity | PLANNED |
| BCF-P12-RELEASE-001 | P12 | 完整功能/性能/a11y/soak/rollback/clean SHA | release manifest verifier | PLANNED |

Phase 0 终检必须检查矩阵没有把 `PLANNED` 写成 `PASS`，后续每个阶段只更新自己实际实现与
执行过的 ID。
