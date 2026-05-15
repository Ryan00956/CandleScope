# 指标系统体检与修复报告

本文记录 CandleScope 指标系统在自定义指标、Pyne 脚本运行、前后端契约和渲染链路中的问题。重点结论：当前“前端页面里自定义写的指标无法生效”不是单一故障，而是多个契约断层叠加造成的。

## 0. 当前实现状态

截至本轮实现，已落地以下修复：

- `POST /api/v1/indicators/compute` 已支持显式 `mode=builtin|script`，避免自定义脚本被 `engineName` 抢走执行路径。
- 后端已新增 `/api/v1/indicators/custom` 的列表、保存、删除接口，自定义指标保存在本地 JSON 文件中。
- 前端指标面板已加载后端自定义指标，保存内置指标编辑结果时会 fork 成自定义脚本。
- Pyne `add_line()` 已兼容 `line_width`、`line_style`、`overlay`、`type="histogram"`、`color_data/colorData` 等参数。
- Pyne 已补充更接近 PineScript 的常用语法别名，例如 `plot.style_histogram`、`shape.*`、`location.*`、`true/false`、顶层 `sma/ema/rsi/macd` 等。
- 已新增 Pyne 三档安全模式：`safe`、`research`、`unsafe`。
- 后端已支持 `PYNE_SECURITY_MODE`、`PYNE_ALLOWED_IMPORTS`、`PYNE_EXEC_TIMEOUT_SECONDS`、`PYNE_MAX_BARS`、`PYNE_MAX_OUTPUT_SERIES`、`PYNE_MAX_OUTPUT_POINTS`。
- 前端 Pyne 编辑器已显示并保存脚本安全模式，切换到 `unsafe` 时会显示确认提示。
- 后端已新增第一版 builtin 指标 WebSocket 路由 `/api/v1/stream/indicators`，支持订阅内置指标、返回初始 `indicator.snapshot`，并在 K 线更新后推送 `indicator.preview`、`indicator.update`、`indicator.snapshot`、`indicator.error`。
- 指标引擎的 `IndicatorKey` 已加入 `exchange` 维度，DataManager bridge、WS 订阅和增量更新都会按 `exchange + market_type + symbol + interval + indicator + params` 隔离实例。
- 前端 `useIndicators` 已接入指标 WS：builtin 指标通过 `/stream/indicators` 获取初始快照和增量更新。
- `/stream/indicators` 已支持自定义 Pyne 脚本订阅：前端传 `kind=script`、`script`、`securityMode` 后，后端会托管脚本并在 K 线更新后基于最新窗口重算，推送 `indicator.snapshot`。
- 前端 `useIndicators` 已把自定义 Pyne 也迁入指标 WS；HTTP compute 仅保留为兼容/兜底路径。
- 指标 WS 已补充稳定性协议：后端所有指标 WS JSON 消息带递增 `seq`，定时发送 `heartbeat`，单连接订阅数量由 `INDICATOR_WS_MAX_SUBSCRIPTIONS` 限制，发送队列大小由 `INDICATOR_WS_QUEUE_SIZE` 控制；队列满时会优先合并同 client 的旧 `indicator.preview`，前端发现 `seq` gap 后会自动重发订阅获取 snapshot。
- 指标 WS 的 Pyne snapshot 已补齐 HTTP compute 同款扩展输出：`markers`、`fills`、`hlines`、`bgcolors`、`barcolors`、`param_schema`、`meta`；前端按 `indicatorId` 替换这些扩展输出，避免一个指标刷新时清掉其他指标的绘图状态。
- 后端已新增统一输出模型 v2：HTTP compute 和 WS snapshot 都会返回 `outputSchemaVersion=2`、`series`、`annotations`、`fills`、`paneLayout`；旧 `lines/markers/hlines/bgcolors/barcolors` 保留，旧 fill 格式临时保留为 `legacyFills`，便于前端分阶段迁移。
- 前端 `useIndicators` 已适配统一输出模型 v2：优先将 `series/annotations/fills` 转换成当前图表内部结构，旧 `lines/markers/hlines/bgcolors/barcolors/legacyFills` 作为 fallback，因此旧指标和新 schema payload 都能显示。
- 后端托管 Pyne 已支持通过 `customId` 从自定义指标 store 加载保存后的脚本、默认参数和安全模式；前端订阅自定义脚本时会附带 `customId`，同时仍传脚本文本以支持未保存/正在编辑的临时脚本。Pyne WS snapshot 计算已切到统一执行器，默认在独立进程里运行，避免慢脚本直接阻塞 WS 收发循环。
- Pyne 已新增进程级执行器 `pyne/executor.py`，默认 `PYNE_EXECUTOR_MODE=process`，脚本在独立进程里运行并由父进程按 `PYNE_EXEC_TIMEOUT_SECONDS + PYNE_PROCESS_GRACE_SECONDS` 强制终止；需要高性能/模型常驻时可切到 `PYNE_EXECUTOR_MODE=inline`。
- Pyne 已新增进程内缓存 API：`pyne.cache(key, loader, ttl=None)`、`pyne.cache_clear(key=None)`、`pyne.cache_stats()`，并提供顶层别名 `cache/cache_clear/cache_stats`。缓存按 `PYNE_CACHE_MAX_ITEMS` 限制条目并淘汰最久未访问项；该缓存只在当前进程内有效，因此模型常驻场景应配合 `PYNE_EXECUTOR_MODE=inline` 使用，默认 process 模式仍优先隔离和超时 kill。
- Pyne 已新增信号输出边界：`emit_signal()` 和 Pine 风格 `alertcondition()` 只产出结构化 `signals` / `annotations(type="signal")`，指标模块不保存 API key、不直接下单；未来 Strategy/Trading 模块可消费这些信号。
- 后端已新增 `/api/v1/indicators/diagnostics` 诊断快照，返回 registry、运行中 IndicatorEngine、custom indicator store、Pyne 安全/执行器/缓存、指标 WS 限流配置，方便后续排查订阅、缓存和脚本执行问题。
- 后端已新增共享序列化层 `app.indicator.serialization`，HTTP compute 和 WS snapshot 共同使用 `serialize_pyne_result()`、`serialize_indicator_result()`、`build_*_snapshot_payload()`，统一输出 `schemaVersion=1`，并为核心计算失败附带 `code`，降低字段漂移风险。
- 已新增结构化错误模型 `errorDetail={code,message,line,column,hint}`；Pyne 语法错误、blocked import、timeout、输出超限、运行时错误、内置指标参数/K 线错误、指标 WS 错误都会尽量返回同一结构，同时保留旧的 `error` 字符串供前端兼容显示。
- Pyne `input.*` 产生的 `param_schema` 已接入前端 active indicator 状态和指标面板；面板会优先按 schema 渲染 `int/float/bool/string/source/color` 参数控件，修改参数后触发重算，旧 params 推断渲染作为兼容兜底保留。
- 副图扩展绘图输出已按 pane 分发：`hline/marker/fill/bgcolor` 会进入对应主图或副图，副图 `hline` 和 `marker` 会挂在该 pane 的指标 series 上，`fill` 匹配改为 `indicatorId + plotId`，避免多个脚本的 `plot_1/plot_2` 串线。

仍未落地、后续继续推进：

- 自定义 Pyne 真正增量执行模型；当前实现是后端托管后的窗口重算。
- 错误码还需要继续覆盖所有非指标 WS 路由、WS 断线/背压、订阅上限、队列合并/丢弃等稳定性事件；当前指标 compute、Pyne runtime 和指标 WS 已先统一。
- 更强的资源隔离，例如进程级内存限制、统一取消令牌和更完整的运行时 metrics。

## 1. 结论摘要

当前指标系统分为两条计算路径：

- 内置指标：前端传 `name` / `engineName`，后端走 `IndicatorEngine`。
- 自定义脚本：前端传 `script`，后端走 `PyneRuntime.exec()`。

问题在于两条路径的边界没有清晰隔离：

- 前端允许编辑内置指标脚本，但请求里仍带 `engineName`，后端会忽略脚本，继续运行内置指标。
- 前端写了自定义指标 CRUD API 调用，但后端没有实现 `/indicators/custom`。
- 文档和模板承诺的 `add_line()` 参数，运行时并不支持，用户照文档写会直接报错。
- Pyne 执行环境直接暴露完整 Python builtins，不具备真正沙盒能力。

## 2. 关键问题

### P0-1：`add_line()` 文档与运行时实现不一致

文档声明：

```python
add_line(
    data,
    color="#f59e0b",
    title="",
    line_width=2,
    line_style=0,
    overlay=True,
    type="line",
    pane=None,
    color_data=None,
)
```

实际实现只支持：

```python
def add_line(data, title="", color="#f59e0b", pane="main"):
    plot(data, title=title, color=color, pane=pane)
```

影响：

- `add_line(... overlay=False)` 会报 `unexpected keyword argument 'overlay'`。
- `add_line(... type="histogram")` 无法绘制柱状图。
- `line_width`、`line_style`、`color_data` 等文档参数全部失效。
- 用户从文档、内置模板或编辑器提示复制示例后，很容易得到不可运行脚本。

修复建议：

- 扩展 `add_line()` 参数，保持旧脚本兼容。
- 将 `line_width` 映射到 `plot(linewidth=...)`。
- 将 `line_style` 映射到 `plot(style=...)` 或前端整数线型。
- 将 `overlay` 映射为 `pane="main"` / `pane="separate"`。
- 将 `type="histogram"` 映射到 `bar()` 或直接产生 histogram 输出。
- 同时兼容 `color_data` 和 `colorData`。

### P0-2：后端缺少自定义指标 CRUD

前端服务层已经声明：

- `GET /api/v1/indicators/custom`
- `POST /api/v1/indicators/custom`
- `DELETE /api/v1/indicators/custom/{indicator_id}`

