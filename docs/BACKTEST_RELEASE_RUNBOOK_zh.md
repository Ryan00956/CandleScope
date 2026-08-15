# Backtest 发布与回滚手册

状态：M10 已在 `codex/backtest-foundation` 形成干净候选
`04b55582b2f73ad48b50fca67eb498fc2ce0fae6` 与完成提交
`2bbc67c84c85568bbdebdbeece2cd7015c150354`。生产 flags 保持 0。
本手册不授权 merge、push 或打开入口。Python First 尚未实现。

## 运行时紧急停用

1. 停止创建新 Study/Run；
2. 将 `BACKTEST_ENABLED` 及全部子 flags 设为 `0`；
3. 重启后确认 `/api/v1/backtests` 未注册；
4. 确认 live / local / replay / plugin 基本健康；
5. 保留故障 Run、日志和 `backtest.db`，不要立即删除。

## 代码回滚

```powershell
git revert --no-commit <release-commit>
```

禁止用 `git reset --hard` 清掉用户工作区。回滚后重跑：

```powershell
Set-Location backend
python -m pytest tests/backtest_contract tests/test_backtest_control_plane.py tests/test_trade_tape.py -q
```

## 当前可重复执行的真实路径 smoke / soak

```powershell
Set-Location frontend
$env:BACKTEST_BASE_URL='http://127.0.0.1:8000/api/v1/backtests'
npm run smoke:backtest
npm run soak:backtest
```

这两个命令通过公开 HTTP API 完成 dataset preview、Run 创建、worker 执行、报告读取和
export hash 校验。`soak:backtest` 默认持续 1 小时；只有在干净发布候选 SHA 上完整执行后，
其输出才可进入发布证据。

当前实现也支持在 `CANDLESCOPE_RUNTIME_MODE=LOCAL_OFFLINE` 下显式打开上述 backtest flags；
此时只放行本地数据与 backtest API，网络隔离仍保持生效。

按成交回测还需要显式打开 `BACKTEST_TRADE_TAPE_ENABLED=1`，并在
`REPLAY_AGG_TRADE_ARCHIVE_DIR` 中存在覆盖所选商品/区间的 checksum-verified aggTrade
归档。没有该数据时 snapshot preview / Run 必须失败；不得退化为 BAR 或在线补数。

资金费参数使用 `FIXED_INTERVAL_V1` 固定费率研究模型，默认费率为 `0`。它不是历史交易所资金费，
报告中的 `fill_model.funding_model` 与 `contract_coverage` 必须保留该限定。

## 已失效的历史微基准

- `docs/evidence/backtest-soak-million-trade-20260814.json`
- `docs/evidence/backtest-soak-1h-20260814.json`

它们直接调用私有 `_enqueue` / `_match`，并写入专用 `soak_*` 表，没有经过
`BacktestRuntime -> worker -> BacktestService -> report/export` 产品路径。因此只能作为
低层吞吐微基准，**不得作为 release gate 或产品 soak 证据**。

## M10 已记录、本轮仍不授权发布的项

M10 证据见 `docs/evidence/BACKTEST_MATURITY_M10_RESULT_20260815_zh.md`：1h 公开 API
soak、4h 浏览器/lifecycle soak、detached exact revert 与 schema rollback 已在候选
`04b55582` 上取证。该结果不授权 merge、push 或打开生产开关。

Python First 的 N10 必须重新取证，不得复用 M10 release manifest。
