# 本地数据与策略研究统一 Phase 1 执行计划（2026-08-25）

## 身份与范围

- 基线：Phase 0 `0522ba90ee23d4b897ec6714bbd3086b3e3a9c8b`（合同冻结）
- 分支：`codex/strategy-research-unification`
- 工作树：`H:\program\CandleScope-strategy-research`
- 本阶段只建立 source-neutral 类型、能力投影和共享 fixture，不改变现有 API 或页面行为。
- 不新增数据库表，不修改 Run schema，不挂载 LIVE `/api/v1/local`。

## 漂移判断

当前代码仍按 Phase 0 ADR 所述分裂：chart-context 与 local manifest 各有身份字段，但没有 ResearchSourceRefV1 / FrozenResearchContextV1。`BacktestRuntime` 仍隐式创建 LocalDatasetService。本 Phase 只新增 `research_data` 合同层，不调用现有 runtime。

## 实施顺序

1. 冻结 ResearchSourceRefV1 与 FrozenResearchContextV1（CURRENT_CHART / IMPORTED_DATASET / COMPLETED_RUN）。
2. 冻结 capability matrix 与用户可见原因；缺失能力 fail-closed 为不可用。
3. 共享 canonical fixture：Python 与 TypeScript 解析同一 JSON。
4. 枚举 unknown fail-closed；前端不得从 fixture 自行发明 snapshotHash。
5. 普通 UI 术语映射不得包含 dataset ID / data epoch / snapshot hash。
6. 跑新合同测试 + Phase 0 同组回归。

## 预计修改文件

- `backend/app/research_data/__init__.py`
- `backend/app/research_data/contracts.py`
- `backend/app/research_data/capabilities.py`
- `backend/tests/fixtures/research_data/canonical-v1.json`
- `backend/tests/test_research_data_contracts.py`
- `frontend/src/features/research-data/researchDataTypes.ts`
- `frontend/src/features/research-data/researchDataSourceModel.ts`
- `frontend/src/features/research-data/__tests__/researchDataSourceModel.test.ts`

## 验证

- Python 与 TypeScript 对同一 fixture 解析一致（canonical JSON 字节级一致）。
- 缺失 dataset/data epoch 的 IMPORTED_DATASET 被拒绝。
- COMPLETED_RUN 缺失 snapshot hash 被拒绝。
- 未知 source kind 被拒绝。
- capability 缺失时显示不可用，不猜测 true。
- 现有 local-data / offline / chart-context / test:backtest / typecheck 无回归。

## 退出标准

- 合同有 schemaVersion。
- canonical fixture 被两端测试。
- 现有 API 尚未改变。
- 不改页面，因此 Phase 0 截图仍然有效。

## 回滚

移除新增 research_data / research-data 文件；无调用方，无需数据迁移。
