# Backtest Python First N7 模板与本地指南（2026-08-15）

## 结论

状态：`PYTHON_FIRST_LOCAL_BETA_READY`（独立分支，生产开关保持 0）。

首批官方模板在 `packages/candlescope-backtest-sdk/templates/`：SMA 交叉、Wilder RSI24、
Donchian 突破、均值回归、买入并持有、始终空仓、ORDER_INTENT 四类订单、
snapshot/restore。另有 Study 参数空间示例。每个模板含假设、clock、warmup、参数、
fidelity、不能声称的内容、BAR/aggTrade 说明和 golden hash。

本地指南给出 10 分钟离线 PowerShell 路径。Host BAR 探针
`backend/scripts/python_template_bar_probe.py` 在独立验证进程中生成可验证报告，
不打开 HTTP 生产 flags。

## 验证

- SDK `tests/test_official_templates.py`：schema、文档字段、snapshot/restore、四类订单、
  全新离线 temp wheel 安装后运行 8 个模板。
- Host `tests/test_python_official_templates.py`：至少 5 个模板 + order_intents 的
  bundle_hash / decision_hash 与 committed goldens 一致。
- 指南命令在全新 `$env:TEMP\cs-py-first-*` 逐条执行：`sdk-ok`、模板存在、
  sma_cross BAR probe `COMPLETED` 且 hash 匹配。
- 相关回归：bundles / studio host path / runtime 通过。

不要把本阶段写成已 merge、已 push 或 production-ready。
