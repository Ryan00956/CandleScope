# 本地数据与策略研究统一 Phase 12 结果（2026-08-25）

## 结论

本分支已修复统一入口的关键正确性问题，并达到“工程候选、生产 HOLD”的诚实状态：

- `/strategy.html?source=current` 不再用默认值伪造当前图表；它在没有真实 `ChartSession` 时说明边界并引导回行情页。
- 行情页 chart-first tester 绑定真实当前图表；导入数据则在同一策略产品内完成导入、看图、运行和报告。
- 导入来源只持有 `dataset_id + data_epoch`，由后端返回 snapshot；React StrictMode 不再提前销毁 tester runtime。
- Vite worktree 字体依赖、Pine 前端导入、marketplace 时间依赖测试和发布校验器均已修正。

生产旗标仍为 0。未 push、未 merge、未 deploy，旧 `codex/local-offline-mode` worktree 未删除。

## 浏览器验收

### LOCAL_OFFLINE

导入 30 根 OHLCV CSV，图表显示 30 根源 K 线；选择 SMA 模板并运行。所有 revision、snapshot、validate、run、report/chart 请求返回 200。Run `bt_f149c500716c425a87e7170ae7ca8f9a` 完成，5 笔已完成交易，净值变化 `-4.52266034 USDT`，精度为 `BAR_APPROX`。console：0 error、2 warning。

### LIVE

策略页的 current 来源显示“当前图表未绑定”及返回行情页动作；行情页加载真实 `BTCUSDT · 1h`、1501 根 K 线和 Binance 连接状态。打开“策略未附着”后，tester 显示“当前图表 · BTCUSDT · 1h”。console：0 error、4 warning。

这两项是短时交互验收，不等于 60 分钟 mixed browser soak。

## 测试

| 门禁 | 结果 |
| --- | --- |
| scoped 后端策略路径 | PASS，91 passed |
| `npm.cmd run test:research-data` | PASS，93 passed |
| `npm.cmd run test:backtest` | PASS，122 passed |
| 前端全量 `npm.cmd test` | PASS，3481 passed / 0 failed |
| `npm.cmd run typecheck` | PASS |
| 变更文件 eslint | PASS |
| 前端全量 `npm.cmd run lint` | FAIL，140 个既有错误 |
| `npm.cmd run check:architecture` | PASS，0 allowlist |
| `npm.cmd run check:i18n` | PASS，3962 keys / 669 source files |
| `npm.cmd run smoke:strategy-research` | PASS |
| `npm.cmd run smoke:backtest` | PASS（启动 LOCAL_OFFLINE 后端后） |
| `npm.cmd run build` | PASS，706 modules；StrategyResearchApp 约 28.23 kB |
| 后端全量 pytest | FAIL，2334 passed 后命中既有 Phase 1 历史契约漂移 |
| 60 分钟 LOCAL_OFFLINE API soak | PASS，711 cycles / 3600131 ms |
| 60 分钟 mixed browser soak | ENV_STOP，本轮只做短时双环境浏览器验收 |

后端第二次排除 Phase 1 契约测试的全量运行在 `test_runtime_materializes_study_beyond_active_run_ceiling` 提前失败；该节点单独运行及与相邻两个用例一起运行均 PASS，说明存在仓库级测试顺序/状态污染，不能据此把候选写成 full backend PASS。

## 回滚与发布决定

关闭 `VITE_RESEARCH_DATA_LIBRARY_ENABLED` 与 `CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED` 即恢复兼容路径，不删除磁盘数据与旧键。发布状态为 **PRODUCTION_HOLD**，待全量后端、全量 lint 和 60 分钟 mixed browser soak 给出可签署结果后再评估启用。
