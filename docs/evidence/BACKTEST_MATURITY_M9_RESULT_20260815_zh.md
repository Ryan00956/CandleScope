# Backtest 成熟化 M9 验收结果（2026-08-15）

## 结论

M9「策略研究工作台与回放研究桥」退出门禁通过。实现基于 M8 提交
`21acca58783c6139233373094fcd96e0e3da2160`，没有进入 M10/M11，没有启用任何生产或高精度默认开关。

## 实现范围

- 新增不可变 `STRATEGY_REVISION_V2`：创建、静态检查、编译、复制、归档均生成或保留独立身份；已归档 revision 不可创建新 Run，旧 Run/报告仍可读。
- 普通内置策略由参数 schema 生成表单；Pine 子集返回带行列与下一步的诊断；Pyne 仅接受安全的统一订单 DSL；外部模型只能引用冻结、离线、带 hash/runtime lock/feature schema 的 artifact，禁止训练、覆盖与联网。
- 长 Run 前必须有同一 revision、同一 `dataset_id + snapshot_hash` 的七日内有界 smoke receipt。
- `PAGED_V1` 信号轨迹从主报告分离，单页最多 500、总计最多 10,000；主报告只保存 count/hash/page identity。RSI pane、订单/成交标记、交易详情和费用证据都使用只读投影。
- `RUN_COMPARE_V2` 先核对 snapshot、账户、合约、指标和 fidelity 身份；不兼容时禁止直接叠加。兼容时返回参数、净值、回撤、交易和费用/资金费/滑点差异，并用 decision/fill hash 解释“同决策、不同成交”。Clone 只允许修改一个既有参数并生成新 Run。
- 回放研究桥默认关闭。启用后只传不可变数据引用与只读策略投影，绑定独立运行身份；人工运行结束前保持盲态，结束后才可一次性揭示。账户、cursor、checkpoint 和 UI store 不共享；超过 2,000 笔人工交易时失败关闭，不把截断结果冒充完整比较。
- schema 升至 v4；提供带显式确认、备份、数据存在即拒绝的 M9→M8(v3) 回滚脚本。

## 自动化验证

| 门禁 | 命令 | 结果 |
|---|---|---|
| M9 focused + M8 + 架构 | `python -m pytest backend/tests/test_backtest_strategy_workspace_m9.py backend/tests/test_backtest_study_v2_m8.py backend/tests/backtest_contract/test_architecture_absence.py -q` | 19 passed，6 个既有 deprecation warnings |
| 后端相关回归 | `python -m pytest backend/tests -k backtest -q` | 186 passed，3595 deselected，6 个既有 warnings |
| Ruff | `python -m ruff check ...` | PASS |
| TypeScript | `npm run typecheck` | PASS |
| ESLint | `npm run lint` | PASS |
| 前端全量测试 | `npm test -- --run` | 3252 passed，0 failed，耗时 161.346 s |
| 前端生产构建 | `npm run build` | PASS；仅保留既有 live chunk >500 kB warning |
| whitespace | `git diff --check` | PASS |

一次把 typecheck、lint、全量测试串联的尝试被 240 s 外层超时中断并产生 EPIPE；三个门禁随后分别以足够预算重跑并全部通过，因此未把超时尝试计为通过证据。

## 真实浏览器产品路径

在本地离线服务 `127.0.0.1:15193/backtest.html` 上完成了文档要求的 M9 产品路径：

1. 选择本地数据与窗口，创建不可变 RSI24 revision，并查看 source/compiled/dependency/runtime hashes、能力与不支持项。
2. BAR smoke 后运行 `bt_ccefedc7c70e4283bf5956f50be8b16e`；看到 RSI pane、K 线交易点、交易表、decision/accepted/fill 时钟、延迟、滑点、手续费、资金费和 BAR 精度提示。
3. 在已验证的 aggTrade 存档上 smoke 并运行 `bt_bf4afb4feb364fbfb553a44a53e22121`；页面显示双时钟与 aggTrade 非 raw trade/非 queue exact 的诚实标注。
4. BAR 与 aggTrade 对比被判定身份不兼容并禁止直接叠加；Clone 仅把 `length=24` 改为 `25`，生成 `bt_d511965e9aab4e95ad286ba04f59f888`，同身份对比获准。
5. Study V2 `st_36eaabc2d55e48faa095bf4ea22ba4be` 完成 5 folds / 20 train trials，OOS 仅含 TEST_RUNS_ONLY；导出接口返回 200，报告与 manifest hash 均重算相符。
6. 页面 reload 后 revision、Run、Study 均恢复，最终 console 为 0 errors / 0 warnings。
7. Pine 非法调用显示行/列与可执行修复建议；安全 Pyne 订单 DSL 编译成功；复制并归档 revision 后旧结果仍可读。

