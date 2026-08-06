# K 线回放 HEDGE Phase 5 执行计划（2026-08-06）

## 背景审计

Phase 1 已建立 risk snapshot、liquidation case/leg/step/order/fill、insurance fund/posting 和 ADL snapshot/candidate/event/selection 的关系模型；Phase 3 已 pin 公开规则、mark/index、fee、历史 L2 与确定性 simulation manifest；Phase 4 已把逐腿成交、费用、资金费和账本做成可重算事实。

Phase 5 开始前的运行时代码仍只实现了一个兼容性短路：按 track 建 case，撤销该 track 的订单后，对每条腿发送一次 `quantity=null` 的 `CLOSE_POSITION`，最后统一扣强平费并把 case 标记完成。该实现存在以下明确缺口：

1. CROSS 违约被按 track 拆分，不是账户级风险案例；
2. 没有撤单后的风险重评估，也没有恢复后退出；
3. 没有 risk-tier 逐档部分强平、逐 fill 重评估和确定性腿排序；
4. 通过 `quantity=null` 全平，无法证明目标数量、部分成交和恢复语义；
5. liquidation order/fill 只是事后占位，未绑定真实 broker order/fill；
6. bankruptcy/takeover、保险基金、ADL 只有表结构，没有运行时 posting；
7. 状态机不是逐 durable step 提交，无法在任一步崩溃后无重复恢复；
8. simulation manifest 已物化保险基金与 ADL cohort，但强平引擎没有消费这些输入。

## 冻结实现决策

- CROSS 使用单一账户级 case，覆盖同一结算资产下所有受影响 FULL track/leg；ISOLATED 继续按独立腿建 case。
- 强平腿顺序固定为 maintenance margin 降序、absolute notional 降序、track id 升序、LONG 先于 SHORT。
- 每个外部副作用都使用由 case/step/leg 派生的稳定 command id；broker command 成功但 step receipt 未提交时，重试命中原 command receipt，不产生第二笔订单或成交。
- 撤单、风险重评估、每次 partial/full execution、bankruptcy transfer、insurance、ADL、complete 分别提交为独立 transaction。
- tier 大于 1 时只平到上一档 notional cap；tier 1 的目标为零。数量按 rule quantity step 向上取整但不超过当前腿数量，每个真实 fill 后重新评估。
- 只发送显式 canonical quantity；禁止 `quantity=null` 和直接清零 position。
- liquidation order/fill 从已经持久化的 broker order/fill 反查并复制，保留真实 price、quantity、fee、source sequence 和执行模型。
- 逐腿 liquidation/bankruptcy/takeover price 使用冻结规则、tick grid 与“其他 CROSS marks 固定”的确定性根；价格、公式输入与 hash 可查询。
- liquidation fee 从用户账户扣除并进入模拟保险基金；破产缺口只扣到 fund 的零余额，不允许负数。
- fund 不足时必须消费当前有效的物化 ADL cohort；候选排序和选择复用 Phase 0 冻结公式，并写 counterparty before/after quantity、cash effect 和 hash-chain receipt。
- 缺 rule、mark、真实 fill、有效 simulation input、有效 ADL cohort 或 cohort 容量不足时，case 与 Run 一起 `FAILED_CLOSED/PAUSED`，不做代理或随机候选。

## 实施顺序

1. 扩展 schema：逐腿 liquidation price proof 与 ADL counterparty ledger；提升 training schema 版本。
2. 把检测改为 CROSS 账户级 / ISOLATED 逐腿 case，并只创建首个 `CANCEL_ORDERS` durable step。
3. 新增当前风险快照、step plan/receipt、稳定 idempotency key 和 fail-closed 辅助函数。
4. 把 service reconciliation 改成循环状态机：cancel → recheck → partial/full（0..N）→ bankruptcy → insurance → ADL → complete。
5. 将真实 broker order/fill、强平费、保险 posting、ADL candidate/selection/counterparty ledger 和最终 hash 串入同一审计链。
6. 更新 portfolio/report/review fork 投影，保证每条腿、step、order、fill、posting、selection 均可查询。
7. 增加 Phase 5 专项测试：撤单恢复、tier 部分强平、双腿全平、跨 track CROSS、保险充足/不足、ADL、cohort 不足 fail closed、每个 durable step 的崩溃重入与 hash 等价。
8. 运行专项、回归、完整 replay backend、frontend replay/typecheck/lint/build、ruff/compile/diff gate；记录真实结果后提交独立 Phase 5 commit。

## 完成门槛

- 不存在强平路径使用 `quantity=null` 或直接写零数量；
- CROSS 多 track 只产生一个账户级 case；
- 每一步都能从 durable state 恢复且不重复订单、fill、fee、insurance 或 ADL；
- insurance balance 永不为负；不足时只允许 ADL 或 fail closed；
- 所有 case/leg/step/order/fill/pricing/posting/candidate/selection/counterparty receipt 可从 portfolio/report 查询；
- 最终状态和 hash 与无崩溃参考执行一致。
