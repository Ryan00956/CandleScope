# 绘图引擎懒加载设计

## 目标

把原生绘图引擎从首屏图表渲染链路里移出去，同时保持现在
`ChartPane` 和 `MultiPaneChart` 的行为不变。首根 K 线绘制不应该为绘图
primitive 付出成本，除非当前图表确实有已保存绘图，或者用户主动进入绘图
流程。

建议边界：

```txt
ChartPane
  -> DrawingController
      -> noop controller
      -> loading controller
      -> real useDrawing engine
```

`ChartPane` 保持原来的渲染和 imperative contract，controller 负责决定当前
绘图能力是空实现、加载中，还是完整引擎已就绪。

## 当前结构

- `ChartPane.jsx` 直接 import `useDrawing`，所以每个 pane 都会把完整 hook
  和所有 primitive 类带进活动模块图。
- `useDrawing.js` 直接 import 所有 primitive：
  `LineDrawingPrimitive`、`FreehandDrawingPrimitive`、`TextDrawingPrimitive`、
  `FibonacciDrawingPrimitive`、`PositionDrawingPrimitive`、
  `ShapeDrawingPrimitive`、`AxisLineDrawingPrimitive`、
  `AngleMeasurementPrimitive`。
- `MultiPaneChart` 会向各个 pane 转发这些 imperative 方法：
  `clearAllDrawings`、`setDrawingsHidden`、`updateSelectedDrawingStyle`、
  `prepareExport`、`getExportSnapshot`。
- 主图绘图 key 是 `drawingKeyBase || symbol`。
- 子窗格绘图 key 是 `${drawingKeyBase || symbol}__${paneId}`，并且要等第一条
  指标 series 出现以后才能作为绘图 anchor。
- 导出会先调用 `prepareExport()`，确保正在编辑的文本能提交到 canvas 再截图。

## Controller 合同

controller 必须暴露当前 `useDrawing` 的全部返回字段：

| 字段 | 空实现行为 | 加载中行为 | 完整引擎行为 |
|---|---|---|---|
| `clearAll` | 清掉当前 pane 的持久化绘图，不处理 attached primitives | 允许清 storage，并尽量取消 pending load | 现有 `useDrawing.clearAll` |
| `setHidden` | 本地记录 hidden 状态 | 本地记录，加载完成后回放 | 现有 `useDrawing.setHidden` |
| `primitivesRef` | 稳定 ref，内容为空数组 | 稳定 ref，加载完成前为空数组 | 现有 primitive ref |
| `selectedPrimId` | `null` | `null` | 现有选中 id |
| `selectedDrawingMeta` | `null` | `null` | 现有选中绘图元数据 |
| `editingTextId` | `null` | `null` | 现有文本编辑 id |
| `editingTextValue` | 空字符串 | 空字符串 | 现有文本编辑值 |
| `editingTextPos` | `null` | `null` | 现有文本编辑位置 |
| `setEditingTextValue` | 稳定 no-op | 加载完成前稳定 no-op | 现有 setter |
| `commitTextEditing` | 返回 `false` | 加载完成前返回 `false` | 现有提交函数 |
| `cancelTextEditing` | 稳定 no-op | 加载完成前稳定 no-op | 现有取消函数 |
| `editInputRef` | 稳定 ref，值为 `null` | 稳定 ref，值为 `null` | 现有 input ref |
| `selectedTextSnapshot` | `null` | `null` | 现有选中文本快照 |
| `selectedTextBox` | `null` | `null` | 现有选中文本框 |
| `updateSelectedText` | 稳定 no-op | 加载完成前稳定 no-op | 现有文本样式更新 |
| `updateSelectedDrawingStyle` | 稳定 no-op | 加载完成前稳定 no-op | 现有绘图样式更新 |
| `deleteSelected` | 稳定 no-op | 加载完成前稳定 no-op | 现有删除选中 |

这样 `ChartPane` 里 `TextEditOverlay` 和 `TextFormatBar` 的条件渲染不用改；
引擎不存在时它们只会拿到 null 编辑态和 null 选中态。

## 加载触发条件

出现任一条件时加载完整绘图引擎：

1. 当前 pane 的绘图 key 在 localStorage 里有已保存绘图。
2. 当前 active tool 是绘图或编辑工具，而不是被动 cursor。
3. 某个绘图相关 imperative 调用需要真实状态：
   `updateSelectedDrawingStyle`、带保存绘图的 `prepareExport`、或者绘图可见且
   已知存在保存绘图的导出。
4. 用户打开了必须检查或编辑已有绘图的流程。

这些被动 cursor 不应该单独触发加载：

- `cursor-default`
- `cursor-crosshair`
- `cursor-dot`
- `cursor-highlighter`
- `cursor-plain`

