# Pyne Runtime Python 包长期方向

本文档定义 Pyne Runtime 作为 Python 包的长期方向。它面向已经熟悉
TradingView Pine 心智模型、但希望在 Python 里写指标和策略的用户，也面向
需要把脚本运行、图表渲染、参数面板和数据 provider 组合起来的宿主应用。

核心边界：

- Pyne Runtime 不做 Pine Script 源码解析、编译或解释。
- Pyne Runtime 不承诺直接运行 `.pine` 文件。
- Pyne Runtime 不做 TradingView 完整图层克隆。
- Pyne Runtime 不内置交易所、券商、行情存储或 UI。
- Pyne Runtime 的目标是提供 Python-native、Pine-like 的运行时语义和稳定输出协议。

换句话说，它的产品形态不是：

```text
Pine source -> parser/compiler/interpreter -> execution
```

而是：

```text
Python script + Pine-like runtime API -> deterministic indicator/strategy output
```

## 1. 产品定位

Pyne Runtime 应该成为一个轻量但语义扎实的 Pine-like Python runtime package。

它主要服务三类场景：

1. 熟悉 Pine 的用户，用 Python 语法写出类似 Pine 的指标、策略和多周期逻辑。
2. 外部图表应用，把 Pyne 作为脚本运行引擎，并自行负责数据、渲染、账号和 UI。
3. CandleScope 这类宿主，把 Pyne 输出的结构化结果渲染成图表、信号、策略报告和调试面板。

Pyne 的价值不是替代普通 Python 回测库，也不是复刻 TradingView。它的价值是把 Pine 用户熟悉的运行时概念带到 Python：

- `close[1]` 表示上一根 bar。
- series 表达式按 bar 传播。
- `na`、`nz()`、`barstate.*` 和 `timeframe.*` 可用。
- `request.security()` 负责跨上下文请求和对齐。
- `strategy.*` 提供确定性的订单、持仓、成交和报告回放。
- `plot()`、marker 和 drawing object 输出为宿主可消费的数据结构。

## 2. 当前基础

当前 Pyne 已经具备比较完整的底座：

- Python 包 API：`run()`、`PyneRuntime`、`PyneSettings`、`PyneData`、`PyneResult`。
- CLI：`pyne run`、`pyne validate`、`pyne schema` 和 `python -m pyne_runtime`。
- Series 语义：OHLCV source、历史引用、算术、比较、布尔组合、`na` / `nz()`。
- Bar 语义：`bar_index`、`last_bar_index`、`time`、`time_close`、`barstate.*`。
- Runtime metadata：`syminfo`、`timeframe`、`session`。
- 状态：`var()`、`pyne.var()`、`set_each()`。
- 表达式辅助：`when()`、`switch()`、`where()`。
- TA：核心和扩展 `ta.*`，并有 TradingView-backed golden capture。
- 集合：`array.*`、`map.*`、`matrix.*`。
- 标准库：`math.*`、`str.*`、`time.*`、`ticker.*`、`color.*`。
- Plot 输出：`plot()`、`hline()`、`fill()`、`plotshape()`、`plotchar()`、`plotarrow()`、marker、bar/bg color 和 alert/signal。
- Drawing object：`line`、`label`、`box`、`table` 的 batch snapshot 和 incremental event。
- Request：host-backed `request.security()`、`request.security_lower_tf()`、tuple return、callable thunk、gaps/lookahead、provider capability 和 metadata。
- Strategy：`strategy()`、entry/order/exit/close/cancel、pending stop/limit、OCA、pyramiding、slippage、commission、margin、risk、trade ledger、summary、lifecycle。
- Incremental runtime：`on_bar()`、preview/confirmed bar、增量 TA、增量 drawing、增量 strategy。

因此后续工作不应该推倒重来，而应该继续加强三件事：

1. Pine 用户迁移体验。
2. 外部应用集成协议。
3. Pine-like 语义覆盖和证据。

## 3. 明确不做什么

这些能力不属于 core package 的长期方向：

