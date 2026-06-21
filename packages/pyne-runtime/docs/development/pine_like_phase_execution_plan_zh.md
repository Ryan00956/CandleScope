# Pyne Pine-like 分阶段执行手册

本文档把后续 Pine-like 支持拆成可逐步执行的大阶段和小 slice。每个 slice 都应遵循同一节奏：

1. 先确认当前基线和工作区状态。
2. 只选择一个小差异或一个窄功能面。
3. 阅读相关实现、fixture、TradingView 捕获数据和测试。
4. 写下局部判断，再改代码或文档。
5. 跑目标测试和 parity/diff gate。
6. 完成后提交；如果遇到无法解释的 TradingView 差异，停止并记录证据。

## 当前基线

截至 2026-06-02，当前主线状态是：

- Strategy TradingView parity 已完成：27 captured case，parity diff 为 0。
- TA parity gate 保持稳定：`ta_core_indicators.json` 和 `ta_advanced_indicators.json` 为 parity，diff 为 0。
- TA reference evidence 仍有剩余差异：29 个 point diff。
- 剩余 TA reference plot：
  - `PLI 75`：9 个 diff。
  - `Supertrend 2 3`：11 个 diff。
  - `Supertrend Direction`：9 个 diff。
- 最近完整检查通过：`.\scripts\check.ps1`，412 passed，strategy/TA parity diff 均为 0。

开始任何新 slice 前，先运行：

```powershell
git status --short
.\.venv\Scripts\python.exe scripts\ta_capture_diff.py --assertion reference --summary
.\.venv\Scripts\python.exe scripts\ta_capture_diff.py --assertion parity --summary
```

如果工作区不干净，先确认变更来源。不要覆盖用户未提交的改动。

## 阶段 1：清完现有 TA reference diff

目标：把当前已采集的 TA TradingView reference evidence 全部收敛到 0 diff，并把可稳定对齐的 fixture 提升到 parity gate。

完成标准：

- `scripts\ta_capture_diff.py --assertion reference --summary` 中当前这批 reference diff 清零，或所有剩余差异都有明确 `known_boundary` 记录。
- `scripts\ta_capture_diff.py --assertion parity --summary` 保持 0 diff。
- `tests/test_golden_ta.py` 和相关 TA 单测通过。
- `.\scripts\check.ps1` 通过。

### Slice 1.1：对齐 `PLI 75`

背景：

- 当前 `PLI 75` 有 9 个 diff。
- 这是 `ta.percentile_linear_interpolation(close, 4, 75)` 的定义差异，范围独立，优先级高于 `Supertrend`。

执行步骤：

1. 读取实现：

```powershell
Select-String -Path src\pyne_runtime\ta.py -Pattern "def percentile_linear_interpolation" -Context 4,80
```

2. 抽取 TV 捕获值和 external bars：

```powershell
@'
import json
from pathlib import Path
f = json.loads(Path("tests/golden/ta_remaining_indicators.json").read_text(encoding="utf-8"))
print(f["external_capture"]["series"]["PLI 75"])
for b in f["external_capture"]["bars"]:
    print(b["time"], b["close"])
'@ | .\.venv\Scripts\python.exe -
```

3. 用小脚本比较常见 percentile 定义：

- TradingView/Pine 是否使用 `nearest_rank` 风格边界。
- linear interpolation 的 rank 公式是否是 `p / 100 * (n - 1)`。
- 排序后是否采用 1-based rank。
- warm-up 是否必须满窗口。

