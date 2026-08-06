# K 线回放 HEDGE Phase 1 完成证据

日期：2026-08-06
基线：`1b2de745`
范围：协议、canonical、schema、持久化、checkpoint/fork/review/export；不提前宣称 Phase 2 保证金公式或 Phase 5 强平算法完整。

## 1. 完成结果

- wire protocol 硬切换到 `replay.v3`，合同版本为 `replay.contract.v3.phase1`。
- training schema 硬切换到 v14 / `replay.training.v2`；旧 schema 继续 fresh-only fail-closed。
- Python、API 与 TypeScript 默认值均为 `position_mode=HEDGE`、`account_data_mode=DETERMINISTIC_SIMULATION`，无 feature flag、灰度或默认关闭入口。
- 最终 HEDGE 创建请求强制绑定 pinned public-history ref、materialized simulation-manifest ref、Phase 0 contract hash、model version 与 public/simulated fidelity。
- `HEDGE + APPROX_PROXY`、`HEDGE + HISTORICAL_EXACT`、缺失固定引用和 `replay.v2` 最终载荷全部拒绝，不静默补默认后重算。
- fresh schema 与生产查询中已移除 `replay_training_liquidation_event`；position leg、margin bucket、risk snapshot、liquidation、insurance 和 ADL 共 14 张关系表成为唯一 HEDGE 状态结构。
- checkpoint 的 portfolio state hash 覆盖完整 `hedge_state`；fork 按选中的 immutable actor checkpoint 重建可变 position/margin 投影，再复制截至游标可见的不可变 liquidation 关系。
- fork 恢复从 checkpoint broker model version 还原 `touch_or_tape_v2`，避免 HEDGE fork 回退到 one-way 线性执行模式。
- position、margin、risk 和 liquidation component hash 改为 owner-independent content hash，fork 可保留相同不可变事件 hash，同时由 child run 拥有独立关系行。

## 2. Canonical 黄金合同

- 黄金夹具：`backend/tests/fixtures/replay/hedge_protocol_phase1_golden.json`
- canonical hash：`sha256:e60521bf4746cc33885930d75be02d5cbcce474eb6046704334dee8ccfeb562f`
- Python 由 `hedge_run_binding` 解析并计算 hash；TypeScript 读取同一夹具、严格解析并计算同一 hash。

## 3. 关系与完整性门禁

- v14 fresh schema 创建并重启成功。
- 14 张表均存在 foreign key；run-scoped sequence/identity unique 约束生效。
- 人工把 schema version 改回 13 后，启动明确拒绝 `schema 13 is obsolete`。
- 多腿 HEDGE 强平保持 LONG/SHORT 两条 liquidation leg 与两个 close order，不压成单行或单 `close_order_id`。
- 完成强平后的 HEDGE run 可从 ReviewMode fork；child 保留 immutable liquidation hash，并从 child checkpoint 重建 LONG/SHORT 零仓关系快照。
- 生产代码无 `replay_training_liquidation_event` 引用；旧 `replay.v2` 仅保留在明确的拒绝测试和历史说明文字中。

## 4. 验证记录

后端完整回放套件：

```powershell
$env:PYTHONPATH='backend;packages/candlescope-plugin-sdk/src'
$replayTests=(Get-ChildItem -LiteralPath 'backend/tests' -Filter 'test_replay*.py').FullName
python -m pytest @replayTests -q
```

结果：`805 passed, 4 warnings in 159.08s`。4 条均为既有 FastAPI `on_event` deprecation warning，无测试失败。

静态门禁：

```powershell
python -m ruff check <全部 Phase 1 修改的 Python 文件>
python -m compileall -q backend/app/replay backend/app/api/v1/replay.py
git diff --check
```

结果：全部通过。

前端门禁：

```powershell
npm run typecheck
npm run test:replay
npm run build
```

结果：TypeScript 类型检查通过；`326/326` replay 测试通过；Vite production build 通过。build 仅报告既有大 chunk 警告。

## 5. 阶段边界

Phase 1 只建立交易所级双向系统必须依赖的协议和关系权威源。逐腿 leverage、CROSS/ISOLATED 公式、reserved margin、reduce-only/close capacity 属于 Phase 2；pinned public archive/materialized manifest importer 属于 Phase 3；exchange-like liquidation sequence、insurance fund 与 ADL 执行分别属于后续阶段。本阶段不把现有强平行为表述为最终交易所等价。
