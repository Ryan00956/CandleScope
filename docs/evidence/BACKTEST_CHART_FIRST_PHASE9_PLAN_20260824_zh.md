# Backtest Chart-first Phase 9 执行计划（2026-08-24）

## 范围

本阶段只抽取普通行情页与高级研究页共享的 source-neutral 图表平台，不创建高级研究路由，不迁移 Study，
不改变默认 feature flags。生产 `LiveChartCell` 必须经过共享 adapter，且用户可见 DOM、请求数、WebSocket
端点和主图交互保持一致。

## 冻结合同

1. `MarketChartSourceRuntime` 只允许 `LIVE_REFERENCE`、`FROZEN_SNAPSHOT`、`RUN_RESULT`。
2. LIVE_REFERENCE 复用现有 `useMarketDataRuntime` 与 Host REST/WS；它的 `executionIdentity` 必须为 null，
   不能作为 Run 的不可变输入。
3. FROZEN_SNAPSHOT 只接受显式 dataset/data_epoch/snapshot_hash 与内存 bars；创建、暂停、恢复均不得联网。
4. RUN_RESULT 只接受显式 run/config/report/chart hash 与 bars；完成 Run 不被 live 更新修改。
5. 三种 source 创建后进入 ACTIVE，并支持 ACTIVE/PAUSED/DISPOSED 生命周期；source slot 切换先 dispose 旧 source。
6. `MarketChartSurface` 绑定 source 拥有的 session、series store、loading/meta 与分页能力；marker/layer/subpane
   作为显式输入，不 import backtest UI。
7. `LiveChartCell -> createLiveReferenceSource -> MarketChartSurface` 是生产路径；共享平台不得反向依赖
   `features/backtest`、`app/LiveChartCell` 或可变 workspace store。

## 验证

- 纯单元测试覆盖 lifecycle、切换清理、live execution fail-closed、冻结 source 断网读取及输入拷贝隔离。
- 源码架构检查阻止 `market-chart-platform -> backtest/replay/app` 反向依赖。
- TypeScript、ESLint、architecture、i18n、全前端 backtest 和相关 app/market-data 测试通过。
- 默认 flag-off 与显式 chart-tester flag-on build 均通过。
- headed Chrome 1440×900 前后各记录：1 cell、1 lightweight chart、canvas 数、K 线请求、WebSocket URL、heap、
  source mode 属性和截图；同屏比较后检查裁切、边距、层级与溢出。

## 回滚

Phase 9 保持单提交。revert 后 `ChartCellCanvas` 恢复直接组合 `SingleChartPanes`；Phase 10 flag 尚未存在或保持
关闭，现有 Run、workspace、图表缓存和 Host lease 均不删除。