- Pine 源码 parser / compiler / interpreter。
- 未翻译地直接运行 TradingView `.pine` 脚本。
- 完整 TradingView runtime clone。
- 完整 TradingView 视觉图层克隆。
- 内置图表 UI、参数面板 UI 或可视化编辑器。
- 内置行情数据库、交易所 adapter、broker connector。
- tick 级真实撮合、订单簿、排队、部分成交、真实券商 margin call。
- 试图保证 TradingView 未公开细节的完全一致。

未来可以有独立工具把 Pine 源码辅助翻译成 Pyne-style Python，但该工具不应该反向绑架 Pyne core 的架构。

## 4. 设计原则

### 4.1 Pine-like 语义优先

如果一个 API 可以做成普通 Python 回测库风格，也可以做成 Pine-like 风格，优先选择 Pine-like。

例如：

```python
strategy(
    "System",
    slippage=2,
    commission_type=strategy.commission.percent,
    commission_value=0.1,
)
```

这种形式比自定义一套回测参数名更适合本项目，因为它保留了 Pine 用户熟悉的心智模型。

### 4.2 Python 语法保持 Python 语法

Pyne 不应该假装 Python 可以表达所有 Pine 语法。

Python 无法天然复刻的点，应提供明确的一等替代 API：

- Pine 的 series `if` / 三元选择：使用 `when()`、`switch()`。
- Pine 的 `:=` 递归赋值：使用 `var()` / `pyne.var()` 状态单元。
- Pine 的 request expression capture：使用 `lambda ctx: ...` thunk。
- Pine 的 realtime intrabar 状态：未来使用显式 `varip`-like API。
- Python 关键字冲突：例如 `array.from(...)` 使用 `array.from_values(...)`。

### 4.3 Core 与宿主边界清晰

Pyne core 负责：

- 脚本执行。
- Pine-like series、bar、request、strategy、state 语义。
- 结构化 output schema。
- provider protocol 和 metadata contract。
- 错误诊断和 validation。

宿主应用负责：

- 市场数据获取和缓存。
- symbol metadata。
- 图表渲染。
- 参数面板 UI。
- 用户、权限、会话、持久化。
- broker 或交易所连接。

### 4.4 每个兼容性声明都要有证据

只要文档说某个行为是 Pine-like，就应该有测试支撑。

高风险区域优先使用 golden tests：

- TA 函数。
- `request.security()` 对齐。
- `barstate` 和 realtime 行为。
- strategy fill、risk、trade ledger 和 report。
- collection history 和 mutation 边界。

## 5. 长期能力方向

### 5.1 Pine 用户迁移体验

这是下一阶段最高价值方向之一。功能已经不少，但 Pine 用户需要更少踩坑、更快上手。

目标：

- 让用户能把 Pine 思路稳定改写成 Pyne Python。
- 让常见 Python/Pine 语法差异有清晰错误提示。
- 让外部应用能在用户保存脚本前给出诊断。

工作项：

1. 编写 Pine-to-Pyne cookbook：
   - indicator declaration。
   - `plot()` / marker。
   - series condition。
   - `var` / `:=`。
   - `request.security()`。
   - strategy entry/exit。
   - array/map/matrix。
2. 增强 `validate()`：
   - AST 检测 `if close > open:`。
   - AST 检测 series 条件 Python 三元表达式。
   - 检测裸表达式传给 `request.security()` 的常见误用。
   - 检测 `array.from` 这类 Python 关键字冲突。
   - 检测可能 lookahead 的负向 history 或 unsupported shift。
3. 错误提示教学化：
   - 告诉用户为什么错。
   - 给出对应 Pyne 写法。
   - 返回稳定 error code，方便宿主 UI 展示。
4. 增加迁移示例：
   - 均线交叉。
   - RSI 信号。
   - Supertrend。
   - 多周期过滤。
   - 简单 strategy。
   - 带参数 schema 的脚本。

完成标准：

- 新用户不用阅读全部概念文档，也能根据 cookbook 写出可运行脚本。
- 常见 Pine 写法误用能在 validate 阶段给出可执行建议。

### 5.2 更完整的 `input.*` 和参数 schema

如果 Pyne 要服务外部应用，参数 schema 是核心能力。宿主需要根据脚本自动生成配置面板。

