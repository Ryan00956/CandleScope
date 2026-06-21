# Pine-like 语义阶段进度

本文记录 Pyne 作为 Python 包时，向 Pine 运行时语义靠近的当前进度、
剩余差距和下一步执行顺序。它不是编译器或解释器计划；Pyne 不直接运行
TradingView Pine 源码，而是在 Python API 层提供尽量接近 Pine 的数据、
执行、绘图、请求和策略语义。

## 边界

- Pyne 是 Python 包，不做 Pine 源码解析、编译或解释。
- Python 用户可以直接写 Python 语句；Pyne API 负责承载 Pine-like 的运行时概念。
- Python 语法无法重载的 Pine 表达方式需要显式 API 近似，例如：
  - Pine 三元表达式要用 `when(cond, a, b)`。
  - Pine `if`/`switch` 对 series 分支要用 `when()` 或 `switch()`。
  - Pine `:=` 递归赋值要用 `var()` / `pyne.var()` 状态单元。
  - `request.security()` 的表达式上下文要用 callable thunk，例如 `lambda ctx: ctx.close`。

## 已完成的主要语义

### Series 与执行模型

- `PyneSeries` 支持 Pine-like 历史引用：`close[1]`、`high[2]`。
- `na`、`na(x)`、`nz(x)`、series 算术、比较、布尔组合已经可用。
- `bar_index`、`time`、`time_close`、`barstate.*`、增量执行上下文已经覆盖。
- `syminfo`、`timeframe`、`session` 等运行时元数据可由 host 或 `PyneSettings` 注入。

### 状态与表达式辅助

- `var()`、`pyne.var()`、`set_each()` 覆盖 Pine 的跨 bar 状态模型。
- `when()`、`switch()` 覆盖 Python 语法无法表达的 series 条件选择。
- 顶层内置与运行时上下文已支持 batch 和 incremental 两种口径。

### 集合类型

- `array.*` 核心可变数组语义已可用。
- 支持 `array.new_*()`、`array.from_values()`、`get/set/push/pop/shift/unshift`、
  `insert/remove/clear/copy/slice/fill/reverse/sort`、搜索和数值聚合。
- Python 关键字限制下，Pine 的 `array.from(...)` 对应为
  `array.from_values(...)` / `array.from_list(...)`。
- `map.*` 核心 key/value 语义已可用，包含 `new/from_values/get/put/remove`、
  `contains/keys/values/copy/clear/size`。
- `matrix.*` 核心二维容器语义已可用，包含 `new/from_rows/get/set/row/col`、
  `transpose/reshape/add/sub/mult` 和数值聚合。

### TA 与数据输出

- 常用 `ta.*` 已覆盖：`sma`、`ema`、`rsi`、`macd`、`bb`、`atr` 等。
- 扩展 TA 已覆盖：`alma`、`hma`、`swma`、`dmi`、`sar`、percentiles 等。
- TA 状态查询 helper 已覆盖：`highestbars`、`lowestbars`、`barssince`、
  `valuewhen`。
- 输出使用稳定 JSON schema，适合宿主图表层渲染。

### 标准库宽度

- `str.*` 高频字符串 helper 已可用。
- 覆盖 `tostring/tonumber/length/substring/pos/contains/startswith/endswith`、
  `replace/replace_all/split/trim/upper/lower/repeat/format`。
- `str` namespace 保持可调用，因此 `str(value)` 仍然可用。
- `ticker.*` 核心 ticker id helper 已可用，覆盖 `new/inherit/modify/standard`
  和 `heikinashi/renko/linebreak/kagi/pointfigure`。
- `time.*` helper 已可用，同时保留 `time` 的 series 行为，覆盖
  `year/month/dayofmonth/dayofweek/hour/minute/second/timestamp/format`。
- `color.*` helper 已扩展，覆盖 `rgb/new/r/g/b/t/when/from_gradient` 和常用颜色常量。
- `math.*` 常用 helper 已扩展，覆盖 variadic `max/min/avg`、rolling `sum`、
  `round_to_mintick`、`random(seed=...)`、三角函数、幂函数和常量。

