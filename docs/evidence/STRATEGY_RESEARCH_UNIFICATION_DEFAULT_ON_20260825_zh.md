# 策略研究默认启用记录（2026-08-25）

## 决定

`codex/strategy-research-unification` 已通过 `--ff-only` 合并到本地 `main`。随后根据用户明确授权，将以下旗标的代码默认值改为启用：

- `CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED=1`
- `VITE_RESEARCH_DATA_LIBRARY_ENABLED=1`

未设置环境变量时，LIVE 后端挂载受信本机 `/api/v1/local/*`，前端显示统一策略研究和本地资料库入口。显式设置任一对应旗标为 `0` 仍执行原有回滚合同；非法前端值保持 fail closed。

## 历史证据边界

`strategy-research-unification-release-20260825.json` 及其哈希制品是启用前候选 `6d267eb25cedc0c0ba8f4df5fab8d5cbc1e8db14` 的历史证据，继续如实记录当时“默认关闭、PRODUCTION_HOLD”的资格状态。本记录不追写该 manifest，也不把后续默认值变化伪装成原候选已经验证过的事实。需要复验该候选时，应在 `68119e74a7effae4b3477efcf64c1ff362c18d36` 的独立 worktree 运行历史 verifier；当前主线的默认启用源码与 smoke 已有意不同。

## 未解除的风险

- 后端全量 pytest 仍有 Phase 1 历史契约漂移和顺序污染。
- 仓库全量 lint 仍有既有错误；本次变更文件必须单独通过 lint。
- 60 分钟 LIVE + LOCAL_OFFLINE mixed browser soak 尚未完成。

这次操作只修改本地 Git 主线与代码默认值；未 push、未 deploy、未删除旧 worktree。

## 合并后验证

| 门禁 | 结果 |
| --- | --- |
| 默认开启 + 显式关闭后端边界 | PASS，15 passed |
| `test:research-data` | PASS，93 passed |
| `test:backtest` | PASS，122 passed |
| 前端全量测试 | PASS，3481 passed / 0 failed |
| typecheck | PASS |
| production build | PASS，706 modules |
| architecture / i18n | PASS |
| strategy research smoke | PASS，`libraryFlagDefault=1` |
| 变更文件 ESLint / Ruff | PASS |
