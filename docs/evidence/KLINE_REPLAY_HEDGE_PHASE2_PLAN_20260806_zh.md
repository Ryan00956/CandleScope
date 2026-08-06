# K 线回放 HEDGE Phase 2 背景审计与执行计划

日期：2026-08-06
基线：`1d205046`
范围：双向账户、逐腿 leverage、初始/维持保证金、CROSS/ISOLATED、order reservation、reduce-only 与 close capacity；不实现 Phase 3 archive importer 或 Phase 5 强平状态机。

## 1. 已确认背景与缺口

- broker 已有 `PositionBook.long/short`，订单和成交可携带 `position_side`，等量双腿不会在执行层互相净额。
- `ReplayOrder` 没有持久化下单时的 effective leverage；成交后 leverage 信息丢失。
- `Position` 没有 active leverage；`build_account` 对 gross notional 一律除以 session max leverage，因此低杠杆仓位成交后会错误释放保证金。
- broker 的 HEDGE exposure/close capacity 已按目标腿校验，但 opening exposure 和 margin reservation 仍主要使用 gross position 与单个 account available scalar。
- training `InstrumentRule.maintenance_margin` 尚未按 quote step 向上；initial margin、tier 选择和 rounding 分散在 storage/service。
- `isolated_margin_json`、分配命令、capacity 与自动释放均按 `track_id` 聚合，HEDGE LONG/SHORT 会共享并串改同一逐仓 allocation。
- portfolio/audit 仍大量从每个 adapter 的聚合 account 字段取 margin/reserved；HEDGE per-leg relation 尚未成为可独立重算的风险真值。
- 右侧交易面板的逐仓分配命令没有 `position_side`，无法对一条腿单独增加或减少保证金。

## 2. 冻结 Phase 2 规则

1. 继续执行 Phase 0 `CANDLESCOPE_HEDGE_ACCOUNT_V1`：两腿无 initial/maintenance offset，各腿分别计算后求和。
2. `InstrumentRule` 是唯一 Decimal rule adapter：
   - initial margin = `ceil_quote(notional / active_leverage)`；
   - maintenance = `ceil_quote(max(0, notional * tier_rate - deduction))`；
   - tier 按首个 `notional <= cap` 选择；
   - capacity quantity 向 quantity step 下取整；费用/保证金向 quote step 上取整。
3. HEDGE 每条腿持久化 active leverage。首个 opening order 设定该腿 leverage；已有非零腿的追加 opening order必须使用同一 leverage。改变非零腿 leverage 必须走独立 `set_position_leverage` 领域命令，不能借 pending order 静默改写。
4. `set_position_leverage` 在 actor 内原子更新目标腿、重算 account/checkpoint/hash；若降低 leverage 后所需 initial margin 超过可用权益则拒绝。LONG/SHORT 互不改写。
5. opening order reservation 使用目标腿 active leverage；reduce-only reservation 恒为零。reduce-only 与 close capacity 只读取目标腿，不得用 net quantity。
6. HEDGE ISOLATED allocation key 固定为 `<track_id>:<LONG|SHORT>`；ONE_WAY 继续用 `<track_id>`。分配、释放、capacity、risk projection、ledger metadata 和 UI 全部携带 `position_side`。
7. CROSS available = equity - Σ position initial margin - Σ active opening-order margin；ISOLATED leg available = isolated wallet - leg position initial margin - leg active opening-order margin。逐仓钱包不共享。
8. margin adjustment 是 hash-chained ledger posting；target 不能低于该腿已用 initial margin + active opening-order reservation。

## 3. 实现顺序

1. 扩展 broker Position/ReplayOrder checkpoint contract，持久化 effective leverage；新增 actor `set_position_leverage` 命令。
2. 重构 broker risk/account：逐腿 initial margin、目标腿 capacity、leverage mutation 不变量与 restart/fork 恢复。
3. 把 `InstrumentRule` 收敛为 initial/maintenance/tier/rounding adapter，并让 storage projection 使用同一实现。
4. 将 HEDGE ISOLATED allocation、自动释放、capacity 与审计改为 per-leg key；更新 API/TypeScript/UI command contract。
5. 增加 CROSS 双腿、ISOLATED 单腿变更、杠杆重算、低杠杆 reservation、reduce-only、close capacity、rounding、restart/fork/corruption 测试。
6. 跑完整 backend replay、frontend replay、typecheck、Ruff、compile 和 build；写结果证据后独立提交。

## 4. 停止条件

- 任何路径仍以 net quantity 判定 HEDGE flat 或 close capacity；
- active leverage 无法进入 actor checkpoint/state hash；
- HEDGE ISOLATED allocation 仍只能按 track 聚合；
- 同一订单在 preview、capacity、placement、restart 后得到不同 reservation；
- account 字段不能从 ledger、position legs、active orders 与 versioned rule 独立重算。
