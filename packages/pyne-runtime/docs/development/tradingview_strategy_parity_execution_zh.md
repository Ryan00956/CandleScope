# TradingView Strategy Parity 下一步执行文档

本文基于 2026-05-29 已导入的 10 份 TradingView strategy plot 导出数据，给出 Pyne strategy runtime 下一阶段的实现顺序、验收标准和质量门。

目标不是继续扩大采集数量，而是先利用这 10 份真实 TradingView reference，把第一批 priority strategy case 从“可采集、可 diff”推进到“关键语义可对齐、可回归”。

## 执行状态

截至 2026-05-29，本执行阶段的 10 个 priority case 已全部从 `reference`
升级为 `parity` gate：

```text
10 captured case(s)
67 plot(s)
195 point(s)
0 difference(s)
0 runtime error(s)
0 skipped
```

当前第一批 priority capture 仍为 `10/10 captured` 且全部 parity；后续第二批
非 priority 扩展已在独立流程中开始推进。剩余非 priority case 不属于本执行阶段的
runtime parity 修复范围。

## 执行前基线

已完成：

- `strategy_capture_status.py` 显示 `10/27 captured`。
- priority case 显示 `10/10 captured`。
- 10 份 capture 均已导入为 `external_capture.assertion = "reference"`。
- capture import 已保存 TradingView active window 的真实 `bars`，diff replay 使用 TV bars 而不是原 synthetic bars。
- focused capture tests 和全量测试通过。

执行前聚合 diff：

```text
10 captured case(s)
67 plot(s)
195 point(s)
107 difference(s)
0 runtime error(s)
0 skipped
```

这说明 capture 链路已经成立，但 Pyne strategy runtime 尚未达到 TradingView parity。

## 执行前 10 份 Reference 的语义结论

| Fixture | Case | TV reference 观察 | Pyne 执行前差异 | 归类 |
| --- | --- | --- | --- | --- |
| `strategy_pine_equivalent_smoke.json` | `market_round_trip_process_on_close` | market entry 后 TV 持仓、权益、open profit、最终 closed trade 均变化 | Pyne 多数点仍为空仓/权益不变 | market fill、默认保证金/下单准入、close timing |
| `strategy_pine_equivalent_bracket_exit.json` | `bracket_limit_exit` | 第 2 根 TV 已生成 1 笔 closed trade | Pyne `Closed Trades` 仍为 0 | bracket exit closed-trade 更新 |
| `strategy_pine_equivalent_bracket_exit.json` | `bracket_stop_exit` | stop bracket 同样在第 2 根生成 closed trade | Pyne `Closed Trades` 仍为 0 | bracket exit closed-trade 更新 |
| `strategy_pine_equivalent_cost_allocation.json` | `percent_commission_round_trip` | TV 第 2 根已持仓 2，权益、net profit、open profit 受百分比手续费和价格影响 | Pyne 仍为空仓/权益不变，closed trade accessor 输出缺失 | cost model、entry admission、trade accessor |
| `strategy_pine_equivalent_cost_allocation.json` | `cash_per_contract_partial_close_allocation` | TV 第 2 根持仓 4，第 3 根部分平仓到 2，并记录 first closed profit/commission/net profit | Pyne 仍为空仓，closedtrades accessor 多为 `None` | partial close、cost allocation、trade accessor |
| `strategy_pine_equivalent_reversal_pyramiding.json` | `reversal_long_to_short_then_flat` | TV 第 2 根开多，第 3 根反手为空头并生成 closed trade | Pyne 仍为空仓，closed trade 未生成 | reversal transaction quantity、lot close/open |
| `strategy_pine_equivalent_reversal_pyramiding.json` | `pyramiding_two_entries_then_flat` | TV 允许同向持仓并持续计 open profit | Pyne 仍为空仓，closed profit accessor 缺失 | pyramiding admission、open trade reporting |
| `strategy_pine_equivalent_margin_order_cancel.json` | `margin_long_rejects_then_small_fill` | 除 `Closed Commission` accessor 外，核心持仓/权益/净利润已对齐 | Pyne 缺少 `Closed Commission` plot 序列 | accessor-only gap |
| `strategy_pine_equivalent_margin_order_cancel.json` | `order_net_position_reduces_and_reverses` | TV 从 2 多降到 1 多，再反转到 2 空，生成两笔 closed trade | Pyne 仍为空仓，closed profit accessor 缺失 | `strategy.order` net position reduce/reverse |
| `strategy_pine_equivalent_margin_order_cancel.json` | `cancel_and_cancel_all_clear_pending` | TV 第 0 根空仓，第 1 根后持仓 1；pending cancel 后未复活 | Pyne 第 0 根已持仓并出现巨大 open profit | pending order chronology、cancel/cancel_all |

