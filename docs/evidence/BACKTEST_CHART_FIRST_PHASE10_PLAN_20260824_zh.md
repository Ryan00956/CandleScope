# Backtest Chart-First Phase 10 执行冻结

日期：2026-08-24

分支：`codex/backtest-chart-first-ux`

范围：独立高级策略研究应用；不迁移 Phase 11 的全部旧工作台能力。

## 1. 入口与回滚

- `VITE_BACKTEST_RESEARCH_ENABLED` 默认 `0`；只有显式设为 `1` 才启动新研究应用。
- `VITE_BACKTEST_LEGACY_WORKBENCH_ENABLED` 默认 `1`；研究入口关闭时继续启动旧 `BacktestApp`。
- 两个 flag 都关闭时显示 fail-closed 状态，不隐式选择任一 runtime。
- 合格构建使用 `VITE_BACKTEST_RESEARCH_ENABLED=1`，此时 `/backtest.html` 默认进入任务首页；回滚只需关闭 research flag 并打开 legacy flag。

## 2. URL 合同

新研究应用只接受三个互斥的 opaque ID：

- `context=brc_<id>`：读取服务端持久化的不可变 `BacktestResearchLaunchContext`；
- `run=bt_<id>`：读取现有不可变 Run、报告和 chart cache；
- `study=st_<id>`：读取现有 Study；
- 无参数：进入任务首页；
- 多个主 ID、越界字符或未知主 ID：fail closed，不猜测对象。

旧 bookmark 中合法 `run` 仍能打开同一 Run；旧 `compare` 参数不进入新 runtime，也不改变 Run。完整比较迁移属于 Phase 11。

## 3. Launch context 权威边界

- 普通图表页创建 context 时向后端提交一次不可变快照；后端生成 `brc_` ID、规范化 JSON、hash 并持久化。
- URL 只传 context ID；高级页通过 API 重新读取 context。
- context 只引用 draft/revision/run ID，不携带源码；源码仍由 Phase 3 的共享、版本化 strategy draft store 读取。
- context 保存参数、quick preset、chart session、绝对时间范围和来源 workspace/cell，避免高级页要求重新选择。
- 后端在创建 context 时确认引用的 Run 存在；revision 若不是内置 revision，则必须存在于 revision repository。

## 4. Runtime 与图表 source 所有权

- `BacktestResearchRuntime` 只跟随 `/backtest.html` 页面生命周期；不 import 或借用 chart-tester React controller/store。
- `ResearchMarketChart` 使用 `useChartSession`、`useMarketDataRuntime` 和 Phase 9 `MarketChartSurface`，创建自己的 `LIVE_REFERENCE` source。
- `FROZEN_SNAPSHOT` 与 `RUN_RESULT` 由共享平台创建离线、不可变 source；切换/卸载通过 source slot 完整 dispose。
- 实时 source 不能作为 Run 执行 identity；运行结果只在 run/config/report/chart identity 全部匹配时投影。
- 普通页和研究页不共享可变 React store；底层行情去重由既有 Host lease/stream coordinator 负责。

## 5. 五类任务与面板矩阵

| 任务 | 左侧默认面板 | 右侧默认面板 | 底部默认面板 |
| --- | --- | --- | --- |
| 精确成交验证 | 策略、数据 | 执行模型 | Run、结果 |
| 参数稳健性研究 | 策略、数据 | Study 约束 | Study、结果 |
| Python/模型测试 | 策略/Bundle | runtime receipt | Run、日志 |
| 多市场比较 | 策略、数据篮子 | 比较口径 | Run、结果 |
| 交易回放复盘 | Run/区间 | review bridge | 交易、结果 |

任务只改变面板组合；切换任务保留同一 runtime、launch context、draft、Run 和图表 source。

## 6. Phase 10 能力切面

- 首批接入：revision 列表、dataset 列表、Run 列表、Run/报告/chart 只读加载、Study 列表/指定 Study 只读加载。
- 本阶段不复制旧工作台的大表单，不自动创建 Study，不自动启动 Run，不创建回放 bridge。
- Run 创建/监控/恢复/克隆/比较/导出、Study 操作、Python/外部模型与回放复盘闭环留给 Phase 11。

## 7. 验证门

- flag-off/legacy-on 构建仍渲染旧工作台；research-on 构建渲染新 shell。
- URL parser、context repository/API、runtime reducer/source 切换、面板矩阵均有自动化测试。
- 浏览器同视口对照已有 live/replay/legacy 源截图；验证 1440×900 布局、任务切换、Run deep link、返回链接、source mode 标签和 dispose/连接诊断。
- 同时打开普通页与研究页，记录 REST/WS/Host lease 诊断；不能把“前端看起来正常”写成底层去重证明。
