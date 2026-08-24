# Backtest Chart-first Phase 8 执行计划（2026-08-24）

## 阶段边界

- 只实现 Phase 8：快速估算随当前 cell 的 chart-session 稳定切换自动重跑，并用前端 workspace 调度与后端容量响应控制资源。
- 不提前抽取 Phase 9 共享图表平台，不创建 Phase 10 高级研究 shell，不改变生产默认 flag。
- 不自动下载数据；PRECISE、NEEDS_DATA 和 unsupported 都停止自动运行并给出可行动原因。

## 实现合同

1. 新增严格默认关闭的 `VITE_CHART_STRATEGY_AUTO_RUN_ENABLED`；普通 FAST attachment 的用户默认选择为自动运行，但 flag off 时不创建 timer 或队列项。
2. 只把真实 session/attachment/auto-run 开关转换为 auto intent；首次挂载和 split/copy 不触发。session 稳定 600 ms 后才排队，并以现有 cell generation token 在执行前再次验真。
3. 每个 cell 同时最多一条 run pipeline；新 session 立即让旧投影 stale，并 abort 尚未提交/仍在观察的旧前端请求，已提交后端 Run 不删除。
4. workspace 自动队列并发上限为 2；同 cell 的待执行 intent 只保留最新 generation。手动运行取消该 cell 的 debounce/待提交自动项并立即进入既有手动 pipeline。
5. 自动 pipeline 只接受 `FAST + READY`。NEEDS_DATA 不调用 materialize，PRECISE 不 resolve、不下载、不 create，unsupported 不 create。
6. Run idempotency key 继续绑定 revision、chart context 与完整 config；后端返回同一已完成 Run 时直接复用 terminal identity，结果 cache 仍只接受完全匹配的 Run/report/chart hash。
7. 后端 active/queue ceiling 返回明确可重试的 `RUN_CAPACITY_EXCEEDED`、HTTP 429 与 `Retry-After`；前端本次停止并显示“后端繁忙”，不无限重试。
8. 面板显示自动运行开启、关闭、等待防抖、workspace 排队、需要数据、精算需手动、unsupported 和后端繁忙等真实原因。

## 验证与证据

- 单元：600 ms 防抖、generation fencing、同 cell latest-wins、四 cell 最大 2 并发、手动抢占待提交 auto、初始 mount/split-copy 不触发。
- pipeline：FAST READY 自动完成；NEEDS_DATA/PRECISE/unsupported 不 create；completed idempotent Run 不重复 poll；容量错误不重试。
- 容量：16/64 未附着 cell 为零 runtime/queue；附着但未发生 session transition 不产生 Run 风暴。
- 浏览器：快速切换 symbol/interval 只发布最后上下文，四图同时 transition 时观察自动并发不超过 2，手动运行优先，并截图暂停原因与最终结果。
- 回归：backtest 前后端覆盖、前端全量、typecheck、lint、i18n、architecture、flag-off/on build、Black/Ruff、`git diff --check`。

## 回滚

关闭 `VITE_CHART_STRATEGY_AUTO_RUN_ENABLED` 后只保留手动运行；关闭 chart tester 总 flag 可回到 Phase 3 以前入口。不可变 Run、结果和 Phase 7 解释/比较数据不删除。