目标：

- 支持更完整的 Pine-like input family。
- 输出稳定的参数 schema。
- 保留 UI metadata，但不在 core 内实现 UI。

工作项：

1. 扩展 input 类型：
   - `input.int`
   - `input.float`
   - `input.bool`
   - `input.string`
   - `input.source`
   - `input.color`
   - `input.timeframe`
   - `input.symbol`
   - `input.session`
   - `input.time`
2. 支持参数 metadata：
   - `title`
   - `defval`
   - `options`
   - `minval`
   - `maxval`
   - `step`
   - `tooltip`
   - `group`
   - `inline`
   - `confirm`
3. 输出 schema：
   - 参数 id。
   - 类型。
   - 默认值。
   - 当前值。
   - UI metadata。
   - source/timeframe/symbol 特殊类型说明。
4. 参数 override：
   - CLI override。
   - `pn.run(..., params=...)`。
   - 类型校验和错误诊断。

完成标准：

- 外部应用可以只读取 Pyne 的 param schema，就生成可用参数面板。
- 常见 Pine input 脚本能自然改写成 Pyne Python。

### 5.3 Request 与 provider contract

`request.*` 是 Pine-like runtime 的关键能力，但数据必须由宿主提供。长期方向是扩展 request 类型，同时把 provider contract 做稳定。

目标：

- `request.security()` 和 `request.security_lower_tf()` 成为稳定 host-backed 多上下文 API。
- provider 能声明能力、metadata、错误口径。
- 可以扩展更多 request family，而不把 core 变成数据平台。

工作项：

1. 强化当前 request：
   - 更多 HTF/LTF gaps/lookahead golden。
   - timezone / session / time_close 边界。
   - requested context history。
   - tuple thunk。
   - invalid symbol 和 capability 组合。
   - provider cache 行为。
2. 扩展 provider protocol：
   - OHLCV provider。
   - metadata provider。
   - capability provider。
   - request diagnostics。
   - stable exception types。
3. 可选扩展 request family：
   - `request.currency_rate`
   - `request.financial`
   - `request.economic`
   - `request.dividends`
   - `request.splits`
   - `request.earnings`
   - generic `request.data()`
4. 保持边界：
   - core 定义接口和对齐语义。
   - 宿主实现数据来源。
   - core 不直接访问外部网络或交易所。

完成标准：

- 外部应用可以稳定实现 provider。
- request 行为有足够 golden evidence。
- 新 request 类型可以按 provider capability 安全开启或关闭。

### 5.4 Realtime、incremental 与 `varip`-like 语义

当前已有 incremental runtime 和 preview/confirmed bar 隔离。长期应该让 realtime 语义更接近 Pine 用户的预期。

目标：

- batch 和 incremental 在可比脚本上尽量收敛。
- preview state 与 confirmed state 边界清楚。
- 提供 `varip`-like API 表达 intrabar state。

工作项：

1. 明确 state 类型：
   - `var()`：跨 confirmed bar 持久。
   - future `varip()`：同一 realtime bar 内持久，bar 确认后按规则提交或重置。
2. 增加 reference tests：
   - batch vs incremental。
   - preview update 不污染 confirmed state。
   - object preview event 不污染 persistent session。
   - strategy preview 和 confirmed fill 行为。
3. 扩展 incremental docs：
   - host 如何喂历史 bar。
   - host 如何喂 realtime update。
   - confirmed bar 如何提交。
   - UI 如何消费 object events。

完成标准：

- 实时宿主可以用 Pyne 做低重复计算的脚本执行。
- 用户能明确知道哪些状态会在 preview 中变化，哪些会提交。

### 5.5 Pine-like 标准库宽度

Pyne 不需要追求一次性全量复刻 Pine 标准库，但应该优先补高频、迁移价值高的 namespace。

目标：

- 常见 Pine 指标和策略迁移时，少遇到 unsupported helper。
- 每个 namespace 的 known differences 清楚。

优先级：

1. `input.*`
2. `ta.*`
3. `math.*`
4. `time.*`
5. `str.*`
6. `color.*`
7. `ticker.*`
8. `array.*` / `map.*` / `matrix.*`

