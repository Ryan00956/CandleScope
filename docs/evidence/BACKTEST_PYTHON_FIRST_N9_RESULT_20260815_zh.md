# Backtest Python First N9 跨商品稳健性（2026-08-15）

## 结论

状态：`CROSS_MARKET_ROBUSTNESS_PASS`（独立分支，生产开关保持 0）。

`BACKTEST_MULTI_MARKET_ENABLED` 默认仍为 `0`。Basket 是独立 symbol Run/account/report
叠加层，不是共享资金的多市场组合账户。独立报告禁止相加冒充组合回测。

## 产品路径

- Study V2 可冻结 `dataset_basket`（`BACKTEST_INDEPENDENT_SYMBOL_BASKET_V1`）
- 每个 symbol 保持独立账户与独立 report hash
- 选参只消费 TRAIN 商品/窗口；TEST/HOLDOUT 参与选参会 `STUDY_SPLIT_LEAK`
- 缺数据按 `FAIL|SKIP` 显式处理，成员名单不静默缩小
- 参数稳定区来自各 TRAIN 商品独立赢家是否一致
- 独立 OOS 可按商品、regime、成本/延迟敏感性汇总，并追溯到每个 Run hash
- BAR/aggTrade decision/fill 差异矩阵
- 只在单商品、单窗口或低成本假设下有效的策略会被标记
- 打开 `BACKTEST_MULTI_MARKET_ENABLED` 时拒绝创建 basket Study

## 验证

- 10 个冻结数据集身份（BTC/ETH/BNB/SOL/XRP TRAIN，ADA/DOGE/AVAX TEST，DOT/LINK HOLDOUT）
- 同 seed/basket/budget 选择 receipt 与 robustness hash 一致
- TEST/HOLDOUT 商品不能进入选参
- 缺 ETHUSDT：`FAIL` 报错，`SKIP` 保留成员并记录 `MISSING_DATASET`
- 独立 OOS 列出每个 Run/report hash，拒绝 `portfolio_contribution`
- `test_python_basket_contract.py`：11 passed
- 既有 `test_backtest_study.py`：7 passed

回滚：不传 `dataset_basket` 即禁用 basket Study；已生成的独立 Run/report 继续可读。
