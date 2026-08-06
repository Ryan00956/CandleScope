# K 线回放 HEDGE Phase 3 完成证据

日期：2026-08-06  
基线：`42ca5560`  
阶段：Phase 3 — pinned public archive 与 materialized simulation manifest

## 1. 结论

Phase 3 已完成。HEDGE Run 现在只能在下列输入全部被 replay 自有对象库验证并原子固定后创建：

- 同一市场、时间范围与 settlement asset 的 public-history archive；
- public archive 声明且与实际绑定一致的 historical L2 archive；
- 版本化、已物化的 insurance/ADL deterministic simulation manifest；
- `BOOK_ASSISTED_REQUIRED`、`HISTORICAL_EXACT` funding 与手工精确起点。

公开输入使用历史固定的 rule、fee policy、mark/index 和 funding；交易所私有保险基金与 ADL 状态继续明确标记为 `DETERMINISTIC_SIMULATION_NOT_HISTORICAL_EXCHANGE_FACT`。本阶段没有把近似改名为历史交易所精确事实，也没有增加 fallback、灰度开关或默认关闭入口。

## 2. 已落地合同

### 2.1 自有对象与不可变导入

- 新增 `replay.hedge-public-history.archive.v1` builder、validator、event hash chain、dataset epoch、proof hash 与 owned catalog。
- simulation manifest 经 Phase 0 validator 二次验证并物化为稳定 phase 70 insurance/ADL 输入事件。
- 同一对象内容重复导入为幂等操作，不改变 generation；同一 ID 指向不同 bytes/dataset/proof 时明确返回 `HEDGE_INPUT_IMMUTABLE_ID_CONFLICT`。
- catalog 只允许 `READY` 对象绑定；owned bytes 缺失、篡改或 catalog generation/checksum 漂移均暂停 Run，`fallback_applied=false`。
- rehydration 只能从导入时记录的 trusted source 恢复，并必须保持相同 checksum、dataset epoch 与 Run input proof；运行时不依赖网络。

### 2.2 原子 Run pin 与全局输入时钟

- training schema 升级到 v15，增加 public/simulation catalog、Run binding、projection、applied receipt 与 input audit 表。
- Run 初始化事务同时固定 public、simulation 与 historical L2 generation/checksum/proof，写入两个 T0 no-lookahead projection。
- HEDGE 单 track 也强制进入 `GLOBAL_ORDERED_INPUT_CLOCK`；事件顺序固定为 rule/fee(10) → market(20) → mark/index(30) → funding(40) → simulation(70)，同毫秒再按 stable source ID 与 source sequence 排序。
- pinned mark 从 T0 起覆盖 track public price 和 LONG/SHORT 逐腿风险投影；缺失时不读取 bar close、trade last 或 adapter mark 兜底。
- 每个 applied event 持久化 source hash、payload、virtual time 与 Run-scoped receipt hash；Review fork 为 child Run 重算 receipt hash，不复制父 Run 的审计结论。

### 2.3 独立审计与产品边界

- input auditor 从 owned archive 重新读取事件，独立重算 binding proof、projection state/hash、cursor、chain 与 applied receipt。
- auditor 发现任一差异会写 `FAIL` 证据并把 binding/Run 置为 `PAUSED`。
- portfolio 暴露不含本地路径的 `replay.hedge-input-view.v1`：对象 generation、dataset/checksum/proof、两类 projection 和最新 auditor 结论。
- 前端严格 parser 同步验证所有 wire 字段、SHA-256、时间范围、source canonical order 与 auditor 状态；未知或不一致字段 fail closed。
- HEDGE fee/funding fidelity 分别为 `PINNED_HISTORICAL_FEE_POLICY` 与 `PINNED_HISTORICAL_FUNDING`；insurance/ADL 仍保留确定性模拟 fidelity。

## 3. 硬门禁证据

| 门禁 | 结果 | 证据 |
| --- | --- | --- |
| 伪造 ref 不能创建 HEDGE | PASS | create 强制从 owned catalog prepare，并交叉核对实际 L2 binding |
| source gap/duplicate/backward/tamper/delete 暂停 | PASS | builder/validator、runtime guard、projection auditor 与 tamper 专项 |
| catalog refresh 不改变已有 pin | PASS | 同内容导入 generation 保持 1；同 ID 异内容拒绝 |
| 无 mark/funding/book fallback | PASS | HEDGE 强制 pinned mark/funding/L2；错误详情固定 `fallback_applied=false` |
| 关闭网络后可重放 | PASS | owned bytes 运行；删除后只用 trusted source 显式 rehydrate，proof 不变 |
| restart/fork 保持证明 | PASS | offline restart 与 Review child receipt 重算/审计通过 |
| 前后端 wire contract 一致 | PASS | `hedge_inputs` 严格 parser、无未知字段兼容洞 |

## 4. 验证结果

### 后端

- Phase 3 专项：`4 passed`。
- Phase 2 逐腿保证金、Review fork 与 Phase 6 HEDGE 强平回归：`4 passed`。
- 完整 replay 后端集：`851 passed, 2322 deselected, 4 warnings in 145.58s`。
- Ruff：通过。
- Python compileall：通过。
- `git diff --check`：通过。

四条 warning 均为既有 FastAPI `on_event` deprecation warning，没有新增 warning 或跳过失败。

### 前端

- replay 测试：`326 passed, 0 failed`。
- TypeScript typecheck：通过。
- ESLint：通过。
- Vite production build：通过（541 modules transformed）。

构建保留既有大 chunk 提示；本阶段没有新增构建失败。

## 5. 范围边界

Phase 3 只负责固定和审计输入，不提前宣称完成 Phase 4 的逐腿 funding/fee ledger，也不宣称完成 Phase 5 的部分强平、保险基金消耗或 ADL execution。下一阶段必须基于本阶段的 phase 40 funding 与 effective fee-policy revision 完成双腿独立结算、幂等 posting 和全账户账本重算。
