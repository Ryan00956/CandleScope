# Backtest Chart-first Phase 4 行情页脚本工作区结果（2026-08-24）

## 结论

Phase 4 状态为 `COMPLETE`。默认关闭的 `VITE_CHART_STRATEGY_TESTER_ENABLED` 后已接入活动图表独占的
顶部“策略”入口和 App shell 所有的可调高度 bottom panel。用户第一次打开只看到“使用策略模板、打开
最近脚本、粘贴已有代码”三个入口；选定脚本后才加载 `StrategyScriptWorkspace`、Monaco 和编辑器 vendor
chunk。普通路径没有暴露 dataset、snapshot、revision 或 Run ID，也没有新增“检查/保存”主按钮。

脚本工作区提供防抖自动保存、光标恢复、保存失败重试、轻量诊断、行列定位、四个标签、
`Ctrl/Cmd+Enter` 与 Run 等价、Escape/Close 焦点返回、指针和键盘面板缩放。Phase 4 的“运行”只发出
typed request 并进入 READY 边界，不伪造 revision、Run 或完成结果；真实 materialize/validate/create
属于 Phase 5。

仓库本地 headed Chrome 已完成单图、四图、最大化、1366 x 768、flag-off、保存失败和同视口设计 QA。
最终控制台为 0 error / 0 warning，`design-qa.md` 为 `passed`。未 push、merge、deploy，主工作树中的用户
改动保持原样。

## 产品表面与所有权

- `TopBar.identityAccessory` 把“策略”放在品种身份后，只有活动 cell 向 top-bar portal 提供入口。
- `MarketWorkspaceFrame.bottomPanel` 是 flex 布局内的 App shell slot，不使用 fixed overlay，不遮挡 K 线时间轴。
- `LiveChartCell` 只在 flag 开启且 cell 已附着，或活动 cell 明确打开面板时 lazy load bridge。
- 四图中切换 active cell 只切换顶部入口与底部面板归属；cell-2、cell-3 的附着和草稿没有写入其他 cell。
- 最大化 cell 后入口、panel context 与 chart session 均继续绑定被最大化的 cell。
- Close 与 Escape 在 React top-bar portal 重挂载后定位当前 cell 的稳定入口并恢复焦点。

## 三种开始方式、草稿和编辑器

- 首次打开准确呈现三个开始入口、简短说明和“在高级研究中打开”，没有空白 Monaco 或 Run 按钮。
- 内置 SMA、RSI、Donchian 三个 Pyne 模板；最近脚本按更新时间倒序且有界，畸形存储行被忽略。
- 粘贴入口创建空的“未命名策略”并主动聚焦编辑器，不读取系统剪贴板。
- source、language、cursor、revision 和 save state 保持在独立 `StrategyDraftStore`，workspace 只保存轻量 attachment。
- 防抖保存失败时 newer in-memory draft 不会被 older durable row 覆盖；UI 显示失败和“重试”，恢复写入后转为已保存。
- Vite manualChunks 先识别 Monaco/`@monaco-editor` 再识别 React，避免 `vendor-react` 反向预加载 editor。
- Monaco 快捷键使用 editor action；`Ctrl/Cmd+Enter` 不向源码插入换行，并通过 effect 保持最新 Run callback。

## 诊断与诚实边界

- 后台轻量诊断与点击 Run 使用同一纯函数；字符串和注释中的策略样文本不会产生假问题。
- 批准错误例 `target_position(targetQty)` 定位为第 8 行、第 19 列，同时显示 Monaco marker、问题说明和定位动作。
- 选择问题会聚焦并 reveal 错误行；刷新后恢复 source 与 line 8 / column 19 cursor。
- 错误不清空草稿；修复为固定值后 Run 与 `Ctrl/Cmd+Enter` 都进入“已就绪”，问题面板显示可运行。
- 概览、交易和设置是明确的 Phase 4 占位文案，没有伪造指标、交易、参数提交或成功结果。
- 浏览器网络记录中点击 Phase 4 Run 没有 revision、runs 或 `/backtests` 创建请求。

## 浏览器与视觉证据

浏览器为仓库本地 Playwright CLI 驱动的 headed Chrome，页面为 flag-on 生产 build，经 Vite preview 代理到
真实 `127.0.0.1:18080` backend；图表加载 1,500+ 根实时 BTCUSDT K 线。

