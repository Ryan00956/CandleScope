# ADR-BACKTEST-005：第一版账户模型选线性永续单向持仓

- 状态：Accepted
- 日期：2026-08-14
- 基线：`main@5df19ae7`

## 背景

执行文档要求第一版只选一个账户模型：现货 long-only，或单向持仓线性永续。现有回放默认也是单向持仓，产品主路径是 USDT 线性合约。

## 决策

冻结 `LINEAR_PERP_ONE_WAY_V1`：线性永续、`ONE_WAY`、`CROSS`、BAR MVP 资金费 `OFF`、Decimal 记账。现货 long-only 作为后续独立模型，不共享模糊字段。第一版不建模爆仓、保险基金和 ADL，报告必须标 `UNMODELED`。

## 后果

BAR MVP 能先交付可对账的单账户回测。合约资金费、标记价和动态规则留到 Phase 8，且会改变 Run 身份。
