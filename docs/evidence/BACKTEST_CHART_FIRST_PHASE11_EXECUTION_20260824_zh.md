# Backtest Chart-First Phase 11 实施与验证证据

日期：2026-08-24

分支：`codex/backtest-chart-first-ux`

运行边界：隔离 worktree `H:\program\CandleScope-backtest-chart-first`；后端使用 `LOCAL_OFFLINE` 与隔离目录 `output/phase11-runtime-20260824`；前端 `15184`、后端 `18092`；没有读取或修改生产数据，没有 push、merge、发布或部署。

## 1. 完成范围

- 新增默认关闭的 `VITE_BACKTEST_RESEARCH_ADVANCED_ENABLED`。research 开、advanced 关时保留 Phase 10 只读页；advanced 开时才开放高级 mutation。
- 快测入口仍只把服务端 `context_id` 写入 URL；“批量研究这些参数”只选择参数稳健性任务，不创建或启动 Study。
- 数据集、冻结快照、coverage、quality 和 contract roles 由服务端对象恢复；编辑中的 JSON 不是权威身份。
- Pyne/Pine revision 支持创建、复制、归档和 smoke；切换 revision 会按新 schema/output contract 重建 Run/Study 草稿，不继承旧 revision 字段。
- Python Studio 只在 `PYTHON_MODEL` 任务中 lazy mount；Host 继续拥有订单、成交、费用、资金费、账户、报告和 Study。
- Run 支持 validate/create、轮询、cancel/resume、参数 clone、compare、export 与 signal trace；完成 Run 才载入 report/chart。
- Study 是独立对象：create 后保持 `CREATED`，显式 start 才执行；SIGNAL output 与历史合约角色缺失均在创建前失败关闭。
- Replay review bridge 只接受已完成 Run；只有服务端返回的 `TrainingRun.run_id` 能构造 replay URL。当前 `LOCAL_OFFLINE` 进程没有 TrainingRun runtime，因此浏览器端显示 `UNAVAILABLE` 并禁用创建动作，不向不可用端点发送请求。
- legacy workbench 入口和 API 保留，Phase 11 回滚不删除已有 Run、Study 或 Replay 数据。

## 2. Capability parity matrix

| 能力 | 新页面落点 | 验证结果 |
| --- | --- | --- |
| dataset/snapshot/coverage/quality/contract roles | `ResearchDataPanel` | 真实本地 fixture 返回 60 bars、epoch、hash、quality；Study 缺历史角色时 fail closed |
| Pyne/Pine revision/smoke/copy/archive | `ResearchStrategyPanel` | revision API 复用；内置策略归档后仍由 capability 合并恢复 |
| Python Bundle/runtime receipt | lazy `PythonStudioPanel` | 进入 Python 任务前未请求 chunk；进入后只请求 `PythonStudioPanel-DGqdXTRW.js` |
| account/fee/funding/latency/fill/risk | `ResearchExecutionPanel` | 高级 Run JSON 经客户端解析并由服务端 validate/rebind 后创建 |
| Run lifecycle/clone/compare/export | `ResearchRunPanel` | `bt_e1b30fd8dead421eb55419362dfe5493` 完成；compare 成功；无冻结参数时 clone 禁用而不是猜参数；export 下载成功 |
| credibility/trace/equity/trades/quality | `ResearchResultsPanel` | 完成 Run 加载 60 bars、report 与 bounded trace；结果来源保持 `RUN_RESULT` |
| Study create/start/cancel/reveal/compare | `ResearchStudyPanel` | create 与 start 分离；不兼容 output/contract roles 在 mutation 前阻断；后端生命周期仍为唯一权威 |
| multi-market/OOS | `ResearchStudyPanel` | 只展示服务端 Study comparison/basket，不在前端求 portfolio sum |
| Run -> replay review | `ResearchReplayPanel` | 动态 capability 为假时操作禁用；URL helper 单测证明只使用服务端 TrainingRun ID |
| 快测 -> 参数研究 | chart tester context handoff | `entry_task=PARAMETER_ROBUSTNESS` 经服务端 opaque context round-trip；不会自动创建/启动 Study |

## 3. 自动化验证

| 命令 | 结果 |
| --- | --- |
| `npm run check:i18n` | PASS；3910 keys、635 source files |
| `tsc --noEmit -p tsconfig.json` | PASS |
| `npm exec -- tsx --test ...backtestResearchPhase10.test.tsx` | PASS；7/7 |
| `npm exec -- tsx --test ...backtestResearchPhase11.test.ts` | PASS；7/7 |
| focused `eslint`（全部 Phase 11 前端变更面） | PASS；0 error/0 warning |
| `python -m pytest tests/test_backtest_research_context_phase10.py -q` | PASS；4/4 |
| advanced-on `npm run build` | PASS；672 modules；research 与 Python Studio 为独立 lazy chunk |
| advanced-off `npm run build` | PASS；672 modules；运行时回到只读研究页 |

仓库全量 `npm run lint` 当前仍有 147 个 Phase 11 之前已存在的 React Compiler lint error；本阶段没有改动这些文件，也没有降低或屏蔽规则。全量 gate 在 Phase 12 作为单独发布阻断项保留。

## 4. 真实浏览器证据

- advanced-on 1440×900：`output/playwright/phase11/research-advanced-final.png`
- Phase 10 reference 与 Phase 11 actual 同视口组合：`output/playwright/phase11/research-advanced-comparison-final.png`
- Study contract gate：`output/playwright/phase11/research-study-contract-gate.png`
- Replay runtime fail-closed：`output/playwright/phase11/research-replay-runtime-gate-final.png`
- advanced-off 只读回退：`output/playwright/phase11/research-advanced-off-readonly.png`
- Run compare：`output/playwright/phase11/research-run-compare.png`
- Python lazy surface：`output/playwright/phase11/research-python-studio-lazy.png`

浏览器结果：高级工作区、Study gate、Replay gate、Python lazy surface 和 advanced-off 回退均为 0 console error / 0 warning。合并对照人工检查未发现 rail/chart/bottom inspector 重叠、裁切或设计系统漂移；1440×900 下内容密度较高但操作区仍可滚动且无覆盖。

## 5. 回滚与已知边界

- `VITE_BACKTEST_RESEARCH_ADVANCED_ENABLED=0` 已实测：页面标记为只读，Run mutation/Study/Python/Replay 高级控制不出现，已完成 Run 仍可读取。
- `VITE_BACKTEST_LEGACY_WORKBENCH_ENABLED=1` 保留 legacy adapter；关闭 advanced 不触碰服务端对象或 workspace。
- 当前离线 fixture 不具备 Replay TrainingRun runtime，也不具备 Study V2 要求的完整历史合约角色。产品选择是动态报告不可用并失败关闭；本阶段不把负向验证伪装成 LIVE replay/Study 正向发布证明。
- Phase 12 必须继续运行全量测试、真实发布 fixture、布局/资源/并发/60 分钟稳定性与逐层回滚演练；生产 flag 仍保持默认关闭。
