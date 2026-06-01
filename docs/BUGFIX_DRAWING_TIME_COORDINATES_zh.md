# 画图工具时间轴坐标 Bug 修复文档

本文记录 CandleScope 前端画图工具在右侧未来空白区跑偏的问题根因、修复方案与验证清单。

状态：待修复。本文档只描述方案，不包含业务代码改动。

影响范围：

- `frontend/src/features/drawings/drawingInteractionController.js`
- `frontend/src/chart-adapter/coordinateBridge.js`
- `frontend/src/chart-adapter/chartInstanceBridge.js`
- `frontend/src/features/drawings/primitives/*.js`

## 背景

画图点当前主要以 `{ time, price }` 存储，渲染时再把 `time` 转回屏幕 `x` 坐标。为了支持亚 K 线精度，交互层会把鼠标 `x` 转成一个小数 logical index，再插值得到连续时间戳。

本地依赖为 `lightweight-charts@5.1.0`。源码行为需要特别注意：

- `coordinateToLogical(x)` 实际走 `_internal_coordinateToIndex(x)`，内部对 float index 使用 `Math.ceil(...)`，返回整数 logical。
- `coordinateToTime(x)` 只在该坐标能映射到已有 bar 时返回时间；右侧未来空白区没有 bar，会返回 `null`。
- `logicalToCoordinate(logical)` 最终调用 `_internal_indexToCoordinate(index)`；如果 `index` 不是整数，返回 `0`。

已核对位置：

- `frontend/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs:6021`：小数 index 返回 `0`。
- `frontend/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs:6040`：`coordinateToLogical()` 底层使用 `Math.ceil(...)`。
- `frontend/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs:12551`：`logicalToCoordinate()` public API。
- `frontend/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs:12560`：`coordinateToLogical()` public API。
- `frontend/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs:12579`：`coordinateToTime()` public API。

## Bug 1：`fracLogical` 亚 K 线坐标被镜像

### 现象

画线、形状、斐波、测量等两点类工具，如果第二个点拖到最后一根 K 线右侧、还没有 K 线的未来区域，预览点会立刻偏移，提交后图形也停在偏掉的位置。

K 线已有区域内不明显，因为该区域优先走 `coordinateToTime(x)` 加相邻 K 线插值，不依赖 `fracLogical` fallback。

### 根因

当前代码：

```js
const intLogical = adapter.coordinateToLogical?.(x);
const x0 = adapter.logicalToCoordinate?.(intLogical);
const delta = x - x0;
const neighbor = delta >= 0 ? intLogical + 1 : intLogical - 1;
const x1 = adapter.logicalToCoordinate?.(neighbor);
fracLogical = intLogical + delta / (x1 - x0);
```

因为 `coordinateToLogical(x)` 返回的是向上取整后的整数，鼠标位于两根 K 线之间时，`x0` 通常在鼠标右侧，`delta <= 0`，`neighbor = intLogical - 1`。此时 `x1 - x0` 为负数，`delta / (x1 - x0)` 为正数，但真实 logical 应该从 `intLogical` 往左减回去。

缺失的方向因子是：

```js
neighbor - intLogical
```

举例，barSpacing = 8：

| 真实 logical | 当前公式结果 | 误差 |
| --- | ---: | ---: |
| 10.0 | 10.0 | 0 |
| 10.1 | 11.9 | +1.8 |
| 10.5 | 11.5 | +1.0 |
| 10.9 | 11.1 | +0.2 |
| 11.0 | 11.0 | 0 |

### 修复方案

最小修复：

```js
fracLogical = intLogical
  + (delta / (x1 - x0)) * (neighbor - intLogical);
```

更易读的写法是固定使用右邻坐标计算每根 K 线宽度：

```js
const x0 = adapter.logicalToCoordinate?.(intLogical);
const xRight = adapter.logicalToCoordinate?.(intLogical + 1);
if (isFinite(x0) && isFinite(xRight) && xRight !== x0) {
  fracLogical = intLogical + (x - x0) / (xRight - x0);
}
```

后一种写法不需要根据 `delta` 判断方向，也不会漏掉方向因子。

### 预期效果

未来空白区 `coordinateToTime(x)` 返回 `null` 时，fallback 到 `logicalToInterpolatedTime(fracLogical)` 也会得到正确的连续时间，不再被镜像到错误一侧。

## Bug 2：小数 `logical` 兜底会被渲染到 `x = 0`