## 总体判断

1. 采集和导入不是主要问题。
   10 个 priority case 均通过 preflight，且 diff 没有 runtime error 或 skipped case。

2. 主要差异集中在 strategy broker emulator 语义。
   大部分问题不是浮点误差，而是持仓是否存在、何时成交、何时生成 closed trade、成本如何计入权益。

3. `closedtrades.*` / `opentrades.*` accessor 是最小且高收益的先修点。
   很多 diff 行是 TV 返回 `0` 或真实 profit/commission，而 Pyne 返回 `None`。这类问题可以先独立收敛，不必同时重写成交逻辑。

4. 默认下单准入和显式 margin 规则需要拆开处理。
   `margin_long_rejects_then_small_fill` 基本对齐，说明已有 margin 逻辑并非全错；但其他真实 BTC 价格 case 中，TV 允许的持仓 Pyne 常表现为空仓，说明默认 margin/admission 与 TV 行为不同。

5. 继续采剩余 17 个 case 的收益暂时低于修 runtime。
   当前 10 个 reference 已覆盖 market、bracket、cost allocation、reversal、pyramiding、margin/order/cancel。先修这些语义，后续 17 个 capture 才更有判别力。

## 实现阶段

### Phase 0: 固化分析入口

目的：让后续每次修复都有稳定命令和可读报告。

任务：

- 执行初期先保留 10 份 capture 的 `assertion = "reference"`，各 case 修到
   0 diff 后再按升级规则改为 `parity`；当前 10 个 priority case 已完成升级。
- 增加一个可选的 diff 摘要输出，按 `case` 和 `plot` 聚合差异数量，方便判断每个修复消掉了哪些差异。
- 在文档或测试输出中明确区分：
  - `reference`: 真实 TV 数据已收录，但不阻断 pytest parity。
  - `parity`: TV 数据必须与 Pyne 输出一致。
   - `strategy_capture_diff.py` 默认检查 `parity` gate；查看 reference 差异时显式
      使用 `--assertion reference` 或 `--assertion all`。

涉及文件：

- `scripts/strategy_capture_diff.py`
- `tests/test_strategy_capture_diff.py`
- `docs/development/quality_gates.md`

验收：

```powershell
.venv\Scripts\python.exe scripts\strategy_capture_diff.py --assertion all --summary `
  tests\golden\strategy_pine_equivalent_smoke.json `
  tests\golden\strategy_pine_equivalent_bracket_exit.json `
  tests\golden\strategy_pine_equivalent_cost_allocation.json `
  tests\golden\strategy_pine_equivalent_reversal_pyramiding.json `
  tests\golden\strategy_pine_equivalent_margin_order_cancel.json

