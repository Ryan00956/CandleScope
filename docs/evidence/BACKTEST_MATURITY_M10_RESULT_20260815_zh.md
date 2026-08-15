# Backtest 成熟化 M10 验收结果（2026-08-15）

## 结论

M10「可靠性、性能和发布验收」全部强制门禁在干净候选
`04b55582b2f73ad48b50fca67eb498fc2ce0fae6` 上通过。M0～M10 主路径由此达到文档定义的成熟回测模式；M11 未实施且保持可选、默认关闭。未 merge、未 push、未启用生产能力、未删除工作树。

## 实现与兼容

- `BACKTEST_CHECKPOINT_V2` 覆盖 BAR、双时钟与成交带，保存不可变输入身份、provider/策略状态、事件游标和安全点；V1 仍按旧语义读取。
- decision 前、订单后、部分成交后、funding 后、报告封存前均可故障注入；恢复不重复成交或资金费，corrupt/stale/mismatch checkpoint 与数据替换、截断、hash 漂移均失败关闭。
- Provider timeout/crash/storage transient 保留最后安全 checkpoint 和审计，只有显式失败 Run resume 才能继续；非恢复错误不得静默重跑。
- schema v5 只新增派生 chart cache，原子写入并校验 hash；旧报告仍可读，v5→v4 回滚只删除派生缓存并保留权威 Run/report/audit 行。
- BAR 仍标记 `APPROXIMATE`；aggTrade 仍标记 `AGGREGATED_TRADE_SEQUENCE`，不宣称 raw trade 或 queue exact；无静默联网补数。

## 自动化验证

| 门禁 | 结果 |
|---|---|
| M10 后端相关回归 | 200 passed，3595 deselected，18.36 s |
| checkpoint/fault matrix | 13 passed；覆盖五个故障点、恢复、SQLite busy、schema rollback 与数据漂移拒绝 |
| detached review focused | 40 passed；diff check、默认 flags、无 M11 扩展均通过，0 findings |
| 前端 typecheck / lint | PASS / PASS |
| 前端全量测试 | 3252 passed，0 failed，136.280 s |
| desktop tests | 34 passed |
| 前端 build | PASS |
| 公开 API smoke | PASS |
| 公开 API 1h soak | 3,604,433 ms，661 个完整 snapshot→Run→report→export→chart 循环，服务存活 |

后端仓库全量另有 `3758 passed, 28 failed, 9 errors`：全部属于 M0 之前提交 `e9705580` 引入 `onBacktestRun` 后遗留的 plugin-platform 冻结合同漂移；受影响 constants/contracts/manifests 在 M0→M10 没有改动。该结果没有冒充全量通过，也没有通过重写旧发布证据来制造通过；M10 相关后端集合为 200/200。

## 真实产品性能

公开 HTTP API、worker、service、repository、report/export 全链路门槛全部通过：

- 20 万 BAR：116.218 s，200,000 输入，2 fills，RSS 370,667,520 B；
- 1,000,000 档官方 aggTrade 工作负载：99.844 s，999,997 个时间原子事件，333 fills，RSS 919,441,408 B；
- 2,000,000 aggTrade：213.078 s，2,000,000 输入，1,214 fills，RSS 1,626,808,320 B；
- 大量部分成交：23.297 s，18,000 fills，报告 13,998,043 B；
- 4 并发 Run：66.578 s，实际最大并发 4；
- Study V2：64 Runs（62 train + 2 OOS），22.5 s。

阈值冻结在 `docs/perf-baselines/backtest/m10-thresholds-v1.json`。环境争用下的早期失败证据保留，未放宽阈值；以上不是私有 `_enqueue/_match` 微基准。

## 4 小时真实浏览器/lifecycle soak

应用内真实浏览器在同一候选进程连续运行 14,494,801 ms，14 次切换 20 万 BAR、200 万 aggTrade 与近 14 MB/18,000 fills 报告：

- 1h：aggTrade 3,009 行、9 canvas、控制台 0；
- 2h：部分成交 2,009 行、9 canvas、控制台 0；
- 3h：BAR 20 行、9 canvas、控制台 0；
- 4h：切回部分成交后 reload，再选同一 Run，恢复 2,009 行、9 canvas、控制台 0；
- heap 样本峰值 115,518,768 B，最终 106,825,048 B；节点峰值 131,024、最终 47,028；监听器峰值 2,030、最终 1,316。不同 Run 卸载后回到稳定的视图特定水平，未见单调无界增长。

完整样本与截图索引位于 `output/backtest-m10-candidate-04b55582/browser-lifecycle-soak-4h.json`。截图 API 返回字节而不自行写路径；保留的原始里程碑字节已显式落盘并参与 artifact hash 校验。

## 回滚、健康与发布证据

- detached worktree 对候选生成 revert `b4ed1657`，reverted tree 与 M9 `eda10ede` 完全一致；演练工作树按要求保留。
- v5→v4 实际回滚丢弃 2 行派生缓存，保留 449 Runs、449 Reports、898 Audit；备份 SHA-256 为 `1f4a271f6c55e1a1084ed6eb6e3b31cd8188df31c1929f6ca4a0d03eaa20a08e`。
- 回滚后 local offline、live、replay、plugin health 均通过；回测路由为 0，plugin runtime 2/2 ready。
- fresh default-off boot 返回 health 200、OpenAPI 无回测路径且未创建 DB。
- release manifest 使用 `candlescope.backtest-release/2`，绑定干净 candidate SHA、四个数据快照 hash、权威 decision/fill/ledger/report hash、命令时长、flags 和 artifact SHA-256。

## 默认开关、限制与退出门禁

`BACKTEST_ENABLED`、BAR、trade tape、Study、replay bridge、external provider、BOOK_ASSISTED、multi-market、online learning 九个生产/高精度开关均为 `0`。验证进程使用显式本地开发 flags，不改变默认值。

已知限制保持诚实：Pine/Pyne 是受限安全语义；aggTrade 不是 raw trade；任何模式都不是 queue exact；BOOK_ASSISTED、多市场、现货和高级研究方法属于 M11 或后续独立决策；回测结果仍不能直接触发 paper/live。

- [x] checkpoint/restore、故障注入、数据身份与恢复失败关闭；
- [x] 真实产品性能、近 16 MB 报告、Study64、4 并发；
- [x] 1h 公开 API soak 与 4h 真实浏览器/lifecycle soak；
- [x] 独立 review、exact revert、schema rollback 与健康检查；
- [x] 后端相关回归、前端 typecheck/lint/tests/build、公开 smoke；
- [x] release manifest 绑定干净 SHA，生产 flags 默认关闭；
- [x] M11 明确为 `NOT_APPLICABLE_OPTIONAL_DEFAULT_OFF`。

结论：满足 M10 与最终 Definition of Done，可以形成独立本地 evidence/completion commit；不授权 merge、push 或生产启用。
