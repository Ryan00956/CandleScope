# TradingView Strategy Capture 执行说明

本文记录 strategy pine-equivalent fixture 从 Pyne-defined 预期推进到真实
TradingView 导出序列的执行方式。Pyne 仍然不运行 Pine 源码；这里的目标是把
TradingView 导出的 plot 序列作为外部证据接入现有 golden runner。

## Fixture 字段

每个 strategy pine-equivalent case 可以加入可选字段：

```json
{
  "external_capture": {
    "provider": "tradingview",
    "status": "captured",
    "tolerance": 1e-9,
    "values": {
      "Position": [2.0, 2.0, 0.0],
      "Net Profit": [0.0, 0.0, 6.0]
    }
  }
}
```

- `provider` 固定为 `tradingview`。
- `status` 为 `not_captured` 时只记录 scaffold 已存在，不能包含 `values`。
- `status` 为 `captured` 时，`values` 会参与测试断言。
- `tolerance` 是可选绝对误差，默认 `0.0`。
- `values` 的 key 必须对应 fixture 脚本里的 `plot(..., "Title")` 标题。

## 导出流程

1. 从 fixture 复制 `pine_equivalent` 脚本到 TradingView Pine Editor。
2. 使用与 fixture `bars` 完全一致的数据窗口或导入数据源。
3. 导出 plot 数据，只保留 fixture 已声明的 plot 标题。
4. 将导出的序列填入 `external_capture.values`。
5. 将 `status` 从 `not_captured` 改为 `captured`。
6. 运行 `python -m pytest tests/test_golden_strategy.py -q`。

也可以用导入脚本写回 fixture：

```powershell
python scripts/strategy_capture_import.py `
  tests/golden/strategy_pine_equivalent_smoke.json `
  --case market_round_trip_process_on_close `
  --values exported_plots.csv `
  --tolerance 1e-9 `
  --note "TradingView export YYYY-MM-DD"
```

`--values` 支持两种格式：

```json
{
  "values": {
    "Position": [2.0, 2.0, 0.0],
    "Net Profit": [0.0, 0.0, 6.0]
  }
}
```

```csv
time,Position,Net Profit
1,2,0
2,2,0
3,0,6
```

CSV 导入会忽略 `time`、`timestamp`、`date`、`datetime`、`bar_index` 等对齐列。
导入脚本默认执行完整性校验：

- 如果导出中包含 fixture 没有声明的 plot 标题，会拒绝写入。
- 如果导出缺少 fixture 已声明的 plot 标题，会拒绝写入；临时局部导入可显式使用
  `--allow-partial-plots`。
- 如果任意 plot 序列长度与 fixture bar 数不一致，会拒绝写入；排查对齐问题时可显式使用
  `--allow-length-mismatch`。

## 状态检查

仓库提供状态脚本，用于查看哪些 case 已经接入真实 TradingView capture：

```powershell
python scripts/strategy_capture_status.py
python scripts/strategy_capture_status.py --json
python scripts/strategy_capture_status.py --missing-only
```

新增 fixture 后，先用 scaffold 脚本补齐 `not_captured` 占位：

```powershell
python scripts/strategy_capture_scaffold.py
python scripts/strategy_capture_scaffold.py --check
```

准备 TradingView 导出时，可以生成 Pine 脚本与 manifest：

```powershell
python scripts/strategy_capture_prepare.py --out-dir .tmp/tradingview-priority --clean
python scripts/strategy_capture_prepare.py --out-dir .tmp/tradingview-all --all --clean
```

prepare 脚本默认只生成 priority case；输出目录中会包含每个 case 的 `.pine`
脚本、`_bars.csv` 数据窗口核对文件，以及 `manifest.json`。manifest 会记录每个
case 的 plot 标题、bar 数、bars 文件、导入命令和 diff 命令。

查看下一条待采集 case 与对应命令：

```powershell
python scripts/strategy_capture_next.py --manifest .tmp/tradingview-priority/manifest.json
python scripts/strategy_capture_next.py --manifest .tmp/tradingview-priority/manifest.json --json
```

导入前可以先对 TradingView 导出的 CSV 做预检查：

```powershell
python scripts/strategy_capture_preflight.py .tmp/tradingview-priority/manifest.json
python scripts/strategy_capture_preflight.py .tmp/tradingview-priority/manifest.json --case market_round_trip_process_on_close
```

preflight 会检查导出文件是否存在、plot 列是否完整、是否包含未知 plot、行数是否
匹配 bar 数；如果导出包含 `time` 列，还会和对应 `_bars.csv` 对齐。

已经导入真实 TradingView 序列后，用 diff 脚本查看外部 capture 与当前 Pyne
输出的差异：

```powershell
python scripts/strategy_capture_diff.py --assertion parity
python scripts/strategy_capture_diff.py --assertion reference tests/golden/strategy_pine_equivalent_smoke.json --case market_round_trip_process_on_close
python scripts/strategy_capture_diff.py --assertion all --json
```

diff 脚本默认只检查 `assertion="parity"` 的 captured case，`not_captured` 会被跳过。
新导入但尚未修到 parity 的 TradingView evidence 应使用 `--assertion reference`
或 `--assertion all` 检查。如果指定 `--case` 但没有找到该 case，或该 case 没有被当前
assertion filter 实际检查到，脚本会返回非零退出码，避免误把空检查当成通过。

报告中的状态含义：

- `captured`：已有 TradingView 导出序列，并参与测试断言。
- `not_captured`：已有 `external_capture` 占位，但还没有导出序列。
- `missing`：该 case 还没有 `external_capture` 字段。

## 优先顺序

优先替换这些已经稳定的 scaffold：

1. `strategy_pine_equivalent_smoke.json`
2. `strategy_pine_equivalent_bracket_exit.json`
3. `strategy_pine_equivalent_cost_allocation.json`
4. `strategy_pine_equivalent_reversal_pyramiding.json`
5. `strategy_pine_equivalent_margin_order_cancel.json`

## 注意事项

- 不要用 Pyne 输出填充 `external_capture.values`。
- 如果 TradingView 导出存在时间戳列，先按 bar 顺序对齐后只写数值序列。
- 如果 TradingView 空值导出为空字符串，应按 fixture 需要转成 `null` 或保留未捕获状态。
- 若外部导出与 Pyne-defined baseline 不一致，先保留差异并新增说明，不要直接覆盖 Pyne baseline。
