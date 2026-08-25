# 本地数据与策略研究统一 Definition of Done 报告（2026-08-25）

## 身份

| 项 | 值 |
| --- | --- |
| 工作树 | `H:\program\CandleScope-strategy-research` |
| 分支 | `codex/strategy-research-unification` |
| HEAD | `e4a514f2be0e13c844e7dec22ea12d9b287abb2f` |
| Phase 12 工程候选 | `87af1d9649a3a008ecbcc47ca8ae0880f8732ea9` |
| 原始 main 工作树 | `H:\program\CandleScope` @ `144e748c`（仅预存 `?? docs/LOCAL_DATA_STRATEGY_RESEARCH_UNIFICATION_EXECUTION_zh.md`） |
| 旧本地模式工作树 | `H:\program\CandleScope-local-offline` @ `d3c2fe37`，未删除、未归档、未 merge |
| 生产旗标 | `CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED=0`，`VITE_RESEARCH_DATA_LIBRARY_ENABLED=0` |

状态约定：PASS / FAIL / ENV_STOP / HOLD。FAIL 与 ENV_STOP 不得写成 PASS。

---

## 每个 Phase 的功能提交 SHA

| Phase | SHA | 提交 |
| --- | --- | --- |
| 0 | `0522ba90ee23d4b897ec6714bbd3086b3e3a9c8b` | `docs(strategy): freeze local-data research unification contract` |
| 1 | `4c1498813649029c3c3bb80258c587fac169a323` | `feat(research): define unified strategy data source contracts` |
| 2 | `537755a7785a433d68dc8024e8d28084a6a2245a` | `refactor(local): extract reusable research data library components` |
| 3 | `5e663c8c73e34f3c8f00d3a79b8497112ed7fc0d` | `refactor(research): unify local dataset runtime ownership` |
| 4 | `21a85967313eb41a64ea9907279c43528f39d155` | `feat(research): expose local data library to trusted live clients` |
| 5 | `c0eb95f6c0b75cb6a34550f91dbf8ec66e3ca947` | `feat(research): add unified strategy data source drawer` |
| 6 | `3eb4d7899d8d77a99d3cdac1fb27a9d570aa3751` | `feat(strategy): add unified full-screen research workspace` |
| 7 | `8d0ddd7db77517466b366c6066b3be70051b0948` | `feat(strategy): bring immutable local analysis into research workspace` |
| 8 | `4e3cfe3f0ff5b68ab19ee164afa2aa7ff5f79b82` | `feat(strategy): run chart and imported data through one frozen context` |
| 9 | `32edf2a44d3015fff5cc40870d782fc27b02ae05` | `feat(strategy): use unified research workspace in offline profile` |
| 10 | `8b680c9dd27a9db59553c554bc9abf1d395efc35` | `feat(strategy): unify quick and advanced research navigation` |
| 11 | `67ac5e46f4790d4a44068416c4466cf5e3ff681e` | `refactor(strategy): retire duplicate local and backtest app orchestration` |
| 12 | `87af1d9649a3a008ecbcc47ca8ae0880f8732ea9` | `test(strategy): qualify unified local-data research release` |

后续证据/修正（不改变 Phase 12 候选身份）：

| SHA | 提交 |
| --- | --- |
| `4b5b9442` | `docs(strategy): record phase 12 candidate SHA` |
| `874b4545` | `docs(strategy): record full pytest vs main and smoke:backtest evidence` |
| `8aa8b5e0` | `docs(strategy): refresh phase 12 release artifact hashes` |
| `e4a514f2` | `feat(strategy): show first-open templates and current-chart source` |

---

## 真实命令与退出码

