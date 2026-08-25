# 本地数据与策略研究统一 Phase 12 执行计划（2026-08-25）

## 身份与范围

- 基线：Phase 11 `0521828b346e794a8af1d35d1e4839ce4f5ee8c1`（功能提交 `67ac5e46`）
- 分支：`codex/strategy-research-unification`
- 建立 release verifier、smoke、双旗标 rollback 与 soak 脚本，冻结候选 SHA 与证据 hash。
- 生产旗标默认值保持 0；“评审后决定”不在本阶段擅自改为 1。
- 只读审计 `codex/local-offline-mode` 脏状态。不 push、不 merge、不部署、不删除旧 worktree、不归档旧分支。

## 漂移判断

Phase 0–11 功能提交已在本分支。仓库尚无 `verify_strategy_research_unification.py` 与 `strategy-research-smoke.mjs`。本环境无交互式浏览器 MCP，LIVE 行情进程未作为本阶段前置启动。60 分钟 mixed soak 若不能同时覆盖 LIVE 看图与 LOCAL_OFFLINE，必须诚实 ENV_STOP，不得伪造 PASS。

## 实施顺序

1. 写下 verifier schema、verifier、frontend smoke、rollback 源码门禁、可选 soak 脚本与测试。
2. 运行文档列出的 scoped pytest / npm 定向测试。
3. 运行 full backend pytest、`npm test`、typecheck、lint、build、`smoke:backtest`。
4. 跑安全矩阵与 LOCAL_OFFLINE guard。
5. 双旗标关闭源码 + 测试演练。
6. 尝试 60 分钟 soak；不能覆盖 LIVE 浏览器路径则记录 ENV_STOP。
7. 只读审计旧 worktree 37 项脏状态。
8. 签署 DoD，绑定 SHA 与 artifact hash。

## 预计修改文件

- `backend/scripts/verify_strategy_research_unification.py`
- `backend/scripts/soak_strategy_research_unification.py`
- `frontend/scripts/strategy-research-smoke.mjs`
- `docs/evidence/STRATEGY_RESEARCH_UNIFICATION_PHASE_12_*`
- `docs/evidence/strategy-research-unification-release-*.json`
- `docs/LOCAL_DATA_STRATEGY_RESEARCH_UNIFICATION_EXECUTION_zh.md`（仅本 worktree 证据签署，不改 main 未跟踪副本之外的无关文件）

## 退出标准

- 必跑测试记录真实退出码。
- 远程 Origin 不能访问本地资料库。
- LOCAL_OFFLINE 无外网 fallback。
- 双旗标关闭恢复 chart-first + 独立 local.html 壳。
- 旧分支未删除。
- release manifest 绑定候选 SHA。
- DoD 逐项签署，未跑项不得标 PASS。

## 回滚

关闭两个资料库旗标；不删除磁盘数据与旧键。代码回滚只 revert Phase 11→4。