### Plot 与绘图对象

- `plot()`、`hline()`、`fill()`、`marker()`、`bgcolor()`、`barcolor()` 已可用。
- `plotshape()`、`plotchar()`、`plotarrow()` 已可用，并映射到现有 marker 输出协议。
- 已加入 Pine-like enum namespace：
  - `shape.*`
  - `location.*`
  - `size.*`
  - `display.*`
  - `format.*`
  - `scale.*`
  - `xloc.*`
  - `yloc.*`
  - `line.*`、`label.*`、`box.*`、`text.*`、`position.*`
- `indicator(..., format=..., scale=..., precision=...)` 可写入 metadata。
- `label.new(..., yloc=...)`、`label.set_xloc()`、`label.set_yloc()` 已支持。
- 增量执行已支持 `line`、`label`、`box`、`table` 的 create/update/delete
  事件流，输出到 `output["object_events"]`，同时保留当前对象快照
  `output["objects"]`；preview 事件运行在克隆上下文中，不污染持久 session。

### Request 多上下文

- `request.security()` 支持 callable thunk、tuple 返回、字段表达式。
- `request.security_lower_tf()` 支持 lower timeframe 分组。
- lower timeframe 返回对象支持 `to_lists()`、`size()`、`first()`、`last()`、
  `get()`、`sum()`、`min()`、`max()`、`avg()` 和 bars-back。
- `barmerge.gaps_*`、`barmerge.lookahead_*` 已加入并校验。
- `ignore_invalid_symbol` 已覆盖 invalid symbol 容错。
- provider capability、provider metadata、requested context cache 已完成。
- 已有 higher timeframe alignment 与 lower timeframe alignment golden fixture。
- 已补充 request edge-case golden fixture，覆盖错位 chart/requested 时间轴下的
  `gaps` / `lookahead`、requested context history、tuple thunk、lower timeframe
  空桶聚合默认值，以及 capability / invalid symbol 组合口径。

### Strategy

- `strategy.entry()`、`strategy.order()`、`strategy.exit()`、`strategy.close()`、
  `strategy.close_all()`、`strategy.cancel()`、`strategy.cancel_all()` 已可用。
- `same_bar_fill_priority` 已支持，用于显式控制同一根 bar 同时触及 stop/limit
  时选择 `strategy.same_bar.stop_first` 还是 `strategy.same_bar.limit_first`。
- `intrabar_path` 已支持，用于选择 `strategy.intrabar.same_bar_priority`、
  `strategy.intrabar.open_high_low_close` 或 `strategy.intrabar.open_low_high_close`。
- `strategy.close()` / `strategy.close_when()` 支持 `qty` 和 `qty_percent`。
- `strategy.exit()` 支持 `qty` 和 `qty_percent`，并保持 `qty` 优先。
- 已有 OCA、pyramiding、commission、slippage、limit verification、margin、
  risk rules、closed/open trade ledgers 和 strategy summary。
- `strategy.lifecycle` 已输出订单生命周期视角，覆盖 pending、filled、
  canceled、rejected、market_fill、pending_fill、pending_canceled、
  pending_rejected、exit/close/cancel/rejected 等阶段，便于宿主层和测试层
  观察 Pine-like 回放逻辑。
- `strategy.lifecycle` 已区分 `requested_qty`、`filled_qty`、`target_qty`
  和 `qty_percent`，用于观察 max position size 截断、partial close/exit 等
  数量语义。
- Strategy golden fixture 已覆盖 same-bar stop/limit priority、intrabar path
  policy、lifecycle quantity/cancel/rejected 语义，以及 risk lock 拒绝
  entry/order 但允许 close_all 的回放行为。
- Strategy lot matching golden fixture 已覆盖 `strategy.close()` 按 entry id
  partial close、`strategy.close_all()` FIFO 拆分，以及 `strategy.exit()`
  `from_entry` partial exit。
