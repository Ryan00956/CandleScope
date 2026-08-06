# K 线回放 HEDGE 交易所对齐 Phase 8 完成证据

日期：2026-08-06

阶段：Phase 8 — 恢复、审计与故障注入

基线：`7dc0951d feat(replay): expose hedge parity by default`

## 1. 结论

Phase 8 已完成。HEDGE 强平状态机现在可在七个 durable transition 的提交前崩溃或提交后响应丢失后真实关闭并重开服务，恢复结果与无故障 reference 路径 hash 一致。SQLite 写忙预算耗尽时不推进公开 projection；释放锁并重开 WAL 后可从 durable pending step 继续。

账户审计现可从 ledger、rules、marks、funding、fills、历史 L2、insurance 和 ADL 独立重建。保险基金 posting、ADL snapshot/candidate/event/selection/counterparty ledger 的 payload/hash/余额/数量链任一损坏都会令顶层审计失败，并把 HEDGE Run 暂停、账户置为 `FAILED_CLOSED`，不继续沿用旧 projection。

## 2. 本阶段实现

### 2.1 保险基金与 ADL 独立审计

- 从 opening balance 和固定 simulation input 事件开始重放保险基金余额、revision、previous hash、posting hash 与 ledger tail。
- 将 liquidation fee inflow 和 bankruptcy deficit debit 与强平成交、保险步骤不可变 plan 对账。
- 从可 rehydrate 的固定 ADL cohort 重新排序 candidate，重算 snapshot input/snapshot hash 与 candidate hash。
- 重算 ADL required/completed notional、event hash、selection hash、对手方 quantity/cash 变化及 counterparty hash chain。
- 将来源计数与保险基金 tail 加入 `independent_exact_state.insurance_and_adl`。
- 服务顶层状态同时要求 account audit 与 HEDGE input audit 成功；非 HEDGE 的 `NOT_APPLICABLE` 保持兼容，不会误报失败。

### 2.2 durable command 重放修复

故障矩阵发现：历史 L2 close 已提交到 replay command log、但 liquidation step 尚未提交时，进程重启会以恢复后的新 revision 重构相同 command ID，触发 `COMMAND_ID_REUSED`。

修复后，取消单与历史 L2 close 在发现既有 deterministic command ID 时读取持久化 command envelope，校验 protocol、command ID、type 与 payload 仍匹配不可变 plan，然后使用原始 client/revision/payload 重放原 ACK。若持久化 envelope 损坏或与 plan 冲突，强平明确 fail closed。

### 2.3 SQLite/WAL、archive 与 fork/review

- 外部 writer 持有 `BEGIN IMMEDIATE` 并耗尽四次写忙尝试时，返回 `PERSISTENCE_DEGRADED`，pending liquidation 与公开 projection hash 保持不变。
- 释放锁后验证 `journal_mode=wal`、`integrity_check=ok`，重开服务恢复结果与 reference hash 一致。
- 对 active HEDGE public archive、simulation manifest 与 historical L2 archive 注入本地对象丢失/EVICTED，均从 trusted source 恢复相同 checksum/dataset epoch；binding proof 与 book projection hash 不变，恢复后强平与审计通过。
- Review 与 fork 前后父 Run state hash、账户 audit proof 与完整强平证据 fingerprint 不变；子 Run 保留 portable evidence 并通过独立审计。
- 多 FULL track 共用一个 virtual time，账户风险只生成一个 case；强平腿按 position side、stable ordinal、track ID 的冻结顺序持久化。

### 2.4 用户接受的近似边界

保险基金余额和 ADL 队列仍使用 Phase 3 固定的确定性 simulation archive，原因是交易所私有账户队列不可获得。模型版本、输入有效期、原始 receipt/hash、候选排序、选择和最终账链均持久化、可审计、可重放；不存在随机回退、灰度入口或默认关闭开关。

## 3. 专项故障矩阵

七个 transition 均覆盖 `BEFORE_COMMIT` 与 `AFTER_COMMIT_RESPONSE_LOSS`：

1. `commit_liquidation_cancellation`
2. `commit_liquidation_recheck`
3. `commit_liquidation_execution`
4. `commit_liquidation_bankruptcy`
5. `commit_liquidation_insurance`
6. `commit_liquidation_adl`
7. `commit_liquidation_complete`

每个注入点均关闭原服务、重开同一 SQLite，随后与无故障 reference 比较：portfolio、HEDGE state、liquidation component/step、insurance posting、ADL event/selection/counterparty hash 一致；order、fill、posting、ADL idempotency key 均唯一。

## 4. 测试证据

### 专项与受影响回归

- Phase 8 专项：`23 passed in 27.55s`。
- Phase 4/5/6/8 受影响集合：`44 passed in 46.92s`。
- 非 HEDGE `NOT_APPLICABLE` 合并状态回归：`5 passed`。
- 多 FULL track 账户级 case/时钟/顺序测试通过。

### 完整门禁

- 后端完整 replay：`900 passed, 2322 deselected, 4 warnings in 252.19s`。
- 前端完整 replay：`329 passed, 0 failed`。
- TypeScript typecheck：通过。
- ESLint：通过。
- Vite production build：通过；仅保留既有 chunk-size warning。
- Ruff：通过。
- Python compileall：通过。
- `git diff --check`：通过。

后端四条 warning 均为既有 FastAPI `on_event` deprecation warning，不是本阶段新增失败。

## 5. 硬门禁对照

| 门禁 | 结果 |
|---|---|
| reference / recovered 最终 hash 一致 | 通过，14 个 transition 崩溃边界全部比较 |
| 重启/重试后幂等键唯一 | 通过，order/fill/posting/ADL 全部唯一 |
| evidence 断裂 fail closed | 通过，六类 insurance/ADL hash 篡改均 FAIL 并暂停 Run |
| SQLite busy 不推进旧 projection | 通过，busy exhaustion 前后 fingerprint 相同 |
| WAL recovery | 通过，重开后 integrity 与 reference hash 一致 |
| archive rehydrate | 通过，public/simulation/L2 receipt 不变 |
| fork/review 不改变父 hash | 通过 |
| 多 FULL track 同一时钟和冻结顺序 | 通过 |
| 默认启用、无灰度模型 | 保持 Phase 7 行为，不新增开关 |

## 6. 阶段边界

本提交只完成恢复、审计、故障注入与证据。1/2/4/8 FULL track 性能矩阵、强平波统计、四小时 soak、100 次生命周期、1,000,000 projection events、release manifest 与 rollback drill 属于 Phase 9，将在下一独立提交中完成。
