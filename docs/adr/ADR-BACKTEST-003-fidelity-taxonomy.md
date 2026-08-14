# ADR-BACKTEST-003：精度分级与报告用语

- 状态：Accepted
- 日期：2026-08-14
- 基线：`main@5df19ae7`

## 背景

用户希望按 K 线和按成交回测。现有数据包含完结 K 线和 `aggTrade`。若把聚合成交宣传成完美回放，研究报告将不可信。

## 决策

冻结五档：`BAR_APPROX`、`TRADE_TAPE`、`AGG_TRADE_TAPE`、`BOOK_ASSISTED`、`QUEUE_EXACT`。报告标签与 `source_event_kind` 绑定。`aggTrade` 只能使用 `AGGREGATED_TRADE_SEQUENCE`。缺少逐笔委托数据时拒绝 `QUEUE_EXACT`。失败不得静默降级。

## 后果

第一版只实现 `BAR_APPROX`。成交回测和盘口辅助按数据能力逐级解锁，并各自带独立 flag。
