# ADR-BACKTEST-006：Phase 0 基线与实施边界

- 状态：Accepted
- 日期：2026-08-14
- 基线：`main@5df19ae7`
- 工作树：`H:\program\CandleScope-backtest-foundation`
- 分支：`codex/backtest-foundation`

## 背景

用户授权按执行文档分阶段实现，并要求独立 worktree。当前 main 与 local-offline 工作区都有未提交脏变更，不能带入回测分支。

## 决策

Phase 0 只冻结合同、ADR、golden、flags、资源上限、证据目录和可执行合同测试。不创建 `app.backtest` 业务包、不注册路由、不创建 `backtest.db`、不增加前端入口。架构测试必须先证明这些实现不存在。

## 后果

后续 Phase 从本分支已验收提交继续。任何业务实现若在合同测试通过前合入，都视为越权。
