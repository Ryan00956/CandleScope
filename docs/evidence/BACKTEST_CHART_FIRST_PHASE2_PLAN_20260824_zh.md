# Chart-first 回测 Phase 2 实施计划（2026-08-24）

## 范围

本阶段只实现执行文档 Phase 2：把 chart session 解析成可复现、不可变的回测上下文，并提供显式授权的数据准备入口。保持现有 `/datasets/snapshot`、`/runs/validate` 和 `/runs` 合同不变，不实现 Phase 3 前端入口。

## 已审计边界

- 不可变数据继续由 `LocalDatasetService` 与 `LocalBarSnapshotProvider` 管理；`BacktestRuntime.preview_snapshot` 仍是 Run 前的权威 snapshot 校验入口。
- 实时/历史 K 线只通过 Host `DataManager`、`BackfillCoordinator` 和既有 storage 查询；本阶段不新增下载器、缓存或重采样器。
- `resolve` 只读本地状态，绝不触发 backfill 或网络请求。
- 尚未冻结的 Host K 线只能得到 `NEEDS_DATA`；只有经过显式 `materialize`、连续性校验和不可变发布后才能得到 `READY`。
- 自定义周期只允许既有精确周期路由或同一不可变 revision 上的整数倍聚合；无法精确构造时返回 `UNSUPPORTED_INTERVAL`。

## 实施顺序

1. 增加默认关闭的 `BACKTEST_CHART_CONTEXT_ENABLED`，并暴露在 backtest capabilities。
2. 增加版本化 quick presets，前端后续只选择 preset ID，Run 仍提交展开后的显式配置。
3. 增加 `ChartBacktestContextResolver`：规范化 chart identity、选择不可变候选、检查范围/缺口/精度、签发短期 resolution token。
4. 增加显式 `materialize`：校验确认、token、revision 与 idempotency；必要时复用 Host backfill；读取 Host 规范查询结果并通过同一个 `LocalDatasetService` 冻结。
5. 增加 `/chart-context/resolve`、`/chart-context/materialize` Pydantic 合同与 API 路由。
6. 覆盖 READY、NEEDS_DATA、UNSUPPORTED_INTERVAL、UNSUPPORTED_FIDELITY、AMBIGUOUS_MARKET、离线纯读取、确认 fail-closed、revision 漂移、89m 非精确周期、并发去重及错误脱敏。
7. 运行 Phase 2 定向测试、完整 backtest 回归、lint/type/build 和公开 API smoke；记录结果后再独立提交。

## 非目标

- 不增加 chart tester 前端 UI、workspace 持久化或自动运行。
- 不更改 legacy workbench 行为。
- 不启用任何默认关闭开关。
- 不 push、merge 或 deploy。