工作项：

- 维护 API matrix。
- 按 namespace 增加函数级测试。
- 对 TradingView 行为容易有差异的函数增加 golden。
- 对冷门 overload 标注 unsupported 或 planned。

完成标准：

- 用户能通过文档快速判断某个 Pine helper 是否可用。
- 缺失函数有明确状态，而不是运行时才猜。

### 5.6 Collection 历史与资源边界

当前集合类型已经可用，但 Pine-like collection 的历史快照和 mutation 边界还可以继续深化。

目标：

- array/map/matrix 支持更清晰的历史和 mutation 语义。
- 宿主可以配置资源限制，避免脚本无限增长内存。

工作项：

1. Collection history：
   - array snapshot history。
   - map snapshot history。
   - matrix snapshot history。
   - mutation 后历史引用口径。
2. Value boundary：
   - scalar。
   - series。
   - color。
   - object handle。
   - nested collection。
3. Resource limits：
   - max array size。
   - max map size。
   - max matrix cells。
   - max nested depth。
4. 错误语义：
   - out-of-range。
   - invalid key。
   - invalid matrix shape。
   - unsupported stored value。

完成标准：

- 常见 Pine collection 示例能稳定改写。
- 大脚本不会无约束消耗宿主内存。

### 5.7 Strategy deterministic replay 深化

Strategy 的长期方向是 deterministic replay layer，而不是 broker emulator。

目标：

- 继续覆盖 Pine 用户常见策略报告和订单语义。
- 保持 fill assumption 明确、可测试、可解释。
- 不进入真实券商模拟器范围。

工作项：

1. Report 细化：
   - 更多 `strategy.closedtrades.*` accessor。
   - 更多 `strategy.opentrades.*` accessor。
   - summary 字段完善。
   - lifecycle 字段稳定化。
2. Fill/risk golden：
   - same-bar ambiguity。
   - intrabar path policy。
   - margin admission。
   - risk lock。
   - partial close / partial exit。
   - OCA。
   - commission allocation。
3. 差异文档：
   - 不做 tick/orderbook。
   - 不做真实 margin call。
   - 不做 broker-side liquidation。
   - 不推断未知 intrabar path。

完成标准：

- 常见 Pine strategy 思路可以用 Pyne 表达，并获得可解释报告。
- TradingView 对照覆盖继续扩大，但不承诺未公开 broker emulator 细节完全一致。

### 5.8 Output schema 与宿主集成协议

既然复杂图形由外部应用渲染，Pyne 的 output contract 必须足够稳定。

目标：

- 宿主可以安全消费 Pyne 输出。
- schema 变化可追踪、可迁移。
- 1.0 前冻结关键 contract。

工作项：

1. Schema versioning：
   - input schema version。
   - output schema version。
   - param schema version。
   - strategy report schema version。
2. Renderer contract：
   - lines。
   - markers。
   - fills。
   - colors。
   - objects snapshot。
   - object events。
   - alerts/signals。
3. Strategy contract：
   - orders。
   - lifecycle。
   - position。
   - summary。
   - closedtrades。
   - opentrades。
4. Docs and fixtures：
   - schema examples。
   - host consumption examples。
   - breaking change migration notes。

完成标准：

- 外部应用可以按 schemaVersion 分支处理。
- 破坏性变化必须有迁移说明和测试。

### 5.9 Developer experience 与包成熟度

Pyne 作为 Python 包需要逐步走向可依赖、可发布、可升级。

目标：

- IDE 体验更好。
- 错误更可诊断。
- 发布和升级更可控。

工作项：

1. Type hints：
   - public API 完整 typing。
   - namespace autocomplete。
   - provider protocol typing。
2. Packaging：
   - wheel build。
   - release checklist。
   - changelog。
   - semver policy。
3. Docs：
   - 文档站或清晰 docs index。
   - API reference。
   - tutorials。
   - cookbook。
   - host integration guide。
4. Quality gates：
   - unit tests。
   - golden tests。
   - capture diff。
   - CLI contract tests。
   - package smoke tests。

完成标准：