这些工具应该触发加载：

- `pen`
- `highlighter`
- `eraser`
- line tools
- shape tools
- `text`
- `fibonacci`
- position tools
- angle measurement

## 已保存绘图检测

实现前先给 storage 增加轻量 helper：

```js
hasSavedDrawings(symbolKey): boolean
```

它只读取和解析当前 localStorage key：`candlescope-drawings-${symbolKey}`。
它不能 import primitive 类。

`ChartPane` 在创建 controller 之前就能算出 pane drawing key：

- 主图：`drawingKeyBase || symbol`
- 子窗格：`${drawingKeyBase || symbol}__${paneId}`

controller 用 `hasSavedDrawings(paneDrawingKey)` 作为早期加载信号。这样刷新后
保存的绘图不会消失，但空图表仍然可以避开重引擎。

## 加载中状态

完整引擎 chunk 加载期间：

- 工具栏选中的工具仍然保存在 app state 里。
- chart cursor/crosshair 行为继续由 `drawingTool` 驱动，和现在一致。
- 不 attach 占位 primitive。
- 没有真实选中对象前，忽略样式编辑。
- 如果用户在引擎就绪前开始绘图手势，不创建半成品绘图。第一次真实绘图交互
  应该等引擎 resolve 后再开始。

第一版实现可以只在用户主动选择绘图工具时显示短暂的图内或工具栏 loading；
因为保存绘图恢复触发的加载可以静默完成。

## 导出行为

`prepareExport()` 必须继续在截图前提交正在编辑的文本。

规则：

- controller 是空实现且 `hasSavedDrawings` 为 false 时，`prepareExport` 是 no-op，
  导出可以继续。
- 如果存在已保存绘图但引擎还没加载，导出生成截图前应该触发或等待引擎加载。
- 如果引擎正因绘图工具激活而加载，导出应该等待加载结束，或者走现有导出错误
  提示路径。
- `hideDrawings` 仍然通过 `MultiPaneChart` 调 `setDrawingsHidden`；hidden 状态
  要在完整引擎加载后回放。

## 文本编辑

文本编辑完全属于完整引擎。

- 空实现和加载中 controller 返回 null 文本编辑态。
- `commitTextEditing()` 在完整引擎就绪前返回 `false`。
- 如果导出触发时正在文本编辑，完整 controller 必须已经可用，并且
  `prepareExport()` 必须调用现有提交路径。

这可以保持现在的导出行为，同时不强迫 text primitive 进入首屏链路。

## 子窗格差异

子窗格绘图有不同的持久化 key 和更晚的 anchor：

- 持久化 key：`${drawingKeyBase || symbol}__${paneId}`
- anchor series：第一条指标 series，而不是 K 线 series

懒加载 controller 不应该在下面两个条件同时满足前实例化子窗格完整引擎：

1. 当前 pane 因为保存绘图或 active drawing tool 需要绘图能力。
2. 绘图 anchor series 已经 ready。

子窗格被移除时，`MultiPaneChart` 继续按现在逻辑清掉 orphaned storage key。

## 实现顺序

1. 给 `drawingStorage.js` 增加 `hasSavedDrawings()`。
2. 把当前 `useDrawing` 放到可动态 import 的真实引擎模块后面，但不改变它的
   public return shape。
3. 增加 `useDrawingController`，作为 `ChartPane` 使用的 adapter。
4. 用 controller 替换 `ChartPane` 对 `useDrawing` 的直接 import。
5. 开启懒加载前补 smoke 覆盖：
   - 没有保存绘图时图表正常加载
   - 激活 line tool 会加载真实引擎
   - 保存绘图刷新后可以恢复
   - 文本编辑后导出仍会调用 `prepareExport`
6. 这些检查通过后，再把 primitive 模块切进 lazy chunk。

## 风险

- React hooks 不能条件调用。真实 hook 必须放在 lazy 模块加载后才 mount 的组件
  或 adapter 层里。
- `useDrawing` 当前拥有 DOM event listeners。第一次绘图手势被处理前，引擎
  必须加载完成。
- 导出预览本来是异步的，但现在假设 `prepareExport()` 是同步的。等待引擎加载
  可能需要给导出 runtime 加一个很小的 async preparation step。
- 子窗格 anchor 在指标 series 创建后才有；如果 controller 忽略 `seriesReady`，
  保存绘图恢复可能会竞态。
- 已有 primitive 持久化格式必须保持不变。

## 结论

先实现 controller 边界，再在 smoke 保护下懒加载真实引擎。不要第一步就直接
拆 primitive 文件；那样虽然可能降 chunk size，但会把生命周期风险继续藏在
`ChartPane` 里。
