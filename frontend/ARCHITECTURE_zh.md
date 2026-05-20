# CandleScope 前端架构

本文记录当前前端架构目标、已经完成的重构，以及后续优化路线。

## 目标

- 让 `App.jsx` 成为组合根，而不是所有数据、流、偏好和工作流逻辑的所有者。
- 渲染组件放在 `src/components`，后端客户端放在 `src/services`，编排和运行时 hook 放在 `src/runtime`。
- 让 K 线加载、指标更新、WebSocket、缺口恢复和用户工作流可以分别理解、验证和维护。
- 让本地开发在 `localhost` 和 `127.0.0.1` 入口下都稳定。
- 通过懒加载首屏不需要的面板，降低初始 JavaScript 成本。

## 当前 Runtime 边界

`src/runtime` 按所有权分组：

| 分组 | 所有权 |
|---|---|
| `chart/` | 图表数据缓存、可见范围恢复、首屏历史加载、左侧分页、缺口恢复、图表展示派生状态 |
| `streams/` | K 线 WebSocket runtime、后端 backfill completion 处理 |
| `exchange/` | 交易所能力目录和周期元数据 |
| `preferences/` | 本地或后端同步的用户偏好 |
| `workflows/` | 导出、绘图、自定义周期、周期提示、自选列表等用户工作流 |

包内边界规则见 [src/runtime/README.md](src/runtime/README.md)。

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
| React、Lightweight Charts、editor、export 库的构建期 vendor chunk | 已完成 |

## 验证基线

前端架构改动后至少运行：

```bash
cd frontend
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

- 绘图 primitives 要单独评估后再懒加载 drawing engine，因为它挂在当前图表 pane 上，
  对图表交互的影响比侧边面板更直接。
- 如果用户反馈 symbol search、watchlist、drawing tools 或 settings 首次点击有延迟，
  再增加交互预加载。
- 当前端 runtime 边界变化时，同步更新顶层 README 和本文档。
