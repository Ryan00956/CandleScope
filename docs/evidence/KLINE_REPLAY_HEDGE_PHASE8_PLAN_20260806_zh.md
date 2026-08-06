# K 线回放 HEDGE 交易所对齐 Phase 8 执行计划

日期：2026-08-06

阶段：Phase 8 — 恢复、审计与故障注入

基线提交：`7dc0951d feat(replay): expose hedge parity by default`

## 1. 背景审计

Phase 5 已把逐账户强平落成一个持久化状态机：撤保护单、风险重算、强平成交、破产接管、保险基金结算、ADL、完成。每一步都有确定性的 case/step/command ID，写入方法在步骤已 `APPLIED` 时直接返回，因此具备幂等基础。现有测试已在七个持久化提交方法返回后模拟响应丢失，并验证重试不会重复创建订单、成交、保险基金 posting、ADL 事件和对手方流水。

但这还不足以证明进程级恢复：

1. 尚未覆盖每一步写入前崩溃；
2. 现有“写入后崩溃”仍在同一服务实例内恢复，没有证明关闭并重开 SQLite/WAL 后结果一致；
3. 没有在 SQLite 写锁耗尽时证明 projection 不会越过未提交步骤，也没有证明重开后能从 durable pending step 继续；
4. 账户审计虽可从 ledger、rules、fills、marks、funding 和两腿持仓独立重建账户，并校验历史 L2 强平成交证明，但保险基金账链、ADL snapshot/candidate/event/selection/counterparty ledger 目前只被投影读取，没有被独立重算；
5. fork 已复制强平、保险基金和 ADL 关系表，但缺少“派生 Review/fork 前后父 Run hash 完全不变”的专门门禁；
6. 多 FULL track 已共享全局有序事件时钟，也有跨 track 的账户级强平测试，但缺少把 reference、故障恢复和最终 hash 同时纳入的断言。

底层 SQLite 已使用 `journal_mode=WAL`、`synchronous=FULL`、`BEGIN IMMEDIATE`、有限写忙重试和 sticky degraded 状态；本阶段复用这一基础，重点补齐边界证明和破损证据 fail-closed，不引入替代存储或默认关闭开关。

## 2. 本阶段确定性近似边界

用户已接受交易所私有数据不可得时的确定性近似。保险基金余额和 ADL 队列继续来自 Phase 3 固定的 simulation archive；模型版本、原始输入 hash、有效时间、候选排序和最终选择都必须持久化并进入审计。近似只替代不可获得的交易所私有状态，不允许跳过证据、静默回退或使用运行时随机数。

## 3. 实施计划

### 3.1 独立审计保险基金与 ADL

- 从 `opening_balance` 开始逐条重算保险基金 posting sequence、previous hash、posting hash、余额和 fund tail/revision。
- 将每个保险基金步骤的 liquidation fee inflow、bankruptcy deficit coverage 与 durable 强平成交、步骤 plan 对账。
- 从固定 simulation projection 重新生成 ADL candidate 排名，并校验 snapshot input/snapshot hash、candidate hash 和排序。
- 重算 ADL event hash、selection hash、completed notional、counterparty quantity/cash 变化及其 hash chain。
- 把上述计数与尾 hash 写入 `independent_exact_state`；任一差异令 account audit 为 `FAIL`。

### 3.2 每个强平状态转换前后故障注入

- 对七个 durable transition 分别注入 `BEFORE_COMMIT` 与 `AFTER_COMMIT_RESPONSE_LOSS`。
- 注入后关闭服务、重开同一数据库，从 durable pending step 恢复。
- 将 reference、before-crash recovered、after-response-loss recovered 的账户、强平组件、步骤和证据 hash 全量比较。
- 断言 command/order/fill/posting/ADL idempotency key 在每种恢复路径下唯一。

### 3.3 SQLite busy 与 WAL 恢复

- 使用真实外部 SQLite writer 持有 `BEGIN IMMEDIATE`，让强平 transition 的有限重试耗尽。
- 断言请求明确返回持久化 degraded 错误，pending step 与公开 projection 均未越过未提交边界。
- 释放写锁、关闭并重开服务，从 WAL/主库恢复后继续，同 reference hash 一致。

### 3.4 Archive rehydrate、fork/review 与多 track 顺序

- 回收并 rehydrate 被 Run 固定引用的历史 L2/账户/近似输入 archive，验证 object/proof/input chain hash 不变。
- 派生 Review/fork 前后分别捕获父 Run 状态、账户审计和强平组件 hash，证明父 Run 没有变化，子 Run 保留完整证据。
- 构造多 FULL track 同一虚拟时刻风险事件，验证全局事件次序、账户级单一 liquidation case、恢复后的最终 hash 与 reference 一致。

## 4. 测试与硬门禁

1. 新增 Phase 8 专项后端测试，覆盖独立保险/ADL 审计、证据篡改、14 个状态机崩溃边界、SQLite busy/WAL recovery、archive rehydrate、fork/review 父 hash、多 FULL track 全局顺序。
2. 运行完整 replay 后端测试；随后运行前端 replay、typecheck、lint、build，确保审计字段扩展没有破坏共享协议。
3. 运行 Ruff、Python compile 与差异检查。
4. 只有 reference/optimized/recovered 最终 hash 全等、幂等键唯一、任一证据破损 audit fail 且不产生新 projection，Phase 8 才可提交。

## 5. 提交边界

Phase 8 仅包含恢复、审计、故障注入测试及对应证据文档；性能/长稳、四小时 soak、百万 projection events 和发布 manifest 留在 Phase 9。完成全部门禁后使用独立提交结束本阶段。
