# 本地数据与策略研究统一 Phase 3 执行计划（2026-08-25）

## 范围

- 提取 LocalDataRuntime 作为唯一写入所有者。
- BacktestRuntime/Worker 注入同一 LocalDatasetService，不再各自 new。
- LOCAL_OFFLINE 最后安装 LocalOfflineBoundary。
- shutdown 顺序：BacktestWorker → BacktestService → LocalImportJobs → LocalDatasetService → OfflineNetworkGuard。
- 第二次 shutdown 幂等；启动中途失败反向清理。
- 不开放 LIVE `/api/v1/local`（Phase 4）。

## 预计文件

- `backend/app/local_data/runtime.py`
- `backend/app/backtest/runtime.py`
- `backend/app/main.py`
- `backend/app/research_data/runtime.py`
- `backend/tests/test_research_data_runtime.py`

## 回滚

还原构造路径；磁盘格式不变。