- 宿主应用可以稳定依赖 Pyne minor version。
- 用户能通过 docs 和 IDE 快速发现 API。

## 6. 推荐里程碑

### Milestone A：Pine 用户迁移体验

范围：

- Pine-to-Pyne cookbook。
- validate AST diagnostics。
- 常见误用 error hints。
- 更多迁移 examples。

价值：

- 直接降低会 Pine 用户上手 Pyne 的成本。
- 比继续堆冷门 API 更能改善实际体验。

### Milestone B：Input schema 与宿主参数面板协议

范围：

- 补齐高频 `input.*`。
- 参数 metadata。
- 参数 schema。
- override 校验。

价值：

- 让外部应用可以自动生成脚本配置 UI。
- 让 Pyne 更像真正可嵌入的 runtime。

### Milestone C：Request provider contract 与更多 golden

范围：

- HTF/LTF gaps/lookahead 边界。
- provider metadata/capability。
- request error model。
- 更多 TradingView-backed request capture。

价值：

- 多周期是 Pine 用户核心需求。
- 也是宿主集成风险最高的区域之一。

### Milestone D：Realtime state 与 `varip`-like API

范围：

- `varip`-like state。
- preview/confirmed tests。
- batch/incremental convergence fixtures。
- realtime host guide。

价值：

- 支持实时图表应用。
- 减少 batch 和 incremental 行为分裂。

### Milestone E：Collection history 与资源限制

范围：

- array/map/matrix history snapshots。
- nested values。
- collection limits。
- error semantics。

价值：

- 提升复杂 Pine-like 脚本迁移能力。
- 保护宿主资源。

### Milestone F：Strategy report 和 golden 扩展

范围：

- 更多 trade accessor。
- lifecycle 稳定化。
- risk/margin/cost 边界。
- TradingView-backed captures 扩展。

价值：

- 继续增强策略用户信心。
- 保持 deterministic replay 的清晰边界。

### Milestone G：1.0 Contract Hardening

范围：

- public API freeze。
- schema freeze。
- semver。
- migration guide。
- release gates。

价值：

- 让外部应用可以长期依赖 Pyne。

## 7. 每个里程碑的完成标准

每个里程碑都应该同时完成：

1. Runtime/API 实现。
2. 单元测试。
3. 必要的 golden 或 capture diff。
4. `docs/reference/pine_like_api_matrix.md` 更新。
5. 对应 API 文档或概念文档更新。
6. 至少一个可运行 example。
7. 完整质量门禁通过。

没有测试和文档的功能，不应该算完成。

## 8. 近期建议

当前代码已经完成了 Pine-to-Pyne cookbook、`validate()` 迁移诊断、
完整 `input.*` metadata、param schema、`varip()`、collection limits、
schema contract、TA capture、strategy capture 和 request capture。下一阶段
不应该继续堆 A/B/C 里已经落地的基础能力，而应该把已经有外部证据的
provider contract 收紧：

```text
Milestone C: Request provider contract 收口与 host 集成硬化
```

已完成的 request 外部证据切片：

1. `request.security()` HTF alignment capture 已进入 parity。
2. `request.security_lower_tf()` grouping、tuple thunk 和 slot 输出已进入 parity。
3. `request.security()` requested `time_close` capture 已进入 parity。
4. `request.security()` requested-context metadata/session capture 已进入 parity。
5. capture pack、status、next、import、diff 工具已经能管理 request fixture。
6. lower-timeframe slot plots 可以重建 provider bars，并参与 diff replay。
7. diff replay 支持 fixture 级 `provider_metadata`，避免使用默认 metadata。
8. `request.security()` 四种 `gaps` / `lookahead` 组合 capture 已进入 parity。
9. `request.security()` daily requested-context capture 已进入 parity，覆盖
   requested `time` / `time_close`、`timeframe.isdaily` 和非 intraday metadata。
10. `request.security()` requested-context session flag capture 已进入 parity，
    覆盖 `session.ismarket`、`session.isfirstbar` 和 `session.islastbar`。
11. `request.security()` requested-context timezone capture 已进入 parity，
    覆盖 UTC 与 Asia/Shanghai hour / day-of-week。
