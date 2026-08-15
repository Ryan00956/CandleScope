# Backtest M8 阶段验收结果（2026-08-15）

## 结论

M8「Study V2 与真正 Walk-forward」通过实现、focused/回归测试、真实浏览器产品路径、SQLite
恢复/迁移/回滚与 hash 复算，满足执行文档 13.8 的全部退出门禁。M8 没有独立性能或 soak 数值阈值，
因此两项为 `NOT_REQUIRED_BY_M8`；没有用私有内核微基准冒充发布证据。

验收基线为分支 `codex/backtest-foundation`、父提交
`acf9a1cd97ae4cb24e14dd2feb96a28dc6135fb4`。没有 merge、push、生产启用或工作树删除；生产与
高精度 flags 继续默认关闭。

## 已实现内容

- 新增 `BACKTEST_WALK_FORWARD_V2`、`TRAIN_CONSTRAINT_OBJECTIVE_SELECT_ONCE_V2`、Study `/2`、
  selection receipt `/1`、OOS `/1`、holdout reveal `/1`；旧 Study 继续 legacy V1。
- 显式持久化 `Study -> Fold -> TrainTrial -> SelectionReceipt -> TestRun`，receipt append-only、
  test 唯一、holdout 一次性揭示；worker 重启幂等恢复，取消后不再规划新 Run并保留已有证据。
- 冻结 hypothesis、snapshot、窗口/purge/embargo/holdout、参数空间、sampler/seed、objective、
  constraints、tie-break、预算、账户/成交/成本/指标/benchmark，以及
  `START_INCLUSIVE_END_EXCLUSIVE_V2` 窗口语义。
- 支持 `NET_RETURN/SHARPE/CALMAR/EXPECTANCY`；最小完整交易、最大回撤、覆盖、ambiguity、
  rejected、可选成本 +25% 约束先于 objective。无交易或违反约束者不可获胜，多空样本不足显式警告。
- OOS 只接收绑定 receipt 的 TEST Run，展示归一化权益、train/test gap、参数邻域、成本/延迟敏感性、
  bootstrap、selection-bias、市场阶段及 buy-and-hold/always-flat 基准；holdout 不进入 OOS。
- UI 先写 hypothesis，再配置 RSI24 参数空间；明确显示 Train/Test/Holdout、TRAIN-only 热图、每 fold
  参数/receipt/TestRun、拼接 OOS 及“不是实盘批准”。
- schema v3 为加法迁移。回滚脚本先写独立备份，只允许无 V2 Study 数据时降到 v2；存在 V2 数据时
  失败关闭且不生成备份。

## 自动化验证

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| M8 focused | `python -m pytest -q backend/tests/test_backtest_study_v2_m8.py` | `10 passed` |
| legacy + M8 Study | `python -m pytest -q backend/tests/test_backtest_study.py backend/tests/test_backtest_study_v2_m8.py` | `17 passed` |
| 相关后端回归 | `python -m pytest -q backend/tests -k backtest` | `181 passed, 3595 deselected, 6 existing warnings` |
| Ruff | M8 Python files `ruff check` + `ruff format --check` | PASS |
| 前端类型/lint | `npm run typecheck` / `npm run lint` | PASS / PASS（0 warnings） |
| 前端全量测试 | `npm test -- --run` | `3250 passed, 0 failed` |
| 前端生产构建 | `npm run build` | PASS；仅既有 `live` chunk 大小告警 |
| Patch | `git diff --check` | PASS |

Focused 覆盖无 test 泄漏、同身份/seed/snapshot/预算 receipt 确定性、无交易与约束淘汰、TEST-only
OOS、窗口不重叠、预算、取消、重启不重复 TestRun、holdout once、inclusive close 规范化、基础策略参数
保留、schema v2→v3→v2 drill、V2 数据存在时拒绝回滚，以及真实 Runtime/SQLite RSI24 多 fold 产品路径。

## 真实浏览器产品路径

- URL：`http://127.0.0.1:15193/backtest.html`，Vite proxy 到隔离后端 `127.0.0.1:18100`；
  `LOCAL_OFFLINE`，网络策略 loopback-only，未联网补数据。
