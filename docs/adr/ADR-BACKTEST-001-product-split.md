# ADR-BACKTEST-001：回放训练与策略回测必须分产品

- 状态：Accepted
- 日期：2026-08-14
- 基线：`main@5df19ae7`

## 背景

CandleScope 已有 K 线回放训练。用户明确要求另建量化回测：回放训练人的交易能力，回测发现和淘汰策略。两者可以复用数据与仿真原语，但不能共用业务对象。

## 决策

保留 `TrainingRun` 与 `BacktestStudy`/`BacktestRun` 两套产品。共享层仅限不可变数据集、事件时钟、撮合/账本、checkpoint 和只读展示。禁止共享可变订单、账户、cursor、UI store。

## 后果

需要独立 API、数据库、flags 和前端工作台。短期会有重复的装配代码；长期避免训练态泄漏进研究报告。