| 场景 | 结果 |
| --- | --- |
| 首次打开 1440 x 900 | PASS；三个入口可见，Monaco/editor 资源为 0 |
| 模板 -> 编辑器 | PASS；选择实际模板后才加载 StrategyScriptWorkspace、vendor-editor 和 Monaco |
| 最近脚本 | PASS；未附着 cell 可列出并显式打开已有 SMA 草稿 |
| 粘贴已有代码 | PASS；空编辑器获焦，手动输入后 source 持久化 |
| 自动保存/光标恢复 | PASS；reload 后恢复源码与 line 8 / column 19 |
| 保存失败/重试 | PASS；QuotaExceeded 模拟失败、内存草稿保留、重试后成功持久化 |
| Run / Ctrl+Enter | PASS；两者等价，快捷键不修改 source |
| panel resize | PASS；pointer 383 -> 471 px；键盘每次 16 px，边界 240–520 px |
| Close / Escape | PASS；两种路径都把焦点还给活动 cell 的策略入口 |
| 四图/最大化 | PASS；4 cells、活动归属、独立 attachment 与最大化 context 正确 |
| 1366 x 768 | PASS；document 无横纵 overflow，chart 与 Close 可见 |
| flag off | PASS；0 入口、0 panel、0 tester/editor 初始资源 |
| 控制台 | PASS；0 error、0 warning |

批准源图和最终 browser capture 已在同一输入中比较：

- [首次打开实现图](backtest-chart-first-phase4/phase4-first-open-1440x900.png)
- [脚本错误实现图](backtest-chart-first-phase4/phase4-script-error-1440x900.png)
- [1366 x 768 实现图](backtest-chart-first-phase4/phase4-first-open-1366x768.png)
- [首次打开源图/实现并排](backtest-chart-first-phase4/qa-first-source-vs-implementation.png)
- [错误态源图/实现并排](backtest-chart-first-phase4/qa-error-source-vs-implementation.png)

同视口比较未留下可执行 P0/P1/P2 视觉问题。实时 bars、price 和 order-book 状态与冻结源图不同；Monaco
生产语法着色和 overview-ruler marker 比静态视觉稿更完整，这些差异不改变 Phase 4 信息层级或几何。

## 自动化证据

| 验证 | 结果 |
| --- | --- |
| Phase 4 feature 定向测试 | PASS，2 tests，0 fail |
| `npm run test:backtest` | PASS，62 tests / 3 suites，0 fail，518 ms |
| `npm test` | PASS，3,339 tests / 3 suites，0 fail，最终代码复跑 116.17 s |
| `npm run typecheck` | PASS |
| `npm run check:architecture` | PASS，0 migration allowlist entries |
| `npm run check:i18n` | PASS，3,628 keys / 601 source files |
| `npm run lint` | PASS，全仓 ESLint |
| 默认 flag-off `npm run build` | PASS，640 modules；保留既有 >500 kB chunk warning |
| flag-on `npm run build` | PASS，640 modules；live 536.35 kB raw / 155.66 kB gzip |
| `git diff --check` | PASS |

flag-on build 中 bridge 为 26.67 kB raw / 8.39 kB gzip，editor workspace 为 2.27 kB raw /
1.15 kB gzip，vendor-editor 为 11.42 kB raw / 4.35 kB gzip。它们会存在于产物图中，但 flag-off 首屏
不会请求；flag-on 首次打开也不会请求 Monaco/editor，直到用户选择真实脚本。

## 已处理的非通过尝试

1. 首轮生产网络检查发现 `vendor-editor` 被首页 preload。根因是 manualChunks 先匹配通用 `react`，把
   `@monaco-editor/react` 归入 React chunk；调整匹配顺序并加入 regression 后，初始请求恢复为 0。
2. 首轮 `Ctrl+Enter` 被 Monaco 消费并插入换行；接入 Monaco editor action 后又发现 action 持有旧
   callback。改为 ref + effect 后，同一快捷键不改 source 且进入 READY。
3. Close/Escape 首轮焦点落到 `body`。根因是 top-bar portal 在 panel state change 后重挂载，旧 ref 已失效；
   改用 cell-id 稳定入口在 commit 后恢复焦点，两条路径均通过。
4. 首轮全仓 lint 拒绝 render 期间同步写 `onRunRef.current`；改为 effect 同步后 lint、typecheck、定向和
   浏览器快捷键回归均通过。没有关闭规则或放宽产品合同。

## 退出标准与回滚

- 不进入 `/backtest.html` 即可开始、编辑并触发 typed Run request：PASS。
- 主路径只有一个“运行”主操作，普通 DOM 不出现内部对象：PASS。
- 首屏主要操作恰为三个，Monaco 按需加载：PASS。
- 单图、四图、最大化、键盘、保存失败和 compact viewport：PASS。
- 关闭 `VITE_CHART_STRATEGY_TESTER_ENABLED` 后 top-bar accessory 与 bottomPanel 渲染 `null`，普通行情页
  恢复原布局；不需要删除 schema 8 attachment 或草稿数据。

Phase 5 尚未开始。
