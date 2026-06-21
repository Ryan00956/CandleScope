# Non-Strategy TradingView Capture 执行计划

本文记录 strategy capture 完成后的下一阶段：把真实 TradingView 导出证据扩展到
TA、`request.security()` 与集合历史边界。目标仍然不是运行 Pine 源码，而是把可
导出的 Pine plot 序列作为外部证据，接入 Pyne 现有 golden runner。

## 当前基线

- Strategy pine-equivalent capture 已完成：27/27 captured，parity diff 为 0。
- TA capture 已开始：`ta_core_indicators.json` 已导入 TradingView reference
  evidence；当前仍不是 parity，主要差异集中在 warm-up 输出、`highestbars` /
  `lowestbars` offset 符号，以及 RSI 初始 RMA 口径。
- 下一阶段优先级：
  1. TA golden 的真实 TradingView 输出对照。
  2. `request.security()` edge-case 的真实 Pine 输出对照。
  3. array/map/matrix 历史快照边界的可 plot 观测值。
  4. `docs/reference/pine_like_api_matrix.md` 的状态矩阵同步。

## Slice 1: TA Capture 最小闭环

先覆盖 `ta_core_indicators.json`，因为它只依赖 source-based TA 和简单条件，
适合作为非 strategy capture 的 smoke。该 slice 新增以下工具：

- `scripts/ta_capture_status.py`
- `scripts/ta_capture_prepare.py`
- `scripts/ta_capture_next.py`
- `scripts/ta_capture_preflight.py`
- `scripts/ta_capture_import.py`
- `scripts/ta_capture_diff.py`

执行链路：

```powershell
python scripts/ta_capture_prepare.py --out-dir .tmp/tradingview-ta --clean
python scripts/ta_capture_next.py --manifest .tmp/tradingview-ta/manifest.json
python scripts/ta_capture_preflight.py .tmp/tradingview-ta/manifest.json --fixture ta_core_indicators.json
python scripts/ta_capture_import.py tests/golden/ta_core_indicators.json --values .tmp/tradingview-ta/01_ta_core_indicators.csv --tolerance 1e-9 --note "TradingView export YYYY-MM-DD, symbol/timeframe/source"
python scripts/ta_capture_diff.py --assertion reference tests/golden/ta_core_indicators.json
```

如果 diff 为 0，再用 `--assertion parity` 重新导入，并运行：

```powershell
python -m pytest tests/test_golden_ta.py -q
python scripts/ta_capture_diff.py --assertion parity
```

## TA 导出注意事项

TA 与 strategy 的最大差异是 warm-up。Pine 图表有完整历史，而 Pyne 只会用导入的
capture bars。为避免 Pine 内建 TA 读取 capture 窗口之前的历史，生成的 Pine 会把
`open/high/low/close/volume` 包装成 `_pyne_*` source：窗口外为 `na`，窗口内才使用
真实图表值。

生成脚本还会输出 `Pyne Capture Index` plot。导出 CSV 时必须保留该列，因为 early
warm-up bars 可能所有指标都是 `na`；capture index 用来标记哪些 bar 属于窗口。

## Slice 2: TA 扩展批次

`ta_core_indicators.json` 通过后，再扩展：

- `ta_remaining_indicators.json`：先处理 source-based 指标，再单独记录 `wpr` 等隐式
  high/low/close 指标的 prehistory 边界。
- `ta_context_indicators.json`：重点验证 `stoch`、`cci`、`mfi`、`vwma` 与
  `supertrend` 的真实 Pine 口径。
- `ta_advanced_indicators.json`：重点验证 tuple 返回、columns plot、DMI/ATR/SAR 等
  需要更谨慎 warm-up 处理的函数。

## Slice 3: Request Capture

TA capture 稳定后，再新增 request capture 工具链。第一批只做同 symbol、固定 HTF、
`gaps_off/lookahead_off`、tuple thunk 的最小窗口，避免一开始把 lower timeframe 分组、
invalid symbol 和 capability gates 混在一起。

## Slice 4: Collections Boundary

array/map/matrix 不能直接导出对象，只导出可 plot 的观测值，例如 size、get、sum、
copy 后独立性和历史引用结果。该阶段更像边界证据，不作为主线第一批。
