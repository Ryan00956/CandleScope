# K 线回放 HEDGE Phase 3 背景审计与执行计划

日期：2026-08-06
基线：`42ca5560`
范围：HEDGE pinned public-history archive、materialized simulation manifest、全局输入时钟、连续性/校验/quarantine/rehydration；不提前实现 Phase 4 的最终逐腿 funding/fee posting 或 Phase 5 的强平执行。

## 1. 已确认背景与缺口

- Phase 1 已把 `hedge_public_history_ref` 和 `simulation_manifest_ref` 固定进 replay.v3 canonical 与 Run 行，但当前只是调用方声明；创建 Run 时没有在 replay-owned catalog 中查找并原子 pin 对象，也没有核对对象内容、范围或 symbol。
- Phase 0 的 simulation manifest validator 已冻结 insurance event hash chain、ADL snapshot coverage 和 model version，但没有 importer、owned object、catalog health、run binding、rehydration 或运行时读取路径。
- 既有 `AccountHistoryArchiveManager` 有 checksum、immutable copy、quarantine、ref、projection 和 account-only event clock，但 archive contract 明确为 `position_mode=ONE_WAY`，不能静默复用成 HEDGE。
- 既有 `HistoricalBookArchiveManager` 已提供 FULL L2 连续性、pin 与 no-fallback 投影；Phase 3 应要求 HEDGE public archive 明确引用同一个已验证 L2 dataset，并在原子绑定时交叉核对，而不是复制第二套盘口格式。
- `TrainingRunService` 已能把 RULE(10)、MARK/INDEX(30)、FUNDING(40) 与 market phase(20) 合并到一个稳定虚拟时钟，但只读取 ONE_WAY account-history。HEDGE 目前仍由 bar/trade mark 驱动风险投影，违反 pinned mark no-fallback。
- 当前没有 fee-policy 输入事件、simulation insurance/ADL materialized event 的全局 source sequence，也没有删除/篡改/gap 后把 Run 置为 `PAUSED` 的 HEDGE guard。

## 2. 冻结 Phase 3 合同

1. Public archive 使用 `replay.hedge-public-history.archive.v1` canonical JSON，内容包含 exchange/market/symbol/settlement identity、时间范围、source identity、capture receipt、连续事件链与一个已验证 historical-L2 ref。
2. Public event kind 固定为 `RULE`、`FEE_POLICY`、`MARK_INDEX`、`FUNDING`；phase 固定为 10、10、30、40。同一毫秒按 `(time, phase, stable source id, source sequence)` 排序，event sequence 从 1 连续，hash chain 从 archive root 开始。
3. Rule/mark/funding/fee 的数值全部是 canonical Decimal string；rule 和 fee 在 replay start 之前或等于 start 必须已有生效值，mark coverage 在整个 bound range 内不得超过声明的最大 gap，funding settlement 不得重复或倒退。
4. Simulation object 继续使用 Phase 0 `replay.hedge-simulation-manifest.v1`，导入时除 validator 外还校验文件 checksum；保险基金事件与 ADL snapshot 被物化成 phase 70 的稳定输入事件，不允许运行时生成随机 cohort。
5. Catalog 的 READY 对象才可绑定。Run ref 必须逐字段匹配 owned catalog；public/simulation 时间范围、symbol、settlement asset、contract/model hash 和 L2 ref 必须同时匹配。
6. Run 创建在同一 SQLite transaction 内写 active public/simulation pin、初始 no-lookahead projection 和输入 proof。后续 catalog 更新不能改变已有 pin；restart/fork 使用固定 generation/checksum。
7. owned 文件缺失、checksum 改变、事件重复/gap/回退或投影 hash 不一致时，将 binding 与 Run 置为 `PAUSED`，返回明确错误且 `fallback_applied=false`；不得读取 last/trade/bar close、固定 funding 或 Touch/Tape 代替。
8. rehydration 只允许从 importer 记录的 external trusted source 恢复，恢复后必须得到同一 byte checksum、dataset epoch、event-chain tail 和 proof hash；网络不是重放依赖。

## 3. 实现顺序

1. 新增 public archive builder/validator、simulation importer validator、typed descriptor/event/projection 与 owned object manager。
2. training schema 升级，增加 public/simulation catalog、run pin、projection、applied-event 和 input-audit 关系及完整 FK/unique/check constraints。
3. 在 TrainingRunService 启动、创建和 shutdown 路径接入 manager；HEDGE create 强制 prepare verified binding，并和 historical L2 binding 交叉核对。
4. 在 initial writer 的同一事务中 bind 两个对象，初始化 rule/fee/mark/insurance/ADL projection 和 run input proof。
5. 将 HEDGE public/simulation account-only events并入既有全局虚拟时钟；以 pinned mark 覆盖逐腿风险投影并拒绝任何 mark/funding/book fallback。
6. 实现 owned object guard、quarantine、显式 rehydrate、restart/fork pin 恢复和独立 input auditor。
7. 增加 builder/import、gap/duplicate/backward/tamper/delete、same-ms ordering、offline restart/rehydrate/hash equivalence 与 no-fallback 测试。
8. 跑完整 backend replay、frontend replay/typecheck/lint/build、Ruff、compile、diff check；写结果证据并独立提交。

## 4. 停止条件

- HEDGE Run 仍可只凭调用方伪造的 ref 创建；
- historical L2 ref 与实际绑定的 book archive 可不一致；
- pinned mark 缺失后任一路径继续用 market last/bar close 计算账户风险；
- source event 不连续或文件被删除/篡改后 Run 仍继续推进；
- restart/rehydration 后 input proof、global event order 或最终 state hash 改变。
