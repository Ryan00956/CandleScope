# Backtest Chart-First Phase 12 发布验证与回滚证据

日期：2026-08-24

分支：`codex/backtest-chart-first-ux`

运行边界：隔离 worktree `H:\program\CandleScope-backtest-chart-first`；后端使用 `LOCAL_OFFLINE`、隔离目录
`output/phase11-runtime-20260824` 和端口 `18092`；advanced-on 前端 preview 使用 `15184`。没有读取或修改生产
数据，没有 push、merge、发布或部署。

## 1. 发布决定

当前候选状态：`IMPLEMENTATION_QUALIFIED_PRODUCTION_NO_GO_PENDING_INDEPENDENT_REVIEW`。

发布机器清单：
[`backtest-chart-first-phase12-20260824.json`](backtest-chart-first-phase12-20260824.json)。

- Phase 0–11 的实现面保持不变；Phase 12 新增真实发布 fixture、浏览器长稳态 harness、布局/资源证据、
  逐层回滚构建和机器可读 manifest。
- 自动化、真实 LOCAL_OFFLINE API、浏览器、桌面、flag-off 资源、60 分钟稳定性和回滚门禁均必须为 PASS；
  任一失败都保持 `NO_GO`。
- 生产构建继续使用仓库默认关闭值。开发验证只能通过进程级显式 flag opt-in，不修改 `.env.example` 默认值。
- 文档要求的独立评审尚未由本执行者替代或伪造；在独立评审确认无 P0/P1 前，不讨论生产默认开启。

## 2. 自动化门禁

| 门禁 | 本轮结果 |
| --- | --- |
| `npm run check:architecture` | PASS；0 migration allowlist entries |
| `npm run check:i18n` | PASS；3910 catalog keys / 635 source files |
| `npm run typecheck` | PASS；browser/node 两套 TypeScript config |
| `npm run lint` | PASS；使用 lockfile 对应的独立 `npm ci` 依赖树 |
| `npm run test:backtest` | PASS；111/111，3 suites |
| `npm test` | PASS；3396/3396，3 suites，约 155 秒 |
| `npm run test:desktop` | PASS；35/35 |
| backend backtest/trade_tape/python_strategy 全覆盖 | PASS；271 passed / 3640 deselected |
| backend release + rollback + contract | PASS；36/36 |
| 快速切换、资源隔离、并发 draft 定向集 | PASS；19/19 |
| 解释、比较、投影、auto-run、高级研究定向集 | PASS；25/25 |
| backend 解释、Study compare、trade tape 定向集 | PASS；26/26 |
| advanced-on build | PASS；672 modules；既有 >500 kB warning |
| default-off build | PASS；672 modules；既有 >500 kB warning |
| 五层独立 rollback builds | PASS；advanced / auto-run / compare / explanation / tester |
| `npm audit --omit=dev` | PASS；production dependency vulnerabilities 0 |

`npm audit` 全依赖树仍报告 1 个 high：`vite -> postcss -> nanoid@3.3.17` 的开发构建链 advisory
`GHSA-2v37-7h3g-55p8`；`effects=[]`，生产依赖审计为 0。本阶段没有越权运行自动修复或改动锁文件。

最初完整 backtest 前端套件发现错误文案中的字面量 `TrainingRun` 触发 replay/backtest 隔离门禁。根因是
backtest feature 不应暴露 replay 内部对象名；最终改为中性的 `Replay training runtime is unavailable.`，随后
111/111 通过。后端第一次从仓库根运行时 subprocess 缺少 SDK import path；以仓库源码
`backend + packages/candlescope-plugin-sdk/src` 明确设置 `PYTHONPATH` 后，真实覆盖集 271/271 通过，没有降低门禁。

## 3. 真实发布 fixture

机器可读 fixture：
[`backtest-chart-first-phase12-fixture-20260824.json`](backtest-chart-first-phase12-fixture-20260824.json)。

- 浏览器正向对象是实际导入隔离 runtime 的 60 行 BTCUSDT/binance/spot/1h 数据集；dataset id、data epoch、
  checksum、覆盖时间和完成 Run 均由 API 返回，不是 UI mock。
- 冻结 goldens 绑定 contract、raw trade tape、aggregate trade tape、Pyne SMA、跨语言 explanation JCS 和
  release manifest 的 SHA-256。
- backend 覆盖补齐 binance usdm、ETHUSDT、原生/精确聚合/不支持周期、READY/缺口/LOCAL_OFFLINE/
  cache corrupt/epoch change、内置/Pyne/Pine/编译失败/不支持精度。

## 4. 浏览器与布局矩阵

仓库 Playwright CLI 驱动用户批准的 Chrome；research 页面使用同一完成 Run
`bt_e1b30fd8dead421eb55419362dfe5493`。1366×768 与 1920×1080 均实际载入 60 根结果 K 线、9 个 canvas、
不可变 Run/config/data identity 和结果 tabs；research 会话为 0 console error / 0 warning。

| 场景 | 结果 |
| --- | --- |
| advanced research 1366×768 / 1920×1080 | PASS；无 rail/chart/result inspector 重叠或裁切 |
| single / left-right double / four-chart | PASS；layout 模板真实切换 |
| maximize / restore | PASS；最大化控制变为“还原图表”，恢复后同一 workspace 保留 |
| flag-off 1 / 4 / 16 图 | PASS；tester DOM 0、tester/backtestEntry runtime resources 0 |
| 16 图容量状态 | PASS；64 logical cells / 4 windows，当前窗口 4×4；tester instances 0 |
| advanced-off rollback | PASS；Phase 10 只读、10 个既有 Run 可见、完成 Run 可重载、9 canvases、clean console |

