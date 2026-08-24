# Backtest Chart-First Phase 10 执行证据

日期：2026-08-24

分支：`codex/backtest-chart-first-ux`

范围：独立高级研究应用、不可变 launch context、共享图表平台接入与双 flag 回滚。

## 1. 已实现合同

- `/backtest.html` 在 `VITE_BACKTEST_RESEARCH_ENABLED=1` 时启动独立 `BacktestResearchApp`；research flag 关闭且 legacy flag 打开时回到旧 `BacktestApp`，双关时 fail closed。
- URL 只接受互斥的 `context`、`run` 或 `study` opaque ID；非法、多主 ID 或未知对象不猜测恢复。
- 新增服务端持久化 `BacktestResearchLaunchContext`：规范化 payload、保存内容 hash、读取时复验；引用的 Run/revision 必须由后端确认存在。
- 高级页拥有独立 runtime 和 `LIVE_REFERENCE` source，复用 `MarketPageFrame`、`MarketWorkspaceFrame`、`MarketChartSurface`、`useChartSession` 与行情 runtime，不共享普通图表页的可变 React store。
- 任务首页提供精确成交验证、参数稳健性、Python/模型、多市场比较、交易回放复盘五个入口；切换任务只切换面板组合，保留 context、session、source 和已加载对象。
- 首批只读接入 revision、dataset、Run/report/chart cache 与 Study；Run 创建、Study 执行、比较/导出和 replay bridge 保留到 Phase 11。
- `LOCAL_OFFLINE` 下不创建 live transport，也不发 exchange catalog 请求；页面明确显示实时参考不可用。`LIVE` 下才创建 realtime lease。

## 2. 数据库与回滚

- backtest schema 由 v6 升至 v7，新增 `backtest_research_launch_contexts`。
- v7 -> v6 回滚仅允许 context 表为空时执行。
- 表内已有 context 时回滚 fail closed，schema 和全部 context 原样保留；Python bundle 的组合回滚在删除任何表前先完成两类行数预检，避免部分降级。
- research/legacy 双 flag 的浏览器回滚验证通过；现有 Run/Study 数据没有迁移或改写。

## 3. 自动化验证

| 验证 | 结果 |
| --- | --- |
| backtest 后端全量：`test_backtest_*.py` + `backtest_contract` | `237 passed, 4 warnings` |
| research context API/完整性/回滚定向测试 | 已包含在上述全量回归并通过 |
| Python bundle + release rollback 定向测试 | `43 passed, 4 warnings` |
| 前端 TypeScript | `tsc --noEmit` 两个配置通过 |
| 前端 ESLint | 全量与 Phase 10 定向检查通过 |
| 前端 production build | research-on 构建通过，`670 modules transformed` |
| 前端全量测试 | `3389 passed, 0 failed`（隔离补齐测试环境的 `@babel/core` 后） |
| `git diff --check` | 通过 |

后端 warning 均为现有 FastAPI `on_event` deprecation warning，本阶段未新增测试 warning 类型。

## 4. 真实浏览器验证

视口统一为 1440×900，使用仓库 Playwright/Chrome。源页面与实现截图在同一张对照图中检查过布局、裁切、padding、字体、边框和圆角。

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 五任务首页 | 任务卡、主导航与既有 market chrome 一致 | `output/playwright/phase10/reference-comparison.png` |
| 精确成交研究 workspace | 三栏 + 图表中心布局无裁切，沿用既有图表控件 | `output/playwright/phase10/research-workspace-comparison.png` |
| immutable Run deep link | `bt_b892...` 加载 30 K bars、`APPROXIMATE/BAR_APPROX`、交易标记与结果指标 | `output/playwright/phase10/research-run-result.png` |
| research off / legacy on | 旧工作台恢复显示 | `output/playwright/phase10/research-off-legacy-on.png` |
| LIVE launch context | `brc_ed558ba3b32242b2beea774b8168c7ee` 恢复 binance/spot/BTCUSDT/1h 与来源 workspace/cell | `output/playwright/phase10/research-live-context.png` |
| LIVE 同视口对照 | 普通图表与研究页使用相同 chart chrome/source 标签，无可见布局回归 | `output/playwright/phase10/research-live-comparison.png` |
| 任务切换 | 精确成交 -> 参数稳健性后 URL/context/session/source 不变，右侧变为 Study 约束 | 浏览器交互记录 |
| 控制台 | 最终 offline Run 与 LIVE research 新会话均为 `0 errors / 0 warnings` | Playwright console 记录 |

## 5. Host 连接观测边界

在隔离 LIVE runtime 中先打开普通页，再在同一浏览器打开相同 binance/spot/BTCUSDT/1h 的研究页：

- 研究页打开前 `/health`：`active_streams=2`、`cache_series=3`、`cache_bars=1511`；
- 研究页打开后 `/health`：`active_streams=2`、`cache_series=2`、`cache_bars=1507`；
- 浏览器存在两个逻辑 WebSocket 客户端，但后端测得的物理 active stream 数未从 2 放大。

这只证明本次受控样本中没有按页面数重复放大底层 active stream，不能外推为所有交易所/所有订阅组合的连接去重证明。测试期间 CCXT 的 exchange WebSocket 曾记录 1m、1h 和 depth stream failure，REST/cache 继续供数且前端无 console 错误；因此不把本次结果写成交易所 WS 健康证明。

## 6. 隔离与清理

- LIVE 验证使用 `output/phase10-live-runtime-20260824` 的复制数据库和本地数据，没有连接或写入生产数据目录。
- 验证完成后关闭本阶段单独启动的 LIVE backend 和 preview。
- 截图和浏览器临时文件位于 ignored `output/`，不进入提交。

## 7. 结论

Phase 10 的独立 runtime、服务端权威 launch context、三种 source mode、五任务 shell、共享图表平台和双 flag 回滚均已落地。实现满足本阶段退出标准；完整高级能力 parity、Study 生命周期和 replay review bridge 进入 Phase 11。
