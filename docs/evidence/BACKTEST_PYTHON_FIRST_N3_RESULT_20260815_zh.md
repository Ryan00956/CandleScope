# Backtest Python First N3 不可变 Bundle 与 Revision（2026-08-15）

## 结论

状态：`PYTHON_BUNDLE_IMMUTABLE`。

目录和 zip 产生相同 canonical bundle hash。冻结后修改用户目录不影响已存字节。
路径穿越被拒绝。schema v6 空表可回滚，有数据则失败关闭。本阶段不执行用户代码、
不声明 sandbox。

`BACKTEST_PYTHON_STRATEGY_ENABLED` 默认 `0`。
