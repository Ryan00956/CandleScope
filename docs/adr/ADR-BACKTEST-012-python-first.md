# ADR-BACKTEST-012：Python First、Host-owned execution 与 Plugin Platform 解耦

- 状态：Accepted
- 日期：2026-08-15
- 基线：`2bbc67c84c85568bbdebdbeece2cd7015c150354`
- 工作树：`H:\program\CandleScope-backtest-foundation`
- 分支：`codex/backtest-foundation`
- 执行合同：[BACKTEST_PYTHON_FIRST_PRODUCTIZATION_EXECUTION_zh.md](../BACKTEST_PYTHON_FIRST_PRODUCTIZATION_EXECUTION_zh.md)
- N0 冻结记录：[BACKTEST_PYTHON_FIRST_N0_RESULT_20260815_zh.md](../evidence/BACKTEST_PYTHON_FIRST_N0_RESULT_20260815_zh.md)

## 背景

M0～M10 已在本分支建立 Host-owned 回测框架、`strategy-provider/1`、BAR/aggTrade
双时钟、账户/报告/Study V2 与恢复合同。现有
`backend/app/backtest/strategy/python_sidecar.py` 只接受
`restricted-expression-v1`，不能作为普通 Python 策略路径。

`e970558031114f8d47b8f63d99fd49aecd96d0a7` 把 `onBacktestRun` 写入冻结 Plugin
Platform v2 activation event，造成仓库级合同漂移。Python First 不依赖该 event。

## 决策

1. **Python First**：用户用标准 Python 编写策略，经仓库内 SDK 与不可变 bundle
   接入既有 CandleScope Host。不另建 Python 撮合、账户或报告引擎。不扩展
   Pine/Pyne 语法、内置函数、`strategy.*`、`request.*` 或仓库外 runtime。
2. **Host-owned execution（延续 ADR-BACKTEST-002）**：数据、watermark、撮合、费用、
   funding、风控、账户、ledger、报告、Study 和审计始终由 Host 拥有。Python 只返回
   `SIGNAL`、`TARGET_POSITION` 或 `ORDER_INTENT`；三者都必须经过 Host
   planner/rules/risk。用户代码永不导入 API/worker Host 进程。
3. **Plugin Platform 解耦**：普通 Python 策略只通过 Backtest 内部
   `strategy-provider/1` 接入。不修改冻结 Plugin Manifest activation event
   列表；N1 必须移除 `onBacktestRun` 并恢复历史 schema/fixture hash，不得重写旧
   证据掩盖漂移。可复用本仓库 sandbox/process 启动原语，但不把 Python 策略注册为
   Plugin activation。

冻结名称：

```text
author contract    = candlescope.python-strategy/1
provider protocol  = strategy-provider/1
bundle schema      = candlescope.python-strategy-bundle/1
runtime profile    = python-strategy-runtime/1
wire transport     = strict-jsonl/1
```

冻结可复现等级：`DETERMINISTIC_CPU_LOCKED`、`SEEDED_CPU_LOCKED`、
`BEST_EFFORT_LOCAL`、`RECORDED_OUTPUT_ONLY`。前两级可用于正式 Study，且长 Run
前必须双前缀 probe。

冻结运行时模式：`SANDBOXED_LOCAL` 为 Windows 默认并在 sandbox 不可用时失败关闭；
`TRUSTED_LOCAL` 必须 `BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED=1` 加显式确认，不得
静默接受 untrusted bundle。AST/builtin 剥离不是安全边界。

冻结开关默认全部为 `0`：

```text
BACKTEST_PYTHON_STRATEGY_ENABLED
BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED
VITE_BACKTEST_PYTHON_STRATEGY_ENABLED
```

既有回测生产开关继续默认 `0`。本轮最终状态最多到
`VALIDATED_CLEAN_SHA_UNMERGED`；不合并 `main`、不推送远端、不启用生产。

## 后果

N1 先恢复仓库集成基线。随后按 N2～N10 增加 SDK、不可变 bundle、隔离 runner、
Host Run/Study 接入、Studio、模板、规模与跨商品稳健性。`restricted-expression-v1`
保留且不改名。N1 rollback target 为 N0 冻结后的文档提交；生产代码身份仍为基线
`2bbc67c84c85568bbdebdbeece2cd7015c150354`。