截图与 SHA-256：

- `output/backtest-m9-runtime-20260815/browser/dual-clock-run-compare.png` — `CB7F872EE0D97A9C84D1CE3862EA4EE4D2CA2668B68866B9418C9085C2C75230`
- `output/backtest-m9-runtime-20260815/browser/study-oos-reload.png` — `0B583EA5A6CCE18F939A8767BEF5065AD31F39E88AF96E92D7FD12D54BD88E1C`
- `output/backtest-m9-runtime-20260815/browser/final-reload-recovery.png` — `6505CDB81C4CC0CF04C11B39A60612C0CAF7D45A8FF473C1F3159B64945D4AF9`

最后补充显式 trade/cost/drawdown 对比和一次性揭示按钮后，最新源码对应的 Vite 页面经本机 HTTP 检查返回 200，后端完成 startup；但应用内浏览器停留在先前的连接失败页，并由 URL 安全策略拒绝继续导航且禁止换表面规避。该增量已由 19 个 focused tests、M9 前端合同测试、typecheck、lint、3252 个全量测试和 build 覆盖；上面的真实浏览器核心路径、截图和零 console 证据来自同一 M9 阶段且未被该增量改变。此限制不被写成一次新的浏览器通过。

## 完整性、兼容与回滚证据

- runtime DB：`schema=4`，`quick_check=ok`，`foreign_key_check=[]`；SHA-256 `CF70710114D225826BD8A4EEF82EAD27E2E3FD53026FF00FCBFB8F4F2B545396`。
- 计数：3 revisions、2 smokes、263 signal trace rows、0 bridges、28 Runs、1 Study。
- aggTrade 主报告 hash：`sha256:cf2ae807e4d91e68da5e8b31ba43a10ce86ad87d0311e19c09cc362b9800656e`；信号轨迹 count=34，hash `sha256:b982ffad3bf7e0ae6996a7dbfe9fea258e711a0de22c0ad0b12288778e5df906`，主报告无 inline trace。
- OOS 报告 hash：`sha256:c846e955b990167551f7a394789bfaaf8ad949848ac698dbb84bc34132296137`。
- 空 v4 DB 实际回滚到 v3：`quick_check=ok`，四张 M9 表均不存在；回滚 DB hash `D16A2178098F4260CF181FE2F9120C62C27D2B7808D47CA96A601B3A517CA003`，备份 hash `36215B4837788C3FB65CD9B6A443D3ACEB31A795395A84EFC6CB6BED07DA9947`。
- 含数据副本回滚按预期退出 1，报告 revisions=3、smokes=2、trace=263、bridges=0，且没有创建备份。
- v1 旧报告 hash/golden 语义保持；新分页 trace、compare V2、revision V2 和 bridge 使用新身份，不静默改变旧 Run。
- M9 不要求性能阈值或 soak；本阶段只记录真实有界产品路径，不把私有微基准冒充性能/发布证据。

## 默认开关与已知限制

空环境下 `BACKTEST_ENABLED`、BAR、trade tape、book assisted、Study、external provider、online learning、multi-market、replay review bridge 全部为 `false`。未 merge、未 push、未启用生产能力。

已知限制：Pine 是明确标注的安全子集，不是完整 TradingView Pine；Pyne 是白名单订单 DSL，不执行任意 Python；外部 artifact 只做冻结离线推理；aggTrade 不是 raw trade，任何模式都不是 queue exact；桥接在默认关闭状态下未做浏览器端人工完成运行，盲态/揭示和隔离契约由后端/API 合同测试覆盖。

## Definition of Done 核对

- [x] 普通策略无需手写 JSON；高级路径使用统一订单接口。
- [x] revision/source/artifact/dependency/runtime identity 不可变且可审计。
- [x] smoke、分页 trace、RSI pane、交易详情、对比与单参数 Clone 完成。
- [x] 独立盲态回放桥默认关闭，并有结束后一次性揭示契约。
- [x] BAR/aggTrade/queue 精度不夸大，无静默联网补数。
- [x] focused、回归、前端全套、build、兼容、完整性和回滚门禁通过。
- [x] 阶段真实浏览器主路径完成且有截图/hash；受策略阻止的补充复验单独披露。

结论：满足 M9 退出门禁，可以形成独立本地提交；提交完成前不得进入 M10。
