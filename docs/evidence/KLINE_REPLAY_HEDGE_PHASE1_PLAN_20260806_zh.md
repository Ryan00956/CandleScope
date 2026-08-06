# K 线回放 HEDGE Phase 1 背景审计与执行计划

日期：2026-08-06
基线：`1b2de745`
范围：协议、canonical、training schema 与持久化边界；不在本阶段实现 Phase 2 的保证金算法或 Phase 5 的强平算法。

## 1. 已确认背景

- 公开训练协议仍为 `replay.v2`，合同版本为 `replay.contract.v2.phase0`；Python 与 TypeScript 共享枚举黄金文件，但尚无训练创建载荷的跨语言 canonical hash 黄金样本。
- training schema 当前为 v13 / `replay.training.v1`，开发期迁移策略为 fresh-only：检测到非当前 schema 会 fail-closed，要求清空训练数据后重建。
- Run 创建与前端草稿默认 `position_mode=ONE_WAY`、`account_data_mode=APPROX_PROXY`；旧 HEDGE 只允许 `APPROX_PROXY + CROSS + funding OFF + book OFF`。
- 仓位与逐仓保证金仍主要存在 `position_json` / `isolated_margin_json` 中。
- 强平仍以单行 `replay_training_liquidation_event` 为权威数据源，唯一键会把同 track、同 source sequence 的多腿结果压成一行，且只保存一个 `close_order_id`。
- checkpoint、fork、review、account audit 与 portfolio export 都直接读取上述单行强平表，因此只新增旁路表不能通过 Phase 1 门禁。
- Phase 0 已确认当前 live training 数据只有 1 个 legacy-unspecified Run、0 个显式 HEDGE rule；本 worktree 不修改、复制或删除 live 数据库。

## 2. 冻结设计

1. 公开 wire protocol 硬切换为 `replay.v3`，合同版本为 `replay.contract.v3.phase1`；保留既有 Python/TypeScript 文件名只是内部代码组织，不代表 wire 兼容。
2. training schema 升级为 v14 / `replay.training.v2`。v13 数据不原位解释；fresh-only 检查继续 fail-closed。
3. `AccountDataMode` 新增唯一 HEDGE 模式 `DETERMINISTIC_SIMULATION`。新请求省略 `position_mode` 时默认为 HEDGE，省略 `account_data_mode` 时默认为确定性模拟。
4. HEDGE 最终创建请求必须显式绑定：
   - `replay.hedge-public-history-ref.v1`；
   - `replay.hedge-simulation-manifest-ref.v1`；
   - Phase 0 合同 hash、模型版本与 public/simulated fidelity。
5. 旧 `HEDGE + APPROX_PROXY`、`HEDGE + HISTORICAL_EXACT`、旧协议和缺少任一固定引用的最终创建请求全部拒绝；空 Run setup 可先记录 HEDGE 默认，但市场选择完成前不能进入可交易状态。
6. `replay_training_liquidation_event` 从 fresh schema 和全部权威查询/复制/审计/投影路径移除，替换为 case → leg/step → order → fill 关系。
7. canonical 与 state component hash 覆盖 position leg、margin bucket、risk snapshot、liquidation、insurance 与 ADL 的版本化字段；不对旧 HEDGE payload 补默认后重算。

## 3. v14 一等关系结构

- `replay_training_position_leg`
- `replay_training_margin_bucket`
- `replay_training_risk_snapshot`
- `replay_training_liquidation_case`
- `replay_training_liquidation_leg`
- `replay_training_liquidation_step`
- `replay_training_liquidation_order`
- `replay_training_liquidation_fill`
- `replay_training_insurance_fund`
- `replay_training_insurance_posting`
- `replay_training_adl_snapshot`
- `replay_training_adl_candidate`
- `replay_training_adl_event`
- `replay_training_adl_selection`

所有子表必须以复合 foreign key 绑定 Run/track/case/step/order/snapshot，序列字段有 scoped unique，Decimal 以 canonical string 保存，hash 使用 `sha256:` 小写十六进制。

## 4. 实现顺序

1. 更新 Python 模型、严格解析器、API payload 与默认/拒绝规则。
2. 升级 v14 schema，加入关系表与约束，移除单行强平表。
3. 更新 storage 的创建、恢复、审计、checkpoint、fork、review、portfolio/export 路径，使新关系模型成为唯一来源。
4. 更新 TypeScript 类型、严格解析器、Hub 默认值与请求构造。
5. 新增跨 Python/TypeScript 的创建载荷 canonical JSON/hash golden。
6. 新增 FK、unique、restart、corruption、旧 HEDGE 拒绝、多腿不压扁测试。
7. 跑 Ruff、后端 Phase 1 相关测试、前端 replay 测试、类型检查；修复回归后单独提交。

## 5. 停止条件

- 发现现有正式 HEDGE Run 需要保留；
- v14 不能在不读取/修改 live 数据库的情况下验证；
- Python 与 TypeScript canonical 不能得到同一 hash；
- 任一 storage 路径仍依赖 `replay_training_liquidation_event`；
- FK、restart 或 corruption 测试无法 fail-closed。
