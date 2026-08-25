# 本地数据与策略研究统一 Phase 2 执行计划（2026-08-25）

## 身份与范围

- 基线：Phase 1 `4c1498813649029c3c3bb80258c587fac169a323`
- 只提取 LocalApp 中的资料库 UI，不改 `/local.html` 合同、localStorage key 或后端。
- local-data 适配器、indicator runtime、event store、interval policy 留在原位置。
- 不引入 StrategyResearchApp（Phase 6）。

## 漂移判断

LocalApp.tsx 仍内嵌 LocalImportForm / LocalDatasetRail / LocalDatasetManagement，并自己做 import job polling。`localAppShell.test.ts` 用源码断言共享图表控件。提取后这些控件仍由 LocalApp 装配。

## 实施顺序

1. 先为导入、资料库列表、管理/revision/trash 增加行为测试。
2. 新增 researchDataApi（包装现有 localDataApi，不复制 HTTP）。
3. 把 import polling/cancel/load/select 收敛到 useResearchDataLibrary。
4. 提取 ImportForm、Rail、Quality、Revisions、Management；LocalApp 只装配。
5. 增加 `npm.cmd run test:research-data`。
6. 回归 local-data 测试、typecheck、lint、build。

## 预计修改文件

- `frontend/src/features/local-data/LocalApp.tsx`
- `frontend/src/features/research-data/*` 提取组件与 hook
- `frontend/package.json`

## 回滚

还原提取提交；无后端或数据格式变化。
