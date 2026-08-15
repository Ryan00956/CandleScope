# Backtest Python First N4 隔离 JSONL Runner（2026-08-15）

## 结论

状态：`PYTHON_RUNTIME_ISOLATED`。

真实解释器 + 严格 JSONL worker 已落地。`SANDBOXED_LOCAL` 在 AppContainer 不可用时失败关闭。
`TRUSTED_LOCAL` 必须 `BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED=1` 且显式确认。Runner 不导入
service/repository/database。尚未注册生产 Run 路径。

200k BAR 正式阈值未冻结。200 步 trivial JSONL step 实测 0.045 s（约 227 µs/step），
外推 200k 约 45 s，不是正式门槛。

攻击矩阵：timeout 杀无限循环、用户 print 不污染协议、EOF/无效 JSON 分类、
SANDBOXED 不可用失败关闭、双 probe hash 一致。AppContainer 在本机不可用时不静默降级。
