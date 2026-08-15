# Backtest Python First N4 隔离 JSONL Runner（2026-08-15）

## 结论

状态：`PYTHON_RUNTIME_ISOLATED`。

真实解释器 + 严格 JSONL worker 已落地。`SANDBOXED_LOCAL` 在 AppContainer 不可用时失败关闭。
`TRUSTED_LOCAL` 必须 `BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED=1` 且显式确认。Runner 不导入
service/repository/database。尚未注册生产 Run 路径。

200k BAR 正式阈值未冻结；本阶段只记录 trusted-local 生命周期探针可通过。
