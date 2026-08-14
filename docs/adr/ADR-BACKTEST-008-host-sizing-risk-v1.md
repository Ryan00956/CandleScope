# ADR-BACKTEST-008：Host Sizing 与风控 V1

- 状态：Accepted
- 日期：2026-08-15
- 基线：`48a67c3a4dd617781d427abf31a86a07da8648a3`

## 决策

新增 `HOST_SIZING_RISK_V1`。只有 Run 显式声明 `sizing_policy` 时启用；未声明的历史 Run
继续使用 legacy unit-signal planner，身份和 hash 不变。启用后，Provider 的原始输出先作为
独立 decision 记账，再由 Host 生成订单，因此 sizing 改变订单数量但不改写 Provider decision。

Sizing identity 只允许：

- `FIXED_QTY_V1`：`abs(target_qty) = fixed_qty`；
- `FIXED_NOTIONAL_V1`：`abs(target_qty) = fixed_notional / (visible_price * multiplier)`；
- `EQUITY_PERCENT_V1`：`abs(target_qty) = visible_equity * equity_percent / 100 / (visible_price * multiplier)`；
- `RISK_PER_STOP_V1`：`abs(target_qty) = visible_equity * risk_per_stop_percent / 100 / (stop_distance * multiplier)`。

计算全程使用 Decimal，最终数量按当时生效的 quantity step 向零量化。最后一种缺少正的
`stop_distance` 时返回 `ORDER_REJECTED_RISK/RISK_STOP_DISTANCE_REQUIRED`，不得退化成固定数量。

`SIGNAL` 使用上述 policy 得到有符号绝对目标数量；`TARGET_POSITION.targetExposure` 永远是
绝对目标数量；`ORDER_INTENT.qty` 永远是显式订单数量。后两者不因本 ADR 改成百分比含义。

## 风控顺序

Host 使用账户实际仓位、活动订单形成的 projected position、当时可见价格/mark、权益、费用、
合约 multiplier 和规则 revision，依次检查：最大绝对仓位、最大名义、最大杠杆、单笔风险、
活动订单数、累计手续费、最大回撤、可选日内损失与冷却。单笔风险有 stop distance 时按
`opening_qty * stop_distance * multiplier`，否则按开仓初始保证金估计。

规则拒单使用 `ORDER_REJECTED_RULES`，风险拒单使用 `ORDER_REJECTED_RISK`。每条拒单必须包含
`reason_code`、事件时间、输入快照、policy revision 和 rule revision。`reduce_only` 可以越过
只限制开仓的风险阈值及 min notional，但仍须数量合法、方向确实减仓且不得越过零。

## 恢复与报告

planner checkpoint 包含风险峰值权益、日内基线、冷却游标、最大实际暴露、停止原因和既有拒单；
engine checkpoint 包含活动订单，因此恢复后的 projected position 必须与 uninterrupted Run 相同。
报告与 chart API 暴露结构化拒单、最大实际仓位/名义和停止原因。Provider 只收到只读执行回报，
不能取得账户对象，也不能直接改余额、订单、成交或报告。

## 后果

此版本不改变成交量参与、latency 或部分成交；这些属于 M6。策略组合、多市场资金分配和
Study 级预算属于后续阶段。所有生产 backtest flags 继续默认关闭。
