# Backtest Python First N8 规模（2026-08-15）

## 结论

状态：`PYTHON_DATA_SCALE_PASS`（独立分支，生产开关保持 0）。

正式产品容量在 `BACKTEST_PYTHON_SCALE_V1_ENABLED=1` 时为 1,000,000 BAR。
默认 `BACKTEST_MAX_BAR_ROWS` 仍为 200,000，旧路径继续可用。
`BACKTEST_MAX_TRADE_EVENTS` 仍为 2,000,000。

1,000,000 BAR Python Host 参考 Run 已真实跑通：

- 证据：`docs/evidence/backtest-python-first-n8-1m-bar-20260815.json`
- 状态 COMPLETED，1 笔成交，checkpoint 间隔 10,000
- 时长约 657.5 秒
- 未声称 TradingView 全市场覆盖，也未在线补数

## 产品路径

- 数据目录暴露 source / checksum / coverage / gap / revision
- CSV 列名自动识别；Parquet/Arrow 流式导入（本地 pyarrow）
- Binance/OKX 本地归档 receipt，无网络
- 头/中/尾 gap、重复、乱序、revision drift 失败关闭
- 分块 Provider feed：execute_bar_run 接受 iterator，不再堆积无用 visible 列表

## 验证

- `test_python_scale_contract.py`：默认 20 万，flag 打开后硬顶 100 万
- `test_python_scale_quality.py`：质量拒绝、别名 CSV、parquet、receipt
- `test_python_million_bar.py`：2k 重跑 hash 一致；1,000,000 BAR 参考 Run
- `test_trade_tape.py`：既有 aggTrade 产品路径
- 2,000,000 aggTrade 上限未改

回滚：关闭 `BACKTEST_PYTHON_SCALE_V1_ENABLED`；默认仍走 20 万。