- Strategy intraday risk reset golden fixture 已覆盖 `session_isfirstbar`
  重置 `max_intraday_loss` 和 `max_intraday_filled_orders` 的回放行为。
- Strategy pending risk lock golden fixture 已覆盖 pending entry 在 intraday
  risk lock 下保持挂起并在 session reset 后成交，以及在 global drawdown lock
  下保持 `pending` 的行为。
- Strategy OCA lifecycle golden fixture 已覆盖 `strategy.oca.cancel` 取消 sibling
  pending order，以及 `strategy.oca.reduce` 减少 sibling pending quantity。
- Strategy cost model golden fixture 已覆盖 percent commission、cash per contract、
  tick slippage、long/short round trip、partial close、close_all 和 reversal order
  的手续费分摊、pending stop/limit fill 在成本模型下的 lifecycle 细节，以及
  same-bar stop/limit priority 与 intrabar path 对成本回放的影响；
  `closedtrades.commission` 已包含 entry lot 手续费分摊和 exit/close/reversal
  成交手续费分摊。
- Strategy limit verification cost golden fixture 已覆盖
  `backtest_fill_limits_assumption` 下未满足验证时 pending entry 保持挂起、不产生
  commission，以及满足验证后仍按 limit price 加 slippage 成交的 entry/exit 成本回放。
- Strategy bracket/stop-limit cost golden fixture 已覆盖 short bracket exit 的
  stop/limit 成交方向、slippage 和 commission，以及 pending stop-limit entry
  同 bar 双触发时 `stop_first` / `limit_first` 对成交原因、价格和 lifecycle 的影响。
- Strategy risk/margin cost golden fixture 已覆盖 risk lock 与 margin rejection
  不产生 commission、rejected lifecycle 保持 `filled_qty=0`，以及已持仓
  `close_all` 仍按 entry/exit 成本口径写入 closed trade。
- Strategy entry sizing cost golden fixture 已覆盖 `strategy.entry` 反转按真实
  transaction quantity 计手续费、lifecycle 暴露 `transaction_qty`，以及
  max position size 截断、pyramiding 拒绝与成本模型交叉时的手续费边界。
- Strategy reversal lot cost golden fixture 已覆盖 multi-lot FIFO reversal、
  小目标反转和 pending stop entry reversal 的 lot/cost 分摊，确保 entry 反转同时
  关闭旧 lot 并打开新 lot 时，closed/open trade commission 都按 transaction quantity
  正确分摊。
- Strategy OCA cost golden fixture 已覆盖 `strategy.oca.cancel` 取消 sibling
  pending order 不产生 commission，以及 `strategy.oca.reduce` 缩量后的 sibling
  pending order 按实际 reduced filled quantity 计 cash-per-contract commission。
- Strategy pending risk recovery cost golden fixture 已覆盖 global drawdown lock
  下 pending entry 保持挂起且不产生 commission，但已有持仓仍可通过 `strategy.exit`
  回收；同时覆盖 intraday risk lock 下 `strategy.close` 可部分回收已有持仓，
  并在 `session_isfirstbar` reset 后重新允许 pending entry 成交。
- Strategy cancel risk cost golden fixture 已覆盖 risk lock 下 `strategy.cancel()`
  与 `strategy.cancel_all()` 仍可清理 pending entry/order，取消动作不产生
  commission，且被取消的 pending order 在后续触价或 intraday reset 后不会复活。
- Strategy trade accessor golden fixture 已覆盖 `strategy.closedtrades.*` 与
  `strategy.opentrades.*` 的 size/qty/profit/net_profit/commission/entry_price/
  exit_price/entry_time/exit_time/entry_id/exit_id/side 字段，包含负索引、
  空 ledger 的默认 `0` / `-1` numeric accessor 返回 `0`、非空 ledger 越界
  numeric 为 `na`、missing string 为空字符串，以及 closed/open ledger 同时
  存在时的读取口径。
- Strategy mixed lifecycle cost golden fixture 已覆盖 risk lock 延迟 pending fill
  后，intraday reset 再触发 OCA cancel / OCA reduce，并继续由 `strategy.cancel()`
  或 `strategy.cancel_all()` 清理剩余 pending order 的 lifecycle 顺序、成本分摊
  和 `submitted_time` / `filled_time` / `canceled_time` 口径。

