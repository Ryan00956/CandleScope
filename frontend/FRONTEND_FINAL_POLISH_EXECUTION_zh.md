# CandleScope 前端最终收尾执行计划

本文定义 CandleScope 前端在主体架构已经完成后的最后一轮优化路线。

当前前端已经不需要再做大架构重构。`app -> features -> chart-adapter/shared` 的主结构已经落地，`check-architecture`、`eslint`、`vite build` 均能通过，且架构检查没有 migration allowlist。继续优化的目标不是追求目录漂亮，而是降低剩余高风险模块的维护成本，并把这份临时 frontend worktree 安全合并回主项目。

本文每个阶段只解决一个问题。除非明确写入本计划，否则不改 UI、不改后端接口、不改产品行为。

## 当前状态

已完成并应保持：

- `src/app/App.jsx` 已经是组合根，约 126 行。
- `src/App.jsx` 只 re-export app 入口。
- `src/features/*` 已按业务能力组织。
- `src/chart-adapter` 已收住 `lightweight-charts` 直接 import。
- `src/runtime` 只保留 performance instrumentation。
- `src/app/view-models/*` 已拆分 AppShell view model。
- `src/features/settings/SettingsModal.jsx` 已拆到较薄的 modal shell。
- drawing primitives 已迁入 `src/features/drawings/primitives`。
- `scripts/check-architecture.mjs` 当前通过且 allowlist 为 0。

仍值得处理：

- `src/features/drawings/drawingInteractionController.js` 仍约 1750 行，是当前最大复杂点。
- `src/components/ChartPane.jsx` 仍约 1290 行，是图表渲染核心复杂点。
- 当前验证主要是 architecture/lint/build，仍需要系统化 browser smoke 和合并前检查。

不建议继续追求：

- 不再为了“更纯”继续移动已经清楚的 feature 目录。
- 不再为减少几十行 App/Shell 代码引入全局状态库。
- 不再在没有真实渲染需求时大拆 ChartPane。

## 总体策略

优先级：

1. 先补验证基线，避免继续改代码时不知道退化在哪里。
2. 只拆 drawing controller 中最容易出错、最常变动的职责。
3. ChartPane 只做低风险 helper 抽取，不重写图表生命周期。
4. 最后做合并前检查，准备回主项目。

## 通用验证命令

在本机如果 `npm` 或 `node` 不在 PATH，使用 bundled Node：

```powershell
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\scripts\check-architecture.mjs
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\eslint\bin\eslint.js .
& 'C:\Users\MECHREVO\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\vite\bin\vite.js build
```

有后端和 Vite dev server 时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/
npm run smoke -- --url http://127.0.0.1:5173/ --drawing-check
npm run smoke -- --url http://127.0.0.1:5173/ --overlay-heavy
```

## Phase P0：冻结当前架构基线

### 修复的问题

现在架构已经接近完成，但还缺少“继续改之前的基线快照”。如果直接继续拆 drawing 或 ChartPane，很难判断后续问题是新改动造成，还是本来就存在。

### 目标

记录当前通过的验证、模块行数和剩余风险，作为后续阶段的对照基线。

### 任务

- 运行 `check-architecture`、`eslint`、`vite build`。
- 记录以下模块行数：
  - `src/features/drawings/drawingInteractionController.js`
  - `src/components/ChartPane.jsx`
  - `src/features/settings/SettingsModal.jsx`
  - `src/app/App.jsx`
  - `src/app/appShellViewModel.js`
- 如果后端可用，运行基础 smoke、drawing smoke、overlay-heavy smoke。
- 把结果追加到本文件的“执行记录”区，或写入阶段提交说明。

### 验收

- 三个静态验证命令通过。
- 有浏览器环境时，三个 smoke 命令通过。
- 当前行数和风险点被记录。

### 不做

- 不改业务代码。
- 不调整目录结构。

## Phase P1：抽出 drawing text edit lifecycle

### 修复的问题

`drawingInteractionController.js` 中 text editing 逻辑和 pointer/selection/persistence 交织在一起。文本编辑包含新建、commit、cancel、双击编辑、overlay 位置、导出前提交，是 drawing 中最容易被小改动破坏的流程之一。

### 目标

把 text edit lifecycle 从主 drawing controller 中抽出，让主 controller 只调用文本编辑 controller 的动作。

### 建议结构

```text
src/features/drawings/
  drawingTextEditController.js
