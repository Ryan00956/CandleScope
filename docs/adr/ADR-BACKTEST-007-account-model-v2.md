# ADR-BACKTEST-007：线性永续账户 V2

- 状态：Accepted
- 阶段：M4
- 身份：`LINEAR_PERP_ONE_WAY_V2`

## 决策

V2 是与 `LINEAR_PERP_ONE_WAY_V1` 并存的新身份，不修改或迁移旧 Run。Host 以 Decimal
账本拥有执行真相，并在订单受理、成交、mark、funding、rules 和补偿分录后重算账户。

- 未实现盈亏只使用历史 `MARK_INDEX.mark_price`；成交价只决定 fill 与 entry。
- 账户持仓采用单向净持仓；账户 entry 为剩余 lot 的加权平均价，已实现交易按 FIFO lot 对账。
- 初始保证金为 `abs(qty) * mark * multiplier / leverage`。
- 维护档位使用半开区间 `[notional_floor, notional_cap)`；超过最后一档以
  `ACCOUNT_RISK_LIMIT_EXCEEDED` 失败关闭。维护保证金为
  `max(0, notional * maintenance_rate - maintenance_deduction)`。
- funding mode 只能是 `OFF`、`FIXED_SCENARIO`、`HISTORICAL_REQUIRED`。前两者不声称历史；
  后者逐个历史 period 恰好结算一次，无仓位 period 仍写零金额审计项。
- 强平在首次使 `equity <= maintenance_margin` 的 mark/rules/funding 事件上触发，价格为该
  事件的历史 mark，模型身份为 `MARK_IMMEDIATE_NO_LIQUIDATION_FEE_V1`。该模型不收额外
  强平费，不模拟保险基金或 ADL。平仓后钱包小于零才标为 `INSOLVENT`。
- 账本 hash chain append-only；更正只能追加 `COMPENSATING_ENTRY`。

## 数据门禁

V2 必须完整覆盖 `MARK_INDEX` 和 `INSTRUMENT_RULES`。只有
`HISTORICAL_REQUIRED` 额外强制完整 `FUNDING`。缺任一强制 role 都失败关闭，禁止退化为
bar close、成交价或当前交易所规则，也禁止联网补取。

## 兼容与回滚

旧 V1 identity、fixture、报告读取和执行路径保持不变。回滚本 ADR 对应实现 commit 即可移除
V2；现有 V1 Run 无需迁移。所有生产回测 flags 继续默认关闭。