## 仍然不是 Pine 的地方

这些差异来自 Python 包边界或当前实现阶段，不代表必须做 Pine 编译器：

- 不能直接运行 `.pine` 源码。
- 不能让 Python `if cond:` 对 series 做 Pine 式逐 bar 分支。
- 不能让 Python 原生三元表达式 `a if cond else b` 对 series 做 Pine 式选择。
- 不能捕获 `request.security(symbol, tf, close + open)` 这种裸表达式的 AST 上下文；
  需要 `lambda ctx: ctx.close + ctx.open`。
- Strategy 仍是确定性回放模型，不是完整券商模拟器。
- Drawing output 是宿主渲染 JSON 协议，不是 TradingView 原生图层对象。

## 下一阶段优先级

### P1: Plot wrapper 补齐

视觉 enum 基础已经完成，`plotshape()`、`plotchar()` 和 `plotarrow()` 已完成。
后续可继续补齐更细的绘图显示参数，但常见 plot wrapper 已经进入可迁移状态。

它们先映射到现有 `marker()` / plot output schema，不需要改变宿主渲染协议。

### P2: 集合类型

面向 Python 包的 Pine-like 集合 API：

- `array.*` 核心语义已完成；后续可以补历史快照和更细的 Pine 边界行为。
- `map.*` 核心语义已完成。
- `matrix.*` 核心语义已完成。

重点不是模仿 Pine 语法，而是保留 Pine 的可变集合语义、历史引用边界和运行时错误口径。

### P3: 标准库宽度

继续扩展高频 namespace：

- `str.*` 高频 helper 已完成；后续可补更细的时间格式化口径。
- `ticker.*` 核心 helper 已完成。
- 更多 `time.*` 核心 helper 已完成。
- 更完整的 `color.*` 核心 helper 已完成。
- 更多真实 Pine 输出对照 golden

### P4: Strategy 回放语义深化

- same-bar stop/limit 触发顺序策略已明确，默认 `stop_first`，可配置 `limit_first`。
- intrabar path policy 已支持 high-before-low / low-before-high 两种确定性假设。
- 订单生命周期报告已加入 `strategy.lifecycle`，并覆盖常见 rejected 原因和
  requested/filled quantity 细节；后续可继续扩展更多 broker-emulator 风格事件。
- 已增加 strategy same-bar、lifecycle、risk lock、lot matching 与 intraday
  reset、pending risk lock、OCA lifecycle、cost model、limit verification cost、
  bracket/stop-limit cost、risk/margin cost、entry sizing cost、reversal lot cost
  与 OCA cost、pending risk recovery cost、cancel risk cost、trade accessor
  和 mixed lifecycle cost golden fixtures；
  后续继续扩大覆盖面。

### P5: Golden 与兼容性证据

- TA golden fixtures 已开始覆盖 `sma`、`ema`、`rma`、`rsi`、rolling extremes、
  `highestbars`、`lowestbars`、`barssince`、`valuewhen`、`macd`、`bb`、
  `atr`、`alma`、`dmi`、`sar`、`hma`、`swma`、`cmo`、`wpr`、`tsi`、
  `percentile_*`、`dev`、`variance`、`stoch`、`cci`、`mfi`、`vwma`
  与 `supertrend`；fixture 内保留 `pine_equivalent`，后续可把 TradingView
  导出的序列替换/追加为外部对照。
- request edge-case golden fixtures 已覆盖 Pyne 定义的 gaps/lookahead、
  lower-timeframe grouping、空桶默认值、tuple thunk 和 capability/invalid symbol
  组合场景；后续可继续补真实 Pine 输出对照。
- strategy fill golden fixtures 已开始覆盖 same-bar、lifecycle、risk lock、
  lot matching、intraday reset、pending risk lock、OCA lifecycle、cost model 与
  limit verification cost、bracket/stop-limit cost、risk/margin cost、entry sizing cost
  和 reversal lot cost、OCA cost、pending risk recovery cost、cancel risk cost
  与 trade accessor、mixed lifecycle cost 场景，后续继续扩大。