```

### 任务

- 迁出以下状态：
  - `editingTextId`
  - `editingTextValue`
  - `editingTextPos`
  - `selectedTextUi` 的 text-edit 派生部分
- 迁出以下行为：
  - start text edit
  - commit text edit
  - cancel text edit
  - double-click text edit
  - export 前 commit active text edit
- controller 通过参数接收 `getPrimitiveById`、`attachPrim`、`detachPrim`、`persistDrawings`、`activeToolRef` 等必要能力。
- 保留序列化格式不变。

### 验收

- `drawingInteractionController.js` 行数下降。
- 新建 text 后点击空白处，行为不变。
- 双击已有 text 能编辑，commit/cancel 行为不变。
- 导出前 active text edit 仍会提交。
- 空文本新建后 cancel 仍会删除临时 primitive。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/ --drawing-check
```

### 不做

- 不改 TextDrawingPrimitive。
- 不改 toolbar。
- 不改 drawing storage schema。

## Phase P2：抽出 drawing selection 和 keyboard lifecycle

### 修复的问题

选择状态、toolbar style sync、Delete/Backspace/Escape 键处理仍分散在主 controller 中。这类逻辑不是 pointer 绘制本身，但会影响所有 drawing 类型。

### 目标

把 selection 和 keyboard lifecycle 独立出来，降低主 controller 对选中对象状态的直接管理。

### 建议结构

```text
src/features/drawings/
  drawingSelectionLifecycle.js
  drawingKeyboardController.js
```

### 任务

- 迁出 `selectPrimitive`、`deselectAll`、`refreshSelectedTextUi`、`selectedDrawingMeta` 更新逻辑。
- 迁出 Delete/Backspace/Escape 处理。
- 保留 toolbar style sync 语义。
- 主 controller 只保留“命中后请求 selection lifecycle 选择某个 primitive”的调用。

### 验收

- 点击选择、取消选择行为不变。
- Delete/Backspace 删除选中 drawing 行为不变。
- Escape 退出当前工具/编辑状态行为不变。
- toolbar 对选中 drawing 的颜色、线宽、文本样式同步不变。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/ --drawing-check
```

### 不做

- 不改 primitive hit-test 算法。
- 不改绘图工具列表。

## Phase P3：抽出 drawing drag/resize lifecycle

### 修复的问题

拖拽、端点 resize、shape resize、position resize 等状态仍集中在主 controller。它们与“创建 drawing”不同，应该是独立的 edit lifecycle。

### 目标

把修改已有 drawing 的 drag/resize lifecycle 从创建流程中分离。

### 建议结构

```text
src/features/drawings/
  drawingDragResizeController.js
```

### 任务

- 迁出 `draggingRef` 相关状态和分支。
- 迁出 line endpoint drag、whole-object drag、shape handle resize、text drag、position resize。
- 让 pointer controller 只负责分发 pointer event，不直接拥有所有 drag/resize 分支。
- 保留 snap 规则和 coordinate conversion 不变。

### 验收

- line endpoint 拖拽不变。
- whole line/freehand/text/shape 拖拽不变。
- rectangle/ellipse resize 不变。
- position drawing 修改不变。
- 拖拽后保存和刷新恢复不变。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/ --drawing-check
```

### 不做

- 不改 snap math。
- 不改 primitive rendering。

## Phase P4：抽出 drawing creation state machine

### 修复的问题

主 controller 仍同时处理各种 drawing 的创建流程：line、axis line、angle、shape、fibonacci、position、freehand、text。每加一个工具都会碰主 controller。

### 目标

把“创建新 drawing”的状态机独立出来，让新增 drawing 工具时只扩展 creation controller 或 primitive factory。

### 建议结构

```text
src/features/drawings/
  drawingCreationController.js
```

### 任务