但后端实际只暴露：

- `GET /api/v1/indicators/registry`
- `GET /api/v1/indicators/registry/{name}`
- `GET /api/v1/indicators/presets`
- `GET /api/v1/indicators/presets/{preset_id}`
- `POST /api/v1/indicators/compute`

影响：

- “保存并关闭”不会保存到后端。
- 自定义指标只能依赖前端 `localStorage` 间接保留。
- 换浏览器、清缓存、多人使用或后端统一管理都无法成立。
- API 文档与实际系统不一致。

修复建议：

- 在后端实现自定义指标存储。
- 最小可行版本可以使用 JSON 文件，例如 `backend/data/custom_indicators.json`。
- 后续再迁移到数据库。
- 保存字段至少包括：

```json
{
  "id": "custom-xxx",
  "name": "My Indicator",
  "description": "",
  "script": "...",
  "params": {},
  "paramSchema": [],
  "created_at": 1710000000,
  "updated_at": 1710000000
}
```

### P0-3：编辑内置指标脚本时，脚本被后端忽略

当前前端计算逻辑优先传入 `engineName`：

```js
computeIndicator({
  name: ind.engineName || undefined,
  script: ind.script,
  ...
})
```

后端逻辑是：

```python
indicator_name = req.name
use_engine = indicator_name is not None

if use_engine and indicator_name:
    return await _compute_engine(indicator_name, req)
elif req.script:
    return await _compute_script(req)
```

也就是说，只要 `name` 存在，`script` 就不会执行。

影响：

- 用户打开内置指标代码，修改源码，再运行到图表，结果仍然是原始内置指标。
- UI 表现与真实行为不一致，会让用户误判“自定义指标系统坏了”。

修复建议：

- 内置指标默认不允许直接覆盖脚本。
- 编辑内置指标时，应执行“另存为自定义”：
  - 新 `id`：`custom-...`
  - `isPreset: false`
  - `engineName: null`
  - 保留脚本内容
- 后端也应明确优先级：如果用户显式选择脚本模式，不应被 `name` 抢占。

## 3. P1 问题

### P1-1：扩展绘图输出只完整支持主图

Pyne 支持：

- `hline()`
- `marker()`
- `fill()`
- `bgcolor()`
- `barcolor()`

但前端主要把这些输出传给主图 `ChartPane`。副图中的 `hline(70)`、`hline(30)`、marker 等不会自然渲染到对应 pane。

影响：

- RSI、MACD、震荡指标等副图脚本无法完整表达图形语义。
- 用户写出的指标和 TradingView/Pine 预期差距较大。

修复建议：

- 后端输出中保留 `pane`。
- 前端按 `pane + indicatorId` 分发扩展输出。
- `ChartPane` 在 sub pane 内也处理 `hline/fill/bgcolor/marker`。

### P1-2：Pyne 运行时不是安全沙盒

当前运行方式：

```python
exec(script, script_globals)
```

并且注入：

```python
ns["__builtins__"] = __builtins__
```

影响：

- 用户脚本可 `import os`、读写文件、访问网络或执行任意 Python 逻辑。
- 死循环会阻塞请求线程。
- 大内存分配可能拖垮后端进程。

修复建议：

- 禁止直接暴露完整 builtins。
- 使用白名单 builtins，例如 `len/range/min/max/sum/abs/round/float/int/bool/list/dict/tuple/enumerate/zip`。
- 禁止或限制 `__import__`。
- 脚本执行放入独立进程。
- 加入超时、内存限制、最大输出点数限制。
- 错误返回需要保留用户可读堆栈位置。

补充说明：考虑到 CandleScope 是偏本地运行的开源项目，且未来可能接入 `ccxt`、`torch`、`sklearn` 等高级能力，不建议只做单一强限制沙箱。更合理的方案是提供分级安全模式，详见“10. 风险说明”。

### P1-3：脚本模式数据校验不足

内置 engine 模式会使用 `BarData.from_dict()` 校验 OHLCV；脚本模式直接在 `PyneContext.from_ohlcv()` 中使用 `dict.get(..., 0)`。

影响：

- 缺字段不会报错，而是默认为 0。
- 用户可能看到错误但看似合理的指标线。

修复建议：

- 脚本模式也复用统一 OHLCV 校验。
- 缺少 `time/open/high/low/close` 应直接返回错误。
- `volume` 可以默认 0，但要明确。

### P1-4：动态参数 schema 已收集但未接入 UI

Pyne 的 `input.int()` / `input.float()` / `input.color()` 会返回 `param_schema`，前端也保存了 `paramSchemas` state，但没有把它接入指标参数面板。

影响：

- 用户在脚本里声明的参数无法自然编辑。
- 参数 UI 仍依赖 `ind.params` 里已有字段。

修复建议：

- `compute` 返回 `param_schema` 后，合并到指标对象。
- 参数面板优先按 `paramSchema` 渲染。
- 用户修改参数后重新计算。

## 4. 建议修复计划

### 第一阶段：让自定义指标真的可用

目标：用户在前端写脚本，运行和保存都能符合预期。

任务：

1. 修复 `add_line()` 参数兼容。
2. 修复编辑内置指标时仍走 engine 的问题。
3. 实现 `/indicators/custom` CRUD。
4. 给 `PyneRuntime` 和 `/indicators/compute` 增加测试。

验收标准：

- `add_line(close, overlay=False, pane="separate")` 能正常出现在副图。
- `add_line(volume, type="histogram", pane="volume")` 能正常绘制柱状图。
- 编辑内置指标后另存为自定义，实际运行用户脚本。
- 刷新页面后自定义指标仍可从后端加载。

### 第二阶段：补齐绘图语义

目标：Pyne 输出在主图、副图、多 pane 下行为一致。

任务：

1. 扩展输出按 pane 分发。
2. 副图支持 `hline()`。
3. 副图支持 `marker()`。
4. 修正 `fill()` 与跨指标 plot id 的匹配策略。

验收标准：

- RSI 脚本中的 `hline(70)` 和 `hline(30)` 出现在 RSI 副图。
- MACD 副图可以显示柱状图、水平线和信号 marker。
- 主图与副图滚动、缩放后扩展图形仍对齐。

### 第三阶段：运行时安全与稳定性

目标：用户脚本不能拖垮后端。

任务：

1. 限制 builtins。
2. 禁止任意 import。
3. 独立进程执行脚本。
4. 添加执行超时。
5. 限制输出数量和序列数量。
6. 错误信息结构化。

验收标准：

- 死循环脚本在超时后被终止。
- `import os` 不可用。
- 大量输出被限制并返回明确错误。
- 后端主进程不会被用户脚本阻塞。

## 5. 架构重构与重写建议

本节记录不属于单点修复、但会持续影响系统演进的设计问题。结论是：不建议推倒整个指标系统重写，但需要把“指标定义、脚本执行、指标存储、图表渲染”四层拆清楚。真正值得重写的是 Pyne 脚本执行器；其他部分更适合渐进重构。

### 5.1 指标 API 契约层需要重构

当前 `/indicators/compute` 同时承担：

- 内置指标计算。
- 自定义脚本计算。
- `# __ENGINE__:` marker 兼容。
- 前端渲染格式适配。

这导致 `name`、`engineName`、`script` 的优先级不清晰。最典型的问题是：请求体同时带 `name` 和 `script` 时，后端会走内置 engine，脚本被忽略。

建议：

- 给计算请求增加显式 `mode`：

```json
{
  "mode": "builtin",
  "name": "MA",
  "params": {},
  "ohlcv": []
}
```

```json
{
  "mode": "script",
  "script": "...",
  "params": {},
  "ohlcv": []
}
```

- 或拆成两个端点：
  - `POST /indicators/compute/builtin`
  - `POST /indicators/compute/script`
- 不再依赖“是否存在 `name`”或“脚本第一行 marker”这种隐式判断。

### 5.2 自定义指标应成为后端一级对象

当前自定义指标更像前端 `activeIndicators` 的副产品，而不是系统里的一级资源。这样会限制后续能力：

- 跨浏览器使用。
- 指标收藏。
- 指标分享。
- 导入导出。
- 告警策略引用指标。
- 多用户管理。

建议建立明确的指标定义模型：

```json
{
  "id": "custom-xxx",
  "kind": "custom",
  "name": "My Indicator",
  "description": "",
  "script": "...",
  "params": {},
  "paramSchema": [],
  "renderHints": {},
  "version": 1,
  "created_at": 1710000000,
  "updated_at": 1710000000
}
```

前端的 active list 应该表示“当前图表启用了哪些指标实例”，而不是承担指标定义存储职责。

### 5.3 PyneRuntime 建议重写为真正的脚本执行器

当前 PyneRuntime 是裸 `exec()` 加一组注入变量，不是真正的脚本执行器。这里建议重写，而不是小修小补。

建议拆成：

- `ScriptValidator`：做 AST 检查，禁止危险节点、危险 import、危险属性访问。
- `ScriptExecutor`：独立进程执行脚本，支持超时终止。
- `PyneNamespace`：只暴露白名单 API 和白名单 builtins。
- `OutputCollector`：产出统一结构化输出，而不是临时 dict。
- `ScriptDiagnostic`：返回结构化错误，包含错误类型、行号、列号和用户可读提示。

目标：

- 死循环不会阻塞后端主进程。
- 大内存脚本不会拖垮服务。
- `import os`、文件读写、网络访问默认不可用。
- 用户脚本错误能定位到具体行。

### 5.4 输出模型需要重构

当前输出结构分散：

- 主输出在 `lines`。
- 扩展输出在 `markers`、`fills`、`hlines`、`bgcolors`、`barcolors`。
- pane 信息散落在各个对象里。

