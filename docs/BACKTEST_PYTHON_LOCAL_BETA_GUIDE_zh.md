# Python 策略本地首次运行

默认所有生产开关为 `0`。不要 merge、push 或打开生产入口。

## 离线模板

仓库内模板（标准库 + `candlescope-backtest-sdk`）：

- `packages/candlescope-backtest-sdk/fixtures/sma_cross`
- `packages/candlescope-backtest-sdk/fixtures/rsi_reversion`
- `packages/candlescope-backtest-sdk/fixtures/breakout`

另见 SDK README：Host 拥有撮合、账户和报告。

## PowerShell（一次性、离线）

```powershell
Set-Location packages/candlescope-backtest-sdk
python -m pip wheel --no-deps -w $env:TEMP\cs-sdk-dist .
python -m pip install --no-index --no-deps --target $env:TEMP\cs-sdk-site (Get-ChildItem $env:TEMP\cs-sdk-dist\*.whl).FullName
$env:PYTHONPATH = "$env:TEMP\cs-sdk-site"
python -c "from candlescope_backtest_sdk import Observation, TargetPosition, Signal, OrderIntent; print('ok')"
```

不要设置全局 `PYTHONPATH` 到可编辑安装。不要在运行时 `pip install` 联网包。

`BACKTEST_PYTHON_STRATEGY_ENABLED` 与 `VITE_BACKTEST_PYTHON_STRATEGY_ENABLED` 保持 `0`，
除非在独立验证进程中显式打开。
