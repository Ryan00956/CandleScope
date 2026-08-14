# Pine strategy 回测兼容矩阵

状态：`PHASE11_SUBSET_FROZEN`

合同版本：`pine.strategy.backtest.v1`

本文只描述 CandleScope Host 回测已冻结的 Pine strategy 子集。它不是 TradingView 等价声明。

## 支持

| 语义 | 合同 |
| --- | --- |
| 计算时点 | 仅 `barstate.isconfirmed` / bar close |
| 入场 | `strategy.entry(..., strategy.long)` 映射为 `TARGET_POSITION=1` |
| 平仓 | `strategy.close` / `strategy.close_all` 映射为 `TARGET_POSITION=0` |
| 金字塔 | 仅 `pyramiding=0` 或缺省 |
| 手续费 | 声明可记录，成交费用仍由 Host 账户模型计算 |
| 输出 | `SIGNAL` 或 `TARGET_POSITION`，不能写 Host 订单 |

## 明确不支持（静态拒绝）

`strategy.order`、`strategy.exit`、`strategy.risk`、`pyramiding>0`、`calc_on_every_tick`、
`process_orders_on_close` 的非默认组合、`request.security`、`request.seed`、forming-bar、
hedge 双向、短线 `strategy.short`（第一版单向账户）。

## 报告用语

页面必须显示 `pine.strategy.backtest.v1` 和“非 TradingView 等价”。
