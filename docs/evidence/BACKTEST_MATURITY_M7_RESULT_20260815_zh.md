# Backtest M7 阶段验收结果（2026-08-15）

## 结论

M7「报告与绩效指标 V2」的实现、测试、真实浏览器验收、兼容性检查和回滚检查均通过，满足 `BACKTEST_MATURITY_EXECUTION_PLAN_zh.md` 12.6 的全部退出门禁。M7 不定义独立性能或 soak 阈值，因此本阶段该项为 `NOT_REQUIRED`，没有使用内核微基准冒充产品证据。

验收基线为分支 `codex/backtest-foundation`、父提交 `8526ff2bb24348e6c9b8abd7729fd25e9b9c68ba`。生产与高精度 flags 仍默认关闭；UI 的 Metrics V2 开关也默认关闭。没有 merge、push、生产启用或工作树删除。

## 已实现内容

- 新增 opt-in 的 `candlescope.backtest-report/2` 与 `BACKTEST_METRICS_V2`，冻结 UTC 日收盘权益采样、365 天年化、Run 无风险利率、benchmark 模型和样本角色；旧 `/1` 生成/读取路径不变。
- Host 使用 Decimal 权威计算收益、风险、完整 FIFO 交易、成本、benchmark、数据质量和可信度指标；短样本、零交易、零波动、非正权益等返回 `null + reason`。
- 权益指标使用 mark-to-market；开放仓位不伪装成完整交易。benchmark 使用同一 snapshot、窗口、费用、滑点和可交易时间。
- 报告封存前失败关闭地核对已平仓 gross PnL、fill fee、funding 和最终权益四条等式，并提供可重算 report hash；JSON/CSV 导出 manifest 绑定同一 hash。
- BAR MAE/MFE 使用持仓期间的权威 open/high/low 序列；市价退出 bar 只允许退出时已知的 open，禁止把退出后的 high/low 泄漏进交易。
- UI 提供核心卡、收益/风险、交易/成本、数据质量、月度收益、同轴权益/回撤、交易多空/盈亏/日期/reason 筛选和点击定位入场 K 线；浏览器只渲染报告字段，不重算指标。
- 新增公式 ADR、产品合同更新、deterministic local-only 浏览器 fixture、golden fixture 和边界/集成测试。

## 自动化验证

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| M7 focused | `python -m pytest backend/tests/test_backtest_metrics_v2_m7.py -q` | `10 passed` |
| 相关后端回归 | `python -m pytest backend/tests -q -k backtest` | `171 passed, 3595 deselected, 6 existing warnings` |
| Ruff | `python -m ruff format --check backend/app/backtest/metrics_v2.py backend/tests/test_backtest_metrics_v2_m7.py` | PASS |
| 前端类型 | `npm run typecheck` | PASS |
| 前端 lint | `npm run lint` | PASS |
| 前端全量测试 | `npm test -- --run` | `3249 passed, 0 failed` |
| 前端生产构建 | `npm run build` | PASS；仅既有 `live` chunk 大小告警 |
| Patch 检查 | `git diff --check` | PASS |

Focused 测试显式覆盖：V2 身份与 fail-closed、依赖版本、独立日收益/波动率参考计算、BAR MAE/MFE 无前视边界、零交易/短窗口、非正权益、导出 hash、公开 Runtime+SQLite 产品路径、golden fixture，以及旧 `/1` 可读、可重算、重复生成 hash 稳定。

## 真实浏览器产品路径

- URL：`http://127.0.0.1:15192/backtest.html`，经 Vite proxy 访问隔离后端 `127.0.0.1:18099`。
- 数据：40 根 deterministic `BTCUSDT 1d` 本地 bar，附本地 mark/index/rules/funding 合同包；manifest hash `sha256:ceb02783711429af1ab55ecd015fa394ca97ff37ba540b6b208ab4c365129d6b`；未联网补数据。
- Run：`bt_056706de89b6451c970654744c38d191`，状态 `COMPLETED`，报告 `/2`。
- 报告 hash：`sha256:656a4ea6315d60936d625802ed2e8c3ef4c04cac15a5f29aadb09e406f202a1d`；代码重算 `true`。
- Metrics hash：`sha256:bf23c69915ed0de2a46a5182b302cd3fdcf7aec72acede68d4b97e4c6cf8fb3e`。
- 结果：3 fills、1 个完整 long trade、1 个未平 short（正确排除出完整交易指标）、40 个日权益点、2 个自然月单元；四项 Decimal 对账全部 `true`。
- 当前 BAR 指标：MAE `-0.0286685617152570457239990287`，MFE `0.180834297522628689512001181`，slippage cost `0.0357`。
- 实际操作：选择 OUT_OF_SAMPLE、创建后台 Run、加载报告、按 LONG 和 `NEXT_BAR_OPEN` 过滤、点击 `trade-1` 定位入场 K 线、查看入场/MAE/MFE/退出、查看权益与回撤、点击下载验证包。
- 下载包 SHA-256：`62fa0355b1bb22558384aa986556a5dce71a719b29152cdfe0bdb0ac6f9ed9f1`。其 JSON、CSV manifest 与下载包均绑定上述同一 report hash。
- Console：0 errors；2 条既有 Chromium 非标准垂直 slider CSS 告警。
- 服务结束后 SQLite：`PRAGMA quick_check=ok`，foreign key violations `0`，DB SHA-256 `27633f8887c3b6f93cfc06c6f77ddec11aa6334ecafed2019f70e6889715bef5`。

截图：

- `output/backtest-m7-runtime-20260815/browser/metrics-v2-report-current.png` — `d09bdbf8ff6f6a980ded667103c2987a1fa2d7ba345f749f6a015ec5b035ac24`
- `output/backtest-m7-runtime-20260815/browser/kline-equity-drawdown-current.png` — `e4badc99f2dfe807d3997104831d6d089f63454a6ed13e6e9915ed16bad1df5e`
- `output/backtest-m7-runtime-20260815/browser/report-trade-filter-current-full.png` — `aa715cf53abd60f3fac3b920881d567642d0594c3812b9485ca3d55199c8a5b9`

## 兼容性、限制与回滚

- `/1`：显式测试验证继续生成、读取、重算 hash 和导出；M7 不迁移或重写旧 Run。
- `/2`：golden fixture SHA-256 `87c8384d6026185a09a571a03837f3c12e74a0c0f80bcba4728e351380a5eb0e`。
- 40 天浏览器样本的 annualized return 按合同返回 `null/WINDOW_SHORTER_THAN_365_DAYS`，不是伪造年化值。
- BAR 仍是近似执行且不代表唯一 K 线内路径；aggTrade 仍不宣称 raw trade、spread/depth/queue exact。
- 回滚方式：独立 revert M7 阶段提交即可停止新建 `/2`；已存 `/1` 无需迁移。所有生产 flags 保持 `0`，Metrics V2 UI 开关初始为 `false`。

## 退出门禁逐项

- [x] `/2` schema 有 golden fixture。
- [x] 指标与独立参考计算对拍。
- [x] 开放仓位、零交易、短样本、非正权益不误导。
- [x] `/1` 继续可读且 hash 可验证/稳定。
- [x] CSV/JSON 导出绑定相同 report hash。
- [x] UI 全路径真实浏览器验收通过。
- [x] 没有 M8/M9/M11 越界实现。

结论：`PASS`，允许形成 M7 独立本地 commit；提交完成前不得进入 M8。
