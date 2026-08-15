# Backtest Python First N0 合同与基线冻结（2026-08-15）

## 结论

状态：`CONTRACT_FROZEN`。

本阶段只冻结执行合同、ADR、名称、失败基线和禁止路径。没有生产代码改动，没有
Python SDK/runtime/Run/UI 实现，没有打开任何生产开关，没有 merge，没有 push。

连续执行目标在本冻结提交之后授权开始 N1，不构成对 merge、push 或生产启用的授权。

## 冻结名称

| 合同 | 冻结身份 |
| --- | --- |
| 作者合同 | `candlescope.python-strategy/1` |
| Provider 协议 | `strategy-provider/1` |
| Bundle schema | `candlescope.python-strategy-bundle/1` |
| Runtime profile | `python-strategy-runtime/1` |
| Wire transport | `strict-jsonl/1` |

可复现等级：`DETERMINISTIC_CPU_LOCKED`、`SEEDED_CPU_LOCKED`、`BEST_EFFORT_LOCAL`、
`RECORDED_OUTPUT_ONLY`。Windows 默认运行时为 `SANDBOXED_LOCAL`；`TRUSTED_LOCAL`
必须显式 flag 加确认。AST/builtin 剥离不是安全边界。

## 基线身份

| 项 | 值 |
| --- | --- |
| 工作树 | `H:\program\CandleScope-backtest-foundation` |
| 分支 | `codex/backtest-foundation` |
| 基线 SHA | `2bbc67c84c85568bbdebdbeece2cd7015c150354` |
| 基线提交 | `backtest: complete M10 release validation` |
| `main` | `5df19ae76686977f324644e9e62a63b73cf6a743` |
| 相对 `main` | ahead 32 / behind 0 |
| 上游跟踪 | 无 |
| merge | 否 |
| push | 否 |

## M10 证据

- 候选 SHA：`04b55582b2f73ad48b50fca67eb498fc2ce0fae6`
- 完成 SHA：`2bbc67c84c85568bbdebdbeece2cd7015c150354`
- 结果：`docs/evidence/BACKTEST_MATURITY_M10_RESULT_20260815_zh.md`
- 发布清单：`docs/evidence/backtest-maturity-release-20260815.json`
- 相关后端：200 passed，3595 deselected
- 前端测试：3252 passed
- M10 状态：`VALIDATED_CLEAN_SHA`（未 merge、未 push、生产 flags 为 0）

M10 相关门禁通过不等于整个分支可集成。

## 完整后端失败基线

M10 记录的仓库全量结果仍为当前冻结失败基线：

```text
3758 passed, 28 failed, 9 errors
```

根因提交：`e970558031114f8d47b8f63d99fd49aecd96d0a7`
（`feat(pyne): add isolated backtest strategy provider`）。该提交把
`onBacktestRun` 写入冻结 Plugin Platform v2 activation event。

N0 复测代表失败（保持红灯，不改代码）：

```text
backend/tests/test_plugin_platform_multi_runtime_phase0.py::test_phase0_contract_matches_current_v2_and_freezes_future_names
  Phase0GateError: fixture=sha256:4524fea17a11506f67d5004f81aa92a359666505d989015c1cf863a036ee99bb
                   current=sha256:a20c43a5c2f276d794a84e95209764d7d11debdd85b1a5ef8c7e8be5552a33aa

backend/tests/test_plugin_platform_multi_runtime_phase1.py::test_phase1_contract_rebuilds_exact_v2_and_v3_generations
  同源合同漂移，失败关闭
```

N1 必须删除非法 activation 并恢复历史 fixture hash。禁止重写旧证据来制造通过。

## 禁止修改路径

仓库外：

- `H:\program\pyne-runtime`
- `H:\program\CandleScope-pine-interpreter`
- `H:\program\CandleScope`（main 工作树）
- `H:\program\CandleScope-plugin-platform`
- `H:\program\CandleScope-pyne-pack`

仓库内禁止功能扩张：

- `packages/candlescope-plugin-pine-compat`
- `packages/candlescope-plugin-pyne`
- `packages/candlescope-plugin-pyne-workbench`
- `packages/candlescope-plugin-sdk` 的 activation event 列表

唯一允许的相邻修改是 N1 兼容性恢复：移除 `onBacktestRun`，恢复冻结 schema、
constants、manifest 与历史 fixture。不得夹带 Pine/Pyne 新能力。

## 默认开关

既有生产/高精度开关保持 `0`：

```text
BACKTEST_ENABLED=0
BACKTEST_BAR_ENABLED=0
BACKTEST_TRADE_TAPE_ENABLED=0
BACKTEST_BOOK_ASSISTED_ENABLED=0
BACKTEST_STUDY_ENABLED=0
BACKTEST_EXTERNAL_PROVIDER_ENABLED=0
BACKTEST_ONLINE_LEARNING_ENABLED=0
BACKTEST_MULTI_MARKET_ENABLED=0
BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED=0
VITE_BACKTEST_ENTRY_ENABLED=0
```

拟议 Python 开关同样冻结为默认 `0`，本阶段尚未写入生产代码：

```text
BACKTEST_PYTHON_STRATEGY_ENABLED=0
BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED=0
VITE_BACKTEST_PYTHON_STRATEGY_ENABLED=0
```

## N1 rollback target

N1 必须是独立可 revert 提交。回滚方式：`git revert` N1。生产代码身份回到
`2bbc67c84c85568bbdebdbeece2cd7015c150354`（N0 无生产 diff）。若完整套件恢复旧
红灯，停止，不进入 N2。

## 验证

- 执行文档全部关联链接存在。
- N0～N10 每阶段都有目标、任务、验证、退出条件、建议提交和回滚。
- 执行文档未写成已实现状态；DoD 复选框保持未勾选。
- `git diff --check` 通过。
- 本阶段 diff 仅文档/ADR/证据。

## 回滚

仅 revert 本 N0 文档提交。不影响现有回测代码、数据、M10 证据或用户其它工作树。