12. request provider error categories 已用 schema-driven focused tests 覆盖
    `request.security()` 与 `request.security_lower_tf()` 两条 API。
13. `request.security(..., ignore_invalid_symbol=True)` invalid-symbol capture
    已进入 parity，覆盖 invalid result 的 `na` / `nz()` fallback 可观测行为。
14. `request.security_lower_tf(..., ignore_invalid_symbol=True)` invalid-symbol
    capture 已进入 parity；TradingView 返回的是 `na` array id，Pine
    capture 脚本需先防护再调用 `array.*` 方法，Pyne 的空数组语义在
    `size()` / fallback / empty flag 观测上与 TradingView 对齐。
15. `request.security()` requested-context expression capture 已进入 parity；
    覆盖复合表达式、条件表达式和 requested-context history 表达式。history
    表达式需要在 external capture 中保留窗口前一根 provider bar。
16. `request.security_lower_tf(..., ignore_invalid_timeframe=True)` invalid-timeframe
    capture 已进入 parity；Pyne 先按可识别的 chart bar spacing 防护非法
    lower timeframe，并返回空 lower-TF groups。
17. `request.security(..., ignore_invalid_symbol=True)` tuple expression
    capture 已进入 parity；Pyne 已按表达式形状返回多个全 `na` series，
    防止 ignored invalid symbol 时 tuple 解包失败。
18. `request.security_lower_tf(..., ignore_invalid_symbol=True)` tuple
    expression capture 已进入 parity；Pine 侧脚本对 invalid lower-TF 返回的
    `na` array id 先做 guard，再观测每个 tuple slot 的空数组/fallback 语义。
19. `request.security_lower_tf(..., ignore_invalid_timeframe=True)` tuple
    expression capture 已进入 parity；继续覆盖非法 lower timeframe 下 tuple
    slot 的空数组/fallback 语义。
20. `request.security(..., ignore_invalid_symbol=True)` calculated expression
    capture 已进入 parity；继续覆盖 ignored invalid symbol 进入 callable
    expression / requested-expression 计算路径后的 `na` / fallback 语义。
21. `request.security_lower_tf(..., ignore_invalid_symbol=True)` calculated
    expression capture 已进入 parity；继续覆盖 invalid lower-TF `na` array id
    guard 与 calculated expression 空数组/fallback 语义。
22. `request.security_lower_tf()` requested-context capture 已进入 parity；
    继续覆盖 lower-TF 内部 `time` / `time_close`、`timeframe.multiplier`
    与 provider bar slot 重建。
23. `request.security_lower_tf()` requested-context timezone capture 已进入
    parity；继续覆盖 lower-TF 内部 UTC / Asia/Shanghai hour 与 day-of-week。
24. `request.security_lower_tf()` array helper capture 已进入 parity；继续覆盖
    lower-TF array `first` / `get(default)` / `min` / `max` / `sum` / `avg`。
25. `request.security()` same-timeframe capture 已进入 parity；继续覆盖
    same timeframe close/history/tuple/gaps/lookahead 与 provider bar 重建。
    `close[1]` 需要在 external capture 中保留窗口前一根 provider bar。

当前外部 capture 状态：

- Request：21/21 captured，0 diff。
- Strategy：27/27 captured，0 diff。
- TA：9/9 captured，0 diff。

推荐的下一个最小切片：

1. 收紧 provider cache 行为：同一 run 内相同
   `(symbol, timeframe, start, end)` 请求应该复用 provider 结果，并用 focused
   tests 固定调用次数。
2. 补 request provider contract 文档：说明 capability、metadata、invalid symbol、
   invalid timeframe、provider exception 和 external capture replay 的稳定边界。
3. 保留 capture 工具链作为 regression gate：新增 request 语义时仍然走
   scaffold -> TradingView CSV -> import -> diff -> check。

这个方向能把多周期 request 从“外部证据已足够厚”推进到“host 集成契约也足够稳”。
它比继续补冷门 API 更能降低宿主集成风险，也能让
`request.security()` / `request.security_lower_tf()` 的兼容性声明落到可执行的
provider contract 上。
