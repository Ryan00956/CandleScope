# Backtest Chart-First Phase 11 执行冻结

日期：2026-08-24

分支：`codex/backtest-chart-first-ux`

范围：把 legacy workbench 的受支持高级能力迁入 Phase 10 的独立 research runtime；不移除 legacy 入口，不改变生产默认 flag。

## 1. 开关与回滚

- 新增 `VITE_BACKTEST_RESEARCH_ADVANCED_ENABLED`，默认 `0`。
- research flag 开、advanced flag 关时保留 Phase 10 只读研究 shell；advanced flag 开时才初始化 mutation、Python、Study 与 replay bridge 能力。
- 回滚 Phase 11 只关闭 advanced flag；Phase 10 的 context、Run/Study 只读查看和 shared chart source 不回滚。
- legacy workbench flag 继续存在；完成 parity matrix 前不删除 legacy code/API。

## 2. Capability parity matrix

| Legacy 能力 | Phase 11 归属 | 迁移合同 |
| --- | --- | --- |
| dataset、snapshot、coverage、gap、quality、contract roles | `ResearchDataPanel` | dataset/range 选择后服务端 preview；完整 identity 与质量详情只读展示 |
| Pyne/Pine revision 创建、复制、归档、smoke | `ResearchStrategyPanel` | 复用 revision API；revision/dataset/snapshot 共同约束 smoke |
| Python Bundle、sandbox/trusted、coverage 与 receipt | `PythonStudioPanel` lazy surface | 只在 `PYTHON_MODEL` + advanced flag 下初始化；沿用既有 trusted confirmation |
| account、fee、funding、latency、participation、fill/risk | `ResearchExecutionPanel` | 专业 JSON draft，服务端 validate 后才允许创建 Run；保留全部已支持字段 |
| Run create、monitor、resume、cancel、clone、compare、export | `ResearchRunPanel` + runtime | 每个 mutation 独立按钮；无隐式 start/clone；完成 Run 才加载 report/chart |
| credibility、signal trace、equity、trade、quality projection | `ResearchResultsPanel` | 有界明细、hash/source 标签；不把实时 source 投影成 Run 结果 |
| Study draft、start、cancel、holdout reveal、compare | `ResearchStudyPanel` | create 只创建 draft，start 必须二次显式操作；reveal 权限沿用后端 |
| multi-market basket/OOS verdict | `ResearchStudyPanel` | 直接展示权威 Study comparison/basket，不做 portfolio sum |
| Run/区间 -> replay review bridge | `ResearchReplayPanel` | 只创建 read-only/blinded bridge；使用服务端返回 TrainingRun ID 打开 replay |
| 普通快测 -> 高级参数研究 | chart tester context handoff | 仍只把 context ID 放进 URL；进入后选择参数稳健性任务且不自动创建/开始 Study |

## 3. Runtime 边界

- 所有高级 mutation 由 `BacktestResearchRuntime` 持有；组件只发 action，不直接拥有第二套 API/store。
- Run/Study polling 只在存在非终态对象时运行；卸载时清 timer/AbortController。
- JSON draft 是可编辑输入，不是权威对象；创建前必须解析、补齐 immutable dataset/snapshot/revision identity，并调用服务端 validate。
- Python studio 复用既有 bundle/runtime contract，不复制实现；非 Python 任务不挂载组件。
- replay bridge 返回的 `trainingRun.run_id` 才能生成 `/replay.html?run=<id>`；前端不猜 ID。
- export 只从服务端生成的 Run export payload 下载，不从屏幕 projection 拼装。

## 4. 浏览器验证

- 1440×900 下验证 advanced-off 与 advanced-on 两套研究页。
- 验证 dataset/snapshot 质量、Run draft validate/create、Run 列表切换、compare/clone/export、trace/trade 详情。
- 验证 Study create 后保持 DRAFT/CREATED，不自动 start；随后显式 start/cancel/reveal/compare。
- 验证 Python panel 只在对应任务初始化。
- 在 replay runtime 可用的隔离环境创建 bridge，确认 URL 使用服务端 TrainingRun ID；关闭/返回后原 research Run/source 不变。
- 与 Phase 10 同视口截图组合检查 rail、chart 和 bottom inspector，无裁切、遮挡或样式漂移。

## 5. 退出门

- matrix 每一项都有组件、action、自动化或浏览器证据；unsupported/flag-off 能力明确 fail closed。
- legacy 入口仍可回滚，advanced 默认关闭。
- “快测 -> 高级研究 -> replay review -> Study draft”路径闭环；三类对象 ID/状态/lifecycle 不混用。
