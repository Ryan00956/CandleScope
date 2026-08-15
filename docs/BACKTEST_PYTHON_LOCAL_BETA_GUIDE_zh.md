# Python 策略本地首次运行

默认所有生产开关为 `0`。不要 merge、push 或打开生产入口。

`BACKTEST_PYTHON_STRATEGY_ENABLED`、`BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED`、
`VITE_BACKTEST_PYTHON_STRATEGY_ENABLED` 保持 `0`，除非在独立验证进程中显式打开。

## 10 分钟第一次 Python 回测

目标：在全新离线临时目录安装 SDK、跑通官方模板决策，并由 Host 生成一份可验证 BAR 报告。

1. 打开 PowerShell，进入仓库根目录。
2. 逐条执行下面的离线命令。不要设置用户级全局 `PYTHONPATH`，不要 `pip install` 联网包。
3. 不要打开生产 flags。Host BAR 探针只在本仓库验证进程中运行。

```powershell
$Offline = Join-Path $env:TEMP ("cs-py-first-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Offline | Out-Null
Set-Location packages/candlescope-backtest-sdk
python -m pip wheel --no-deps -w "$Offline\dist" .
python -m pip install --no-index --no-deps --target "$Offline\site" (Get-ChildItem "$Offline\dist\*.whl").FullName
Copy-Item -Recurse templates "$Offline\templates"
$env:PYTHONPATH = "$Offline\site"
$env:PYTHONNOUSERSITE = "1"
python -c "from candlescope_backtest_sdk import Observation, TargetPosition, Signal, OrderIntent; print('sdk-ok')"
python -c "from pathlib import Path; print((Path(r'$Offline')/'templates'/'sma_cross'/'strategy.py').exists())"
Set-Location ../..
python backend/scripts/python_template_bar_probe.py --template sma_cross --work-dir "$Offline"
```

不要把 `$env:PYTHONPATH` 写进用户环境变量。验证结束后关闭该终端即可。

## 官方模板

仓库内首批模板：

- `packages/candlescope-backtest-sdk/templates/sma_cross`
- `packages/candlescope-backtest-sdk/templates/rsi_wilder_24`
- `packages/candlescope-backtest-sdk/templates/donchian_breakout`
- `packages/candlescope-backtest-sdk/templates/mean_reversion`
- `packages/candlescope-backtest-sdk/templates/buy_and_hold`
- `packages/candlescope-backtest-sdk/templates/always_flat`
- `packages/candlescope-backtest-sdk/templates/order_intents`
- `packages/candlescope-backtest-sdk/templates/snapshot_restore`

每个模板目录含策略假设、signal clock、warmup、参数范围、支持的 fidelity、不能声称的内容、
BAR 与 aggTrade 说明；golden hash 在 `templates/goldens/<name>.json`。

N2 的 `fixtures/` 仍是作者合同探针，不是产品首发目录。

## Python 策略 API

策略只实现 `prepare`、`warmup`、`step`、`on_execution_report`、`snapshot`、`restore`、`close`。

只允许返回：

- `SIGNAL`：LONG / SHORT / FLAT
- `TARGET_POSITION`：绝对目标数量
- `ORDER_INTENT`：MARKET / LIMIT / STOP / STOP_LIMIT

Host 把作者 `quantity` 映射为仓位或订单数量。策略不能把返回值当成已接受订单。

## 数据和 no-lookahead

`Observation` 只包含当前已完结 bar 和 watermark。不要缓存未来序列，不要读取 DataFrame 全历史。
`warmup` 只吃回看窗口；`step` 只在 watermark 已推进后被调用。

## 输出与 Host 执行

Python 只产生决策。订单、成交、费用、资金费、风控、账户、ledger、报告和 Study 由 CandleScope Host 生成。
`BAR_APPROX` 不是 K 线内部唯一路径。`AGG_TRADE_EXECUTION` 使用聚合成交，不是 raw trade，也不是 queue exact。

## sandbox / TRUSTED_LOCAL

Windows 默认 `SANDBOXED_LOCAL`：AppContainer + Job Object，不可用则失败关闭。
`TRUSTED_LOCAL` 必须 `BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED=1` 且显式确认权限事实，不能用含糊的“继续”。

## 调试和错误代码

常见失败：

- `BUNDLE_STATIC_DIAGNOSTIC`：源码行列与生命周期/导入合同
- `SANDBOX_UNAVAILABLE`：沙箱失败关闭
- `TRUSTED_LOCAL_DISABLED` / `TRUSTED_LOCAL_UNCONFIRMED`
- `PROVIDER_TIMEOUT` / `PROVIDER_CRASH_UNRECOVERABLE`
- `FLAG_DISABLED`：HTTP 入口默认关闭

下一步写在错误 `details.next_step` 或 Studio 失败面板。

## checkpoint / restore

`snapshot()` 必须返回可 JSON 编码的状态。`restore()` 必须恢复后继续给出相同决策。
官方示例：`templates/snapshot_restore`。Host 拥有 checkpoint 身份，策略不能写数据库。

## Study V2

使用同一 PYTHON_SOURCE revision 和 parameter schema。
参数空间示例：`templates/study_parameter_space.json`。
Test 不参与选择；OOS 只拼接 TestRun。不要把 Study 当成 Python 专用寻优器。

## 从普通 Python 脚本迁移

1. 删掉 `pandas` 全历史循环和直接下单函数。
2. 把状态放进 `prepare` / `snapshot` / `restore`。
3. 每个完结 bar 只返回一种冻结输出。
4. 用官方模板 zip 导入 Studio，或按上面的离线探针验证。
5. 不要 `import app`、`sqlite3`、网络库。

## 为什么不能直接访问 DataFrame 全历史或数据库

那样会绕过 watermark 和 no-lookahead，也会让策略看到 Host 账户真相或改写报告。
V1 合同只允许当前 Observation。需要更长回看时，自己在策略状态里保留有限窗口，并写入 snapshot。

## 回滚

关闭 flags；删除或 revert 模板与本文档不影响运行时。