- strategy pine-equivalent smoke fixture 已加入基础 market round-trip 对照样板：
  Pyne 脚本显式使用 `price=close` 固定成交价，fixture 同时保存
  `process_orders_on_close=true` 的 Pine scaffold，方便后续替换为 TradingView
  导出的外部序列。
- strategy pine-equivalent pending entry fixture 已加入 limit entry 与 stop entry
  样板，用于对照 pending 提交、触发成交、平仓、position/equity/netprofit
  与 lifecycle 口径。
- strategy pine-equivalent bracket exit fixture 已加入 limit exit 与 stop exit
  样板，用于对照 `strategy.exit()` bracket 的出场原因、成交价、closed trade、
  position/equity/netprofit 与 lifecycle 口径。
- strategy pine-equivalent cost fixture 已加入 cash-per-order commission 与 tick
  slippage 往返样板，用于对照 gross profit、commission、net profit、equity
  与 closed trade cost allocation 口径。
- strategy pine-equivalent cost allocation fixture 已加入 percent commission 与
  cash-per-contract partial close 样板，用于对照按名义金额、按合约数和按部分平仓
  比例分摊的 closed trade 成本口径。
- strategy pine-equivalent reversal/pyramiding fixture 已加入 opposite entry 反转与
  pyramiding=1 同向加仓样板，用于对照 transaction quantity、独立 entry lot、
  close_all FIFO 平仓、position/equity/netprofit 与 lifecycle 口径。
- strategy pine-equivalent OCA/risk fixture 已加入 OCA cancel 与 OCA reduce 在
  intraday risk lock 下延迟 pending fill、session reset 后恢复触发、取消 sibling
  或缩减 sibling quantity 的样板。
- strategy pine-equivalent risk/size/limit fixture 已加入 global drawdown lock、
  max position size 截断与 limit verification tick 假设样板，用于对照 rejected
  lifecycle、filled_qty 截断、pending limit 验证、commission 与 closed trade 口径。
- strategy pine-equivalent exit/path fixture 已加入 `strategy.exit(qty_percent=...)`
  partial exit、same-bar stop/limit priority 与 intrabar path 样板，用于对照
  exit target_qty/filled_qty、同 bar 双触发分支与显式高低路径分支。
- strategy pine-equivalent short-side fixture 已加入 short bracket stop/limit 分支、
  short max position size 截断与 short OCA reduce cost allocation 样板，用于对照
  空头方向的 slippage、commission、filled_qty 截断和 reduced sibling quantity。
- strategy pine-equivalent margin/order/cancel fixture 已加入 margin admission、
  lower-level `strategy.order` net-position 减仓/反转，以及 `strategy.cancel()` /
  `strategy.cancel_all()` 清理 pending order 后不复活的样板。
- 10 个 priority strategy pine-equivalent TradingView capture 已全部进入
  `parity` gate，覆盖 market round-trip、bracket exit、percent commission、
  cash-per-contract partial close、reversal、pyramiding、margin admission、
  `strategy.order` 减仓/反转，以及 `strategy.cancel()` / `strategy.cancel_all()`
  pending 清理；聚合 diff 为 `10 captured case(s), 67 plot(s), 195 point(s),
  0 difference(s)`。
- 第二批非 priority capture 已开始推进；`cash_per_order_slippage_round_trip`
  已导入 TradingView 60m export，并因补齐 fixture 的
  `process_orders_on_close=True` 进入 `parity` gate。当前 strategy capture
  聚合 diff 为 `11 captured case(s), 75 plot(s), 211 point(s),
  0 difference(s)`。
- `exit_partial_then_close_all` 已通过诊断导出确认 TradingView 在
  `process_orders_on_close=true` 下对本 bar 新提交的 marketable `strategy.exit`
  使用 bar close 填价、下一根 bar 才可见，并按 FIFO 关闭实际 lot；
  该 case 已提升为 `parity`。当前 strategy capture 聚合 diff 为
  `12 captured case(s), 83 plot(s), 243 point(s), 0 difference(s)`。
