# Chart-first 回测 Phase 4 实施计划（2026-08-24）

## 视觉目标与范围

本阶段严格实现 Phase 0 已获批准的同视口视觉合同中的“首次打开”和“脚本出错”，并建立脚本、
概览、交易、设置四个标签的普通模式外壳。目标源为：

- `docs/assets/backtest-chart-first-phase0/visual-first-1440x900.png`
- `docs/assets/backtest-chart-first-phase0/visual-error-1440x900.png`

运行完成和 stale 的真实结果、ResultContextBar、指标与图上标记由 Phase 6 实现；Phase 4 不伪造
BacktestRun。一个“运行”按钮和 `Ctrl/Cmd+Enter` 只进入同一 typed run-request 边界并先执行轻量
诊断，Phase 5 再把该边界串到 revision、chart context、validate 和 create。

参考稿中的背景 K 线由现有 `LiveChartCell` 真实渲染，不复制截图；脚本面板没有需要生成的新位图
资产。字体沿用仓库已有 Inter / JetBrains Mono，颜色、间距、圆角和边框沿用现有 token。

## 已审计边界

- `MarketWorkspaceFrame` 目前是 toolbar、chart、right rail 三段横向所有者；bottom panel 必须进入
  toolbar 右侧的内容列，以 flex 布局减少图表高度，不能使用 fixed overlay。
- active `LiveChartCell` 已独占 TopBar、interval、toolbar、right rail、feature surfaces 和 status bar
  portal；策略入口与底部业务视图也应由同一 active cell 提供，避免 App 持有脚本业务状态。
- workspace runtime 缺少 attachment 更新 action；新增 action 只更新指定 cell，不走 link group。
- Phase 3 runtime factory 已以 `workspaceId + cellId` 隔离。已附着 cell 保留轻量 runtime；未附着
  cell 只有在用户打开策略面板时才创建，关闭后立即释放。
- `@monaco-editor/react`、Pyne/Pine language support 和主题已存在。整个 bridge 使用 dynamic import，
  Monaco 再位于第二层 lazy boundary；首开三入口不会请求 editor chunk。
- `StrategyDraftStore` 已与 workspace 分离，但需要增加 fail-closed recent-list 能力，才能实现“打开
  最近脚本”；workspace 仍只保存 draft ID，不保存源码。
- Phase 0 参考 panel 在 1440x900 为 1036x383。生产实现使用右 rail 前的全部可用宽度，默认高度
  约 42vh，并限制在 260–520 px；1366x768 保留完整 header、主操作和可用图表区域。

## 实施顺序

1. 为 `MarketWorkspaceFrame` 增加 nullable `bottomPanel` slot 与内容列，补 source-neutral DOM test。
2. App 只持有 panel open/close 和 portal host；flag off 时不渲染入口、host 或 bridge。
3. 为 workspace runtime 增加 cell-local `updateCellStrategyAttachment` action 与隔离测试。
4. 扩展 draft adapter/store 的 recent list；损坏记录跳过，按 updatedAt 降序并限制数量。
5. 新增纯 UI model：三模板、开始入口、轻量诊断、保存/入口状态文案和禁止内部术语检查。
6. 新增 lazy `ChartStrategyTesterCellBridge`：激活/释放 Phase 3 runtime，加载/订阅 draft，向 active
   cell 的 bottom-panel portal 提供视图。
7. 新增 `ChartStrategyTesterPanel`：四标签、三入口、模板选择、最近脚本、粘贴空草稿、返回、关闭、
   高级研究入口、placeholder、可调高度和键盘/焦点合同。
8. 用户选定脚本后才 lazy load `StrategyScriptWorkspace` 与 Monaco；恢复 source/language/cursor，防抖
   自动保存，保存失败保留内存草稿并允许重试。
9. 背景/点击运行使用同一诊断函数；错误定位 line/column、问题列表和 Monaco marker，不清空草稿。
10. 增加中英文文案、CSS、组件/纯函数/静态 import tests；再执行真实浏览器首开、模板、粘贴、
    自动保存、报错、快捷键、切 cell、四图、最大化、resize、1366x768 和 flag-off 检查。
11. 使用相同视口对批准稿与产品截图做 design QA；P0/P1/P2 清零后才提交。

## 非目标

- 不创建 StrategyRevision 或 BacktestRun，不 resolve/materialize 数据，不轮询报告。
- 不实现完成/stale 指标、交易列表、ResultContextBar 或 chart marker source。
- 不读取系统剪贴板，不在普通 DOM 暴露 dataset、snapshot、revision ID、Run ID 或账户模型。
- 不改 legacy `/backtest.html`，不启用默认 flag，不 push、merge 或 deploy。

## 退出门禁

- flag off 的 live DOM、runtime 实例和已加载 chunk 回到 Phase 3 基线。
- 首次打开准确呈现三入口且 Monaco 未加载；选择后 editor 才加载并恢复草稿/光标。
- 自动保存成功、失败、重试与 recent list 有测试；源码不进入 workspace。
- 点击运行与 `Ctrl/Cmd+Enter` 走同一 request；错误精确定位且草稿保留。
- 单图、四图、active cell、最大化、resize 和 1366x768 浏览器走查通过。
- 普通模式只有一个主操作“运行”，DOM 不出现内部对象操作。
- `design-qa.md` 最终为 passed；自动化、typecheck、architecture、i18n、lint、build 全通过。