- 数据：220 根 deterministic `BTCUSDT 1d` bar 与本地 mark/index/rules/funding；data epoch
  `sha256:3ff7ab517618c2f40c480dc8d46d3fe2c289eb727844f86b8e52f8a4b4aada62`，合同 bundle
  `sha256:d5c9f3bd88cd5e4dda93c6ef9a5a4f678771ae2cc58134affa4667f88b992a15`。
- Study：`st_5476ea48f3ea4d44b6f68d3ab03ca288`，最终 `COMPLETED`；4 folds、16 TRAIN、4 唯一
  TestRun、4 append-only receipts、1 HOLDOUT Run。
- 每 fold 选择均为 `length=20, oversold=30, overbought=70`；length=24 的无完整交易候选显示
  `MIN_CLOSED_TRADES` 并未获胜。
- OOS：`TEST_RUNS_ONLY_V1`，hash
  `sha256:d8ea0b9c007c51f0d1093ba7f01ab3c86383373fa1a70aac55b089c6f6577caa`，代码复算 true，
  4 个 OOS Run ID 与 4 个 fold TestRun ID 集合完全相同。
- Holdout receipt：
  `sha256:5f40712a39ab19020a086bc8ca4db174dc2d3302402133bb987b3ddbcc80d7de`，复算 true；Run
  `bt_9149de1cfc5441b9ab145874f462a211` 完成。揭示按钮完成后消失，重复调用的 focused test 返回同一 receipt/Run。
- Console：0 errors；2 条既有 Chromium 非标准垂直 slider CSS 告警。
- 截图：
  - `output/backtest-m8-runtime-20260815/browser/study-v2-oos-before-holdout.png` —
    `7782e6a3698fa3c64ed93a73b59d6025b5ac71bc6ce2182feb3275a69a8932d9`
  - `output/backtest-m8-runtime-20260815/browser/study-v2-completed-holdout.png` —
    `9e1d0a44af5a6745a80ca295e4bcb090dab2b7fd8c7154d786fb63b37d6fc8d5`

首次浏览器验收诚实暴露了两个问题：V2 列表未 enrichment，以及 inclusive close 导致 holdout 起点偏移
1ms。前者使 UI 显示 legacy/0 folds，后者按合同失败为 `DATA_ROLE_COVERAGE_MISSING`。两者均在 M8
范围内修复、补回归测试，并用全新不可变 Study 完整重跑；失败 Study/Run 未被改写或删除。

## 兼容性、存储与回滚

- legacy Study focused 7/7 继续通过；V2 使用新协议分派和新表，不重写旧 trials。
- M7 `/2` 是 V2 选参输入；旧 `/1` Run/报告路径由相关后端 181 项回归继续覆盖，未做重算迁移。
- 结束服务后 SQLite `quick_check=ok`、foreign key violations `0`，DB SHA-256
  `6dce4a599261602ccc86801c02911db3488b804aa3b477fa6c692e18e8aa1d0a`。
- 临时数据库真实执行 schema v3→v2 rollback 后 `quick_check=ok`；有 V2 Study 数据时回滚拒绝且备份
  文件不存在。生产回滚要求停服务、独立备份并 revert M8 提交；无数据清理授权时不得降级 schema。
- 默认配置实测 backtest 总开关、BAR、trade、book、Study、external provider、online learning、
  multi-market、replay bridge 全为 `false`。

## 退出门禁逐项

- [x] test 数据从未参与参数选择。
- [x] 同 seed、snapshot、预算和冻结身份产生相同 selection receipt。
- [x] OOS 汇总只包含唯一 TestRun。
- [x] 无交易或违反约束的候选不会因 objective 偶然较高获胜。
- [x] RSI24 参数空间 Study 完整展示各 fold 选择、receipt、TestRun、OOS 与 holdout。
- [x] 迁移、恢复、取消、一次性揭示、旧 Study 读取、默认 flags 和回滚均通过。
- [x] 没有实现 M9 或 M11。

结论：`PASS`，允许形成 M8 独立本地 commit；提交完成前不得进入 M9。