这个模型很难支撑复杂指标和多 pane 渲染。建议统一为：

```json
{
  "series": [],
  "annotations": [],
  "fills": [],
  "paneLayout": []
}
```

每个输出对象都应明确包含：

- `id`
- `indicatorId`
- `pane`
- `type`
- `data`
- `style`
- `scale`
- `zIndex`

这样主图、副图、多指标、fill 引用和 hline 都能按统一模型处理。

### 5.5 前端指标状态需要拆分

当前 `useIndicators` 同时负责：

- localStorage 持久化。
- 自动添加 VOL。
- 指标计算调度。
- 参数更新。
- pane 分组。
- 扩展输出聚合。
- 错误状态管理。

这个 hook 已经承担过多职责。建议拆成：

- `useIndicatorDefinitions`
- `useActiveIndicatorInstances`
- `useIndicatorComputeQueue`
- `useIndicatorPaneModel`
- `useIndicatorPersistence`

拆分后，计算调度、渲染分组、存储同步可以独立测试，也能降低后续修交互 bug 时误伤计算链路的风险。

### 5.6 内置指标与 Pyne 指标边界需要重构

当前内置 preset 给用户展示“参考脚本”，但运行时实际走 engine。这个设计容易误导用户。

建议：

- 内置指标默认只提供参数化配置。
- 内置指标源码可以只读查看。
- 一旦用户修改源码，必须明确 fork 成自定义指标。
- fork 后清除 `engineName`，并固定走 script mode。
- 高性能、长期维护的指标再通过后端注册为 builtin。

### 5.7 推荐重构路线

建议按以下顺序推进，避免大爆炸重写：

1. 先修契约：增加 `mode`、兼容 `add_line()`、内置编辑 fork。
2. 再补持久化：实现自定义指标 CRUD。
3. 拆分前端 `useIndicators`。
4. 统一输出模型。
5. 重写 Pyne 执行器。

其中 Pyne 执行器是唯一建议“重写”的模块；其余部分建议在保持当前功能可用的前提下渐进重构。

## 6. 后端维护指标并通过 WS 推送的目标架构

当前前端指标计算路径是：

```text
后端提供 K 线
    ↓
前端保存 chartData
    ↓
前端发现指标、参数或 K 线变化
    ↓
前端把整段 OHLCV 发回后端 `/indicators/compute`
    ↓
后端批量计算指标
    ↓
前端接收 lines 并渲染
```

这条链路可以工作，但并不理想：

- 同一份 K 线在前后端来回传输。
- 每次指标计算都偏全量，实时 tick 多时容易造成重复计算。
- 指标实例生命周期实际由前端状态驱动，后端没有统一维护当前图表订阅了哪些指标。
- 多个前端打开同一交易对和周期时，会重复触发相同计算。
- 后端已有 `IndicatorEngine` 的增量事件设计，但 HTTP compute 路径没有充分发挥它。

更合理的目标架构是：

```text
交易所 WS / REST 回补
        ↓
后端 DataEngine 维护 K 线
        ↓
后端 IndicatorEngine 订阅 K 线事件
        ↓
指标实例增量更新
        ↓
后端 WS 推送：
  - candle.updated / candle.closed
  - indicator.snapshot
  - indicator.preview
  - indicator.updated
  - indicator.recomputed
        ↓
前端只负责渲染
```

这个方向与现有后端设计是吻合的。当前后端已经具备：

- `IndicatorEngine.subscribe()`
- `IndicatorEngine.on_bar_updated()`
- `IndicatorEngine.on_bar_closed()`
- `IndicatorEngine.on_bars_backfilled()`
- `IndicatorEvent`
- `data_manager_bridge`

缺失的是指标订阅 WS 协议、前端订阅管理、初始快照推送和指标实例生命周期治理。

### 6.1 建议的 WS 订阅协议

前端打开图表或添加指标时发送：

```json
{
  "type": "indicator.subscribe",
  "requestId": "req-1",
  "symbol": "BTCUSDT",
  "interval": "1m",
  "marketType": "spot",
  "indicators": [
    {
      "clientId": "ma-20",
      "kind": "builtin",
      "name": "MA",
      "params": { "period": 20 }
    },
    {
      "clientId": "rsi-14",
      "kind": "builtin",
      "name": "RSI",
      "params": { "period": 14 }
    }
  ]
}
```

后端收到后：

1. 查询当前 symbol/interval 的历史 K 线。
2. 创建或复用对应 `IndicatorEngine` 实例。
3. 初始化指标历史结果。
4. 先推完整快照。
5. 后续随着 K 线事件推增量更新。

初始快照：

```json
{
  "type": "indicator.snapshot",
  "requestId": "req-1",
  "clientId": "ma-20",
  "indicatorId": "spot:BTCUSDT:1m:MA:xxxxx",
  "lines": [
    {
      "id": "ma",
      "pane": "main",
      "type": "line",
      "data": [
        { "time": 1710000000, "value": 60000.1 }
      ]
    }
  ]
}
```

形成中 K 线预览：

```json
{
  "type": "indicator.preview",
  "clientId": "ma-20",
  "time": 1710000060,
  "values": {
    "ma": 60120.5
  }
}
```

K 线收盘后的确认更新：

```json
{
  "type": "indicator.updated",
  "clientId": "ma-20",
  "time": 1710000060,
  "values": {
    "ma": 60118.2
  }
}
```

历史回补或修复后的重算：

```json
{
  "type": "indicator.recomputed",
  "clientId": "ma-20",
  "indicatorId": "spot:BTCUSDT:1m:MA:xxxxx",
  "lines": []
}
```

取消订阅：

```json
{
  "type": "indicator.unsubscribe",
  "clientIds": ["ma-20", "rsi-14"]
}
```

### 6.2 前端职责变化

迁移后，前端不再把整段 OHLCV 发回后端计算指标，而是：

- 发送指标订阅请求。
- 接收 snapshot 后 `setData()`。
- 接收 preview 后更新当前形成中点。
- 接收 updated 后 update/append 已确认点。
- 接收 recomputed 后重置整条指标线。

前端指标 hook 可以从“计算调度中心”瘦身为：

- `useIndicatorSubscriptions`
- `useIndicatorSeriesStore`
- `useIndicatorPaneModel`

前端仍负责：

- 指标配置 UI。
- 当前图表启用了哪些指标。
- 图表 pane 布局。
- Lightweight Charts 渲染。

前端不再负责：

- 判断何时批量 compute。
- 将整段 K 线发回后端。
- 维护复杂 compute queue。
- 复用或销毁后端指标实例。

### 6.3 内置指标优先迁移，自定义脚本分阶段处理

内置指标非常适合后端托管和 WS 增量推送，因为它们已经实现了：

- `init(bars)`
- `update_partial(bar)`
- `update_closed(bar)`
- `recompute(bars)`

自定义 Pyne 脚本则不同。当前 PyneRuntime 是批量执行模型，不是增量指标类。任意用户脚本不一定可以 O(1) 增量更新，例如：

```python
x = np.percentile(close[-200:], 90)
```

或者：

```python
for i in range(len(close)):
    ...
```

因此不建议一开始就把所有自定义脚本都承诺为实时增量。

推荐迁移策略：

1. 第一阶段：内置指标走后端 WS 增量订阅。
2. 自定义 Pyne 指标继续走 HTTP `/indicators/compute` 批量计算。
3. 第二阶段：自定义指标定义保存到后端。
4. 第三阶段：后端托管 Pyne 自定义指标，但采用“防抖 + 尾部窗口重算”。
5. 长期阶段：如果需要，再设计 Pyne 增量 API。

自定义指标托管初期可以采用：

- 新 tick：不重算或低频 preview。
- 新收盘 K：重算最近 N 根窗口。
- 参数或脚本变化：全量重算。
- 历史回补：全量重算。

### 6.4 后端需要新增的能力

后端要支持该架构，需要补齐：

- 指标 WS 路由，例如 `/api/v1/stream/indicators`。
- WS 连接级订阅表：`connection -> clientId -> IndicatorKey`。
- 反向索引：`IndicatorKey -> connections/clientIds`。
- 初始历史 K 线查询和 snapshot 推送。
- `IndicatorEvent` 到 WS message 的转换层。
- unsubscribe 和连接断开后的 refcount 清理。
- backfill/recompute 事件推送。
- 错误事件推送：参数错误、指标不存在、计算失败。

### 6.5 推荐迁移路线

不要一次性把所有指标能力搬到 WS。推荐路线：

1. 保留现有 `/indicators/compute`，保证当前功能可用。
2. 新增 `indicator.subscribe` WS 协议，仅支持 builtin。
3. 前端内置指标改走 WS，自定义 Pyne 继续走 HTTP。
4. 后端完善指标实例引用计数和 unsubscribe。
5. 自定义指标 CRUD 落地后，再考虑 Pyne 指标后端托管。
6. 最后重构统一输出模型，使 HTTP 和 WS 使用同一种指标输出结构。

最终目标：

```text
后端维护 K 线、指标实例和订阅；
前端只负责显示、配置和交互。
```

这是比当前前端驱动批量计算更清晰、更可扩展的架构，也更符合现有 `DataEngine + IndicatorEngine` 的设计意图。

## 7. Pyne 用户体验设计原则

后端 WS 化、指标后端托管之后，Pyne 对用户仍然应该保持简单。关键原则是：**用户写脚本的体验和系统如何实时维护指标必须解耦**。

用户不应该关心：

- WS 订阅协议。
- `IndicatorEngine` 生命周期。
- 指标实例 refcount。
- `update_partial()` / `update_closed()`。
- 后端采用全量重算、窗口重算还是增量更新。

用户只应该关心：

