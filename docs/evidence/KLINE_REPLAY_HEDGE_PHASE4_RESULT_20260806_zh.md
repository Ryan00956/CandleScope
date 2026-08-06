# K 线回放 HEDGE Phase 4 完成证据：逐腿费用、资金费与可重算账本

日期：2026-08-06

分支：`codex/replay-hedge-exchange-parity`

计划：[`KLINE_REPLAY_HEDGE_PHASE4_PLAN_20260806_zh.md`](KLINE_REPLAY_HEDGE_PHASE4_PLAN_20260806_zh.md)

## 1. 完成结论

Phase 4 已完成。HEDGE 账户不再把 funding/fee 当成 broker 投影附属字段：LONG/SHORT 现在各自拥有不可变结算事实、逐腿累计值、hash-chained ledger 证据和独立 auditor 重算路径。该路径为正式默认 HEDGE 合同的一部分，没有 feature flag、灰度分支或默认关闭入口。

## 2. 已实现范围

### 2.1 schema v16

- 新增 `replay_training_fee_policy_extension`，对每个 fee revision 固定 `policy_version`、`account_tier`、`liquidation_fee_bps`、公开来源和 component hash。
- 新增 `replay_training_hedge_funding_settlement`，主键包含 `position_side`，保存公开事件、结算前 signed/absolute quantity、mark、rate、contract size、舍入、cash delta、rule revision、ledger link 和 component hash。
- HEDGE T0、后续 FEE_POLICY event 与 Review fork 都生成 run-owned 完整策略 hash；不存在只复制 parent hash 的伪 child 记录。

### 2.2 双腿 funding 与 fee

- FUNDING 公开事件在 applied receipt 同一 SQLite 事务中，固定按 LONG、SHORT 分别结算。
- 公式为 `-(signed_qty * mark * contract_size * rate)`，对绝对值按 quote step 向上取整后恢复符号。
- 等量双腿不会相互净额消失；测试样本分别产生 `-0.01` 与 `+0.01`，账户合计为 `0`。
- fill 必须携带合法 `position_side`；手续费绑定 fill event time 生效的完整 fee revision，ledger metadata 同时保存 side、policy version/tier、liquidation fee revision 和公开 source reference。
- position leg 的 `accumulated_funding`、`trading_fees`、`liquidation_fees` 从 durable settlement/fill/ledger 派生，不再信任 broker JSON 覆盖。

### 2.3 mutation ledger

- HEDGE position component 变化生成零现金 `POSITION_MUTATION`；逐腿会计累计变化生成 `POSITION_ACCOUNTING_MUTATION`。
- POSITION、ISOLATED_LEG、CROSS margin bucket 的 component hash 变化生成零现金 `MARGIN_MUTATION`。
- posting id 包含 component revision/hash；重复投影不增加 entry，状态回到旧值时仍因新 revision 得到独立证据。
- 既有 `MARGIN_ALLOCATION`/`MARGIN_RELEASE` 与 fee/funding cash posting 继续使用同一 ledger chain 和账户 tail hash。

### 2.4 portfolio、report、review 与 export

- `hedge_state.leg_accounting` 按腿披露三类累计值、funding/fee/mutation/ledger 数量、最后 ledger sequence/hash 与 position component hash。
- active fee policy 暴露完整有效策略；report 对 HEDGE 自动运行 account audit，并嵌入同一 modelled account 逐腿证据。
- FILLS/LEDGER account-record export 保留 `position_side`、effective revision 和完整 metadata。
- Review fork 重新生成 child fee extension、funding component hash、ledger chain 和逐腿累计值；测试证明 parent/child 结果相同而 funding component hash 集合不相交。
- 修复 fork 的时间重演边界：auditor 使用原 fill 的 `event_time_ms + source_sequence` 重建 funding 前快照，不把同毫秒、同 source sequence 的后续强平成交错误放到 funding 之前。

### 2.5 独立 auditor

- 以 `(track_id, position_side)` 重演全部 HEDGE fills 和最终两腿数量。
- 独立重算 maker/taker fee、完整 policy/extension hash、逐腿 funding pre-snapshot/formula/rounding、settlement component hash、逐腿累计值、账户 cash/equity/overlay 与 ledger chain。
- 正常、重试后、重启后和 Review child 均为 `PASS`。
- 篡改测试明确定位：
  - `hedge_funding[track-1:LONG:...].pre_settlement_signed_quantity`；
  - `position_leg[track-1:LONG].accumulated_funding`；
  - `ledger[n].entry_hash`。

## 3. 幂等与恢复证据

- 首次 funding 产生 2 条逐腿 settlement 和 2 条 funding ledger。
- 模拟 response loss 后直接重放同一个已提交公开事件，数量仍为 2/2，overlay cash 不变。
- 关闭服务、重开同一数据库后 audit 仍 PASS，逐腿累计仍为 `-0.01/+0.01`。
- Review fork 对 child 自有 hash 执行 audit 并 PASS。

## 4. 验证结果

### 后端专项与回归

- Phase 1–4 + 既有 Phase 6/16：`46 passed`。
- Phase 4 专项：`3 passed`，覆盖逐腿 funding、effective fee revision、maker/taker/liquidation policy、response-loss retry、restart、report、export、Review fork 和三类篡改。
- 完整 replay 后端：`855 passed, 2322 deselected, 4 warnings in 165.17s`。
  - 首次全量 collection 因新 worktree 未把仓库内 SDK 加入 Python path，统一报 `candlescope_plugin_sdk` 缺失；使用 `PYTHONPATH=packages/candlescope-plugin-sdk/src` 按仓库布局重跑后全部通过。

### 前端与静态门禁

- 前端 replay：`326 passed`。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm run build`：通过；仅保留既有 chunk size warning。
- 修改范围 Ruff check：通过。
- Python compileall：通过。
- `git diff --check`：通过。

### 非阻塞基线记录

仓库 mypy 在导入依赖后报告既有广泛基线（本次 scoped invocation 为 `618 errors in 50 files`；`--follow-imports=skip` 仍包含训练模块原有类型债）。它不是 Phase 4 新增运行时失败，也未被伪装成通过；本阶段以 Ruff、compile、855 项真实后端回归、326 项前端回归和专项审计篡改门禁作为提交条件。

## 5. 下一阶段边界

Phase 4 冻结了 `liquidation_fee_bps` 的 effective revision 和逐腿 liquidation fee 累计入口，但没有在本阶段重写 Phase 5 强平状态机。Phase 5 将以本阶段的逐腿 position/margin/accounting facts 为输入，实现完整撤单重评估、部分/全量强平、破产接管、保险基金与 ADL；不得退回聚合净仓或无状态直接改仓。