4. 修改实现时只改 `percentile_linear_interpolation`，不要顺手改 `PNR`。
5. 刷新 `tests/golden/ta_remaining_indicators.json` 的 local `expected_series`。
6. 运行：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_ta_runtime.py tests/test_golden_ta.py tests/test_ta_capture_diff.py -q
.\.venv\Scripts\python.exe scripts\ta_capture_diff.py --assertion reference --summary
.\.venv\Scripts\python.exe scripts\ta_capture_diff.py --assertion parity --summary
```

验收：

- `PLI 75` 从 reference diff 摘要中消失。
- reference diff 应只剩 `Supertrend 2 3` 和 `Supertrend Direction`。
- 提交信息建议：`Align percentile interpolation with TradingView`。

### Slice 1.2：拆解 `Supertrend`

背景：

- 当前 `Supertrend 2 3` 有 11 个 diff，`Supertrend Direction` 有 9 个 diff。
- 它涉及 ATR/RMA、band carry、direction 翻转、初始方向和 source high/low/close 上下文，风险比 PLI 更高。

执行步骤：

1. 读取实现和相关 ATR/RMA：

```powershell
Select-String -Path src\pyne_runtime\ta.py -Pattern "def supertrend|def atr|def rma" -Context 4,100
```

2. 抽取 TV 捕获序列、external bars、当前 Pyne 输出。
3. 先判断差异归类：

- `warmup`：初始输出位置不同。
- `atr_seed`：ATR/RMA seed 不同。
- `band_carry`：upper/lower band 继承规则不同。
- `direction_sign`：方向正负号或翻转条件不同。
- `source_alignment`：high/low/close capture wrapper 对齐问题。

4. 不要一次性重写 `supertrend`。建议拆成两个内部小步：

- 先让 `Supertrend Direction` 的符号和翻转位置对齐。
- 再让 `Supertrend 2 3` 的线值对齐。

5. 每个内部小步都跑 reference diff，避免一个改动同时引入多个未知变量。

验收：

- `Supertrend 2 3` 和 `Supertrend Direction` 都从 reference diff 摘要中消失。
- `ta_context_indicators.json` 可从 `reference` 提升为 `parity`，前提是同一 fixture 内无剩余 diff。
- 提交信息建议：`Align supertrend with TradingView`。

### Slice 1.3：提升 TA reference 到 parity

执行步骤：

1. 确认 reference diff 清零：

```powershell
.\.venv\Scripts\python.exe scripts\ta_capture_diff.py --assertion reference --summary
```

2. 将已清零 fixture 的 `external_capture.assertion` 从 `reference` 改为 `parity`。
3. 运行：

```powershell
.\.venv\Scripts\python.exe scripts\ta_capture_diff.py --assertion parity --summary
.\.venv\Scripts\python.exe -m pytest tests/test_golden_ta.py tests/test_ta_capture_diff.py -q
.\scripts\check.ps1
```

验收：

- 所有 captured TA fixture 都在 parity gate 内。
- `scripts/check.ps1` 保持通过。
- 提交信息建议：`Promote TA captures to parity`。

## 阶段 2：扩大 TA TradingView 覆盖面

目标：避免当前实现只对已采集的少量 bars 和参数组合正确。

优先采集批次：

1. Warm-up 边界批次：短长度、长长度、刚好满窗口、窗口前有 `na`。
2. 趋势切换批次：适合 `supertrend`、`sar`、`dmi/adx`。
3. 震荡指标批次：`stoch`、`mfi`、`wpr`、`cmo`。
4. Percentile/statistics 批次：`percentile_*`、`variance`、`stdev`、`dev`。
5. Tuple 返回批次：`bb`、`macd`、`dmi` 等多返回值。

每一批执行：

```powershell
.\.venv\Scripts\python.exe scripts\ta_capture_prepare.py --out-dir .tmp\tradingview-ta --clean
.\.venv\Scripts\python.exe scripts\ta_capture_next.py --manifest .tmp\tradingview-ta\manifest.json
.\.venv\Scripts\python.exe scripts\ta_capture_preflight.py .tmp\tradingview-ta\manifest.json --fixture <fixture>.json
.\.venv\Scripts\python.exe scripts\ta_capture_import.py tests\golden\<fixture>.json --values <export.csv> --tolerance 1e-9 --assertion reference --note "TradingView export YYYY-MM-DD, symbol/timeframe/source"
.\.venv\Scripts\python.exe scripts\ta_capture_diff.py --assertion reference tests\golden\<fixture>.json
```

验收：

- 新 evidence 先进入 `reference`，不要直接进 `parity`。
- 差异必须被分类为 runtime bug、Pine semantics、capture alignment、float tolerance 或 known boundary。
- 修到 0 diff 后再提升 parity。

## 阶段 3：补强 Pine-like runtime 语义

目标：从指标函数扩展到 Pine 脚本常见语义，让 Python API 层更接近 Pine 的运行模型。

建议顺序：

1. Series 与 `na` 边界：
   - 历史引用的边界行为。
   - `na` 在比较、布尔组合、数学函数中的传播。
   - `nz`、`fixnan`、`valuewhen`、`barssince` 等状态依赖函数。

2. 表达式和状态：
   - `when()` / `switch()` 的 series 条件行为。
   - `var()` / `set_each()` 的 batch 与 incremental 一致性。
   - tuple、多返回值、嵌套调用。

3. 输入和元数据：
   - `input.*` 默认值、类型约束和 metadata。
   - `indicator()` / `strategy()` 参数兼容性。
   - `syminfo`、`timeframe`、`session` 注入。

4. 时间语义：
   - `time`、`time_close`、`timestamp`。
   - session first/last bar。
   - timezone 和 timeframe 边界。

每个 slice 的验收：

- 至少一个 focused unit test。
- 如果可由 TradingView plot 观察，补 reference capture。
- batch 与 incremental 若都涉及，必须同时验证。

## 阶段 4：扩大 `request.security()` 和多上下文覆盖

目标：让多 timeframe、多 symbol、lookahead/gaps 的行为更可靠。

建议 slice：

1. Higher timeframe 最小 parity：
   - same symbol。
   - 固定 HTF。
   - `gaps_off` / `lookahead_off`。

2. Lookahead/gaps 矩阵：
   - `barmerge.gaps_on/off`。
   - `barmerge.lookahead_on/off`。
   - chart/requested 时间轴错位。

3. Tuple thunk：
   - `request.security(symbol, tf, lambda ctx: (ctx.close, ctx.high))`。
   - 多返回值历史引用。

4. Lower timeframe 聚合：
   - 空数组。
   - first/last/sum/avg/min/max。
   - 不完整低周期 bars。

验收：

- 先写 request capture 工具或扩展现有 TA capture 工具，不手动拼 fixture。
- 每个 capture 都保留 bars 和 notes。
- parity gate 不允许已知 reference 差异混入。

## 阶段 5：Strategy/Broker 语义扩展

目标：在已有 27 个 strategy parity case 基础上扩大边界，而不是重做已完成基础。

建议新增批次：

1. Stop/limit 组合极端情况：
   - 同 bar 多订单触发。
   - stop-limit entry 双触发。
   - exit bracket 与 close/cancel 同时出现。

2. OCA/OCO 深水区：
   - cancel/reduce 混合。
   - 部分成交后 sibling 数量变化。
   - risk lock 与 OCA 同时发生。

3. Pyramiding 和 reversal：
   - 多 lot FIFO/LIFO 观察。
   - max position size 截断。
   - 反转订单 transaction quantity。

4. 成本模型：
   - percent/cash_per_order/cash_per_contract。
   - slippage 与 limit verification 组合。
   - commission 在 partial close 和 reversal 中的分摊。

验收：

- 新 case 默认先 `reference`。
- 已有 27 个 parity case 必须始终保持 0 diff。
- 每个 strategy 语义差异都要落到 lifecycle、closed/open trades 或 summary 的可观察字段上。

## 阶段 6：文档、矩阵和发布整理

目标：把已完成语义变成用户可理解、可维护、可发布的状态。

执行 slice：

1. 更新支持矩阵：
   - `docs/reference/pine_like_api_matrix.md`
   - `docs/reference/compatibility.md`
   - `docs/api/ta.md`
   - `docs/api/strategy.md`

2. 更新开发文档：
   - 当前文档。
   - `docs/development/pine_like_semantics_progress_zh.md`
   - `docs/development/non_strategy_capture_plan_zh.md`

3. 发布前质量门：

```powershell
.\scripts\check.ps1
```

4. 打包检查由 `check.ps1` 统一覆盖；如果单独执行，确保 wheel 和 sdist 都通过 `twine check`。

验收：

- 用户能从文档判断哪些 Pine-like 能力已支持、哪些是 known boundary。
- CI/local gate 覆盖 captured parity。
- release note 能准确说明 Pyne 是 Python API 层 Pine-like runtime，不是 Pine 源码解释器。

## 每个 slice 的固定提交模板

完成一个 slice 后，提交前检查：

```powershell
git diff --stat
git diff -- <changed-files>
.\.venv\Scripts\python.exe -m pytest <focused-tests> -q
.\.venv\Scripts\python.exe scripts\ta_capture_diff.py --assertion parity --summary
```

如果该 slice 触及 strategy：

```powershell
.\.venv\Scripts\python.exe scripts\strategy_capture_diff.py --assertion parity --summary
```

如果该 slice 改动进入主干语义或 capture gate：

```powershell
.\scripts\check.ps1
```

提交信息使用动词开头，保持一个 slice 一个提交，例如：

- `Align percentile interpolation with TradingView`
- `Align supertrend with TradingView`
- `Promote TA captures to parity`
- `Add request security reference capture`
- `Document Pine-like compatibility matrix`