- 迁出 active draft/preview primitive 的创建和清理。
- 迁出每类 tool 的 click/pointer 创建流程。
- 保留 `drawingPrimitiveFactory.js` 作为 primitive 构造入口。
- 主 controller 只负责把 pointer event、当前 tool、coordinate 转换结果传给 creation controller。

### 验收

- line、ray、infinite line 创建不变。
- horizontal/vertical/cross line 创建不变。
- angle measure 创建不变。
- rectangle/ellipse 创建不变。
- fibonacci 创建不变。
- position long/short 创建不变。
- freehand/highlighter 创建不变。
- text 创建不变。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/ --drawing-check
```

### 不做

- 不新增工具。
- 不改 serialized schema。

## Phase P5：给 drawing controller 加轻量单元测试面

### 修复的问题

drawing 的回归主要依赖 browser smoke。smoke 很重要，但无法覆盖每个 controller 的纯逻辑分支，也不适合快速定位失败原因。

### 目标

为已经拆出的纯 helper/controller 增加最小测试面，优先覆盖不依赖 DOM/canvas 的逻辑。

### 候选覆盖

- `drawingModel.js`
- `drawingPrimitiveFactory.js` 中可纯测的 option shaping
- `drawingSnapController.js` 的候选选择
- 新增的 text/selection/drag lifecycle 中可纯测的 state reducer

### 任务

- 如果当前项目没有测试 runner，先评估是否只添加纯函数测试脚本，或暂时写 smoke checklist。
- 优先把 controller 中可纯测逻辑抽成 reducer/helper。
- 测试只覆盖行为规则，不 mock Lightweight Charts。

### 验收

- 至少有一个 drawing 相关快速测试入口。
- 新测试不依赖后端。
- 测试失败能定位到具体 drawing lifecycle。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

如果新增测试脚本：

```powershell
npm run test:drawing
```

### 不做

- 不为了测试重写 drawing engine。
- 不在单元测试里启动浏览器。

## Phase P6：ChartPane 只拆低风险 overlay helpers

### 修复的问题

`ChartPane.jsx` 仍较大，但它是图表渲染核心，盲目拆分风险高。当前最值得拆的是已相对独立的 overlay rendering，而不是 chart lifecycle 本身。

### 目标

只把 marker、bgcolor、barcolor 等独立 overlay 更新逻辑迁入 chart-adapter helper。暂不拆 visible range、pane sync、main candle update。

### 建议结构

```text
src/chart-adapter/
  markerRenderer.js
  backgroundRenderer.js
  barColorRenderer.js
