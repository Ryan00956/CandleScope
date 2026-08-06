# K 线回放 HEDGE Phase 6 完成证据：历史 L2 强平执行

日期：2026-08-06

分支：`codex/replay-hedge-exchange-parity`

计划：[`KLINE_REPLAY_HEDGE_PHASE6_PLAN_20260806_zh.md`](KLINE_REPLAY_HEDGE_PHASE6_PLAN_20260806_zh.md)

## 1. 完成结论

Phase 6 已完成。HEDGE 强平不再使用普通 mark/Touch/Tape close，而是只消费风险触发时冻结的、已验证连续历史 L2 可见深度。该能力直接属于默认 HEDGE 合同，没有 feature flag、灰度分支或默认关闭入口。

历史盘口可以证明当时公开可见的价位和数量，但不能证明真实撮合队列位置。因此固定 fidelity 为 `HISTORICAL_L2_VISIBLE_DEPTH_CONSERVATIVE_V1`，所有 API、portfolio、Review 和报告证据均保持 `queue_exact=false`；不得宣称历史 queue-exact fill。

## 2. 已实现范围

### 2.1 schema v18 与触发时快照

- `replay_training_liquidation_book_snapshot` 在 liquidation case 创建事务内冻结每条受影响 track 的 archive、actual/virtual time、last update id、完整可见 bids/asks、book hash、fidelity、queue 声明与 snapshot hash。
- 快照必须与 case trigger virtual time 完全相同，projection/active ref/archive 必须均为 READY，book hash 必须用冻结 bids/asks 独立重算通过。
- 当前 UI projection 后续推进不会覆盖 case 快照；取消订单、风险重算或进程重启后，仍消费原 trigger snapshot。
- 可见深度从原展示用途的 20 档扩展到 archive 合同允许的 5000 档上限。

### 2.2 逐档执行与真实 Broker 证据

- SELL 强平按 bids 降序、BUY 强平按 asks 升序消费；同 case/track/side 的后续 step 会扣除前序已消费档位，禁止重复使用可见数量。
- liquidation durable plan 固定 requested/visible quantity、逐档 price/quantity/book level、book hash、last update id、fidelity、queue 声明和 execution-plan hash。
- 新增仅 training 内部可调用的 `_training_execute_historical_book_close`；外部 replay 命令不能调用。
- 一张 reduce-only MARKET order 可产生多个真实 Broker fills。fills 进入原 order/fill、position、closed trade、ledger、checkpoint 和 state hash；training receipt 再逐条校验并写非空 `book_level`。
- Broker checkpoint restore 已把历史 L2 fill 纳入同 accepted sequence 的合法内部因果关系；命令回执丢失或 commit 后崩溃可幂等恢复。

### 2.3 过滤器与 fail closed

- book/ref/archive 缺失或非 READY、as-of 不一致、snapshot/book hash 不符、单边为空、价格非正/重复/乱序、price tick 冲突、quantity step 冲突、可见深度不足或计划数量不守恒，均拒绝生成普通 close。
- 失败被写成 durable `FAILED_CLOSED` step；case/account 进入 `FAILED_CLOSED`，Run 进入 `PAUSED`。
- 已提交的前序强平成交不会因下一步深度不足而回滚；恢复时也不会重复成交。
- ONE_WAY 既有 close 行为保留，但 HEDGE liquidation 路径不存在 Touch/Tape fallback。

### 2.4 投影、复盘与审计

- portfolio/hedge state、liquidation timeline、Review projection 和 report 均包含公开安全的 snapshot/execution proof；state/liquidation hash 覆盖新证据。
- 公开 Review 只保留 virtual time、levels 和 proof hashes，不泄漏 archive id 或 actual time；内部 archive binding 仍通过既有私有边界服务精确 fork。
- Review fork 复制 snapshot/execution rows 并映射 child track；历史 L2 fill checkpoint 可精确恢复。
- account auditor 独立校验 snapshot hash、trigger time、execution-plan hash、fidelity/queue、level quantity sum、proof/frozen-snapshot link 和逐 fill book-level/price/quantity 对应关系；篡改 proof 后审计为 FAIL。

### 2.5 快进等价

- 每个全局 risk wave 在 mark/funding/risk 之前提交同 wave historical book projection。
- HEDGE + BOOK + open position 使 advance planner 保持 `FULL_EVENT_SCAN`，不会跨过 liquidation wave 使用 terminal aggregate shortcut。
- 克隆同一 pre-crash 数据库和 replay-owned objects 后，开启优化的 `ADVANCE_BY` 与显式 `STEP_BASE` reference 得到相同 hedge-state hash、execution-plan hashes 和 PASS account audit。

## 3. 专项测试

Phase 6 新增 6 项专项：

1. LONG 三档 + SHORT 一档的双向逐档成交，验证真实 Broker fill reason 与 historical marker；
2. visible depth 不足时 `HISTORICAL_BOOK_DEPTH_EXHAUSTED`；
3. off-grid price 时 `HISTORICAL_BOOK_PRICE_FILTER_CONFLICT`；
4. off-grid quantity 时 `HISTORICAL_BOOK_QUANTITY_FILTER_CONFLICT`；
5. execution proof 篡改后 account audit FAIL；
6. 优化请求强制 FULL scan 并与逐步 reference hash 等价。

Phase 5 的 12 个强平/保险基金/ADL/七点崩溃恢复用例在新 L2 执行路径上重新全部通过。既有 Review fork 测试也覆盖了 historical L2 checkpoint 恢复。

## 4. 最终门禁

- 完整 replay 后端：`875 passed, 2322 deselected, 4 warnings in 161.42s`。
  - 4 个 warning 均为既有 FastAPI `on_event` 弃用提示。
- 前端 replay：`326 passed`。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm run build`：通过；仅保留既有 chunk-size warning。
- 修改范围 Ruff format/check：通过。
- Python compileall：通过。
- `git diff --check`：通过。

## 5. 下一阶段边界

Phase 6 已完成历史 L2 强平执行与完整证据链。Phase 7 将把当前后端已存在的 HEDGE、双腿风险字段、liquidation timeline、insurance/ADL 和 L2 execution proof 硬切到默认创建体验、右栏、Review 和导出，并移除仍把这些能力标记为 unavailable/disabled 的前端旧合同。