- 输入参数。
- 使用 OHLCV 数组计算指标。
- 调用 `plot()`、`hline()`、`marker()` 等绘图函数。
- 保存后指标能自动显示并随行情更新。

推荐的用户脚本形态应该保持数组式、声明式，例如：

```python
indicator("My RSI", overlay=False)

length = input.int(14, "Length", minval=1)
r = ta.rsi(close, length)

plot(r, "RSI", color=color.purple)
hline(70, "Overbought", color=color.red)
hline(30, "Oversold", color=color.green)
```

用户感知流程应该是：

```text
写脚本
  ↓
点击运行
  ↓
图上出现结果
  ↓
点击保存
  ↓
后续自动实时更新
```

### 7.1 不建议让普通用户写生命周期函数

不要要求普通用户写：

```python
def init(ctx):
    ...

def on_bar(bar):
    ...

def on_tick(tick):
    ...
```

这种方式对开发者可能灵活，但对普通指标用户过重，会把“写指标”变成“写插件”。Pyne 应该保持类似 TradingView Pine 的体验：用户面向序列和绘图函数，而不是面向后端事件生命周期。

推荐分层：

- 普通用户：写 Pyne 数组式脚本。
- 高级用户：使用更多绘图函数和参数声明。
- 系统开发者：通过 `Indicator` 类实现真正 O(1) 增量内置指标。

普通用户示例：

```python
length = input.int(20, "Length")
plot(ta.sma(close, length))
```

高级用户示例：

```python
indicator("MA Cross", overlay=True)

fast = ta.ema(close, 12)
slow = ta.ema(close, 26)

plot(fast, "Fast")
plot(slow, "Slow")
marker(crossover(fast, slow), text="BUY", position="below")
```

系统开发者才需要实现：

```python
class MAIndicator(Indicator):
    def update_closed(self, bar):
        ...
```

### 7.2 后端托管 Pyne 时的内部执行策略

用户脚本可以保持简单，但后端内部可以按不同策略执行：

- 初始订阅：拉取历史 K 线，执行一次 Pyne，推送 snapshot。
- 新 tick：可选择不重算，或低频重算最近窗口并推 preview。
- K 线收盘：重算最近 N 根窗口，或必要时全量重算。
- 参数变化：全量重算。
- 脚本变化：全量重算。
- 历史回补：全量重算并推送 recomputed。

这套策略不需要暴露给用户。用户只需知道保存后的指标会自动更新。

### 7.3 自定义 Pyne 不应承诺全部 O(1) 增量

内置指标可以做到 O(1) 增量，因为它们由后端类显式实现 `update_partial()` 和 `update_closed()`。

但任意 Pyne 脚本不一定能增量化，例如：

```python
x = np.percentile(close[-200:], 90)
plot(x)
```

或者：

```python
values = []
for i in range(len(close)):
    values.append(custom_calc(close[:i + 1]))
plot(values)
```

因此自定义 Pyne 的目标应该是：

- 保持用户书写简单。
- 后端自动选择合适的重算策略。
- 遇到慢脚本时降低实时预览频率。
- 不让慢脚本拖垮服务。

可以给用户轻量提示：

```text
该指标计算较慢，实时预览频率已自动降低。
```

不要要求用户理解底层优化策略。

### 7.4 需要补齐的易用性能力

为了让 Pyne 真正简单易用，需要补齐以下能力。

#### 默认模板

新建指标时默认模板应使用推荐写法：

```python
indicator("My Indicator", overlay=True)

length = input.int(20, "Length", minval=1)
src = input.source(close, "Source")
line_color = input.color(color.orange, "Color")

ma = ta.sma(src, length)
plot(ma, "MA", color=line_color)
```

#### 运行前校验和清晰错误

不要只返回：

```text
Script error
```

应该返回类似：

```text
第 5 行：ta.sma() 缺少 period 参数
```

或者：

```text
第 8 行：plot() 的 data 长度与 K 线数量不一致
```

#### 参数自动生成 UI

用户写：

```python
length = input.int(20, "Length", minval=1)
line_color = input.color(color.orange, "Color")
```

前端应自动生成：

- `Length` 数字输入框。
- `Color` 颜色选择器。

用户不应该手写 JSON 参数 schema。

#### 主图/副图控制要简单

推荐用：

```python
indicator("RSI", overlay=False)
```

控制整个指标进入副图。

必要时单条线也可以指定：

```python
plot(rsi, "RSI", pane="separate")
```

但普通用户不应该被迫理解复杂 pane 模型。

#### 内置指标 fork 体验

用户修改内置指标时，应明确提示：

```text
正在基于 MA 创建自定义副本
```

修改后的指标必须变成：

- `kind: "custom"` 或 `kind: "script"`。
- `engineName: null`。
- 走 script mode。

不要让用户误以为自己修改了系统内置 MA，也不要让 UI 显示已修改但后端仍运行内置 engine。

### 7.5 最终体验目标

理想状态是：

```text
用户写起来像 TradingView Pine；
系统跑起来像后端托管指标服务。
```

即：

- 用户只写简单脚本。
- 后端负责保存、校验、执行、重算、推送。
- 前端负责参数 UI、图表显示和交互。
- 复杂性能和实时性策略由系统内部处理。

### 7.6 Pyne 贴近 Pine Script 的兼容边界

Pyne 不建议实现完整 Pine Script 解释器，也不建议承诺直接运行 TradingView Pine 源码。更合理的目标是：

```text
Pyne = Python 运行时 + Pine 风格语法糖 + Pine 风格序列 API
```

即：

- 普通 Python 语法完全保留。
- 用户可以使用 numpy 和 Python 函数。
- 同时提供 Pine 风格的常量、函数别名和序列工具。
- 常见 Pine 指标可以低成本迁移。
- 不承诺支持 Pine 的完整语法和执行模型。

应在文档中明确说明：

```text
Pyne 是 Pine-inspired Python DSL。
它兼容普通 Python 语法，并提供 Pine 风格函数、常量和序列工具。
它不是 Pine Script 解释器，不保证直接运行 TradingView Pine 源码。
```

推荐用户可以写这种混合风格：

```python
indicator("MA Trend", overlay=true)

length = input.int(20, "Length")
src = input.source(close, "Source")

def normalize(x):
    mn = np.nanmin(x)
    mx = np.nanmax(x)
    return (x - mn) / (mx - mn)

ma = sma(src, length)
trend_color = iff(close > ref(close, 1), color.green, color.red)

plot(ma, "MA", color=trend_color, linewidth=2)
```

这个例子同时使用：

- Pine 风格 `indicator/input/plot/color`。
- Pyne 辅助函数 `iff/ref/sma`。
- 普通 Python 函数。
- numpy。

### 7.7 建议优先支持的 Pine 风格语法糖

第一阶段建议只改运行时 namespace，不做语法预处理，不改 Python 语法。

#### 布尔和空值别名

注入：

```python
true = True
false = False
na = np.nan
```

用户即可写：

```python
indicator("RSI", overlay=false)
```

这是合法 Python，因为 `false` 是运行时变量名。

#### 条件选择函数

Pine 写法：

```pinescript
x = close > open ? high : low
```

Pyne 不应支持 `? :` 原生语法，而应提供：

```python
x = iff(close > open, high, low)
```

同时可以提供别名：

```python
x = where(close > open, high, low)
```

底层可映射到 `np.where()`。

#### 历史引用函数

Pine 写法：

```pinescript
close[1]
```

Pyne 不建议重定义 Python 的 `close[1]` 语义。Python 用户会自然理解 `close[1]` 是数组第二项，强行改成 Pine 的“上一根 K 线”会破坏 Python 直觉。

推荐提供：

```python
prev_close = ref(close, 1)
```

对应 Pine：

```pinescript
close[1]
```

未来可以考虑 `Series.prev()`：

```python
prev_close = close.prev(1)
```

但第一阶段用 `ref(series, n)` 最稳。

#### 常用 ta 函数顶层别名

支持：

```python
sma(close, 20)
ema(close, 20)
rsi(close, 14)
macd(close, 12, 26, 9)
```

等价于：

```python
ta.sma(close, 20)
ta.ema(close, 20)
ta.rsi(close, 14)
ta.macd(close, 12, 26, 9)
```

这样简单指标迁移时更接近 Pine。

#### Pine 风格常量命名空间

建议支持：

```python
plot.style_line
plot.style_histogram
hline.style_solid
hline.style_dashed
hline.style_dotted
shape.triangleup
shape.triangledown
shape.circle
location.abovebar
location.belowbar
location.top
location.bottom
```

用户即可写：

```python
plot(hist, "MACD Hist", style=plot.style_histogram)
marker(crossover(fast, slow), shape=shape.triangleup, location=location.belowbar)
```

#### 输入 API 参数别名

继续兼容：

```python
input.int(14, "Length", minval=1)
```

同时支持更 Pine 风格的关键字：

```python
input.int(defval=14, title="Length", minval=1)
```

`input.float()`、`input.bool()`、`input.color()`、`input.source()` 同理。

#### `plot()` 参数向 Pine 靠拢

建议 `plot()` 兼容常见 Pine 参数：

```python
plot(
    series,
    title="RSI",
    color=color.purple,
    linewidth=2,
    style=plot.style_line,
)
```

同时继续兼容当前 Pyne 位置参数：

```python
plot(series, "RSI", color=color.purple)
```

### 7.8 不建议支持或暂缓支持的 Pine 语法

以下能力不建议第一阶段支持。

#### `? :` 条件表达式

Python 不支持：

```python
x = cond ? a : b
```

除非做预处理器或解释器。不建议为了这个破坏“Pyne 是 Python”的边界。

替代方案：

```python
x = iff(cond, a, b)
```

#### `close[1]` Pine 语义

不建议把 `close[1]` 改成上一根 K 线，因为这与 Python/numpy 语义冲突。

