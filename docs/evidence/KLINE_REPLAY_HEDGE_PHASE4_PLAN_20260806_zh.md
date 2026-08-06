# K 线回放 HEDGE Phase 4 执行计划：逐腿费用、资金费与可重算账本

日期：2026-08-06

分支：`codex/replay-hedge-exchange-parity`

前置提交：`df1e7091 feat(replay): pin deterministic hedge inputs`

## 1. 阶段目标

本阶段只完成执行文档 Phase 4：在 Phase 3 已固定的公开规则、费率、标记价格与资金费输入上，建立 LONG/SHORT 各自独立、可幂等重放、可从初始权益独立重算的费用和资金费事实。强平状态机、保险基金消耗和 ADL 留到 Phase 5。

完成态必须同时满足：

- 资金费使用结算事件到达前的 LONG/SHORT 持仓快照，分别生成方向相反的现金流；
- maker/taker fee 绑定成交时刻实际生效的公开 fee-policy revision；liquidation fee revision 同样被完整冻结，供 Phase 5 使用；
- position、margin、funding、fee 的每次权威变更都能由 hash-chained contract ledger 追溯；
- portfolio、report、review fork 与账户导出提供逐腿会计事实；
- auditor 不信任投影值，能从成交、规则、公开输入、结算事实和账本重新计算两条腿及账户现金。

## 2. 背景审计结论

### 2.1 可复用能力

- `replay_training_contract_ledger` 已按 `posting_id` 幂等，且每条记录包含前序哈希和 entry hash；账户保存 tail hash。
- 普通手续费已按成交时刻选择 fee revision，并使用合约面值、quote step 和 maker/taker bps 重算。
- Phase 2 已建立 `replay_training_position_leg` 与逐腿 margin bucket；Phase 3 已把 RULE/FEE/MARK/FUNDING 输入固定在不可变公开档案中，并按全局时钟稳定排序。
- 现有 account auditor 已能独立重算账本链、手续费、单向资金费和账户余额，可扩展而不另建第二套审计入口。

### 2.2 必须修复的缺口

- `replay_training_funding_settlement` 的主键只有 run/track/time，且只保存一个 quantity，不能表示同一结算时刻的 LONG 和 SHORT。
- HEDGE 的 FUNDING 事件目前只更新公开输入投影，没有产生现金、结算事实或逐腿累计值。
- HEDGE 成交的 `position_side` 尚未进入手续费账本元数据，逐腿 `trading_fees` 仍可能被 broker 投影覆盖。
- 公开 fee 输入中的 `policy_version`、`account_tier`、`liquidation_fee_bps` 尚未进入可查询的有效策略关系。
- auditor 的成交状态仍以 `track_id` 为键，会把 HEDGE 两条腿错误净额化；review fork 也只会复制旧的单腿 funding settlement。
- 逐腿 position/margin 投影更新没有零现金 mutation receipt，账本不能完整证明状态变更。

## 3. 数据与协议设计

训练 schema 升至 v16，并新增两张 additive 表：

1. `replay_training_fee_policy_extension`
   - 与现有 fee policy 以 `(run_id, revision)` 一一对应；
   - 固定 `policy_version`、`account_tier`、`liquidation_fee_bps`、source reference 和 component hash；
   - 非 HEDGE 旧路径用显式 `NOT_APPLICABLE`/规则默认值补齐，保持旧协议兼容。

2. `replay_training_hedge_funding_settlement`
   - 主键 `(run_id, track_id, position_side, settlement_time_ms)`；
   - 保存公开事件序号/哈希、结算前 signed/absolute quantity、mark、rate、contract size、舍入方法、cash delta、rule revision、ledger sequence 和 component hash；
   - 同一个 FUNDING 事件固定按 LONG 后 SHORT 顺序结算；零仓位也记录零现金事实，保证完整可审计。

逐腿累计字段采用派生权威值：

- `accumulated_funding = SUM(hedge funding cash_delta)`；正数为收到，负数为支付；
- `trading_fees = SUM(configured_fee)`，始终为非负已付费用；
- `liquidation_fees = SUM(-ledger.cash_delta)` for `LIQUIDATION_FEE`，Phase 5 接入；
- position leg upsert 不再信任 broker 对上述三个字段的声明。

