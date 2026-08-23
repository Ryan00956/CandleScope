# Backtest Chart-first Phase 0 合同与基线结果（2026-08-24）

## 结论

Phase 0 已通过，当前状态为
`COMPLETE_VISUAL_APPROVED`。ADR、可重跑命令、追踪矩阵、真实浏览器
基线、真实公开 API smoke 与四个视觉状态均已形成；生产代码、默认 flags、主工作树、远端和
部署均未改变。

用户已于 2026-08-24 明确批准四个同视口视觉合同稿；人工视觉/产品评审门禁关闭，Phase 0
满足退出条件。本结果与对应资产将由 Phase 0 独立提交冻结，Phase 1 尚未开始。

## 合同冻结

- [ADR-BACKTEST-013](../adr/ADR-BACKTEST-013-CHART-FIRST-STRATEGY-TESTER.md) 冻结
  BacktestRun/Study/TrainingRun 三对象、能力共享/runtime 隔离、普通/高级双层入口、状态与 stale
  语义、默认关闭和回滚边界。
- 同一 ADR 冻结 `TradeExplanationV1`、`JCS_SHA256_V1`、64 KiB/64 conditions/128
  variables 等预算、`comparison_context_hash`、`RUN_COMPARE_V3` 和
  `TRADE_FINGERPRINT_V2` occurrence multiset。
- [追踪矩阵](BACKTEST_CHART_FIRST_PHASE0_TRACEABILITY_20260824_zh.md) 明确区分 Phase 0
  已通过基线与 Phase 1～12 计划测试，不把未实现能力写成通过。

## 自动化与 API 结果

| 门禁 | 结果 |
| --- | --- |
| `npm run check:architecture` | PASS；migration allowlist 0 |
| `npm run check:i18n` | PASS；3562 keys / 590 files |
| `npm run typecheck` | PASS；88.897 s |
| `npm run test:backtest` | PASS；26/26 |
| 后端相关 pytest | PASS；241 tests，52.29 s；4 个既有 FastAPI `on_event` 弃用 warning |
| `npm run build` | PASS；628 modules，Vite 6.50 s；保留既有 >500 kB raw chunk warning |
| 公开 API smoke | PASS；12 rows，snapshot→Run→report→export hash，API 424 ms |

第一次尝试从空的 worktree `.venv` 启动 Python 是 setup failure，不计为通过；后端回归明确改用
`D:\anaconda\python.exe` 后通过。第一次 smoke 指向现有 18080 dev runtime 时，因为没有完整不可变
dataset 而按合同失败，未创建 Run。随后在独立 `LOCAL_OFFLINE` 18084 runtime 导入仓库 fixture，
真实公开 API smoke 通过：

- Run：`bt_6dc3547ca3dd41939aad5a8e7cd465cb`
- report hash：`sha256:fcf0cb2b37c08b9ded3392fd37c3f47b2863a7f2e674f4fbef35f3234314cdb6`
- 净收益：`-38.473 USDT`
- 完整交易：1；成交：2
- 可比较基线 Run：`bt_bdbd6e50200348d99c01735fce156fb5`
- 现有 compare 明确仍是 `RUN_COMPARE_V2`，可比净收益 delta `+149.991`；未伪装成未来 V3。

## 性能与连接基线

- 默认生产 build：live entry `531.72 kB / 154.30 kB gzip`；backtest entry
  `92.05 / 22.16 kB gzip`；replay entry `293.27 / 78.78 kB gzip`；shared index
  `783.01 / 233.71 kB gzip`。
- 同一会话布局切换到完整 ready：单图 756 ms；四图 2413 ms。
- 新 tab、Host/cache 已暖：单图 2573 ms；四图 1279 ms。两次顺序与缓存不同，只作为原始
  observation，不是 percentile 或 release gate。
- `VITE_KLINE_BATCH_STREAM_ENABLED=1`：单图 1 个物理 batch WS / 1 logical client /
  2 subscriptions；四图仍为 1 个物理 WS / 4 clients / 8 subscriptions；页面关闭后全部归零。
- 默认前端 batch flag 未设置时 batch active connection 为 0；没有把显式 flag-on 数据描述成
  生产默认。

机器可读证据：[backtest-chart-first-phase0-20260824.json](backtest-chart-first-phase0-20260824.json)。

## 浏览器基线

三张截图均来自同一 Codex 内置浏览器、1440×900 视口，稳定后再捕获：

- [主图基线](../assets/backtest-chart-first-phase0/baseline-main-1440x900.png)
- [K 线回放基线](../assets/backtest-chart-first-phase0/baseline-replay-1440x900.png)
- [旧回测页基线](../assets/backtest-chart-first-phase0/baseline-backtest-legacy-1440x900.png)

## 四个视觉合同状态

视觉稿复用当前深色 token、真实主图截图与真实 smoke Run 图表/成交/权益。HTML 与截图均明确标注
“Phase 0 视觉合同 · 非生产实现”，不声称 Phase 4 已完成。

- [首次打开](../assets/backtest-chart-first-phase0/visual-first-1440x900.png)：只有三个开始入口；无空白
  Monaco、dataset、revision 或 Run。
- [运行完成](../assets/backtest-chart-first-phase0/visual-completed-1440x900.png)：固定结果对象条、四个核心
  指标、真实前后 delta、真实成交原因入口与唯一“运行”。
- [脚本出错](../assets/backtest-chart-first-phase0/visual-error-1440x900.png)：草稿保留，行内诊断和问题列表
  都定位第 8 行第 19 列，修复后仍使用“运行”。
- [结果已过期](../assets/backtest-chart-first-phase0/visual-stale-1440x900.png)：明确上一结果 15m、当前图表
  1m，旧标记隐藏，冻结汇总降权保留，重新执行仍叫“运行”。
- 可交互状态切换源：[chart-first-visual-contract.html](../assets/backtest-chart-first-phase0/chart-first-visual-contract.html)。

## 内部普通用户走查

| 问题 | 当前视觉合同结论 |
| --- | --- |
| 是否始终只有一个主操作“运行” | 是；首次选择入口时不提前出现运行，进入脚本后只有一个运行按钮 |
| 是否需要理解 revision/Run/dataset/snapshot | 否；四态主路径均不出现这些内部术语 |
| 是否一眼看懂结果针对什么 | 是；完成和 stale 顶部都固定显示 symbol、interval、范围、精度、费用/过期原因 |
| 出错时是否知道改哪里或做什么 | 是；行列、变量名、修复建议与定位入口同屏 |

用户人工评审已基于四张同视口图批准上述四项。若后续实现偏离该合同，应重新截图、计算哈希并
重新进行视觉评审，不能用内部走查替代。

## 门禁状态

- 自动化、API、浏览器、性能/租约、证据完整性：PASS。
- 视觉/产品人工评审：PASS（用户于 2026-08-24 明确批准）。
- Phase 0 commit：本结果与资产由 Phase 0 独立提交冻结。
- Phase 1：未开始。
