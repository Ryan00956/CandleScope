# 本地数据与策略研究统一 Phase 3 结果（2026-08-25）

## 结论

Phase 3 通过。`LocalDataRuntime` 是唯一写入 owner；`BacktestRuntime`/`BacktestWorker` 注入同一 `LocalDatasetService`。LIVE 在 Backtest 启用时创建 `LocalDataRuntime`；LOCAL_OFFLINE 仍通过 `LocalOfflineRuntime` facade，内部使用 `LocalDataRuntime` + `LocalOfflineBoundary`。shutdown 幂等；worker.start 失败会关闭已启动线程。

## 测试

`pytest` research_data_runtime + backtest_runtime + chart_context + quick_presets + offline + local_data：51 passed，exit 0。

## 回滚

还原 runtime 构造；磁盘格式不变。