## 4. 结算与幂等顺序

每个公开 FUNDING 事件在同一 SQLite 写事务内执行：

1. 验证 HEDGE binding、输入链和连续 event sequence；
2. 读取当时的两条 relational position leg，作为不可变 pre-settlement snapshot；
3. 读取结算时刻生效的 instrument rule；
4. 对 LONG/SHORT 分别计算 `-(signed_qty * mark * contract_size * rate)`，按 quote step 对绝对值向上取整后恢复符号；
5. append 唯一 posting、insert 逐腿 settlement、累计账户 overlay cash；
6. 刷新逐腿派生 accounting 字段；
7. 最后写 applied-event receipt 和输入投影。

若 response 丢失后重试，applied-event 或 settlement/posting 的唯一键使整个事务只生效一次；进程重启后使用相同数据库仍遵守相同唯一约束。

成交同步顺序：先以 fill 主键去重，绑定成交时刻的 fee policy + extension，写 fill 和 fee ledger，再刷新逐腿费用。HEDGE fill 缺失或携带非法 `position_side` 时 fail closed。

## 5. 账本与对外投影

- fee/funding ledger metadata 明确包含 `position_side`、policy/public event reference、舍入规则和 pre-settlement snapshot。
- position leg 与 margin bucket 的 component hash 变化时写零现金 mutation entry；posting id 由目标 component hash 构成，因此相同投影重复同步不会增加记录。
- portfolio 增加 `hedge_state.leg_accounting`，每条腿披露累计资金费、手续费、强平费、结算/费用/mutation entry 数和最后 ledger sequence/hash。
- report 继续嵌入权威 portfolio；account-records 的 LEDGER/FILLS 导出保留新增 metadata/position_side；review fork 重建 child-owned fee policy extension、逐腿 settlement、ledger hash 和逐腿累计值。

## 6. 独立审计规则

扩展现有 account auditor：

- 以 `(track_id, position_side)` 重演 HEDGE fills；
- 从 fee policy + extension、instrument rule、fill notional/liquidity 独立重算 configured fee；
- 对每个逐腿 funding settlement 重新读取对应公开 applied event，验证 event hash、结算前数量、mark、rate、舍入、rule revision、ledger link 和 cash delta；
- 从逐腿 settlement/fill/liquidation ledger 重算 relational leg 的三个累计字段；
- 重算完整 ledger hash chain、现金总额与 account overlay/current balance；
- 任一差异使用精确字段路径，例如 `hedge_funding[track-1:LONG:...].pre_settlement_quantity`，不得只返回笼统失败。

## 7. 实现步骤

1. 增加 schema v16、fee extension 和逐腿 funding settlement。
2. 在 T0 与后续 FEE_POLICY event 同步完整策略扩展，并纳入输入 auditor。
3. 实现 HEDGE funding 双腿结算、账户现金更新和逐腿累计刷新。
4. 加固 fill fee：HEDGE position_side、完整 policy metadata、逐腿 fee 累计。
5. 为 position/margin component 变更补零现金账本 receipt。
6. 扩展 portfolio/report/export/review fork。
7. 扩展 account auditor 与篡改诊断。
8. 新增 Phase 4 专项测试；回归 Phase 1–3、旧 replay backend、frontend parser/typecheck/lint/build。

## 8. 硬门禁与停止条件

必须通过：

- 等量 LONG/SHORT 在同一 funding event 下产生等绝对值、反方向 cash flow；
- 同一输入重复调用、模拟 response loss 重试、关闭并重开 store 后均无重复 settlement/ledger/cash；
- maker/taker 成交准确绑定各自 effective revision，liquidation fee revision 可被 Phase 5 精确读取；
- review fork 拥有 child-run 哈希，但逐腿会计结果与所选父 run 前缀一致；
- 正常 auditor `PASS` 且零差异；分别篡改 fee revision、funding pre-snapshot、ledger hash、position cumulative field 时返回对应字段；
- 全量既有 replay 测试与前端质量门禁不回退。

只有出现无法通过确定性规则、schema 或现有公开输入解决的硬错误时停止并报告；不会因缺少交易所私有账户数据而退回灰度或默认关闭。
