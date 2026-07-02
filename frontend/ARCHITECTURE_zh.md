# CandleScope 前端架构

本文记录当前前端架构目标、已经完成的重构，以及后续优化路线。

下一阶段逐步执行方案见
[前端优化执行文档](OPTIMIZATION_EXECUTION_zh.md)。
当前阶段审查和推荐后续工作见
[前端优化阶段审查](OPTIMIZATION_PHASE_REVIEW_zh.md)。

## 目标

- 让 `src/app/App.jsx` 成为组合根，而不是所有数据、流、偏好和工作流逻辑的所有者。
- 让 `src/features/*` 按业务能力拥有状态、runtime、storage、controller 和 feature UI 入口。
- 让 `src/runtime` 不再承载业务所有权，只保留跨应用性能 instrumentation。
- 让 K 线加载、指标更新、WebSocket、缺口恢复和用户工作流可以按 feature 分别理解、验证和维护。
- 让本地开发在 `localhost` 和 `127.0.0.1` 入口下都稳定。
- 通过懒加载首屏不需要的面板，降低初始 JavaScript 成本。

## 当前所有权边界

Phase 10 后，`src/app` 拥有应用组合根和 Shell。Phase 11 后，原先在
`src/hooks` 和 `src/runtime` 中的业务 runtime 已迁入对应 feature。

`src/features` 按业务能力分组：

| 分组 | 所有权 |
|---|---|
| `chart-session/` | 当前 symbol、exchange、market type、interval、dataset key、自定义周期、交易所 capability、可见范围存储 |
| `market-data/` | K 线 `SeriesDataFeed`、有界 `SeriesWindowStore`、delta 渲染输入、首屏历史加载、左侧分页、backfill completion、K 线 WebSocket、背景预取、gap recovery、header 行情展示状态 |
| `indicators/` | active indicators、计算调度、hosted indicator WebSocket、输出 reducer、pane projection、catalog 和 Pyne 安全策略 |
| `drawings/` | 绘图工具状态、primitive 交互、选择、snap、持久化、lazy drawing engine host |
| `watchlist/` | 自选列表、侧栏布局、订阅层级、watchlist price stream |
| `symbol-search/` | symbol catalog、收藏、搜索过滤、modal interaction |
| `settings/` | 图表外观、代理、交易所刷新、cache limit、维护动作、数据库工具面板 |
| `export/` | 导出选项、预览、导出服务和导出前绘图提交协作 |

`src/runtime` 仅保留 app-wide performance marks，规则见
[src/runtime/README.md](src/runtime/README.md)。Feature 边界规则见
[src/features/README.md](src/features/README.md)。

## 后端连接

前端默认使用同源 `/api/v1`。在 Vite 本地开发时，`vite.config.js` 会把
`/api` 的 HTTP 和 WebSocket 请求代理到 `http://localhost:8000`。

这样可以避免一种假故障：页面从 `http://127.0.0.1:5173` 打开，但浏览器
CORS 阻止访问 `http://localhost:8000`，导致 K 线 HTTP 请求失败。

只有在后端不能通过 Vite proxy 访问时，才需要设置 `VITE_API_BASE`。

## 已完成

| 模块 | 状态 |
|---|---|
| 图表数据 runtime 抽取 | 已完成 |
| 首屏历史加载 runtime 抽取 | 已完成 |
| K 线 WebSocket runtime 抽取 | 已完成 |
| Backfill completion runtime 抽取 | 已完成 |
| Gap recovery runtime 抽取 | 已完成 |
| 背景预取 runtime 抽取 | 已完成 |
| Watchlist runtime 和存储抽取 | 已完成 |
| 绘图、导出、设置、价格轴、自定义周期工作流抽取 | 已完成 |
| Runtime 目录分组和边界文档 | 已完成 |
| Vite `/api` proxy 和可配置 API base | 已完成 |
| Settings、Indicators、Alerts、Export 面板懒加载拆包 | 已完成 |
| Symbol search modal、watchlist sidebar、drawing toolbar 懒加载拆包 | 已完成 |
| active/saved drawing workflow 的 lazy drawing engine host | 已完成 |
| 前端性能 marks 和 smoke timing report | 已完成 |
| K 线优先于指标和后台任务的首屏加载 | 已完成 |
| 保守的 chart series 尾部增量更新路径 | 已完成 |
| K 线窗口预算、feed 收敛、delta 渲染、指标窗口化和乐观切换 | 已完成 |
| `check:architecture` 迁移 allowlist 清零 | 已完成 |
| symbol search 和 Settings 的意图预加载 | 已完成 |
| React、Lightweight Charts、editor、export 库的构建期 vendor chunk | 已完成 |
| Phase 10 app shell 和 lazy surfaces 迁入 `src/app` | 已完成 |
| Phase 11 清理 `src/hooks` 和业务 `src/runtime` 迁移期入口 | 已完成 |

## 验证基线

前端架构改动后至少运行：

```bash
cd frontend
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

浏览器 smoke 验证：

1. 启动后端到 `http://localhost:8000`。
2. 启动 Vite 到 `5173`。
3. 运行仓库内 smoke 检查：

   ```bash
   npm run smoke -- --url http://127.0.0.1:5173/
   ```

   该检查会确认页面达到 `Connected to Binance`、非零 `bars`、
   `Live (WebSocket)`，确认 drawing toolbar 已加载，并确认懒加载的
   symbol search 和 Settings 面板可以打开。

Windows 下如果后端启动日志因为控制台编码失败，可用 UTF-8 输出启动：

```powershell
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

## 剩余工作

- 收紧 lazy surface 的 smoke timing 粒度；当前浏览器 smoke 循环对产品验证是安全的，
  但有 500 ms 的粗轮询下限。
- 继续以实测为依据优化 fills、markers、hlines 和 overlays 的图表渲染成本。
- `SingleChartPanes` 内部简化继续以证据驱动。它仍然是最密集的图表模块，但
  Lightweight Charts 写操作应继续经 `chart-adapter`。
- 当本地 smoke 数字稳定到适合跨机器比较后，可以考虑把性能预算报告接入 CI。
- 继续把仍留在 `src/components` 的 feature UI 实现逐步迁入对应 feature，避免只为了目录整齐而移动仍不稳定的代码。
- 当前端 feature 边界变化时，同步更新顶层 README 和本文档。
