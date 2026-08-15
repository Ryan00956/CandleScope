# Backtest Python First N2 作者合同与 SDK（2026-08-15）

## 结论

状态：`PYTHON_AUTHOR_CONTRACT_V1_FROZEN`。

新增仓库内 `packages/candlescope-backtest-sdk`。本阶段不执行用户代码，不接入 Run。

冻结名称：`candlescope.python-strategy/1`、`strategy-provider/1`、
`candlescope.python-strategy-bundle/1`、`python-strategy-runtime/1`、
`strict-jsonl/1`。

## 验证

- SDK 架构测试：无 backend/database/network/Plugin Platform import。
- strict JSON：duplicate key / NaN / Infinity / 安全整数边界。
- Host 与 SDK schema 字节与 canonical hash 一致。
- wheel 离线安装并两次导入 Observation/Context 与三种输出。
- SMA / RSI / 突破 fixture 只依赖标准库和 SDK。
- Pine/Pyne 路径本阶段零功能扩张。

## 回滚

删除未被生产 Run 引用的新 SDK 与 Host schema 副本。旧回测不受影响。