- `same_bar_exit_stop_first` 已导入 TradingView 60m export，并确认
  `process_orders_on_close=true` 下上一根 bar 已挂出的 marketable bracket exit
  使用上一根 close 作为填价参考；该 case 已提升为 `parity`。当前 strategy
  capture 聚合 diff 为 `16 captured case(s), 103 plot(s), 283 point(s),
  0 difference(s)`。
- `oca_cancel_waits_for_intraday_risk_reset` 已导入 TradingView 60m export，并确认
  `strategy.risk.max_intraday_loss` 会在 bar 内亏损触发时自动强平当前仓位；该
  case 已提升为 `parity`。当前 strategy capture 聚合 diff 为
  `17 captured case(s), 109 plot(s), 307 point(s), 0 difference(s)`。
- `oca_reduce_waits_for_intraday_risk_reset` 已导入 TradingView 60m export，并确认
  `process_orders_on_close=true` 下 OCA reduce pending order 与 intraday risk
  reset 的组合行为；该 case 已提升为 `parity`。当前 strategy capture 聚合 diff 为
  `18 captured case(s), 115 plot(s), 337 point(s), 0 difference(s)`。
- `limit_entry_then_close` 已导入 TradingView 60m export；在 BTCUSDT.P 60m
  采集窗口内 limit entry 未触发，Pyne 与 TradingView 的空仓序列一致。该 case
  已提升为 `parity`。当前 strategy capture 聚合 diff 为
  `19 captured case(s), 120 plot(s), 352 point(s), 0 difference(s)`。
- `stop_entry_then_close` 已导入 TradingView 60m export，并确认
  `process_orders_on_close=true` 下 stop entry 成交后的可见时点与后续 close
  可见性。该 case 已提升为 `parity`。当前 strategy capture 聚合 diff 为
  `20 captured case(s), 125 plot(s), 367 point(s), 0 difference(s)`。
- `global_drawdown_lock_rejects_entries` 已导入 TradingView 60m export，并确认
  `strategy.risk.max_drawdown` 与 `strategy.risk.max_intraday_loss` 不同：
  global drawdown 进入风险锁后拒绝后续 entry/order，但不会像 intraday loss
  那样自动强平已有持仓；在 `process_orders_on_close=true` 下同 bar 的
  `close_all` 可见性仍延后到下一根 plot。该 case 已提升为 `parity`。当前
  strategy capture 聚合 diff 为
  `21 captured case(s), 131 plot(s), 385 point(s), 0 difference(s)`。
- `max_position_size_caps_entry` 已导入 TradingView 60m export，并确认
  `strategy.risk.max_position_size(3)` 会把首笔 5 手 long entry 截断为 3 手；
  后续同方向 entry 因已达到上限被拒绝。该 case 已提升为 `parity`。当前
  strategy capture 聚合 diff 为
  `22 captured case(s), 137 plot(s), 403 point(s), 0 difference(s)`。
- `limit_verification_waits_for_tick_assumption` 已导入 TradingView 60m export；
  在 BTCUSDT.P 采集窗口内，`limit=10` 未触及，Pyne 与 TradingView 均保持
  空仓、无成交、无 commission。该 case 已提升为 `parity`。当前 strategy
  capture 聚合 diff 为
  `23 captured case(s), 143 plot(s), 427 point(s), 0 difference(s)`。
- `short_bracket_stop_first_costs` 已导入 TradingView 60m export，并确认 short
  exit stop 在提交时已经 marketable 时按当前参考价成交，而不是按远离市场的
  stop 价成交；本地 short-side fixture 也已对齐 `process_orders_on_close=True`。
  该 case 已提升为 `parity`。当前 strategy capture 聚合 diff 为
  `24 captured case(s), 149 plot(s), 439 point(s), 0 difference(s)`。
