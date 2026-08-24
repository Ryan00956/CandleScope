# Backtest Chart-First Phase 6 执行计划（2026-08-24）

## 阶段边界

- 只实现执行文档 Phase 6：把已完成 Run 的结果投影回当前图表工作区。
- 不提前实现 Phase 7 的多 Run 对比、参数扫描或研究编排。
- `VITE_BACKTEST_CHART_STRATEGY_TESTER_ENABLED` 继续默认关闭；不推送、不合并、不部署、不修改生产数据。

## 仓库复用结论

- 复用 `BacktestResultChart` 的权益曲线和成交标记投影纯函数，不另建图表引擎。
- 复用 `ExternalMarkerSource` 接入当前 `ChartCellCanvas`；新增来源仍按 cell 隔离，并与成交流、插件标记合并。
- 复用 `ChartSurfaceActions` 定位交易时间；不跳转到独立回测页完成主结果查看。
- 复用现有图表策略 Runtime 的 generation 与 result identity；输入变化时在布局提交阶段隐藏旧标记，同时保留旧结果上下文并明确标为过期。

## 实现契约

1. 后端 `/runs/{run_id}/chart` 返回稳定 `chart_hash`；前端结果缓存键固定为 `run_id + report_hash + chart_hash`，并校验 Run、Report、Chart 三者身份一致。
2. 已完成结果以 `ResultContextBar` 固定显示：标的、周期、绝对时间范围、范围语义、精度、手续费来源/费率与 Run 身份。`ALL_AVAILABLE` 只称“全部本地可用数据”。
3. 概览页显示可信度、核心指标与权益/回撤曲线；零交易、空曲线、报告缺失和加载失败均有独立说明。
4. 交易页用固定行高虚拟列表承载 100,000 行；点击一行只定位所属 cell 的当前图表。
5. 回测标记源只发布可视时间区间加 overscan 内的标记，并设置确定性上限；上下文变化同一帧清空。
6. 面板高度与活动标签页按 `workspaceId + cellId` 保存；结果对象只留在所属 Runtime/cell，不随布局复制。
7. 高级研究链接携带 `run` 查询参数，独立回测页按该参数选中对应 Run。
8. 截图导出契约保持确定：现有图表截图只捕获图表 surface，不包含 portal 中的策略测试器底部面板；用单元测试和浏览器对照证明。

## 验证与证据

- 单元/组件：缓存身份、chart hash、旧结果隐藏、可视区标记、100k 虚拟列表、单元格隔离、面板恢复、深链与空状态。
- 回归：backtest 专项、完整前端测试、类型检查、lint、architecture、i18n、默认关/显式开构建、相关后端测试。
- 浏览器：仓库内 Playwright CLI + headed Chrome；真实隔离本地后端 Run，1440×900 与 1366×768，完成态/过期态/交易定位/四图隔离/缩放。
- 视觉：把 Phase 0 完成态和过期态源图与 Phase 6 实现截图放在同一比较输入后检查并修正。
- 最终证据写入 `docs/evidence/backtest-chart-first-phase6/`、Phase 6 结果 Markdown 和机器可读 JSON，再做窄提交。