```

### 任务

- 每次只迁出一种 overlay。
- helper 接收 chart/series/ref/data/options，不接收业务 feature 对象。
- 保持 `recordPerfEvent` 语义不变。
- 每迁出一种 overlay 都运行 build 和 overlay-heavy smoke。

### 验收

- ChartPane 行数下降，但行为不变。
- marker 显示不变。
- bgcolor/barcolor 显示不变。
- overlay-heavy smoke 通过。

### 验证

```powershell
node ./scripts/check-architecture.mjs
node ./node_modules/eslint/bin/eslint.js .
node ./node_modules/vite/bin/vite.js build
```

有运行环境时：

```powershell
npm run smoke -- --url http://127.0.0.1:5173/ --overlay-heavy
```

### 不做

- 不重写 main candle update。
- 不改 visible range restore。
- 不改 pane sync。

## Phase P7：长时运行 smoke 和性能检查

### 修复的问题

短 build/lint 不能暴露长期 subscription churn、drawing memory、overlay 重建过频等问题。之前已有经验表明短验证可能绿，但长期行为仍有风险。

### 目标

在合并前做一轮更接近真实使用的运行验证。

### 任务

- 启动后端。
- 启动 Vite。
- 跑基础 smoke。
- 跑 drawing smoke。
- 跑 overlay-heavy smoke。
- 手动或脚本化观察：
  - 切换 symbol/interval 后旧数据是否残留。
  - 左拖加载历史后 indicator 是否补齐。
  - drawing 保存刷新是否恢复。
  - Settings lazy panel 是否能打开。
  - overlay-heavy 情况下是否有明显卡顿或报错。

### 验收

- 三个 smoke 通过。
- 浏览器 console 无新增错误。
- 没有明显 subscription 重连循环。
- 没有 drawing/export 明显退化。

### 不做

- 不在本阶段继续改架构。
- 不把性能优化和架构收尾混在一个提交里。

## Phase P8：合并回主项目前检查

### 修复的问题

这个 repo/worktree 是前端临时优化 worktree，最终要合并回主 CandleScope。合并前必须确认 diff 范围、文档入口和验证记录都清楚。

### 目标

让这份前端优化可以安全进入主项目，而不是带着不明来源的临时改动回去。

### 任务

- 检查 `git status --short`。
- 检查 diff 范围是否主要在 `frontend/`。
- 确认 README 中有以下入口：
  - 架构文档
  - rebuild 执行文档
  - hardening 执行文档
  - final polish 执行文档
- 运行静态验证。
- 条件允许时运行 smoke。
- 写清楚未完成事项：drawing controller 仍可继续拆，ChartPane 仅按需求拆。

### 验收

- diff 范围可解释。
- 文档入口完整。
- 验证命令结果清楚。
- 剩余风险清楚。

### 不做

- 不在合并前临时做大改。
- 不把 backend/package 无关改动混入前端优化总结。

## 推荐提交顺序

1. `docs(frontend): add final architecture polish plan`
2. `test(frontend): record final architecture validation baseline`
3. `refactor(frontend): extract drawing text edit lifecycle`
4. `refactor(frontend): extract drawing selection lifecycle`
5. `refactor(frontend): extract drawing drag resize lifecycle`
6. `refactor(frontend): extract drawing creation controller`
7. `test(frontend): add drawing controller regression coverage`
8. `refactor(frontend): extract chart overlay render helpers`
9. `test(frontend): run final frontend smoke checks`
10. `docs(frontend): prepare frontend merge-back summary`

## 停止条件

出现以下情况时停止继续拆分：

- drawing 拆分需要重写 primitive 类。
- drawing smoke 开始不稳定。
- ChartPane 拆分碰到 visible range 或 pane sync 退化。
- 为了减少行数引入更多跨模块依赖。
- 新 helper 只是搬代码，没有降低所有权复杂度。

## 完成定义

本计划完成后，前端收尾阶段即完成：

- drawing controller 不再是单一巨型状态机。
- drawing 的 text、selection、drag/resize、creation lifecycle 各自有明确 owner。
- ChartPane 只做低风险 helper 抽取，不破坏核心渲染。
- architecture/lint/build/smoke 均有记录。
- 合并回主项目的 diff 范围、验证结果、剩余风险都清楚。

到这一步就应该停止架构优化，转入功能开发或合并流程。

## 执行记录

### P0 基线（2026-06-01，Linux/WSL，node v24）

静态验证：

- `npm run check:architecture`：通过（`Architecture check passed (0 migration allowlist entries active).`）。
- `npm run lint`：通过，无告警。
- `npm run build`：通过（`✓ built in ~5.6s`）。

关键模块行数：

| 模块 | 行数 |
| --- | --- |
| `src/features/drawings/drawingInteractionController.js` | 1750 |
| `src/components/ChartPane.jsx` | 1290 |
| `src/features/settings/SettingsModal.jsx` | 76 |
| `src/app/App.jsx` | 126 |
| `src/app/appShellViewModel.js` | 65 |

Smoke：本次会话无后端/Vite dev server，三类 smoke 未执行，留待 P7 在运行环境补跑。

环境备注：

- 本机 `node`/`npm` 可用，直接使用 `npm run ...`；文档中 Windows PowerShell bundled-node 路径仅适用于原作者机器，可忽略。
- 既有 `drawingSelectionController.js`(103) 与 `drawingPointerController.js`(64) 已存在，P2 按“整合进既有文件”处理，避免新建重名 lifecycle 文件造成职责重叠。

### P1–P4 抽取进展（Linux/WSL，node v24）

每个阶段均为“逐字搬运 + 静态校验”，未改 UI / 后端接口 / 序列化格式；每阶段 `check:architecture` + `lint` + `build` 三项全绿、lint 无告警。

| 阶段 | 抽出文件 | 形态 | 主控制器行数 |
| --- | --- | --- | --- |
| P0 基线 | — | — | 1750 |
| P1 文本编辑生命周期 | `drawingTextEditController.js` (`useDrawingTextEdit`) | hook | 1664 |
| P2 选择 + 键盘生命周期 | `drawingSelectionController.js`(`useDrawingSelection`) + `drawingKeyboardController.js`(`useDrawingKeyboard`) | hook | 1604 |
| P3 拖拽/缩放生命周期 | `drawingDragResizeController.js`（`applyTextAndPositionDrag` / `applyLineFibShapeDrag`） | 纯函数 | 1357 |
| P4 创建状态机 | `drawingCreationController.js`（7 个创建 helper） | 纯函数 | 1199 |

要点：

- 有状态生命周期（P1 文本编辑、P2 选择）抽成 `useXxx` hook；纯指针处理逻辑（P3 拖拽、P4 创建）抽成返回 `boolean`（是否消费事件）的纯函数，避免 hook 依赖数组/闭包扰动，也规避 React Compiler 的 `react-hooks/immutability` 规则。
- P4 把 `handleMouseDown` 的 7 处创建分支（freehand 起笔、text 放置、position 放置、两点提交、轴线创建、两点首击锚点）与 `handleMouseMove` 的两点预览更新替换为 helper 调用；选择/拖拽初始化逻辑仍留在主控制器。
- 主控制器自 1750 → 1199 行（-551 / -31.5%）。


### P5 轻量单元测试面

- 项目原本无测试 runner。采用 Node v24 内置 `node:test`（零新依赖），新增 `npm run test:drawing`，入口为 `src/features/drawings/__tests__/drawingModel.test.js`。
- 覆盖 `drawingModel.js` 中不依赖 DOM/canvas 的纯逻辑：`isPassiveCursorTool` / `cursorStyleForPassiveTool` / `isFiniteNumber` / `shapeTypeFromTool` / `axisLineTypeFromTool` / `constrainShapeScreenPoint` / `resizedShapeBoxFromHandle` / `decimateScreenPoints` / `nextDrawingId`，共 9 个用例全部通过，不 mock Lightweight Charts、不依赖后端。

### P6 ChartPane overlay helper 抽取

- 把三类独立 overlay 渲染逻辑迁入 `src/chart-adapter/`，与既有 `overlaySeriesRenderer.js`（hline/fill）保持同一模式：
  - `markerRenderer.js` — `renderMarkers` + `flattenIndicatorMarkers`
  - `barColorRenderer.js` — `applyBarColors`（`toCandlePoint` / `canUseTrailingCandleUpdate` 作为参数注入，避免改动 ChartPane 其它调用点）
  - `bgcolorRenderer.js` — `renderBgcolorOverlay`（返回 effect cleanup）
- helper 只接收 chart/series/ref/data/options，不接收业务 feature 对象；`recordPerfEvent` 事件名与字段保持完全不变。
- 未触碰 main candle update / visible range restore / pane sync。
- `ChartPane.jsx` 自 1290 → 1063 行（-227）。

### 静态验证（P0–P6 收尾）

- `npm run check:architecture`：通过（0 allowlist）。
- `npm run lint`：通过，0 告警。
- `npm run build`：通过。
- `npm run test:drawing`：9/9 通过。

### P7 / P8 未执行说明

- P7 长时 smoke / 性能：`scripts/smoke.mjs` 需要本地 Chrome/Edge 可执行文件 + 运行中的 Vite dev server 与后端指标服务。本会话环境无浏览器、无后端，故未执行，留待具备运行环境时按文档命令补跑。
- P8 合并前检查：当前目录为损坏的 git worktree（`H:/program/CandleScope/.git/...`，WSL 路径无法解析），git 命令不可用。已用上述四项静态检查 + 单测作为合并就绪证据；正式合并前请在可用 git 环境重跑 check:architecture / lint / build / smoke。