- `short_bracket_limit_first_costs` 已导入 TradingView 60m export；TradingView
  侧没有 Pyne 的 `same_bar_fill_priority=limit_first` 旋钮，但在本次 BTCUSDT.P
  窗口中 short bracket 输出仍与 Pyne 当前序列一致。该 case 已提升为 `parity`。
  当前 strategy capture 聚合 diff 为
  `25 captured case(s), 155 plot(s), 451 point(s), 0 difference(s)`。
- `short_max_position_size_caps_entry` 已导入 TradingView 60m export，并确认
  short 方向同样会被 `strategy.risk.max_position_size(3)` 截断到 3 手；
  后续同方向 entry 因达到上限被拒绝。该 case 已提升为 `parity`。当前
  strategy capture 聚合 diff 为
  `26 captured case(s), 161 plot(s), 469 point(s), 0 difference(s)`。
- `short_oca_reduce_costs_use_reduced_quantity` 已导入 TradingView 60m export；
  在本次 BTCUSDT.P 采集窗口内，short stop orders 未触发，Pyne 与 TradingView
  均保持空仓、无成交、无 commission。该 case 已提升为 `parity`。当前
  strategy capture 聚合 diff 为
  `27 captured case(s), 168 plot(s), 497 point(s), 0 difference(s)`。
- strategy pine-equivalent fixture 已加入 `external_capture` 可选字段约定；
  当 `status="captured"` 且包含 TradingView 导出的 plot `values` 时，golden
  runner 会把外部序列纳入断言。
- 已加入 `scripts/strategy_capture_status.py`，用于统计 `captured`、
  `not_captured` 与 `missing` 的 strategy pine-equivalent capture 状态。
- 已加入 `scripts/strategy_capture_import.py`，支持从 TradingView 导出的 JSON/CSV
  plot 序列写回 `external_capture.values`，并拒绝未知 plot 标题、缺失 plot
  标题与长度不匹配的导出。
- 已加入 `scripts/strategy_capture_scaffold.py`，用于给新增或既有
  strategy pine-equivalent case 补齐 `not_captured` 占位；当前 27 个 case
  已全部具备 `external_capture` contract，状态脚本不再报告 `missing`。
- 已加入 `scripts/strategy_capture_prepare.py`，用于生成 TradingView 导出准备包：
  `.pine` 文件、`_bars.csv` 数据窗口核对文件、`manifest.json` 和人工执行 README，
  默认覆盖 10 个 priority case。
- 已加入 `scripts/strategy_capture_next.py`，用于读取当前 capture 状态并输出下一条
  待采集 case 及 prepare/preflight/import/diff 命令。
- 已加入 `scripts/strategy_capture_preflight.py`，用于在导入前检查 TradingView
  CSV 导出文件是否存在、plot 列是否完整、行数是否匹配，并校验可选 `time` 列。
- 测试层已保护 capture contract：`strategy_capture_scaffold.py --check` 必须对
  真实 golden fixtures 返回 0，priority case 必须全部具备 TradingView capture 元数据。
- 已加入 `scripts/strategy_capture_diff.py`，用于对比 `captured` 的 TradingView
  plot 序列与当前 Pyne 输出，并在发现差异或运行错误时返回非零退出码。
- batch / incremental parity tests。

## 下一步建议

下一步建议从 strategy pine-equivalent capture 转向非 strategy 方向：当前 27 个
strategy case 已全部具备 TradingView-backed `parity` capture，后续可继续采集
TA golden、`request.security()` edge case、array/map/matrix 历史快照边界等
真实 Pine 输出对照。strategy capture 若继续扩展新 case，仍使用
`strategy_capture_next.py`、`strategy_capture_prepare.py`、
`strategy_capture_preflight.py`、`strategy_capture_import.py` 和
`strategy_capture_diff.py` 维持同一条证据链。
完成后应同步更新：

- `tests/golden/`
- `tests/test_golden_*.py`
- `docs/api/ta.md`
- `docs/reference/pine_like_api_matrix.md`

验证门槛保持为完整检查脚本通过。