### 现象

某些异常或兜底路径下，图元点可能保存为：

```js
{ time: null, price, logical: 10.5 }
```

此时如果 primitive 走 logical 兜底，点会被渲染到画布最左侧附近，表现为突然飞到很远。当前用户可见的“未来空白区立刻跑偏”主要由 Bug 1 触发；本 bug 更像潜伏的兜底路径风险，但需要一并堵上。

### 根因

多个渲染路径有类似代码：

```js
if ((x == null || !isFinite(x)) && dp.logical != null) {
  x = timeScale.logicalToCoordinate(dp.logical);
}
```

但 `lightweight-charts@5.1.0` 的 `logicalToCoordinate()` 只接受整数 index。小数 logical 会进入 `_internal_indexToCoordinate(index)`，因为 `!isInteger(index)` 返回 `0`。

涉及位置包括：

- `frontend/src/features/drawings/drawingInteractionController.js`
- `frontend/src/features/drawings/primitives/LineDrawingPrimitive.js`
- `frontend/src/features/drawings/primitives/FibonacciDrawingPrimitive.js`
- `frontend/src/features/drawings/primitives/ShapeDrawingPrimitive.js`
- `frontend/src/features/drawings/primitives/AngleMeasurementPrimitive.js`
- `frontend/src/features/drawings/primitives/AxisLineDrawingPrimitive.js`
- `frontend/src/features/drawings/primitives/FreehandDrawingPrimitive.js`
- `frontend/src/features/drawings/primitives/TextDrawingPrimitive.js`

### 修复方案

不要把小数 logical 直接传给 `timeScale.logicalToCoordinate()`。应集中提供一个 helper，例如：

```js
export function logicalToCoordinateInterpolated(timeScale, logical) {
  if (!timeScale || logical == null || !isFinite(logical)) return null;

  const left = Math.floor(logical);
  const fraction = logical - left;
  const xLeft = timeScale.logicalToCoordinate(left);

  if (xLeft == null || !isFinite(xLeft)) return null;
  if (fraction === 0) return xLeft;

  const xRight = timeScale.logicalToCoordinate(left + 1);
  if (xRight != null && isFinite(xRight)) {
    return xLeft + fraction * (xRight - xLeft);
  }

  return null;
}
```

然后把所有 logical 兜底从：

```js
timeScale.logicalToCoordinate(dp.logical)
```

替换为：

```js
logicalToCoordinateInterpolated(timeScale, dp.logical)
```

不建议用 `Math.round(dp.logical)` 或 `Math.floor(dp.logical)` 修复，因为会丢失亚 K 线精度。

## Bug 3：全局 logical 被当成当前 series 本地下标

### 现象

副图或稀疏 indicator series 上画图时，即使修正了 Bug 1 的方向公式，未来空白区仍可能出现更大幅度的时间偏移。

典型触发条件：

- 副图 drawing anchor 是某条 indicator series。
- indicator 数据过滤了 `null` / 非 finite 值，导致该 series 的第一条数据并不对应全局 time scale 的 logical `0`。
- 未来空白区 `coordinateToTime(x)` 返回 `null`，于是调用 `logicalToInterpolatedTime(fracLogical)`。

### 根因

`logicalToInterpolatedTime()` 当前直接把全局 logical 当成 `series.data()` 数组下标：

```js
const dataIndex = logicalIndex;
```

但 Lightweight Charts 的 logical index 属于全局时间轴，起点由所有 series 的时间轴数据决定；`series.data()` 下标只属于当前 drawing anchor series。副图 indicator 数据被过滤后，二者起点可以相差很多根 K 线。

代码里已经有类似的正确做法：`drawingSnapController.js` 会先取 `seriesData[0].time` 的坐标，再用 `coordinateToLogical()` 求出当前 series 第一根数据对应的全局 logical，最后用 `logical - firstLogical` 得到本地数组下标。

### 修复方案

在 `logicalToInterpolatedTime()` 里先把全局 logical 换算成当前 series 的本地 data index：

```js
const firstTime = seriesData[0]?.time;
const firstCoord = firstTime == null ? null : adapter.timeToCoordinate?.(firstTime);
const firstLogical = firstCoord == null || !isFinite(firstCoord)
  ? null
  : adapter.coordinateToLogical?.(firstCoord);

const dataIndex = firstLogical == null || !isFinite(firstLogical)
  ? logicalIndex
  : logicalIndex - firstLogical;
```

