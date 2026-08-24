# Backtest Chart-First Phase 12 执行冻结

日期：2026-08-24

候选起点：`e63f23a8`（Phase 11 完成提交）

分支：`codex/backtest-chart-first-ux`

## 1. 发布判定边界

- Phase 12 产出机器可读 evidence、manifest、截图和回滚结果；任何必跑 gate 失败都保持 `NO_GO`，不得写成 PASS。
- 生产构建全部 backtest/chart-first/research flags 继续默认 `0`。开发验证可显式开 flag，但不修改生产默认值。
- 只使用隔离 worktree、隔离 `LOCAL_OFFLINE` 数据目录和仓库 fixture；不读取/修改生产数据，不 push、merge、发布或部署。
- 独立评审属于外部阻断关口；自动化与浏览器证据完成后仍不自称已获生产默认开启授权。

## 2. 实施顺序

1. 复核 package-lock、解释器、浏览器、fixture、端口和当前 clean HEAD；处理验证环境漂移，不修改共享主工作树依赖。
2. 运行文档列出的 architecture、i18n、双 tsconfig、lint、backtest、完整 frontend、build 与 backend 全量 backtest gate。
3. 建立受控 release fixture，覆盖现货/永续、两个 symbol、原生/精确聚合/不支持周期、READY/gap/offline/corrupt/epoch-change。
4. 用自动化覆盖普通三状态与 stale、Run/解释/比较、四 cell 隔离、快速切换、晚到响应、并发预算、按需 runtime 与 16/64 未附着零实例。
5. 在 1366×768 与 1920×1080 走查单图/四图/最大化、高级五任务、Python lazy、Study/replay fail-closed；保存截图和 console/request 证据。
6. 执行默认 flag-off 的 1/4/16 图资源回归，并记录请求、WebSocket、tester 实例与浏览器 heap；只做同口径比较。
7. 运行至少 60 分钟的真实浏览器稳定性观察，定期采样页面/后端健康、console、请求失败、heap、runtime/lease 数；不中途缩短或伪造时长。
8. 分层关闭 advanced research、auto-run、compare、explanation、chart tester、chart-context resolver，并启用 legacy adapter；验证 Run/workspace 仍可读且数据 hash 不变。
9. 生成 machine-readable release evidence 与 manifest，绑定 clean candidate HEAD、环境、命令、结果、截图 SHA-256 和回滚证据。

## 3. 退出门

- 必跑命令与 backend 全量 backtest 测试全部通过；如验证环境与 lockfile 漂移，必须在隔离 worktree 恢复精确 lock，不修改共享依赖树。
- 浏览器矩阵、60 分钟观察和回滚演练均有机器可读 PASS；任何预期失败关闭状态必须与产品能力标签一致。
- 首次成功路径、跨 cell/symbol/interval 隔离、解释/比较真实性、advanced/legacy parity 与 flag-off 资源基线均有证据。
- 生产 flags 默认关闭；只有独立评审无 P0/P1 后才允许另行讨论生产默认开启。
