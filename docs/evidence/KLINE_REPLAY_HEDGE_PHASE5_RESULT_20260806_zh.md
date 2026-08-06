# K 线回放 HEDGE Phase 5 完成证据：完整强平、保险基金与 ADL

日期：2026-08-06

分支：`codex/replay-hedge-exchange-parity`

计划：[`KLINE_REPLAY_HEDGE_PHASE5_PLAN_20260806_zh.md`](KLINE_REPLAY_HEDGE_PHASE5_PLAN_20260806_zh.md)

## 1. 完成结论

Phase 5 已完成。HEDGE 强平已从按 track 的一次性兼容捷径，硬切到可恢复的账户级关系状态机：CROSS 账户一次风险违约只建立一个 case，ISOLATED 按腿隔离；撤单、风险重评估、逐档部分/全量强平、破产接管、保险基金、ADL 和完成均有独立 durable step、不可变 plan、风险快照与 hash。该路径直接属于默认 HEDGE 合同，没有 feature flag、灰度分支或默认关闭入口。

保险基金与 ADL 继续遵守 Phase 0 冻结的数据边界：公开规则和 mark 使用 Run-pinned 输入；无法获得的交易所私有基金余额、对手方账户和排队状态使用 `BINANCE_USDM_LINEAR_HEDGE_DETERMINISTIC_SIMULATION_V1` 物化输入，产品不得宣称历史交易所 exact。

## 2. 已实现范围

### 2.1 schema v17 与查询证据

- `replay_training_liquidation_leg` 新增逐腿 `liquidation_price`。
- 新增 `replay_training_liquidation_leg_price_proof`，保存 mark、scope equity、scope maintenance、tick、rule revision、公式版本、liquidation/bankruptcy/takeover price 和 proof hash。
- 新增 `replay_training_adl_counterparty_ledger`，保存对手方 before/delta/after quantity、takeover price、cash effect 与 previous/entry hash。
- portfolio/report/Review fork 暴露并复制 risk snapshot、price proof、case/leg/step/order/fill、insurance posting、ADL snapshot/candidate/event/selection/counterparty ledger；恢复后退出的 case 单独投影为 `liquidation_recoveries`，不伪装成实际强平成交。

### 2.2 账户级强平状态机

- CROSS 将同一结算账户下所有受影响 FULL tracks/legs 放进一个 case；ISOLATED 仍按腿建 case。
- 状态机固定为 `CANCEL_ORDERS → RISK_RECHECK → PARTIAL/FULL_LIQUIDATION (0..N) → BANKRUPTCY_TRANSFER → INSURANCE_FUND_SETTLEMENT → ADL → COMPLETE`。
- 撤单目标、每一步的数量/腿/适配器、破产结算、基金缺口和 ADL 选择均先写进 immutable step plan，再执行副作用。
- 每个外部 broker 命令由 case/step/leg 派生稳定 idempotency key；重试反查原 broker order/fill，不重复造单。
- 强平腿总序为 maintenance margin 降序、absolute notional 降序、track id 升序、LONG 先于 SHORT；所有比较使用 Decimal，保险基金选择不使用 SQLite REAL/float 排序。

### 2.3 部分强平、真实成交与价格证明

- tier 大于 1 时只减到上一档 notional cap；每个真实 fill 后重新计算 position、tier、账户 equity/maintenance，恢复安全即停止。
- tier 1 或部分强平仍不安全时按确定性腿顺序全平；每笔 close 都发送显式 canonical quantity，不使用 `quantity=null`，也不直接把 position quantity 写零。
- liquidation order/fill 绑定已经持久化的 broker order/fill，保留真实 order id、fill id、price、quantity、fee、source sequence 和 execution model。
- liquidation/bankruptcy/takeover price 使用 pinned rule、tick grid 和固定其他 CROSS marks 的公式输入；每条腿有可查询 proof hash。

### 2.4 保险基金、ADL 与 fail closed

- 每笔真实强平成交的 liquidation fee 从用户账户扣除，形成逐笔 ledger posting，并进入模拟保险基金。
- 破产缺口只可把保险基金扣到零，数据库余额约束和运行时代码均禁止透支。
- 基金不足时消费 Run manifest 固定的 ADL cohort；ranking、selection 与 counterparty before/delta/after 形成 hash-chain receipt。
- rule、mark、真实 fill、price proof、simulation input、ADL cohort 或容量缺失时，case 进入 `FAILED_CLOSED`，账户进入 `FAILED_CLOSED`，Run 进入 `PAUSED`；不存在无限基金、随机候选或代理 fallback。

## 3. 幂等、崩溃与哈希等价

- 对七个 durable commit 点分别注入“事务已经提交、进程随后丢失”的异常：cancellation、recheck、execution、bankruptcy、insurance、ADL、complete。
- 测试先持久化同一个 breach/case，再复制数据库和 replay-owned objects，形成恢复路径与无崩溃 reference 路径；两条路径使用相同 controller/command material。
- 每个崩溃点恢复后都只有 2 个真实 close orders、2 个 fills、2 个 insurance postings、1 个 ADL event/selection/counterparty ledger；没有重复副作用。
- 七条恢复路径的最终 case `component_hash` 和全部 `step_hash` 与各自无崩溃 reference 完全一致。

## 4. 验证结果

### 后端专项与回归

- Phase 5 专项：`12 passed in 7.54s`。
- 七个 durable step 崩溃等价子集：`7 passed in 5.48s`。
- 删除旧强平入口后的 Phase 5 + Phase 16 聚焦回归：`27 passed in 12.90s`。
- 最终待提交树完整 replay 后端：`868 passed, 2322 deselected, 4 warnings in 157.47s`。
  - 首次误用仅含 `backend` 的 `PYTHONPATH` 收集整个 backend，因仓库内 SDK 未加入路径产生 41 个 `candlescope_plugin_sdk` 收集错误；按仓库既定布局改为 `PYTHONPATH=backend;packages/candlescope-plugin-sdk/src` 后完整通过。
  - 4 个 warning 均为既存 FastAPI `on_event` 弃用提示。

### 前端与静态门禁

- 前端 replay：`326 passed`。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm run build`：通过；仅保留既有 chunk size warning。
- 修改范围 Ruff format/check：通过。
- Python compileall：通过。
- `git diff --check`：通过。

## 5. 下一阶段边界

Phase 5 已让强平使用真实 broker order/fill 和显式数量，但尚未把 liquidation close 的执行算法硬切为“按历史 L2 可见深度逐档消耗并保存 book level/剩余量”的专用路径。Phase 6 将补齐严格 L2 continuity、depth exhaustion、price band/filter、保守 queue 边界，以及逐事件与 optimized 快进 hash 等价；任何 book gap 都不得回退 Touch/Tape。