然后沿用现有的 floor/frac 插值与前后 extrapolate 逻辑。这样主图和副图都以“当前 drawing anchor series 的第 0 个点”为插值基准，不再把全局 logical 直接误当数组下标。

### 预期效果

副图使用有空值、稀疏点或延迟起点的 indicator line 时，未来空白区的时间插值不会因为 indicator 数据过滤而被整体平移。

## 三个问题的关系

三个问题可以独立触发，但都属于时间轴坐标转换问题：

1. Bug 1 负责把未来空白区的 `fracLogical` 算错，导致生成错误时间。
2. Bug 2 负责在 `time` 不可用时，把小数 logical 兜底渲染到 `x = 0`。
3. Bug 3 负责在副图或稀疏 indicator series 上，把全局 logical 误当当前 series 本地下标，放大时间偏移。

当前用户可见的“画到未来没有 K 线区域立马跑偏”，优先由 Bug 1 解释；Bug 2 是后续兜底路径隐患；Bug 3 是副图和稀疏 indicator 场景下的独立放大器。如果验证清单包含副图指标错位，就必须把 Bug 3 纳入本次修复范围。

## 后续结构性治理

修完上述三个点后，仍建议继续收敛坐标模型：logical index 不应在多个模块里被临时换算成当前 `series.data()` 下标。

原因：

- Lightweight Charts 的 logical range 起点是所有 series 的时间轴起点。
- 副图 drawing anchor 可能是某条 indicator series。
- indicator 数据会过滤 `null` / 非 finite 值，导致 `series.data()` 下标与全局 time scale logical index 不一定一致。
- 主图还有 alignment series 用于跨 pane 对齐。

后续如果要彻底收敛，应把“时间轴坐标转换”集中在 chart adapter 内，而不是让 drawing controller 和各 primitive 分别处理。

## 建议实施顺序

1. 修复 `screenToData()` 中 `fracLogical` 的方向公式。
2. 修复 `logicalToInterpolatedTime()` 的全局 logical 到当前 series 本地下标换算。
3. 新增统一的 `logicalToCoordinateInterpolated()` helper。
4. 替换所有 primitive 和 `dataToScreen()` 中的小数 logical 兜底。
5. 为坐标转换补单元测试或轻量 fake adapter 测试。
6. 手动验证主图、副图、未来空白区、拖拽和缩放后的行为。

## 验证清单

### 自动测试建议

用 fake adapter 构造这些场景：

- `coordinateToLogical(x)` 返回 `Math.ceil(floatIndex)`。
- `logicalToCoordinate(n)` 对整数返回 `n * barSpacing`。
- `coordinateToTime(x)` 在最后一根 K 线右侧返回 `null`。
- `timeToCoordinateInterpolated(time)` 能把插值时间映射回期望 x。

应覆盖：

- 真实 logical 为 `10.1` 时，`screenToData()` 得到的 logical/time 不应落到 `11.9`。
- 真实 logical 为 `10.5` 时，不应被镜像到 `11.5`。
- 当 `seriesData[0].time` 对应全局 logical `100` 时，全局 logical `110.5` 应换算成本地 data index `10.5`，不应直接当作 `110.5`。
- `logicalToCoordinateInterpolated(10.5)` 应返回 10 与 11 的中点，不应返回 `0`。
- `time: null, logical: 10.5` 的图元不应渲染到画布最左侧。

### 手动验证建议

- 主图：从已有 K 线区域画线到右侧未来空白区，预览端点应贴着鼠标移动。
- 主图：关闭吸附后重复上述操作，确认没有突然跳动。
- 主图：开启吸附后，从最后一根 K 线附近拖到未来空白区，确认从吸附态离开时平滑过渡。
- 形状、斐波、角度测量、文字、自由画笔分别验证未来空白区。
- 拖拽/缩放已有图元端点到未来空白区，确认不跳到最左侧。
- 副图：使用有空值或稀疏点的 indicator line，验证画图坐标不因 indicator 数据过滤而放大偏移。
- 缩放、平移、加载更多历史数据后重复验证。

## 非目标

本次修复不需要改动：

- 图元 `zOrder()` 层级。
- drawing engine lazy load。
- toolbar 激活状态。
- pointer listener 生命周期。

这些模块可能影响“能不能看见/能不能接到事件”，但不是未来空白区坐标跑偏的根因。