替代方案：

```python
ref(close, 1)
```

#### `var`、`:=`、bar-by-bar 状态语义

Pine 的：

```pinescript
var x = 0
x := x + 1
```

依赖 Pine 的逐 bar 执行模型。Pyne 当前是数组式批量执行，不建议直接兼容。

如确实需要状态，后续可以设计 Pyne 专属 helper，而不是照搬 Pine 语法。

#### `request.security()`

多周期、多品种数据请求涉及：

- 数据源管理。
- 时间对齐。
- 缺失 K 线处理。
- 回补策略。

第一阶段不建议支持。后续可以设计：

```python
security("BTCUSDT", "1h", close)
```

但应作为独立能力规划。

#### `strategy.*`

策略回测和下单模型不是指标绘制系统的一部分。`strategy.entry()`、`strategy.exit()` 等不应混入第一阶段 Pyne 指标运行时。

### 7.9 Pine 到 Pyne 迁移表

建议在用户文档中提供迁移表：

| Pine Script | Pyne |
|-------------|------|
| `true` / `false` | `true` / `false`，等价于 `True` / `False` |
| `na` | `na`，等价于 `np.nan` |
| `ta.sma(close, 20)` | `ta.sma(close, 20)` 或 `sma(close, 20)` |
| `ta.ema(close, 20)` | `ta.ema(close, 20)` 或 `ema(close, 20)` |
| `close[1]` | `ref(close, 1)` |
| `cond ? a : b` | `iff(cond, a, b)` |
| `plot(x, title="X")` | `plot(x, title="X")` |
| `plot.style_histogram` | `plot.style_histogram` |
| `shape.triangleup` | `shape.triangleup` |
| `location.belowbar` | `location.belowbar` |

### 7.10 实现步骤

#### 第一阶段：只扩展 runtime namespace

在 `PyneRuntime._build_namespace()` 中注入：

```python
ns["true"] = True
ns["false"] = False
ns["na"] = np.nan

ns["iff"] = lambda cond, a, b: np.where(cond, a, b)
ns["where"] = ns["iff"]
ns["ref"] = utils.shift

ns["sma"] = ta.sma
ns["ema"] = ta.ema
ns["rsi"] = ta.rsi
ns["macd"] = ta.macd
```

同时补充：

- `shape` namespace。
- `location` namespace。
- `plot.style_*`。
- `hline.style_*`。

该阶段不改变脚本语法，因此不会破坏普通 Python 兼容性。

#### 第二阶段：完善函数参数兼容

重点统一：

- `plot()` 参数。
- `marker()` 参数。
- `hline()` 参数。
- `add_line()` 旧兼容参数。
- `input.*()` Pine 风格关键字。

目标是让 Pine 用户迁移时少改参数名。

#### 第三阶段：编辑器迁移辅助

在前端编辑器中提供“Pine 到 Pyne 草稿转换”能力，但只做辅助，不承诺完全正确。

例如将：

```pinescript
//@version=5
indicator("MA", overlay=true)
len = input.int(20)
plot(ta.sma(close, len))
```

转换成：

```python
indicator("MA", overlay=true)
length = input.int(20, "Length")
plot(ta.sma(close, length))
```

并提示用户检查。

#### 第四阶段：考虑 Series 包装

未来可以把 `close` 从 numpy array 包装为 `Series`，支持：

```python
close.prev(1)
close.crosses_over(ma)
```

但这会影响大量 `ta.*` 函数和 numpy 兼容，应后置。第一阶段使用 `ref(close, 1)` 更稳。

## 8. 建议测试清单

后端单元测试：

- `test_pyne_add_line_accepts_legacy_extended_args`
- `test_pyne_add_line_histogram_output`
- `test_pyne_compute_rejects_invalid_ohlcv`
- `test_indicator_compute_prefers_script_when_engine_name_is_absent`
- `test_custom_indicator_crud_roundtrip`
- `test_custom_indicator_delete_missing_returns_404`

前端测试：

- 创建自定义指标后会调用 script compute。
- 编辑内置指标会 fork 成自定义指标，不再带 `engineName`。
- `param_schema` 能生成参数编辑控件。
- 副图指标的 hline/marker 被传到对应 pane。

手工验收脚本：

```python
indicator("Custom RSI", overlay=False)
length = input.int(14, "Length", minval=1)
r = ta.rsi(close, length)
plot(r, "RSI", color=color.purple)
hline(70, "Overbought", color=color.red)
hline(30, "Oversold", color=color.green)
```

预期：

- 指标在副图显示。
- 参数面板出现 `Length`。
- 70/30 水平线显示在副图。
- 修改 `Length` 后重新计算。
- 保存并刷新页面后指标仍存在。

## 9. 优先修复文件

- `backend/app/indicator/pyne/plot.py`
- `backend/app/indicator/pyne/runtime.py`
- `backend/app/api/v1/indicators.py`
- `frontend/src/components/IndicatorPanel.jsx`
- `frontend/src/hooks/useIndicators.js`
- `frontend/src/components/MultiPaneChart.jsx`
- `frontend/src/components/ChartPane.jsx`
- `frontend/src/services/indicatorApi.js`

## 10. 风险说明

短期内最危险的问题是 Pyne 执行环境。当前 Pyne 是本地脚本执行环境，不是强安全沙箱。若该软件只在本机单用户使用，风险可以低于云服务或多用户服务，但仍需要防止误操作、死循环、第三方脚本夹带危险代码，以及未来接入交易接口后的资产风险。

当前最适合的修复策略不是大重构，而是先统一前后端契约，让现有 Pyne 脚本路径稳定可用，再逐步补齐持久化、pane 渲染和沙盒安全。

### 10.1 Pyne 三档安全模式

为了兼顾普通用户安全和高级用户扩展能力，建议 Pyne 提供三档安全模式，而不是简单地“全禁”或“全放开”。

推荐配置：

```env
PYNE_SECURITY_MODE=safe
PYNE_EXEC_TIMEOUT_SECONDS=5
PYNE_MAX_BARS=50000
PYNE_MAX_OUTPUT_SERIES=20
PYNE_MAX_OUTPUT_POINTS=1000000
PYNE_ALLOWED_IMPORTS=numpy,pandas,scipy,sklearn,torch
```

#### safe mode：默认模式

面向普通指标用户。

建议配置：

```env
PYNE_SECURITY_MODE=safe
```

行为：

- 禁止 `import`。
- 使用 builtins 白名单。
- 保留执行超时。
- 限制输出 series 数量。
- 限制输出点数。
- 只使用系统注入的 `np`、`ta`、`input`、`plot`、`color`、`math` 等 API。

适合：

- 普通技术指标。
- 自己写的 Pyne 脚本。
- 从可信来源复制的简单指标脚本。

不适合：

- 需要加载模型文件。
- 需要访问网络。
- 需要调用 `ccxt`。
- 需要使用额外第三方库。

#### research mode：研究模式

面向本地高级用户、机器学习实验、特征工程和数据科学脚本。

建议配置：

```env
PYNE_SECURITY_MODE=research
PYNE_ALLOWED_IMPORTS=numpy,pandas,scipy,sklearn,torch
PYNE_EXEC_TIMEOUT_SECONDS=10
```

行为：

- 允许 import 白名单模块。
- 默认仍限制危险模块，例如 `os`、`subprocess`、`shutil`、`socket`。
- 保留执行超时。
- 保留输出数量限制。
- 可使用 `pandas`、`scipy`、`sklearn`、`torch` 等研究库。

适合：

- 本地模型推理。
- 特征工程。
- 机器学习指标实验。
- 高级统计指标。

注意：

- `torch` / `sklearn` 模型加载不应在每根 K 线上反复执行。
- 后续可考虑提供模型或对象缓存 API，例如 `pyne.cache()`。
- research mode 仍不建议用于运行不可信脚本。

#### unsafe mode：完全信任模式

面向本机开发、完全可信脚本、量化交易实验。

建议配置：

```env
PYNE_SECURITY_MODE=unsafe
```

行为：

- 暴露完整 Python 能力。
- 允许任意 import。
- 可访问文件系统。
- 可访问网络。
- 可调用 `ccxt` 等交易库。
- 风险由用户自行承担。

适合：

- 本机个人实验。
- 可信脚本。
- 需要访问外部 API 的高级场景。
- 需要完整 Python 能力的研究脚本。

必须明确提示：

```text
unsafe mode 允许脚本执行任意 Python 代码，包括读写文件、访问网络和调用交易接口。恶意脚本可能造成数据损坏或资产损失。仅在本机运行完全信任的脚本时启用。
```

即便在 unsafe mode，也建议保留可配置超时，避免误写死循环导致后端不可用。

### 10.2 建议的 builtins 策略

safe mode 和 research mode 不应暴露完整 `__builtins__`，而应使用白名单：

```python
SAFE_BUILTINS = {
    "len": len,
    "range": range,
    "min": min,
    "max": max,
    "sum": sum,
    "abs": abs,
    "round": round,
    "float": float,
    "int": int,
    "bool": bool,
    "list": list,
    "dict": dict,
    "tuple": tuple,
    "set": set,
    "enumerate": enumerate,
    "zip": zip,
}
```

research mode 可以额外提供受控 `__import__` wrapper，只允许 `PYNE_ALLOWED_IMPORTS` 中的模块。

unsafe mode 才使用完整 builtins。

### 10.3 `ccxt` 和真实交易的边界

未来如果接入 `ccxt`，不建议普通指标脚本直接下单：

```python
import ccxt
exchange.create_order(...)
```

原因：

- 指标脚本可能在每次订阅、每次重算、每根 K 线收盘时执行。
- 回补或重算可能导致重复下单。
- 脚本错误可能直接造成资产损失。

更合理的设计是：

