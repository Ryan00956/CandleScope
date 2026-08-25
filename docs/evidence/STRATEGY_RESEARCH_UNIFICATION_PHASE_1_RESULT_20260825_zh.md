# 本地数据与策略研究统一 Phase 1 结果（2026-08-25）

## 结论

Phase 1 通过。已冻结 ResearchSourceRefV1 / FrozenResearchContextV1 / capability matrix；Python 与 TypeScript 解析同一 canonical fixture；未知枚举和缺失身份 fail-closed；前端不能发明 snapshot hash。现有 API 与页面未改。

## 身份

- 基线：`6fb69e4f04231aaf7430e386092f9ed1166fe72d`（Phase 0 证据修订之后）
- 分支：`codex/strategy-research-unification`
- 工作树：`H:\program\CandleScope-strategy-research`

## 合同

- `schemaVersion`: `candlescope.research-source/1`、`candlescope.frozen-research-context/1`
- source kind：CURRENT_CHART / IMPORTED_DATASET / COMPLETED_RUN
- 共享 fixture：`backend/tests/fixtures/research_data/canonical-v1.json`
- snapshot hash 必须由后端 freeze/preview 提供
- 缺失 capability 视为不可用
- 普通 UI 术语不含 dataset ID / data epoch / snapshot hash

## 测试

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pytest tests/test_research_data_contracts.py` | 0 | 11 passed |
| `tsx --test researchDataSourceModel.test.ts` | 0 | 10 passed |
| `pytest` local_data service/api/jobs | 0 | 23 passed |
| `pytest` offline main_profile + network_guard | 0 | 3 passed（带仓库 PYTHONPATH） |
| `pytest` chart_context + quick_presets | 0 | 14 passed |
| `npm.cmd run test:backtest` | 0 | 118 passed |
| `npm.cmd run typecheck` | 0 | 通过 |

页面未改，Phase 0 四张 UI 基线仍然有效。

## 回滚

删除 `backend/app/research_data`、对应测试与 `frontend/src/features/research-data`。无数据迁移。

## 未解决问题

- 尚无调用方；LIVE 资料库 API 与统一壳属于后续 Phase。
- `test:research-data` npm script 按文档属于 Phase 2。
