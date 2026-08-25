# ADR-BACKTEST-014：本地数据作为策略研究来源，LOCAL_OFFLINE 保持技术 profile

- 状态：Accepted for implementation
- 日期：2026-08-25
- 基线：`main@144e748cc881220565cd5aa07fc494cba9a4133c`
- 工作树：`H:\program\CandleScope-strategy-research`
- 分支：`codex/strategy-research-unification`
- 授权文档：[LOCAL_DATA_STRATEGY_RESEARCH_UNIFICATION_EXECUTION_zh.md](../LOCAL_DATA_STRATEGY_RESEARCH_UNIFICATION_EXECUTION_zh.md)
- 不替代：
  - [ADR-BACKTEST-004](ADR-BACKTEST-004-local-data-foundation.md)
  - [ADR-BACKTEST-013](ADR-BACKTEST-013-CHART-FIRST-STRATEGY-TESTER.md)
  - [local-offline-mode.md](../local-offline-mode.md)
  - [BACKTEST_CHART_FIRST_UX_EXECUTION_zh.md](../BACKTEST_CHART_FIRST_UX_EXECUTION_zh.md)
  - [BACKTEST_SYSTEM_EXECUTION_zh.md](../BACKTEST_SYSTEM_EXECUTION_zh.md)

## 背景

当前 main 已经同时拥有：

- 本地不可变资料库（导入、质量、revision、项目包、精确向上聚合）
- chart-first 策略快测
- 独立高级研究页 `/backtest.html`
- `LOCAL_OFFLINE` 进程级离线边界

但产品层仍把这些能力呈现为并列入口：`/local.html`、行情页“策略”、TopBar“策略回测”。用户会把“本地模式”理解成与“策略回测”并列的独立产品。

旧分支 `codex/local-offline-mode@d3c2fe37` 落后当前 main 284 个提交，独有 9 个历史提交，工作区另有 37 项脏状态。ADR-004 已禁止整枝 merge。main 已语义移植本地数据能力，因此本方案必须从当前 main 继续，而不是从旧分支开发。

技术上还存在多个 `LocalDatasetService` 写入所有者：`LocalOfflineRuntime`、`BacktestRuntime`、`BacktestWorker` 各自构造。只读打开不可变 revision 可以并行，但资料库写入、current pointer、trash、import job 和生命周期不能继续依赖多个隐式所有者。

## 决策

### 1. 一级产品只有“策略”

普通用户只看到一个策略入口。本地数据是该产品中的一种数据来源，不是一级导航模式。

两条数据入口：

1. 当前图表（`CURRENT_CHART`）
2. 导入数据（`IMPORTED_DATASET`）

可选第三种只读来源：完成 Run（`COMPLETED_RUN`）。

两条可运行入口必须在创建 Run 前汇合为同一个不可变身份：

```
dataset_id + data_epoch + snapshot_hash + interval + start_time_ms + end_time_ms
```

前端不得自行拼装 `snapshot_hash`。后端再次校验后才接受 Run。

导入后用户可以只看图、画线、加指标、标事件和查看质量，不必创建策略 Run。

### 2. LOCAL_OFFLINE 是技术 profile，不是页面开关

`CANDLESCOPE_RUNTIME_MODE=LOCAL_OFFLINE` 继续是进程级边界：

- 不启动交易所 ingestion、backfill、行情 WebSocket、Replay、在线目录刷新、插件 Host
- 只允许本地资料库和已明确支持的 Backtest API
- 强制 loopback 监听并安装非 loopback 网络阻断

统一产品入口不得把它降级为页面中可热切换的按钮。LIVE 与 LOCAL_OFFLINE 使用同一个策略研究工作区；离线时实时来源显示不可用原因。

### 3. 第一版不做 LiveChartCell 混合数据热切换

`LiveChartCell` 拥有实时 session、SeriesDataFeed、WebSocket lease、回填、链接组和多图状态。本地数据拥有不可变 `dataset_id + data_epoch`、无 stream URL、无在线 fallback 的静态 feed。

第一版行为：

- 当前图表快测继续在行情页 bottom panel 运行。
- “导入自己的数据”进入同一“策略”产品下的全屏策略研究工作区。
- 全屏工作区使用共享图表平台，但拥有独立 research runtime。
- 若以后需要每图表单元格选择本地数据，另写 ADR，不在本方案顺带实现。

### 4. 禁止整枝 merge 旧本地分支

继续遵守 ADR-004：

- 不直接 merge `codex/local-offline-mode`
- 不在该分支上继续开发
- 不因为本方案实施而删除旧工作树或归档旧分支
- 旧工作树 37 项脏状态在最终收口前只读保留
- 最终只对仍未进入 main 的非本地数据脏改动做独立归类，且必须另获用户授权

### 5. 硬边界

1. `IMPORTED_DATASET` 永不静默联网补数据、插值、换周期或切换 revision。
2. revision / 范围 / 脚本变化时，旧结果同一渲染帧进入 STALE 并隐藏旧标记。
3. 导入 OHLCV 只能直接支持 `BAR_APPROX`；界面不得暗示已有逐笔或队列精度。
4. TrainingRun 与 BacktestRun/Study 继续隔离账户、checkpoint、cursor 和 UI store。
5. LIVE 中 `/api/v1/local` 全部视为本机资料库 API；只接受可信本机 Origin/Host；不信任 CORS 或 `X-Forwarded-For`；不添加 `remote_admin` 裸开关。
6. 唯一写入所有者：`LocalDataRuntime` 拥有 `LocalDatasetService` 与 import jobs；`BacktestRuntime` 注入只读/共享服务，不再隐式创建第二个可写 service。
7. 回滚旗标默认关闭：
   - `CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED`
   - `VITE_RESEARCH_DATA_LIBRARY_ENABLED`
   - 关闭后必须恢复当前已验证的 chart-first + 独立 `local.html` 行为
   - 默认值变化只能在 Phase 12 评审后发生，不在中途改生产默认

### 6. 目标信息架构

- canonical URL：`/strategy.html`
- `/local.html` 与 `/backtest.html` 保留兼容 bootstrap，启动同一个 StrategyResearchApp
- 行情页只保留“策略”入口；“高级研究”从策略面板或结果面板进入
- 普通 UI 不展示 dataset ID、data epoch、snapshot hash

## 后果

Phase 0 只冻结合同与基线。Phase 1 先建立 source-neutral 合同，Phase 2 提取可复用资料库组件，Phase 3 统一写入所有者，Phase 4 才在 LIVE 中按本机 Origin 开放资料库 API。在完成批次 A 之前，不得把资料库管理面暴露给 LIVE 页面，也不得提前实现统一壳。

本 ADR 不授权：push、merge、deploy、默认开启两个研究资料库旗标、删除旧 worktree/分支、扩大 LOCAL_OFFLINE 插件/Pine/Pyne/Replay 权限。