- Pyne 指标只产生信号。
- 交易执行由单独 Strategy / Trading 模块负责。
- API key、权限、风控、下单确认都由交易模块管理。

推荐脚本输出形式：

```python
buy = crossover(fast, slow)
sell = crossunder(fast, slow)

emit_signal("buy", when=buy)
emit_signal("sell", when=sell)
```

或者：

```python
alertcondition(buy, "Buy Signal")
alertcondition(sell, "Sell Signal")
```

如果 unsafe mode 允许用户直接使用 `ccxt`，UI 和文档必须明确风险。

### 10.4 前端 UI 建议

指标编辑器应显示当前 Pyne 安全模式：

```text
Pyne 模式：safe / research / unsafe
```

切换到 unsafe mode 时应弹出确认：

```text
不安全模式允许脚本执行任意 Python 代码，包括访问文件、网络和交易 API。恶意脚本可能造成数据损坏或资产损失。仅在本机运行完全信任的脚本时启用。
```

可以允许脚本声明期望模式：

```python
# pyne: mode=research
```

但最终以后端配置为准：

- 后端是 `safe`，脚本声明 `unsafe` 不生效。
- 后端允许 `unsafe`，脚本才能请求 `unsafe`。
- 前端只显示当前后端实际模式和风险提示。

### 10.5 推荐实施顺序

1. 文档中明确“当前 Pyne 不是强安全沙箱”。
2. 新增 `PYNE_SECURITY_MODE` 配置。
3. 实现 safe mode builtins 白名单。
4. 实现执行超时。
5. 实现 research mode import 白名单。
6. 实现 unsafe mode 显式开启。
7. 前端显示当前模式和风险提示。
8. 后续再考虑独立进程、内存限制和更强隔离。

## 11. 复审补充：仍需补齐的工程落地点

前面的章节已经覆盖主要方向，但真正执行时还需要补齐一些工程细节。否则容易出现“架构方向正确，但迁移中体验断裂或线上状态不稳定”的问题。

### 11.1 兼容与迁移策略

当前用户已有的指标状态主要存放在浏览器 `localStorage`。后续如果引入后端自定义指标库、WS 指标订阅和 `mode` 字段，需要明确兼容策略。

建议：

- 保留旧 `/indicators/compute` 一段时间，不要立即删除。
- 新增 `mode` 后，旧请求按兼容逻辑处理：
  - 有 `name` 且无 `mode`：视为 `mode="builtin"`。
  - 无 `name` 且有 `script`：视为 `mode="script"`。
- 对旧的 `# __ENGINE__:` marker 保持读取能力，但不再鼓励新代码使用。
- 前端启动时检测旧版 `activeIndicators`：
  - 若存在 `engineName`，保持 builtin 订阅。
  - 若是 `custom-*` 且只有本地脚本，提示用户迁移到后端保存。
- 自定义指标定义需要 `schemaVersion` 字段，方便未来迁移。

建议指标定义增加：

```json
{
  "schemaVersion": 1,
  "id": "custom-xxx",
  "kind": "script",
  "name": "My Indicator",
  "script": "...",
  "params": {},
  "paramSchema": [],
  "renderHints": {}
}
```

### 11.2 WS 稳定性：重连、乱序和背压

WS 指标推送不能只设计消息格式，还需要处理连接不稳定和消息乱序。

建议补齐：

- 心跳：`ping/pong` 或定期 server heartbeat。
- 重连：前端断线后自动重连并重新发送当前订阅。
- 序列号：每个订阅流带 `seq`，前端可识别乱序或丢包。
- 快照版本：snapshot 带 `snapshotId` 或 `asOf`，delta 带对应时间戳。
- 幂等更新：同一 `time + outputId` 重复到达时前端 update 而不是 append 重复点。
- 背压策略：前端处理不过来时，后端可合并 preview，只保留最新形成中值。
- 连接清理：WS 断开必须释放订阅 refcount，避免指标实例泄漏。

建议消息增加：

```json
{
  "type": "indicator.updated",
  "clientId": "ma-20",
  "seq": 42,
  "time": 1710000060,
  "values": {
    "ma": 60118.2
  }
}
```

如果前端发现 `seq` 跳号，应请求重新 snapshot。

### 11.3 自定义指标存储一致性

如果最小版本使用 JSON 文件存储自定义指标，需要考虑并发和损坏恢复。

建议：

- 写入时使用临时文件 + 原子 rename。
- 多请求写入时加文件锁或进程内锁。
- 保存前做 schema 校验。
- 保留 `created_at`、`updated_at`。
- 删除时不要静默成功，未找到应返回 404。
- 支持导入/导出，便于用户备份。
- 指标名可重复，但 `id` 必须唯一。
- 后续迁移数据库时提供一次性迁移脚本。

最小存储接口建议：

- `list_custom_indicators()`
- `get_custom_indicator(id)`
- `upsert_custom_indicator(definition)`
- `delete_custom_indicator(id)`
- `export_custom_indicators()`
- `import_custom_indicators(items)`

### 11.4 统一错误模型

当前错误容易分散在 HTTP、WS、PyneRuntime、前端 console 中。建议统一错误结构。

建议错误格式：

```json
{
  "ok": false,
  "error": {
    "code": "PYNE_RUNTIME_ERROR",
    "message": "ta.sma() missing required argument: period",
    "line": 5,
    "column": 10,
    "hint": "检查 ta.sma(src, period) 的第二个参数。"
  }
}
```

建议错误码：

- `INDICATOR_NOT_FOUND`
- `INVALID_PARAMS`
- `INVALID_OHLCV`
- `PYNE_SYNTAX_ERROR`
- `PYNE_RUNTIME_ERROR`
- `PYNE_TIMEOUT`
- `PYNE_IMPORT_BLOCKED`
- `PYNE_OUTPUT_LIMIT_EXCEEDED`
- `WS_SUBSCRIBE_FAILED`
- `WS_SEQUENCE_GAP`

前端只展示用户可读 `message/hint`，详细堆栈进入后端日志。

### 11.5 观测与诊断

指标系统后续会变成后端长期运行服务，需要基础观测能力。

建议记录：

- 当前 WS 连接数。
- 当前指标订阅数。
- 活跃 `IndicatorEngine` 实例数。
- 每个指标计算耗时。
- Pyne 脚本执行耗时。
- Pyne timeout 次数。
- Pyne import blocked 次数。
- recompute 次数和触发原因。
- backfill 后指标重算耗时。
- WS 推送队列长度。
- 丢弃/合并 preview 次数。

可以先在 `/api/v1/indicators/diagnostics` 暴露简化快照，后续再接入更完整的 metrics。

当前已落地第一版 `/api/v1/indicators/diagnostics`：

- `registry`：内置指标数量和名称。
- `engine`：`IndicatorEngine.snapshot()`，包含实例数、stream 数、listener 数、实例初始化状态、bar 数、refcount。
- `customIndicators`：本地自定义指标数量、存储路径、读取错误。
- `pyne`：安全模式、允许 import、执行器模式、超时、输出限制、缓存统计。
- `websocket`：单连接订阅上限、发送队列大小、heartbeat 间隔。

尚未落地的是长期 metrics 聚合，例如每次 Pyne 执行耗时、timeout 次数、preview 合并次数和 WS 连接总数；这些应后续接入专门 metrics 层，而不是继续堆在指标 API 里。

### 11.6 性能预算与资源限制

文档已有安全模式，但还需要明确性能预算。否则 research/unsafe mode 很容易把指标系统拖慢。

建议默认预算：

- 单次 Pyne 执行默认超时：safe 5 秒，research 10 秒，unsafe 可配置。
- 单个指标最大输出 series 数：20。
- 单次输出最大点数：1,000,000。
- 单个 WS 连接最大订阅数：例如 50。
- 单个 symbol/interval 最大活跃指标实例数：可配置。
- preview 合并窗口：例如 200ms。

对于 ML 模型：

- 不建议每次执行都加载模型。
- 后续提供 `pyne.cache()` 或后端模型缓存。
- 缓存需要有 key、TTL、手动清理能力。
- GPU 使用要有明确提示，避免用户误以为普通指标运行成本很低。

### 11.7 `ccxt`、交易模块和指标模块边界

文档已经说明不建议普通指标脚本直接下单，但还需要在系统边界上落实。

建议：

- 指标模块只负责产生 signals / alerts。
- 交易模块负责 API key、交易权限、风控、下单和审计日志。
- Pyne 中即便支持 `emit_signal()`，也不直接执行交易。
- unsafe mode 下用户可自行 import `ccxt`，但 UI 必须持续显示风险。
- 后续若提供官方交易能力，应使用单独 Strategy Engine，而不是塞进 Indicator Engine。

### 11.8 配置与依赖管理

research mode 允许 `torch/sklearn/pandas`，但这些库可能没有安装，尤其是开源本地项目。

建议：

- 后端启动时暴露 Pyne runtime capabilities：

```json
{
  "securityMode": "research",
  "allowedImports": ["numpy", "pandas", "sklearn", "torch"],
  "availableModules": {
    "pandas": true,
    "sklearn": false,
    "torch": true
  }
}
```

- 前端编辑器显示当前可用模块。
- import 不可用时返回清晰错误，而不是长堆栈。
- 文档区分基础安装和 research extras 安装。

例如后续可以提供：

```bash
pip install -r backend/requirements-research.txt
```

### 11.9 测试清单需要扩展

当前测试清单覆盖了最初修复项，但新增 WS、Pyne 兼容和安全模式后需要补充。

后端新增测试：