工作目录默认 `H:\program\CandleScope-strategy-research`。后端 pytest 使用 `D:\anaconda\python.exe`，`PYTHONPATH` 指向仓库内 `packages/candlescope-plugin-sdk/src` 与 `packages/candlescope-backtest-sdk/src`。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pytest -q tests/test_local_data_service.py tests/test_local_data_api.py tests/test_local_data_jobs.py tests/test_local_offline_main_profile.py tests/test_local_offline_network_guard.py tests/test_research_data_access.py tests/test_backtest_chart_context.py tests/test_backtest_research_source.py tests/test_backtest_release_gate.py tests/test_strategy_research_unification_release.py tests/backtest_contract` | 0 | 89 passed |
| `pytest -q tests/test_research_data_access.py tests/test_local_offline_main_profile.py tests/test_local_offline_network_guard.py` | 0 | 12 passed（安全矩阵 + LOCAL_OFFLINE） |
| `cd frontend && npm.cmd run test:research-data` | 0 | 89 passed（first-open 修正后） |
| `cd frontend && npm.cmd run test:backtest` | 0 | 121 passed |
| `cd frontend && npm.cmd run typecheck` | 0 | 通过 |
| `cd frontend && npm.cmd run check:architecture` | 0 | 0 allowlist |
| `cd frontend && npm.cmd run smoke:strategy-research` | 0 | `{"ok":true,"canonical":"/strategy.html",...}` |
| `cd frontend && npm.cmd run build` | 0 | 通过；`BacktestApp` 0.72 kB |
| `python backend/scripts/soak_strategy_research_unification.py --duration-ms 3600000` | 0 | 711 cycles，3600131 ms；**mixed LIVE 浏览器路径未覆盖** |
| `cd frontend && npm.cmd run smoke:backtest`（LOCAL_OFFLINE uvicorn `:8000` + 80 根 CSV） | 0 | `{"ok":true,"cycles":1,"runId":"bt_f6ebc08b9e564d47ba653b82bcf02eb4"}` |
| `python backend/scripts/verify_strategy_research_unification.py --manifest ... --schema ...` | 0 | status PASS（候选 `87af1d96`） |
| `cd frontend && npm.cmd test` | 1 | 3473 pass / 1 fail `scripts/pine-language.test.mjs` monaco ESM |
| `cd frontend && npm.cmd run lint` | 1 | ~185 既有 eslint 错误 |
| 全量 `pytest -q` | FAIL/HUNG | plugin 簇失败与 `main@144e748c` 同类（unification 10 fail/1 err vs main 13 fail/2 err）；~65% plugin sandbox/sidecar 挂起 |

---

## 双旗标 rollback

关闭两个资料库旗标后：

1. `resolveResearchDataLibraryEnabled({}) === false`。
2. `/strategy.html` 仍打开统一壳；导入 CTA 隐藏；**使用当前图表**仍可选（`/strategy.html?source=current` 填入 `BTCUSDT`/`1m`）。
3. `/local.html` 在 flag=0 时走 LocalApp 兼容壳。
4. LIVE 进程 `CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED=0` 时 `/api/v1/local/datasets` 为 404。
5. 不删除 local-data、backtest DB、revision、项目包或旧 localStorage 键。

生产默认值未改为 1。

---

## Definition of Done 签署

### 15.1 产品

- [PASS] 一级入口只有 TopBar「策略」→ `/strategy.html`。
- [PASS] 当前图表与导入数据是同一产品中的两个来源。
- [PASS] 导入后可以只看图，不必运行策略。
- [PASS] 普通路径为脚本、数据、运行、结果；first-open 显示三个模板。
- [PASS] 高级研究经 launch context 进入，不要求重新配置。
- [PASS] `/strategy.html` 为 canonical URL。
- [PASS] `/local.html` 与 `/backtest.html` 兼容。

### 15.2 数据

- [PASS] 两条来源冻结为 `dataset_id + data_epoch + snapshot_hash`。
- [PASS] 本地数据不联网、不插值、不静默换 revision。
- [PASS] 质量、coverage、gap、revision 可审计。
- [PASS] 图表、指标、绘图、事件和 Run 使用同一数据身份。
- [PASS] revision 变化立即 stale。

### 15.3 后端

- [PASS] LocalDataRuntime 是唯一写入 owner。
- [PASS] BacktestRuntime 使用注入的数据服务。
- [PASS] LIVE 本地资料库 Origin/Host/loopback 边界（F1–F6）。
- [PASS] LOCAL_OFFLINE network guard 与 API allowlist（scoped + soak 远程 Origin 403）。
- [PASS] 失败启动与 shutdown 无泄漏（offline profile 测试）。

### 15.4 前端

- [PASS] LocalApp/BacktestApp 不再各自维护业务编排。
- [PASS] chart-first 快测无回归（test:backtest 121）。
- [PASS] StrategyResearchApp source-neutral。
- [PASS] legacy URL 只做 bootstrap。
- [PASS] flag=0 不增加首屏负担；导入隐藏，当前图表仍可选。
- [PASS] 多图 cell 状态隔离（既有 chart-first 测试）。

### 15.5 可信度

- [PASS] BAR 数据只声明 BAR_APPROX。
- [PASS] 解释来自决定时结构化证据。
- [PASS] 不可比较 Run 不给方向性结论。
- [PASS] 用户能查看数据版本、质量和执行精度。
- [PASS] 报告不把回测结果描述成真实胜率保证。

### 15.6 发布

- [PASS] scoped tests 通过。
- [FAIL] 全量后端/前端测试通过（plugin 簇与 main 同类失败；全量后端挂起；pine-language 1 fail；lint 既有失败）。
- [ENV_STOP] 完整交互式浏览器验收（无浏览器 MCP；有 first-open HTML 捕获 `driven_change=true`）。
- [PASS] security matrix（F1–F6 + 远程 Origin 403）。
- [PASS] LOCAL_OFFLINE 零外网（guard + klines/stream/replay 403）。
- [ENV_STOP] 60 分钟 mixed soak（LOCAL_OFFLINE API 711 cycles；`liveChartBrowser`/`liveImportedChartBrowser` 为 false，不得标 mixed PASS）。
- [PASS] 双旗标 rollback drill。
- [PASS] release manifest 绑定候选 SHA 与证据 hash。
- [PASS] 旧分支未经授权未归档。

---

## 三类完成状态（必须分开）

### 工程实现完成

Phase 0–12 功能代码已提交。统一策略工作区、FrozenResearchContext、LOCAL_OFFLINE 同壳、导航收敛、重复编排拆除、first-open 三模板与当前图表来源均在分支上。

### 验证完成（有缺口）

Scoped 测试、typecheck、architecture、strategy-research smoke、build、security、LOCAL_OFFLINE allowlist、双旗标 rollback、release verifier 已通过。

未完成：全量后端 pytest、全量前端 `npm test`、eslint 全量、LIVE 浏览器 mixed soak、交互式 1440×900 浏览器矩阵。

### 尚未 push / merge / deploy

未 push。未 merge 到 main。未部署。生产旗标保持 0。发布决定 **HOLD**。

---

## 延期与未完成

- M9 RSI trace 窗格、decision/fill hash 行、旧 bounded fill 表：见 `strategyResearchLegacyMap.ts`。
- CURRENT_CHART 全屏 K 线仍是会话填充面，不是行情页 LiveChartCell 热切换。
- Pine/Pyne 自定义脚本不在 LOCAL_OFFLINE 宣称可用。
- 旧 `codex/local-offline-mode` 37 项脏状态只读保留。