主行情布局会显示 LOCAL_OFFLINE 下既有 realtime/plugin/order-book/WebSocket 的预期失败关闭；这些 console
错误与 toast 单独记录，没有写成 clean console，也没有归因给 backtest。研究页与 advanced-off 只读页均为
clean console。

关键截图位于 `output/playwright/phase12/`：

- `research-completed-run-1366x768.png`
- `research-completed-run-1920x1080.png`
- `layout-double-1366x768.png`
- `layout-four-1366x768.png`
- `layout-maximized-1366x768.png`
- `flag-off-1-cell-1920x1080.png`
- `flag-off-4-cell-1920x1080.png`
- `flag-off-16-cell-1920x1080.png`
- `rollback-advanced-off-readonly.png`

Phase 11 同视口 source/reference + actual 合并对照仍是本界面的视觉基准；Phase 12 当前代码只将 replay runtime
错误文案去内部对象名，未改变 UI 结构或样式。Phase 12 截图再次人工检查了 1366×768、1920×1080、四图和
16 图，没有发现新的裁切、溢出或设计系统漂移。

## 5. 快速切换、并发与资源

- 20 次连续 chart/strategy identity 切换只接受最终 generation；晚到 response 不能写入当前 cell。
- cell A 的 token/result 不能写入 cell B；同名 cell 跨 workspace 仍隔离。
- 4 个变化 cell 的 auto-run 并发不超过 2，队列保留最新 generation；manual preemption 不取消活动工作。
- 64 个未附着 cell、初始 mount、copy/blank edit 均创建 0 runtime；close/detach/workspace delete/flag-off 后
  runtime、marker、polling 和引用全部释放。
- flag-off 实际浏览器没有请求 `ChartStrategyTesterCellBridge`、backtestEntry 或 strategyTester runtime chunk；
  单图/四图/16 图 used heap 诊断分别约 18.2 MB / 19.5 MB / 31.7 MB。该值只用于同轮资源观察，不伪装成
  跨机器 percentile。

## 6. 60 分钟浏览器稳定性

脚本：`frontend/scripts/backtest-chart-first-phase12-browser-soak.js`。

机器可读结果：
[`backtest-chart-first-phase12-soak-20260824.json`](backtest-chart-first-phase12-soak-20260824.json)。

执行合同：每 60 秒采样一次；轮换 SUMMARY/TRADES/TRACE/COMPARE/QUALITY；每 10 分钟整页 reload 并重新绑定
同一完成 Run；每次验证 capabilities 与 Run API 200、Run/COMPLETED 可见、canvas、五个结果 tabs、console、
pageerror、requestfailed 与 JS heap；开始/中点/结束截图落盘。

- 目标时长：`3600000 ms`
- 实际时长：`3601140 ms`
- samples / reloads：`61 / 6`
- console errors / page errors / request failures / sample failures：`0 / 0 / 0 / 0`
- first / last / max heap：`13995784 / 16674536 / 17919151 bytes`；增长 `2678752 bytes`，低于
  `148213512 bytes` 上限
- 结果：`PASS`；中点和末帧均人工检查通过，最终 Playwright console 为 0 error / 0 warning

## 7. 分层回滚

机器可读证据：
[`backtest-chart-first-phase12-rollback-20260824.json`](backtest-chart-first-phase12-rollback-20260824.json)。

- 五个 frontend rollback variant 全部写到旁路 `output/phase12-builds/*`；长测使用的 advanced-on
  `frontend/dist/backtest.html` SHA-256 前后完全一致，避免交叉污染。
- advanced off + legacy on 的真实浏览器回到 Phase 10 只读研究；完成 Run 仍可展示，mutation surface 不出现。
- auto-run、compare、trade explanation、chart tester 均可单独关闭并通过 build + contract tests。
- `BACKTEST_CHART_CONTEXT_ENABLED` 默认 0；关闭时返回 `FLAG_DISABLED`，已有 DB 不删除。
- shared platform adapter 按 Phase 9 合同只能提交/构建级回滚，不是产品 flag；回滚不修改 Run/workspace/cache。
- 回滚前后 10 个 Run 的 `run_id:state` 排序向量 SHA-256 都是
  `06d36e984e9bbb8946f38ab5ab84b45e4c90d33a0c683c447c0bb40ad9f22008`。

## 8. 退出标准与剩余关口

- 第一次成功快测、普通三入口/唯一主操作、三状态、immutable identity、stale、解释、比较和高级复用：PASS。
- unit/component/API/browser/desktop/build/60-minute soak/rollback evidence：`PASS`。
- flag-off 不创建 runtime、不请求 tester chunk，单图/多图现有 layout 功能不回归：PASS。
- rollback 不删除 Run、Study 或 workspace：PASS。
- production flags 默认关闭：PASS。
- 独立评审无 P0/P1：`PENDING_EXTERNAL_REVIEW`。

因此 Phase 12 的技术验证完成后，候选仍保持生产 `NO_GO`；独立评审是生产默认开启前的唯一显式外部关口，
不得由本执行记录自行勾选。