- `test_compute_mode_builtin_ignores_script_only_when_mode_builtin`
- `test_compute_mode_script_runs_script_even_if_name_absent`
- `test_legacy_engine_marker_still_supported`
- `test_custom_indicator_schema_version_roundtrip`
- `test_custom_indicator_store_atomic_write`
- `test_pyne_true_false_na_aliases`
- `test_pyne_iff_where_ref_helpers`
- `test_pyne_top_level_ta_aliases`
- `test_pyne_safe_mode_blocks_import`
- `test_pyne_research_mode_allows_whitelisted_import`
- `test_pyne_research_mode_blocks_dangerous_import`
- `test_pyne_unsafe_mode_allows_import`
- `test_pyne_timeout_returns_structured_error`

WS 新增测试：

- `test_indicator_ws_subscribe_returns_snapshot`
- `test_indicator_ws_updates_on_closed_bar`
- `test_indicator_ws_preview_is_coalesced`
- `test_indicator_ws_unsubscribe_releases_refcount`
- `test_indicator_ws_disconnect_cleans_subscriptions`
- `test_indicator_ws_sequence_gap_requires_resnapshot`
- `test_indicator_ws_backfill_pushes_recomputed`

前端新增测试：

- 断线重连后会重新订阅当前指标。
- 收到 snapshot 后使用 `setData`。
- 收到 updated 后按 `time/outputId` 幂等 update。
- 收到 recomputed 后替换整条线。
- 当前 Pyne 安全模式在编辑器中可见。
- unsafe mode 显示风险提示。
- Pine 风格模板可以成功运行。

### 11.10 建议补一个总执行顺序

目前文档中有多个局部阶段。实际执行时建议合并为一个总顺序：

1. 修复 P0：`add_line()`、内置编辑 fork、自定义 CRUD、基础测试。
2. 明确 compute mode：兼容旧接口，新增显式 `mode`。
3. 完成 Pyne 易用性第一阶段：`true/false/na`、`iff/ref`、顶层 ta 别名、plot 常量。
4. 实现 Pyne 三档安全模式的 safe/research/unsafe 配置。
5. 扩展参数 UI 和结构化错误。
6. 补齐副图扩展绘图输出。
7. 新增 builtin 指标 WS 订阅，不迁移自定义 Pyne。
8. 前端内置指标从 HTTP compute 切到 WS。
9. 统一 HTTP/WS 输出模型。
10. 后端托管 Pyne 自定义指标，先采用防抖和窗口重算。
11. 重写 Pyne 执行器为独立进程执行模型。
12. 考虑 Strategy / Trading 模块，和指标模块保持边界。

## 12. 可执行任务拆解

本节把前面的设计拆成可以逐项实现或开 issue 的任务。优先级按“先恢复可用性，再改善体验，再迁移架构”的原则排列。

### Epic A：修复自定义指标当前不可用问题

目标：用户在前端新建、运行、保存自定义指标，行为与 UI 一致。

#### A1. 修复 `add_line()` 兼容参数

范围：

- `backend/app/indicator/pyne/plot.py`
- `backend/tests/test_pyne_runtime.py` 或新增同类测试文件

任务：

- 扩展 `add_line()` 支持 `line_width`、`line_style`、`overlay`、`type`、`pane`、`color_data`、`colorData`。
- `type="line"` 映射到 line 输出。
- `type="histogram"` 映射到 histogram 输出。
- `overlay=False` 默认进入 `pane="separate"`。
- 保持旧写法 `add_line(data, color, title)` 不破坏。

验收：

- `add_line(close, overlay=False)` 不报错，并进入副图。
- `add_line(volume, type="histogram", pane="volume")` 返回 histogram。
- 文档里的 `add_line()` 示例可以直接运行。

#### A2. 内置指标编辑时 fork 成自定义指标

范围：

- `frontend/src/components/IndicatorPanel.jsx`
- `frontend/src/components/IndicatorEditor.jsx`
- `frontend/src/hooks/useIndicators.js`

任务：

- 编辑 `isPreset: true` 的指标时，保存动作创建新自定义指标。
- 新指标清除 `engineName`。
- 新指标设置 `isPreset: false`、`kind: "script"`。
- UI 提示“正在基于内置指标创建自定义副本”。

验收：

- 修改 MA 内置脚本后，后端实际执行用户脚本。
- 原内置 MA 不被覆盖。
- active list 中能区分内置指标和自定义副本。

#### A3. 实现自定义指标 CRUD

范围：

- `backend/app/api/v1/indicators.py`
- 建议新增 `backend/app/indicator/custom_store.py`
- `frontend/src/services/indicatorApi.js`
- `frontend/src/components/IndicatorPanel.jsx`

任务：

- 实现 `GET /api/v1/indicators/custom`。
- 实现 `POST /api/v1/indicators/custom`。
- 实现 `DELETE /api/v1/indicators/custom/{indicator_id}`。
- 最小版本用 JSON 文件存储。
- 存储字段包含 `schemaVersion`、`id`、`kind`、`name`、`script`、`params`、`paramSchema`、`renderHints`、`created_at`、`updated_at`。
- 写入使用临时文件 + 原子 rename。

验收：

- 新建自定义指标后刷新页面仍存在。
- 删除不存在的指标返回 404。
- JSON 文件损坏时后端能给出明确错误，不静默覆盖。

#### A4. 明确 compute mode

范围：

- `backend/app/api/v1/indicators.py`
- `frontend/src/services/indicatorApi.js`
- `frontend/src/hooks/useIndicators.js`

任务：

- `ComputeRequest` 增加 `mode: "builtin" | "script" | None`。
- 新请求显式传 `mode`。
- 旧请求保持兼容。
- `mode="script"` 时必须执行脚本，不受 `name` 抢占。
- `mode="builtin"` 时必须要求 `name` 存在。

验收：

- 同时传 `mode="script"`、`name`、`script` 时执行脚本。
- 同时传 `mode="builtin"`、`name`、`script` 时执行内置指标。
- 旧版 `# __ENGINE__:` marker 仍可运行，但不作为推荐路径。

### Epic B：提升 Pyne 易用性和 Pine 迁移体验

目标：Pyne 保持 Python 兼容，同时让 Pine 用户低成本迁移常见指标。

#### B1. 注入 Pine 风格基础别名

范围：

- `backend/app/indicator/pyne/runtime.py`
- `backend/app/indicator/pyne/utils.py`
- Pyne runtime 测试

任务：

- 注入 `true = True`。
- 注入 `false = False`。
- 注入 `na = np.nan`。
- 注入 `iff(cond, a, b)`。
- 注入 `where(cond, a, b)`。
- 注入 `ref(series, n=1)`。

验收：

- `indicator("X", overlay=false)` 可以运行。
- `iff(close > open, high, low)` 返回序列。
- `ref(close, 1)` 等价于上一根收盘价序列。

#### B2. 注入常用 ta 顶层别名

范围：

- `backend/app/indicator/pyne/runtime.py`

任务：

- 注入 `sma`、`ema`、`wma`、`rma`、`vwma`。
- 注入 `rsi`、`macd`、`atr`、`bb`。
- 注入 `crossover`、`crossunder` 等已有工具函数。

验收：

- `plot(sma(close, 20))` 可以运行。
- `dif, dea, hist = macd(close)` 可以运行。

#### B3. 增加 Pine 风格常量命名空间

范围：

- `backend/app/indicator/pyne/plot.py`
- `backend/app/indicator/pyne/runtime.py`

任务：

- 支持 `plot.style_line`。
- 支持 `plot.style_histogram`。
- 支持 `hline.style_solid`、`hline.style_dashed`、`hline.style_dotted`。
- 注入 `shape.triangleup`、`shape.triangledown`、`shape.circle`。
- 注入 `location.abovebar`、`location.belowbar`、`location.top`、`location.bottom`。

验收：

- `plot(hist, style=plot.style_histogram)` 生成 histogram。
- `marker(cond, shape=shape.triangleup, location=location.belowbar)` 能正确返回 marker。

#### B4. 更新默认模板和编辑器提示

范围：

- `frontend/src/components/IndicatorPanel.jsx`
- `frontend/src/editor/pyneLanguage.js`
- `backend/app/indicator/pyne/README_zh.md`

任务：

- 新建指标默认模板改为 `indicator/input/plot` 推荐写法。
- 自动补全加入 `true/false/na/iff/ref/sma/ema/rsi`。
- 文档增加 Pine 到 Pyne 迁移表。

验收：

- 新建模板无需修改即可运行。
- 编辑器能提示新增语法糖。

### Epic C：Pyne 安全模式与运行限制

目标：默认保护普通用户，同时允许本地高级用户显式开启 research/unsafe 能力。

#### C1. 增加 Pyne 安全配置

范围：

- `backend/app/core/config.py`
- `backend/app/indicator/pyne/runtime.py`

任务：

- 增加 `PYNE_SECURITY_MODE`。
- 增加 `PYNE_EXEC_TIMEOUT_SECONDS`。
- 增加 `PYNE_ALLOWED_IMPORTS`。
- 增加 `PYNE_MAX_OUTPUT_SERIES`。
- 增加 `PYNE_MAX_OUTPUT_POINTS`。

验收：

- 默认模式为 `safe`。
- 配置变更后 runtime 行为可测试。

#### C2. 实现 safe mode

范围：

- `backend/app/indicator/pyne/runtime.py`

任务：

- 使用 builtins 白名单。
- 禁止 import。
- 保留 `np`、`ta`、`input`、`plot` 等注入 API。
- import 被阻止时返回结构化错误。

验收：

- `import os` 在 safe mode 被阻止。
- 普通 `ta.sma()` 脚本可运行。

#### C3. 实现 research mode

范围：

- `backend/app/indicator/pyne/runtime.py`

任务：

- 实现受控 `__import__` wrapper。
- 只允许 `PYNE_ALLOWED_IMPORTS` 中的顶层模块。
- 阻止 `os/subprocess/shutil/socket` 等危险模块。
- 暴露 runtime capabilities。

