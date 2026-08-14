# ADR-BACKTEST-002：宿主拥有执行真相

- 状态：Accepted
- 日期：2026-08-14
- 基线：`main@5df19ae7`

## 背景

回测策略来源包括 Pyne、Pine、ONNX、本地 Python 和外部模型。如果插件自己写订单或报告，将无法保证无前视、可重放和账本可对账。

## 决策

新增贡献点 `strategy-provider/1`，不修改 `candlescope.script-runtime/1`。插件只输出 `SIGNAL` / `TARGET_POSITION` / `ORDER_INTENT`。撮合、账户、风险、指标和审计永远属于 Host。

## 后果

Host 必须提供有界 `ObservationFrame` 和 `ExecutionReport`。插件不得申请任意历史查询，也不得打开 CandleScope SQLite。