.venv\Scripts\python.exe -m pytest tests\test_strategy_capture_diff.py -q
```

退出标准：

- diff 报告能快速看出每个阶段减少了哪些差异。
- 不改变现有 runtime 行为。

### Phase 1: Trade Accessor 序列补齐

目的：先消掉 `None` 类差异，让 `strategy.closedtrades.*` 和 `strategy.opentrades.*` 在 reference plots 中可对齐。

优先覆盖的 TV plot：

- `strategy.closedtrades.profit(0)`
- `strategy.closedtrades.commission(0)`
- `strategy.closedtrades.profit(0) - strategy.closedtrades.commission(0)`
- first/last closed trade profit
- `strategy.opentrades`

执行前证据：

- `percent_commission_round_trip` 的 `Closed Profit / Closed Commission / Closed Net Profit` 为 `None`。
- `cash_per_contract_partial_close_allocation` 的 First/Last closed cost 字段多为 `None`。
- `reversal_long_to_short_then_flat`、`pyramiding_two_entries_then_flat`、`order_net_position_reduces_and_reverses` 的 closed profit accessor 多为 `None`。
- `margin_long_rejects_then_small_fill` 除 `Closed Commission` 外基本对齐，因此这一步可以获得一个接近 parity 的 case。

涉及文件：

- `src/pyne_runtime/strategy/ledger.py`
- `src/pyne_runtime/strategy/module.py`
- `tests/test_strategy_runtime.py`
- `tests/test_golden_strategy.py`

实现要点：

- 明确 accessor 在无对应 trade 时的返回值，按 10 份 TV reference 的 plot 导出结果对齐。
- 确认 `StrategyTradesNamespace` 对负索引、越界索引、无交易时的 numeric/string 返回与当前 golden claim 一致；如 reference 证明 claim 不对，调整 claim 和测试。
- 不在这一阶段改变 fill timing、margin admission 或 lot matching。

阶段验收：

```powershell
.venv\Scripts\python.exe -m pytest tests\test_strategy_runtime.py -q
.venv\Scripts\python.exe -m pytest tests\test_golden_strategy.py -q
.venv\Scripts\python.exe scripts\strategy_capture_diff.py --assertion parity tests\golden\strategy_pine_equivalent_margin_order_cancel.json --case margin_long_rejects_then_small_fill
```

退出标准：

- `margin_long_rejects_then_small_fill` 的 diff 归零，或只剩有明确边界说明的非 accessor 差异。
- `None` 类 accessor 差异显著减少。

### Phase 2: 默认保证金与下单准入对齐

目的：解决真实 BTC 价格下，TV 已持仓而 Pyne 仍为空仓的问题。

执行前证据：

- `market_round_trip_process_on_close` 中 TV 第 1、2 根持仓 2，Pyne 为 0。
- `percent_commission_round_trip` 中 TV 第 2 根持仓 2，Pyne 为 0。
- `cash_per_contract_partial_close_allocation` 中 TV 持仓 4 后部分平仓到 2，Pyne 为 0。
- `reversal_long_to_short_then_flat` 和 `pyramiding_two_entries_then_flat` 也显示 TV 已建仓而 Pyne 未建仓。
- `margin_long_rejects_then_small_fill` 已基本对齐，说明显式 margin rejection 行为需要保护。

涉及文件：

- `src/pyne_runtime/strategy/costs.py`
- `src/pyne_runtime/strategy/risk.py`
- `src/pyne_runtime/strategy/replay.py`
- `tests/test_strategy_runtime.py`
- `tests/golden/strategy_pine_equivalent_smoke.json`
- `tests/golden/strategy_pine_equivalent_cost_allocation.json`
- `tests/golden/strategy_pine_equivalent_reversal_pyramiding.json`

实现要点：

- 区分默认策略配置和显式 `margin_long` / `margin_short` 配置。
- 默认情况下不要把高名义价值订单错误地当作 margin reject，除非 fixture 或 settings 明确要求。
- 保留已有 explicit margin rejection 语义，尤其保护 `margin_long_rejects_then_small_fill`。
- 重新核对 `initial_capital=1000`、qty 为 BTC 合约数量、TV 导出中权益变化的计算口径。

阶段验收：

```powershell
.venv\Scripts\python.exe scripts\strategy_capture_diff.py --assertion parity tests\golden\strategy_pine_equivalent_smoke.json
.venv\Scripts\python.exe scripts\strategy_capture_diff.py --assertion parity tests\golden\strategy_pine_equivalent_cost_allocation.json --case percent_commission_round_trip
.venv\Scripts\python.exe scripts\strategy_capture_diff.py --assertion parity tests\golden\strategy_pine_equivalent_margin_order_cancel.json --case margin_long_rejects_then_small_fill
```

退出标准：

- market/cost/reversal/pyramiding case 不再因为错误拒单而全程空仓。
- `margin_long_rejects_then_small_fill` 不退化。

### Phase 3: Market Fill 与 `process_orders_on_close`

目的：对齐 market entry、`strategy.close()`、`process_orders_on_close=true` 的 bar timing。

执行前证据：

- smoke case 中 TV 在中间 bar 已持仓并计算 open profit，最终 bar 生成 closed trade。
- cost allocation case 中 TV 第 2 根已有 position/open profit，而 Pyne 仍为空仓。
- cancel case 中 Pyne 第 0 根过早持仓，说明提交、成交、取消的时序存在错位。

涉及文件：

- `src/pyne_runtime/strategy/replay.py`
- `src/pyne_runtime/strategy/orders.py`
- `src/pyne_runtime/strategy/ledger.py`
- `tests/test_strategy_runtime.py`
- `tests/golden/strategy_pine_equivalent_smoke.json`

实现要点：

- 明确每个 bar 的执行顺序：
  1. 脚本在 bar 上提交订单。
  2. 根据 `process_orders_on_close` 决定 market order 是否在当前 bar close 成交。
  3. pending stop/limit 根据同 bar 或后续 bar 的 high/low/open/close 触发。
  4. 成交后更新 open trades、position、equity、closed trades。
  5. plot 读取更新后的 series。
- 把 capture 中 `_pyne_capture_bar(N)` 的 bar offset 与 replay 内部 timestamp 对齐。
- 修复“第 0 根已经持仓”的过早成交问题。

阶段验收：

```powershell
.venv\Scripts\python.exe scripts\strategy_capture_diff.py --assertion parity tests\golden\strategy_pine_equivalent_smoke.json
.venv\Scripts\python.exe scripts\strategy_capture_diff.py --assertion parity tests\golden\strategy_pine_equivalent_margin_order_cancel.json --case cancel_and_cancel_all_clear_pending
.venv\Scripts\python.exe -m pytest tests\test_strategy_runtime.py -q
```

退出标准：

- smoke case 的 position/equity/open profit/closed trades 主要路径对齐。
- cancel case 不再第 0 根提前持仓。

### Phase 4: Bracket Exit 与 Closed Trade 生成

目的：修复 `strategy.exit()` bracket limit/stop 已触发但 Pyne 未更新 closed trade 的问题。

执行前证据：

- `bracket_limit_exit` 第 2 根 TV `Closed Trades = 1`，Pyne 为 0。
- `bracket_stop_exit` 第 2 根 TV `Closed Trades = 1`，Pyne 为 0。

涉及文件：

- `src/pyne_runtime/strategy/orders.py`
- `src/pyne_runtime/strategy/replay.py`
- `src/pyne_runtime/strategy/ledger.py`
- `tests/test_strategy_runtime.py`
- `tests/golden/strategy_pine_equivalent_bracket_exit.json`

实现要点：

- 检查 `strategy.exit()` 的 target qty、from_entry、limit/stop 触发结果是否正确传给 ledger。
- 确认 exit fill 后 position 和 open lots 被减少，closed trade 在同一 bar 对 plot 可见。
- 保护 same-bar priority 和 intrabar path 已有 golden。

阶段验收：

```powershell
.venv\Scripts\python.exe scripts\strategy_capture_diff.py --assertion parity tests\golden\strategy_pine_equivalent_bracket_exit.json
.venv\Scripts\python.exe -m pytest tests\test_strategy_runtime.py -q
```

退出标准：

- `bracket_limit_exit` 与 `bracket_stop_exit` 的 `Closed Trades` 对齐。

### Phase 5: Cost Allocation 与 Equity 口径

目的：对齐 percent commission、cash per contract、partial close 的权益、净利润、手续费分摊。

执行前证据：

- `percent_commission_round_trip` TV 第 2 根 `Equity = -780.638`、`Net Profit = -1472.038`、`Open Profit = -308.6`。
- `cash_per_contract_partial_close_allocation` TV 第 2 根 `Net Profit = -1`，第 3 根 `First Closed Commission = 1`、`First Closed Net Profit = -213.8`。

涉及文件：

- `src/pyne_runtime/strategy/costs.py`
- `src/pyne_runtime/strategy/ledger.py`
- `src/pyne_runtime/strategy/replay.py`
- `tests/test_strategy_runtime.py`
- `tests/golden/strategy_pine_equivalent_cost_allocation.json`

实现要点：

- 入口手续费、出口手续费、部分平仓手续费必须按 TV reference 分配到 open/closed trade。
- `strategy.netprofit`、`strategy.equity`、`strategy.openprofit` 的更新顺序必须与 plot bar 对齐。
- partial close 生成 closed trade 时，需要保留剩余 open lot 的 entry commission 分摊。

阶段验收：

```powershell
.venv\Scripts\python.exe scripts\strategy_capture_diff.py --assertion parity tests\golden\strategy_pine_equivalent_cost_allocation.json
.venv\Scripts\python.exe -m pytest tests\test_strategy_runtime.py -q
```

退出标准：

- cost allocation fixture 的 position/equity/netprofit/openprofit 与 closed cost accessor 明显收敛。
- 不破坏已有 cost model golden。

### Phase 6: Reversal、Pyramiding 与 `strategy.order`

目的：对齐反手、同向加仓、`strategy.order` 净持仓减少/反转。

执行前证据：

- `reversal_long_to_short_then_flat` TV 从多头反手为空头，并生成 closed trade。
- `pyramiding_two_entries_then_flat` TV 允许同向持仓并计 open profit。
- `order_net_position_reduces_and_reverses` TV 从 2 多降到 1 多，再反转为 2 空，并生成两笔 closed trade。

涉及文件：

- `src/pyne_runtime/strategy/replay.py`
- `src/pyne_runtime/strategy/ledger.py`
- `src/pyne_runtime/strategy/orders.py`
- `src/pyne_runtime/strategy/risk.py`
- `tests/test_strategy_runtime.py`
- `tests/golden/strategy_pine_equivalent_reversal_pyramiding.json`
- `tests/golden/strategy_pine_equivalent_margin_order_cancel.json`

实现要点：

- `strategy.entry()` opposite direction 应按 TV transaction quantity 同时 close old lot 和 open new lot。
- `strategy.order()` 应以净持仓变化为核心，不完全等同于 entry admission。
- pyramiding admission 只限制同向 entry 的允许次数，不应错误阻止可允许的同向持仓。
- closed trade lot matching 使用 FIFO，保持已有 lot matching golden。

阶段验收：

```powershell
.venv\Scripts\python.exe scripts\strategy_capture_diff.py --assertion parity tests\golden\strategy_pine_equivalent_reversal_pyramiding.json
.venv\Scripts\python.exe scripts\strategy_capture_diff.py --assertion parity tests\golden\strategy_pine_equivalent_margin_order_cancel.json --case order_net_position_reduces_and_reverses
.venv\Scripts\python.exe -m pytest tests\test_strategy_runtime.py -q
```

退出标准：

- reversal/pyramiding/order reduce-reverse case 不再表现为空仓。
- closed trade count 与 first/last closed profit 开始对齐。

### Phase 7: Pending Cancel / Cancel All

目的：对齐 `strategy.cancel()` 与 `strategy.cancel_all()` 清理 pending order 后不复活的语义。

执行前证据：

- `cancel_and_cancel_all_clear_pending` 中 TV 第 0 根空仓，第 1 根后持仓 1。
- Pyne 当前第 0 根已经持仓，并把 BTC 价格级 open profit 写入 equity/open profit。

涉及文件：

- `src/pyne_runtime/strategy/orders.py`
- `src/pyne_runtime/strategy/replay.py`
- `tests/test_strategy_runtime.py`
- `tests/golden/strategy_pine_equivalent_margin_order_cancel.json`

实现要点：

- cancel/cancel_all 应在 replay 阶段明确标记 pending order 为 canceled。
- canceled pending order 后续 bar 不得再次触发。
- cancel 本身不应生成 commission、closed trade 或 open trade。
- 与 risk lock / intraday reset 下 pending order 恢复规则分开处理。

阶段验收：

```powershell
.venv\Scripts\python.exe scripts\strategy_capture_diff.py --assertion parity tests\golden\strategy_pine_equivalent_margin_order_cancel.json --case cancel_and_cancel_all_clear_pending
.venv\Scripts\python.exe -m pytest tests\test_strategy_runtime.py -q
```

退出标准：

- cancel case 第 0 根 position/open trades/equity/open profit 与 TV 对齐。
- 后续 pending order 不复活。

## Parity Gate 升级规则

每个 case 修到 0 diff 后，才允许把该 case 从 reference gate 升级为 parity gate。

升级条件：

- `strategy_capture_diff.py --assertion parity <fixture> --case <case>` 返回 0；
   若 case 名拼错或没有实际检查到 captured parity case，脚本必须返回非零。
- `external_capture.assertion` 从 `reference` 改为 `parity`。
- `tests/test_golden_strategy.py` 在该 case 上恢复外部 TV 值断言。
- 对应 runtime 单元测试覆盖 root cause，而不是只改 golden。

建议升级顺序：

1. `margin_long_rejects_then_small_fill`
2. `bracket_limit_exit`
3. `bracket_stop_exit`
4. `market_round_trip_process_on_close`
5. `percent_commission_round_trip`
6. `cash_per_contract_partial_close_allocation`
7. `pyramiding_two_entries_then_flat`
8. `reversal_long_to_short_then_flat`
9. `order_net_position_reduces_and_reverses`
10. `cancel_and_cancel_all_clear_pending`

这个顺序从 accessor-only gap 开始，再进入 bracket/market/cost/reversal/cancel 的复杂路径。

## 每轮实现的固定验证

单阶段最小验证：

```powershell
.venv\Scripts\python.exe -m pytest tests\test_strategy_runtime.py -q
.venv\Scripts\python.exe -m pytest tests\test_golden_strategy.py -q
.venv\Scripts\python.exe scripts\strategy_capture_diff.py --assertion parity `
  tests\golden\strategy_pine_equivalent_smoke.json `
  tests\golden\strategy_pine_equivalent_bracket_exit.json `
  tests\golden\strategy_pine_equivalent_cost_allocation.json `
  tests\golden\strategy_pine_equivalent_reversal_pyramiding.json `
  tests\golden\strategy_pine_equivalent_margin_order_cancel.json
```

提交前完整验证：

```powershell
.venv\Scripts\python.exe -m compileall src tests scripts -q
.venv\Scripts\python.exe -m ruff check .
.venv\Scripts\python.exe -m pytest -q
git diff --check
```

如果修改 public API 或 package layout，还要运行：

```powershell
.venv\Scripts\python.exe -m pytest tests\test_architecture.py -q
```

## 暂不做的事

- 暂不继续采剩余 17 个非 priority case，除非某个修复需要新的 TV 证据。
- 暂不把 17 个非 priority scaffold 直接改成 `captured` 或 `parity`。
- 暂不为了让 diff 归零而改写 TV reference values。
- 暂不把 Pyne 定位成 TradingView Pine 源码解释器；本阶段只对齐 Python API 下的 Pine-like strategy runtime。

## 阶段完成标准

本执行阶段完成时已满足：

- 10 个 priority case 仍保持 captured。
- 10 个 priority case 全部进入 parity。
- 聚合 diff 从执行前 `107 difference(s)` 降为 `0 difference(s)`。
- 全量测试、ruff、diff check 通过。
- `docs/development/pine_like_semantics_progress_zh.md` 和 `docs/reference/pine_like_api_matrix.md` 同步更新 strategy parity 状态。