验收：

- 白名单中的 `import pandas` 成功，未安装时给清晰错误。
- `import os` 被阻止。

#### C4. 实现 unsafe mode 与 UI 风险提示

范围：

- `backend/app/indicator/pyne/runtime.py`
- `backend/app/api/v1/indicators.py`
- `frontend/src/components/IndicatorEditor.jsx`

任务：

- unsafe mode 使用完整 Python builtins。
- 前端显示当前 Pyne 模式。
- unsafe mode 显示醒目风险提示。
- 脚本头部 `# pyne: mode=research` 只能请求不高于后端允许的模式。

验收：

- unsafe mode 可 import 任意模块。
- safe 后端下脚本声明 unsafe 不生效。
- UI 明确显示风险。

### Epic D：统一错误、参数 UI 和绘图输出

目标：用户看得懂错误，参数可编辑，副图输出完整。

#### D1. 结构化错误模型

范围：

- `backend/app/api/v1/indicators.py`
- `backend/app/indicator/pyne/runtime.py`
- 前端错误展示组件

任务：

- [x] 定义统一错误码。
- [x] 返回 `code/message/line/column/hint`。
- [x] HTTP 和 WS 使用同一错误结构。

验收：

- [x] 语法错误显示行号。
- [x] blocked import 显示明确原因。
- [x] 前端不展示后端堆栈。

#### D2. 参数 schema 接入 UI

范围：

- `frontend/src/hooks/useIndicators.js`
- `frontend/src/components/IndicatorPanel.jsx`

任务：

- [x] `compute` 返回 `param_schema` 后写入指标定义。
- [x] 参数面板优先按 schema 渲染。
- [x] 支持 int/float/bool/string/source/color。

验收：

- [x] `input.int(20, "Length")` 自动生成数字输入框。
- [x] 修改参数后重新计算。

#### D3. 副图扩展绘图输出

范围：

- `frontend/src/hooks/useIndicators.js`
- `frontend/src/components/MultiPaneChart.jsx`
- `frontend/src/components/ChartPane.jsx`

任务：

- [x] `hline/marker/fill/bgcolor` 按 pane 分发。
- [x] sub pane 支持 hline。
- [x] sub pane 支持 marker。
- [x] fill 匹配使用 `indicatorId + plotId`，避免跨指标冲突。

验收：

- [x] RSI 副图显示 70/30 hline。
- [x] 副图 marker 出现在正确 pane。
- [x] 多个指标都有 fill 时不串线。

### Epic E：builtin 指标 WS 订阅

目标：内置指标从前端批量 compute 迁移为后端托管、WS 增量推送。

#### E1. 后端指标 WS 路由

范围：

- 建议新增 `backend/app/api/v1/indicator_stream.py`
- `backend/app/main.py`
- `backend/app/indicator/engine.py`

任务：

- [x] 新增 `/api/v1/stream/indicators`。
- [x] 支持 `indicator.subscribe`。
- [x] 支持 `indicator.unsubscribe`。
- [x] 支持连接断开清理。
- [x] 建立 `connection -> clientId -> IndicatorKey`。
- [x] 建立 `IndicatorKey -> subscribers`。

验收：

- [x] subscribe 后立即收到 snapshot。
- [x] unsubscribe 后 refcount 释放。
- [x] 断开连接后无遗留订阅。

#### E2. DataManager 到 IndicatorEngine 事件桥

范围：

- `backend/app/indicator/data_manager_bridge.py`
- `backend/app/data_engine` 相关事件接口

任务：

- [x] 确认 closed bar 事件进入 `on_bar_closed()`。
- [x] 确认 partial bar 事件进入 `on_bar_updated()`。
- [x] backfill 后触发 `on_bars_backfilled()`。
- [x] 将 `IndicatorEvent` 转换成 WS message。

验收：

- [x] 新收盘 K 线触发 `indicator.updated`。
- [x] 形成中 K 线触发 `indicator.preview`。
- [x] 回补触发 `indicator.recomputed`。

#### E3. WS 稳定性

范围：

- 后端 WS 路由
- 前端 WS 客户端

任务：

- [x] 消息增加 `seq`。
- [x] 支持 heartbeat。
- [x] 支持前端重连后重新订阅。
- [x] preview 合并，避免高频刷屏。
- [x] 前端发现 seq gap 后请求 snapshot。

验收：

- [x] 手动断网恢复后指标自动恢复。
- [x] 高频 tick 下 preview 不无限堆积。

#### E4. 前端内置指标迁移到 WS

范围：

- `frontend/src/hooks/useIndicators.js`
- 建议新增 `frontend/src/hooks/useIndicatorSubscriptions.js`
- 建议新增 `frontend/src/services/indicatorWs.js`

任务：

- [x] builtin 指标使用 WS subscribe。
- [x] custom Pyne 已进一步迁移到 WS 托管窗口重算；HTTP compute 保留为兼容兜底。
- [x] snapshot -> `setData`。
- [x] updated/preview -> 幂等 update。
- [x] recomputed -> 替换整条线。

验收：

- [x] MA/RSI/VOL 等内置指标不再通过 HTTP compute 反复计算。
- [x] 自定义指标仍可运行。
- [x] 切换 symbol/interval 后旧订阅正确释放。

### Epic F：统一输出模型

目标：HTTP 和 WS 使用同一套指标输出结构。

#### F1. 定义统一输出 schema

范围：

- `backend/app/indicator/types.py`
- `backend/app/indicator/pyne/plot.py`
- `backend/app/api/v1/indicators.py`

任务：

- [x] 定义 `series`。
- [x] 定义 `annotations`。
- [x] 定义 `fills`。
- [x] 定义 `paneLayout`。
- [x] 每个输出包含 `id/indicatorId/pane/type/data/style/scale/zIndex`。
- [x] 保留 `lines` 兼容字段一段时间。

验收：

- [x] HTTP compute 返回新旧双格式。
- [x] WS snapshot 使用新格式。
- [x] 前端可从新格式构建 pane。

#### F2. 前端渲染适配新 schema

范围：

- `frontend/src/hooks/useIndicators.js`
- `frontend/src/components/MultiPaneChart.jsx`
- `frontend/src/components/ChartPane.jsx`

任务：

- [x] 将 `series/annotations/fills` 转换为 chart series。
- [x] 保留旧 `lines` fallback。
- [x] 统一主图/副图渲染路径。

验收：

- [x] 旧指标和新指标都能显示。
- [x] 多 pane 输出行为一致。

### Epic G：Pyne 后端托管与执行器重写

目标：自定义 Pyne 也能后端托管，但不要求全部 O(1) 增量。

#### G1. 后端托管 Pyne 自定义指标

范围：

- 自定义指标 store
- 指标 WS 路由
- PyneRuntime

任务：

- [x] 订阅 `kind="script"` 指标时从后端 store 加载脚本。
- [x] 初始执行并推 snapshot。
- [x] 新收盘 K 线按窗口重算或全量重算。
- [x] 参数变化触发重算。
- [x] 脚本变化触发重算。

验收：

- [x] 保存后的 Pyne 指标可以通过 WS 订阅。
- [x] 慢脚本不会阻塞其他指标。

#### G2. Pyne 执行器进程隔离

范围：

- 建议新增 `backend/app/indicator/pyne/executor.py`
- `backend/app/indicator/pyne/runtime.py`

任务：

- [x] 将脚本执行移入独立进程。
- [x] 支持 timeout kill。
- [x] 主进程只接收结构化结果。
- [x] 为 unsafe/research 保留配置开关。

验收：

- [x] 死循环脚本被终止。
- [x] 后端主进程不挂。
- [x] 错误返回结构化。

#### G3. Pyne cache 能力

范围：

- `backend/app/indicator/pyne/runtime.py`
- `backend/app/indicator/pyne/executor.py`

任务：

- [x] 设计 `pyne.cache(key, loader, ttl=None)` 或类似 API。
- [x] 支持模型加载缓存。
- [x] 支持手动清理或重启清空。

验收：

- [x] torch/sklearn 模型不会每根 K 线重复加载。
- [x] 缓存超限有明确策略。

### Epic H：交易/策略边界预留

目标：为未来 ccxt 和量化交易预留边界，但不把交易直接塞进指标系统。

任务：

- [x] 定义 `emit_signal()` 或 `alertcondition()` 输出结构。
- [x] 指标模块只产出信号。
- [x] Strategy / Trading 模块后续消费信号。
- [x] 文档明确指标脚本直接下单只属于 unsafe 自担风险。

验收：

- [x] Pyne 可以输出 buy/sell signal。
- [x] 指标系统不保存 API key。
- [x] 指标系统不直接下单。

### 建议 issue 切分顺序

第一批必须先做：

1. A1：`add_line()` 兼容。
2. A2：内置编辑 fork。
3. A3：自定义指标 CRUD。
4. A4：compute mode。
5. D1：结构化错误的最小版本。

第二批改善体验：

1. B1：基础 Pine 风格别名。
2. B2：ta 顶层别名。
3. B3：常量命名空间。
4. B4：模板和编辑器提示。
5. D2：参数 schema UI。
6. D3：副图扩展绘图。

第三批安全与可观测：

1. C1：安全配置。
2. C2：safe mode。
3. C3：research mode。
4. C4：unsafe mode UI 提示。
5. 11.5 中的 diagnostics。（已完成第一版）

第四批 WS 架构迁移：

1. E1：指标 WS 路由。
2. E2：事件桥。
3. E3：WS 稳定性。
4. E4：前端 builtin 迁移。

第五批长期架构：

1. F1/F2：统一输出模型。
2. G1：Pyne 后端托管。
3. G2：执行器进程隔离。
4. G3：Pyne cache。
5. H：策略/交易边界。
