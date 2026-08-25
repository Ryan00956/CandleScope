# CandleScope 本地数据与策略研究统一逐步执行方案

- 状态：Phase 0–11 已提交；Phase 12 工程资格完成、生产 HOLD（旗标默认 0）。签署见 `docs/evidence/STRATEGY_RESEARCH_UNIFICATION_PHASE_12_DOD_20260825_zh.md`。未 push、未 merge、未删除旧 worktree。
- 日期：2026-08-25
- 仓库基线：main@144e748cc881220565cd5aa07fc494cba9a4133c
- 参考旧分支：codex/local-offline-mode@d3c2fe37d1deacba8951b5725353ca967eca2d79
- 适用范围：本地数据导入、不可变资料库、图表分析、chart-first 策略快测、全屏高级策略研究、LOCAL_OFFLINE 运行边界
- 不在本文授权范围：直接合并旧分支、删除旧工作树、修改回放 TrainingRun、扩大插件权限、部署或推送

本文解决一个产品和架构同时存在的问题：

> 用户不应再把“本地模式”理解成与“策略回测”并列的独立产品。本地数据应成为策略研究的一种数据来源；LOCAL_OFFLINE 继续作为技术运行边界，而不是一级导航模式。

本文不是概念稿。每个 Phase 都包含目标、依赖、修改范围、执行步骤、验证、退出标准、建议提交和回滚。实施者必须按顺序执行，不得因为后续代码容易实现而跳过当前 Phase 的退出门禁。

---

## 0. 如何使用本文

### 0.1 执行规则

1. 从当前 main 新建独立工作树和分支，不在 codex/local-offline-mode 上继续开发。
2. 一个 Phase 一个主提交；证据修订可以使用紧随其后的 docs/evidence 提交。
3. 每个 Phase 开始前创建计划证据，结束后创建结果证据。
4. 每个 Phase 必须同时验证 LIVE 与 LOCAL_OFFLINE 中与本阶段相关的行为。
5. 任一退出标准未满足时，不进入下一 Phase。
6. 禁止把“页面能打开”当成数据身份、离线边界、策略运行或持久化已经正确。
7. 禁止通过静默联网补数据、插值、换周期或切换 revision 来让验收通过。
8. 旧 local-offline 工作树中的 37 项脏状态在最终收口前只读保留，不得清理或覆盖。

### 0.2 建议工作树

在 H:\program\CandleScope 保持 main 不动：

    git status --short --branch
    git rev-parse HEAD
    git worktree add H:\program\CandleScope-strategy-research -b codex/strategy-research-unification main

后续命令默认在以下目录执行：

    H:\program\CandleScope-strategy-research

### 0.3 每个 Phase 的证据

每个 Phase 至少产生：

- docs/evidence/STRATEGY_RESEARCH_UNIFICATION_PHASE_N_PLAN_YYYYMMDD_zh.md
- docs/evidence/STRATEGY_RESEARCH_UNIFICATION_PHASE_N_RESULT_YYYYMMDD_zh.md
- docs/evidence/strategy-research-unification-phase-n-YYYYMMDD.json

结果证据至少记录：

- baselineSha
- candidateSha
- dirtyPathsBefore
- dirtyPathsAfter
- commands
- exitCodes
- scopedTests
- fullTests
- browserScenarios
- runtimeMode
- effectiveFlags
- rollbackResult
- unresolvedFindings

---

## 1. 最终产品决定

### 1.1 一级产品只有“策略”

目标信息架构只有一个面向普通用户的策略入口：

    行情工作台
      └─ 策略
          ├─ 使用当前图表
          ├─ 导入自己的数据
          ├─ 最近脚本
          └─ 高级研究

不再把“本地模式”“策略回测”“高级回测”作为三个并列入口。

普通用户第一次打开“策略”时只需要理解：

- 当前数据
- 脚本
- 运行
- 结果

dataset_id、data_epoch、snapshot_hash、StrategyRevision、BacktestRun 和 provider kind 继续存在于系统内部，但不进入普通主路径。

### 1.2 两种数据入口，一个冻结汇合点

产品有两条数据入口：

1. 当前图表：使用 exchange、market type、symbol、interval 和用户选择的日期范围。
2. 导入数据：使用 CSV 导入后的本地不可变数据集。

两条入口必须在创建 Run 前汇合为同一个不可变身份：

    dataset_id
    data_epoch
    snapshot_hash
    interval
    start_time_ms
    end_time_ms

Run 创建之后不再区分“来自在线图表”还是“来自用户 CSV”来决定可信度。可信度由数据来源、质量、覆盖、缺口、执行精度和运行时收据共同说明。

### 1.3 本地查看不是必须运行策略

导入数据后，用户可以只看图、画线、加指标、标事件和查看质量，不必创建策略 Run。

因此准确关系是：

    策略研究工作区
      ├─ 数据查看与分析
      └─ 可选的策略运行与结果研究

“本地数据是策略研究的数据来源”不等于“导入后必须回测”。

### 1.4 LOCAL_OFFLINE 不是页面开关

CANDLESCOPE_RUNTIME_MODE=LOCAL_OFFLINE 继续是进程级技术边界：

- 不启动交易所 ingestion
- 不启动 backfill
- 不启动行情 WebSocket
- 不启动 Replay
- 不启动在线目录刷新
- 不启动插件 Host
- 只允许本地资料库和已明确支持的 Backtest API
- 安装并验证非 loopback 网络阻断

统一产品入口不得把 LOCAL_OFFLINE 降级为一个可在页面中热切换的按钮。

### 1.5 第一版不把多图行情单元格变成混合数据单元格

第一版明确不做“同一个 LiveChartCell 在实时 WebSocket 和导入 CSV 之间热切换”。

原因：

- LiveChartCell 当前拥有实时 session、SeriesDataFeed、WebSocket lease、回填、链接组和多图状态。
- 本地数据拥有不可变 dataset_id + data_epoch、无 stream URL、无在线 fallback 的静态 feed。
- 直接在每个多图单元格中混合两套生命周期，会同时扩大状态、缓存、链接和释放风险。

第一版行为：

- 当前图表快测继续在行情页 bottom panel 中运行。
- 用户点击“导入自己的数据”时进入同一“策略”产品下的全屏策略研究工作区。
- 全屏工作区使用共享图表平台，但拥有独立 research runtime。
- 后续若需要每图表单元格选择本地数据，另写 ADR，不在本文顺带实现。

---

## 2. 当前仓库基线

### 2.1 已经完成的能力

main 当前已经拥有：

- backend/app/local_data 下的本地不可变数据服务
- CSV 后台导入、进度与取消
- 质量报告、revision 对比与切换
- 资料库重命名、归档、回收站与恢复
- .csproject 项目包导入导出
- 精确整数倍向上聚合和自定义周期
- 本地指标、绘图和事件分析
- backend/app/backtest 下的 BacktestRun、Study、报告和执行内核
- chart-context resolve/materialize
- 行情页 chart-first Strategy Tester
- 独立高级研究页
- LOCAL_OFFLINE 中可选启动 BacktestRuntime

当前数据层已经共享：

- BacktestRuntime.list_datasets 直接读取 LocalDatasetService
- BacktestRun 使用 dataset_id + data_epoch + snapshot_hash
- chart-context 将当前在线图表物化为本地不可变数据集

当前产品层仍然分裂：

- frontend/local.html + LocalApp 管理和查看导入数据
- 行情页“策略”只理解当前 ChartSession
- frontend/backtest.html 再次选择本地数据集并运行高级研究
- TopBar 仍有独立“策略回测”链接

### 2.2 旧分支的真实状态

codex/local-offline-mode：

- merge-base 为 e642125f9132eb3774101f11bae38a263865eb69
- 相对当前 main 落后 284 个提交
- 相对当前 main 有 9 个历史独有提交
- 工作树有 33 个 tracked 修改和 4 个 untracked 文件

本地模式相关的 39 个文件已经与 main 中 fe4c356b 快照逐文件一致。main 之后又继续增强本地数据和回测集成。

结论：

- 不直接 merge 旧分支
- 不从旧分支继续开发
- 不因为本方案实施而删除旧工作树
- 最终只对仍未进入 main 的非本地数据脏改动做独立归类

### 2.3 当前必须修正的技术重复

当前存在多个 LocalDatasetService 所有者：

- LocalOfflineRuntime 创建一个 service
- BacktestRuntime 创建一个 service
- BacktestWorker 再创建一个 service

只读打开不可变 revision 可以并行，但资料库写入、current pointer、trash、import job 和生命周期不能继续依赖多个隐式所有者。

统一前端之前必须先建立：

- 一个写入所有者
- 明确的只读 snapshot provider
- 可注入的 BacktestRuntime 数据依赖
- 唯一启动和关闭顺序

---

## 3. 目标信息架构

### 3.1 行情页普通入口

行情页保留当前 chart-first 体验：

    [策略]
      ├─ 使用策略模板
      ├─ 打开最近脚本
      ├─ 粘贴已有代码
      └─ 导入自己的数据

“导入自己的数据”不是文件 input 直接塞进当前 LiveChartCell，而是打开：

    /strategy.html?action=import

并携带当前 workspace/cell 的可选 launch context，方便用户以后返回当前图表。

### 3.2 全屏策略研究

全屏页使用一个统一壳：

    ┌──────────────────────────────────────────────────────────┐
    │ CandleScope 策略   [当前图表] [本地资料库]      [运行]   │
    ├──────────────┬───────────────────────────────┬───────────┤
    │ 数据          │ 共享研究图表                   │ 策略      │
    │               │                               │           │
    │ 导入 CSV      │ K 线 / 指标 / 绘图 / 事件       │ 脚本      │
    │ 资料库        │                               │ 参数      │
    │ 质量          │                               │ 设置摘要  │
    │ 修订          │                               │           │
    ├──────────────┴───────────────────────────────┴───────────┤
    │ 结果：概览 / 成交 / 解释 / 比较 / 高级研究                 │
    └──────────────────────────────────────────────────────────┘

默认只展开用户当前任务需要的区域：

- 导入时：数据栏展开，策略栏收起。
- 查看数据时：图表最大，左右栏可收起。
- 编辑策略时：策略栏展开，数据只显示简短来源条。
- Run 完成后：底部结果展开，旧标记与当前身份严格绑定。

### 3.3 唯一导航

最终导航规则：

- 行情页只有“策略”入口。
- “高级研究”从策略面板或结果面板进入。
- /strategy.html 是 canonical URL。
- /backtest.html 保留兼容入口，启动同一个 StrategyResearchApp。
- /local.html 保留兼容入口，启动同一个 StrategyResearchApp 并默认选择本地资料库。
- 兼容入口不再维护第二套 React App。

---

## 4. 不可破坏的产品与数据合同

### 4.1 本地数据不联网

当 source.kind=IMPORTED_DATASET 时：

- K 线只能从同一 dataset_id + data_epoch 读取
- 指标只能从同一 dataset_id + data_epoch 计算
- 事件只能投影到同一 dataset_id + data_epoch
- 周期只能使用已有源周期或可证明完整的向上聚合
- 缺口不得联网修复
- 不得把当前市场价格混入本地图表
- 不得在数据不足时自动切换成 CURRENT_CHART

### 4.2 revision 变化必须 stale

以下任一变化发生时，当前结果立即进入 STALE：

- dataset_id 改变
- data_epoch 改变
- snapshot_hash 改变
- interval 改变
- 日期范围改变
- 策略内容、参数或执行设置改变

同一渲染帧必须隐藏旧成交标记。旧摘要可以保留，但必须明确说明“结果属于旧数据或旧设置”。

### 4.3 用户确认边界

以下操作需要明确用户动作：

- 从当前图表联网准备缺失历史
- 导入 CSV
- 激活旧 revision
- 删除、移入回收站或恢复数据集
- 导入 .csproject
- 运行高精度或高成本任务

以下操作不需要重复确认：

- 读取已选本地 revision
- 在同一数据身份中分页看图
- 读取质量报告
- 计算已允许的静态内置指标
- 运行用户已明确点击的普通 BAR 快测

### 4.4 执行精度不因产品合并而模糊

继续区分：

- BAR_APPROX：基于 K 线估算
- TRADE_TAPE / AGG_TRADE_TAPE：基于成交序列
- BOOK_ASSISTED：使用订单簿辅助
- QUEUE_EXACT：只有真正队列证据才能声明

导入 OHLCV CSV 只能直接支持 BAR_APPROX。界面不得因为进入“策略”产品而暗示已经拥有逐笔或队列精度。

### 4.5 回放继续独立

TrainingRun 与 BacktestRun/Study：

- 不共享账户
- 不共享 checkpoint
- 不共享 cursor
- 不共享 UI store
- 不互相修改

只允许通过已有只读 research bridge 创建带 provenance 的新对象。

---

## 5. 统一数据来源合同

### 5.1 前端 ResearchSourceRefV1

建议新增：

    frontend/src/features/research-data/researchDataTypes.ts

类型：

    type ResearchSourceRefV1 =
      | {
          schemaVersion: "candlescope.research-source/1";
          kind: "CURRENT_CHART";
          workspaceId: string;
          cellId: string;
          exchange: string;
          marketType: string;
          symbol: string;
          interval: string;
        }
      | {
          schemaVersion: "candlescope.research-source/1";
          kind: "IMPORTED_DATASET";
          datasetId: string;
          dataEpoch: string;
          interval: string;
        }
      | {
          schemaVersion: "candlescope.research-source/1";
          kind: "COMPLETED_RUN";
          runId: string;
          datasetId: string;
          dataEpoch: string;
          snapshotHash: string;
        };

该对象描述用户选中的来源，但不等于可运行身份。

### 5.2 FrozenResearchContextV1

所有 Run 创建前必须得到：

    schemaVersion: candlescope.frozen-research-context/1
    sourceKind
    datasetId
    dataEpoch
    snapshotHash
    interval
    startTimeMs
    endTimeMs
    symbol
    qualitySummary
    capabilitySummary
    contextHash

规则：

- CURRENT_CHART 通过 chart-context resolve/materialize 得到。
- IMPORTED_DATASET 通过本地 manifest + backtest snapshot preview 得到。
- COMPLETED_RUN 从 Run 的不可变身份得到，只读打开。
- 前端不得自行拼装 snapshotHash。
- 后端再次校验 dataEpoch 和 snapshotHash 后才接受 Run。

### 5.3 数据能力矩阵

每个来源必须返回能力，而不是靠页面猜测：

| 能力 | CURRENT_CHART | IMPORTED_DATASET | COMPLETED_RUN |
| --- | --- | --- | --- |
| 查看 K 线 | 是 | 是 | 是 |
| 导入新数据 | 否 | 是 | 否 |
| 修改当前 revision 指针 | 否 | 是 | 否 |
| BAR_APPROX | 覆盖完整时 | 是 | 只读结果 |
| TRADE_TAPE | 有冻结成交时 | 仅导入成交后 | 取决于原 Run |
| 在线补数据 | 用户确认后 | 永不 | 永不 |
| 指标 | 当前行情 runtime | 本地显式-bars runtime | 只读结果能力 |
| 绘图/事件 | 当前 chart scope | dataset + epoch scope | 独立 review scope |

### 5.4 UI 术语

普通 UI 使用：

- 当前图表
- 本地资料库
- 数据版本
- 数据已冻结，可复现
- 数据有缺口
- 基于 K 线估算

普通 UI 不使用：

- local profile
- data epoch
- snapshot hash
- dataset ID
- provider ABI
- BacktestRun ID

高级“可信度详情”中可以显示截断后的身份和完整复制按钮。

---

## 6. 目标后端边界

### 6.1 保留 local_data 作为数据领域

不重命名 backend/app/local_data，也不把数据导入代码搬进 backtest。

local_data 继续负责：

- 导入
- 校验
- 不可变 revision
- manifest
- quality
- resampling
- project package
- trash
- 本地指标数据读取

backtest 继续负责：

- snapshot preview
- StrategyRevision
- Run/Study
- 执行
- 账户与撮合
- 报告
- 比较与解释

新增 research_data 只做产品编排和能力投影，不复制底层数据：

    backend/app/research_data/
      __init__.py
      contracts.py
      capabilities.py
      access.py
      runtime.py

### 6.2 拆分运行时

目标类：

    LocalDataRuntime
      service: LocalDatasetService
      jobs: LocalImportJobManager
      start()
      shutdown()

    LocalOfflineBoundary
      middleware
      networkGuard
      install()
      uninstall()

    BacktestRuntime
      localData: injected LocalDatasetService
      snapshots: LocalBarSnapshotProvider
      worker: BacktestWorker

约束：

- LocalDataRuntime 是写入生命周期唯一所有者。
- BacktestRuntime 不再隐式创建第二个可写 service。
- Worker 只读取已冻结 revision；如需要独立连接，只能使用只读 snapshot provider。
- shutdown 顺序为 BacktestWorker → BacktestService → LocalImportJobs → LocalDatasetService → OfflineNetworkGuard。
- 任一步启动失败都反向清理已经启动的对象。

### 6.3 LIVE 中的本地资料库 API

当前 local_data API 只接受 LOCAL_OFFLINE。统一后需要在 LIVE 中允许本机策略研究使用，但不能直接把管理面暴露到局域网。

真实威胁：

- LIVE 默认可能监听 0.0.0.0。
- local_data API 包含导入、删除、trash、revision 激活和项目包。
- Vite proxy 可能让远程浏览器的后端连接看起来来自 127.0.0.1。
- CORS 不是身份验证。

第一版安全合同：

- /api/v1/local 全部视为本机资料库 API，包括读操作。
- LIVE 中只接受可信本机 Origin/Host；无 Origin 的 CLI 请求还必须来自 loopback。
- 不信任 X-Forwarded-For 来授予本机权限。
- 通过 Vite proxy 的请求同时检查浏览器 Origin，远程 LAN Origin 必须被拒绝。
- Electron/桌面壳复用现有 desktop handshake 或显式注册的本机应用 Origin。
- LOCAL_OFFLINE 仍强制监听 loopback 并安装 network guard。
- 未来若需要远程资料库管理，必须单独实现认证和授权；不得用一个 remote_admin=1 裸开关放开。

建议错误：

    code: local_research_origin_required
    message: Local research data is available only from the trusted local application.

### 6.4 Feature flags

新增两个窄范围回滚旗标：

    CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED
    VITE_RESEARCH_DATA_LIBRARY_ENABLED

语义：

- 后端旗标只控制 LIVE 中启动和挂载本地资料库管理面。
- LOCAL_OFFLINE 继续按运行 profile 启动本地资料库，不依赖该旗标。
- 前端旗标只控制统一策略界面中的“导入数据/本地资料库”入口。
- 关闭两个旗标必须恢复当前 chart-first + 独立 local.html 行为。
- 实施期间默认 0；Phase 12 通过后再决定默认开启，不在中途改生产默认。

---

## 7. 目标前端边界

### 7.1 不再扩张两个巨型组件

当前：

- LocalApp.tsx 约 1251 行
- BacktestApp.tsx 约 1914 行
- LiveChartCell.tsx 约 926 行

禁止把导入表单直接复制进 BacktestApp，也禁止把完整 BacktestApp 塞进 LocalApp。

### 7.2 提取本地资料库组件

从 LocalApp.tsx 提取：

    frontend/src/features/research-data/
      researchDataTypes.ts
      researchDataApi.ts
      researchDataSourceModel.ts
      useResearchDataLibrary.ts
      ResearchDataDrawer.tsx
      ResearchDataSourceBar.tsx
      ResearchDataImportForm.tsx
      ResearchDatasetRail.tsx
      ResearchDatasetManagement.tsx
      ResearchDatasetQuality.tsx
      ResearchDatasetRevisions.tsx

保留 local-data 中的数据适配器和分析能力：

    localDataApi.ts
    useLocalChartRuntime.ts
    useLocalIndicatorRuntime.ts
    localAnalysisStore.ts
    localAnalysisMarkerSource.ts
    localIntervalPolicy.ts

原则：

- research-data 是产品编排。
- local-data 是本地数据能力实现。
- backtest 是策略执行和结果。
- app 只负责装配与 portal。

### 7.3 新增 StrategyResearchApp

建议目录：

    frontend/src/features/strategy-research/
      StrategyResearchApp.tsx
      StrategyResearchShell.tsx
      StrategyResearchRuntime.ts
      strategyResearchState.ts
      strategyResearchLaunch.ts
      StrategyResearchChart.tsx
      StrategyResearchSourcePanel.tsx
      StrategyResearchScriptPanel.tsx
      StrategyResearchResultPanel.tsx
      strategyResearch.css

三个 HTML 入口共用同一个 app：

    strategy-main.tsx
      ├─ strategy.html
      ├─ backtest.html compatibility bootstrap
      └─ local.html compatibility bootstrap

bootstrap 只决定初始 intent，不创建不同 runtime：

- strategy.html：恢复最近来源
- backtest.html：初始打开高级研究任务
- local.html：初始打开本地资料库

### 7.4 与当前 chart-first 的关系

ChartStrategyTesterCellBridge 继续拥有当前图表快测 runtime。

新增能力：

- Panel 首次入口增加“导入自己的数据”。
- 点击后使用 strategyResearchLaunch 构建 launch context。
- 全屏页可以返回来源 workspace/cell，但不复用原 CellBridge 的 React state、AbortController 或 SeriesWindowStore。
- 当前图表 Run 与本地数据 Run 继续使用同一 backtest API 和结果投影。

### 7.5 持久化

必须保留旧数据：

- 现有 local-data 的 dataset_id + data_epoch 作用域键不删除。
- 现有 StrategyDraftStore 不迁移成第二份脚本存储。
- 新增 strategy-research workspace key，只保存来源选择、面板布局和最近 Run 引用。
- 读取旧 local.html 偏好后可以投影到新壳，但迁移失败必须回退到默认视图，不能清空旧键。

建议：

    candlescope:strategy-research:v1

不得保存：

- 绝对本地文件路径
- CSV 原始内容
- 未冻结浏览器 OHLCV
- 可复用信任 token

---

## 8. 核心用户流程

### 8.1 当前图表第一次运行

1. 用户在行情图表点击“策略”。
2. 选择模板、最近脚本或粘贴代码。
3. 点击“运行”。
4. 系统 resolve 当前 ChartSession。
5. 已有不可变覆盖时直接冻结；不足时显示缺口和“准备数据并运行”。
6. 用户确认后才允许联网准备。
7. 创建 Run。
8. 完成后在原图显示成交标记和底部结果。

该流程保持当前 chart-first 合同，不因本地资料库合并而退化。

### 8.2 导入 CSV 后只看图

1. 用户点击“导入自己的数据”。
2. 进入 /strategy.html?action=import。
3. 选择 CSV、symbol、interval、timezone 和 volume policy。
4. 后台导入显示上传和解析进度。
5. 通过校验后发布不可变 revision。
6. 自动选中新数据集并打开图表。
7. 策略栏保持收起。
8. 用户可以查看质量、切换可证明周期、加指标、画线和标事件。

全过程不得访问交易所。

### 8.3 导入 CSV 后运行策略

1. 用户在本地图表点击“策略”或展开策略栏。
2. 选择脚本和参数。
3. 点击“运行”。
4. 前端用 dataset_id + data_epoch 请求 snapshot preview。
5. 后端返回 snapshot_hash、覆盖和质量。
6. UI 显示“数据已冻结，可复现”和 BAR 精度。
7. 创建 Run。
8. 结果标记投影到同一 data_epoch 图表。

若 revision 在第 4～7 步变化，Run 创建必须失败为 DATASET_IDENTITY_CHANGED，前端重新解析，不得偷偷切到新 revision。

### 8.4 LOCAL_OFFLINE 中运行策略

1. 用户通过 start-local-offline 启动。
2. 统一策略页默认打开本地资料库。
3. “当前图表/实时行情”入口显示不可用原因。
4. 导入、查看和 BAR 策略运行可用。
5. 依赖插件 Host、在线目录或 Replay 的能力按 capability 隐藏或禁用。
6. network guard 记录零非 loopback 连接。

### 8.5 revision 切换

1. 用户查看完成 Run。
2. 用户在数据栏激活另一个 revision。
3. 当前图表切换到新 data_epoch。
4. 旧结果同一渲染帧进入 STALE 并隐藏标记。
5. 用户可以打开旧 Run 的冻结结果，但不能把旧标记画到新 revision 上。

### 8.6 高级研究交接

1. 用户从普通策略结果点击“高级研究”。
2. 创建新的 research launch context。
3. 交接脚本、参数、来源、范围和最近 Run。
4. 高级页按任务进入：精确成交、参数稳健性、Python/模型、多市场、回放复盘。
5. 不要求用户重新选择数据集或复制 ID。

---

## 9. 分阶段执行计划

## Phase 0：冻结合同、基线和 ADR

### 目标

建立可复现基线，确认本文的产品决定，不修改运行时代码。

### 依赖

- main 工作树干净
- 当前 HEAD 与本文基线差异已解释
- 旧 local-offline 工作树仍可只读访问

### 修改范围

- docs/adr/ADR-BACKTEST-014-LOCAL-DATA-AS-RESEARCH-SOURCE.md
- docs/evidence/STRATEGY_RESEARCH_UNIFICATION_PHASE_0_PLAN_*.md
- docs/evidence/STRATEGY_RESEARCH_UNIFICATION_PHASE_0_RESULT_*.md
- docs/evidence/strategy-research-unification-phase-0-*.json

### 步骤

1. 记录 main SHA、origin/main SHA、工作树和所有 worktree。
2. 记录 codex/local-offline-mode 的 HEAD、merge-base、ahead/behind 和 37 项脏状态。
3. 运行现有 local-data、offline、backtest chart-context 和 chart-first 前端测试。
4. 截取当前四个状态：行情页策略首次打开、完成结果、/backtest.html、/local.html。
5. 新增 ADR，冻结：
   - 本地数据是策略研究来源。
   - LOCAL_OFFLINE 是技术 profile。
   - 第一版不做 LiveChartCell 混合数据热切换。
   - 旧分支禁止整枝 merge。
6. 记录现有前端包体、首屏请求、WebSocket 数量和 console 基线。

### 验证

    git status --short --branch
    git rev-parse HEAD
    git worktree list --porcelain

    cd backend
    .\.venv\Scripts\python.exe -m pytest -q tests/test_local_data_service.py tests/test_local_data_api.py tests/test_local_data_jobs.py
    .\.venv\Scripts\python.exe -m pytest -q tests/test_local_offline_main_profile.py tests/test_local_offline_network_guard.py
    .\.venv\Scripts\python.exe -m pytest -q tests/test_backtest_chart_context.py tests/test_backtest_quick_presets.py

    cd ..\frontend
    npm.cmd run test:backtest
    npm.cmd run typecheck

### 退出标准

- ADR 被评审接受。
- 基线失败被明确区分为既有失败或本方案阻断。
- 四个 UI 状态有截图和 SHA-256。
- 旧分支没有任何修改。
- 本 Phase 只有 docs/adr 与 docs/evidence 改动。

### 建议提交

    docs(strategy): freeze local-data research unification contract

### 回滚

删除本 Phase 新增文档即可；不涉及运行时、数据库或用户数据。

## Phase 1：冻结统一数据来源和能力合同

### 目标

建立 source-neutral 类型和后端能力投影，不改变现有页面行为。

### 依赖

- Phase 0 ADR accepted
- 当前 chart-context 与 local manifest wire contract 已记录

### 修改范围

- backend/app/research_data/contracts.py
- backend/app/research_data/capabilities.py
- backend/tests/test_research_data_contracts.py
- frontend/src/features/research-data/researchDataTypes.ts
- frontend/src/features/research-data/researchDataSourceModel.ts
- frontend/src/features/research-data/__tests__/*

### 步骤

1. 新增 ResearchSourceRefV1 和 FrozenResearchContextV1。
2. 冻结 CURRENT_CHART、IMPORTED_DATASET、COMPLETED_RUN 三种 source kind。
3. 冻结 capability matrix 和用户可见原因。
4. 建立 Python/TypeScript 共享 fixture。
5. 对所有枚举做 unknown fail-closed。
6. 明确内部身份不会直接进入普通 UI。
7. 不新增数据库表，不修改 Run schema。

### 验证

- Python 与 TypeScript 对同一 fixture 解析一致。
- 缺失 dataset/data epoch 的 IMPORTED_DATASET 被拒绝。
- COMPLETED_RUN 缺失 snapshot hash 被拒绝。
- 未知 source kind 被拒绝。
- capability 缺失时 UI 显示不可用，不猜测 true。
- 现有 chart-first 和 local-data 测试无回归。

### 退出标准

- 合同有 schemaVersion。
- canonical fixture 被两端测试。
- 现有 API 尚未改变。
- 页面截图与 Phase 0 一致。

### 建议提交

    feat(research): define unified strategy data source contracts

### 回滚

移除新增 research_data/research-data 文件；因为尚无调用方，不需要数据迁移。

## Phase 2：把 LocalApp 拆成可复用资料库组件

### 目标

消除 LocalApp 巨型组件，但保持 /local.html 行为逐像素和逐合同不变。

### 依赖

- Phase 1 类型冻结
- Phase 0 local.html 截图和浏览器基线可用

### 修改范围

- frontend/src/features/local-data/LocalApp.tsx
- frontend/src/features/research-data/ResearchDataImportForm.tsx
- frontend/src/features/research-data/ResearchDatasetRail.tsx
- frontend/src/features/research-data/ResearchDatasetManagement.tsx
- frontend/src/features/research-data/ResearchDatasetQuality.tsx
- frontend/src/features/research-data/ResearchDatasetRevisions.tsx
- frontend/src/features/research-data/useResearchDataLibrary.ts
- frontend/src/features/research-data/researchDataApi.ts
- frontend/package.json

### 步骤

1. 先为 LocalImportForm、LocalDatasetRail、LocalDatasetManagement 增加行为测试。
2. 每次只提取一个组件，保持 props 和 API 调用一致。
3. 把加载、选择、import job polling 和 cancellation 收敛到 useResearchDataLibrary。
4. LocalApp 继续装配提取后的组件，不切换新产品壳。
5. 保留 local-data adapter、indicator runtime、event store 和 interval policy 原位置。
6. 增加 npm script test:research-data。
7. 对导入取消、revision 切换、trash/restore 和 package round-trip 做回归。

### 验证

    cd frontend
    npm.cmd run test:research-data
    npm.cmd run test:backtest
    npm.cmd run typecheck
    npm.cmd run lint
    npm.cmd run build

浏览器：

- /local.html 首屏一致
- 导入成功、失败、取消一致
- 质量、revision、trash 和项目包一致
- 无新增 console error
- 无在线行情请求

### 退出标准

- LocalApp 只负责页面装配，不再内嵌导入和管理实现。
- 所有旧 local-data 测试通过。
- localStorage key 未改变。
- 网络请求集合与 Phase 0 一致。

### 建议提交

    refactor(local): extract reusable research data library components

### 回滚

还原组件提取提交；本 Phase 不修改后端和数据格式。

## Phase 3：拆分本地数据运行时并建立唯一写入所有者

### 目标

让 LIVE、LOCAL_OFFLINE 和 Backtest 共享明确的数据生命周期，消除隐式多写入所有者。

### 依赖

- Phase 1 后端合同
- LocalDatasetService 并发和锁行为已有测试

### 修改范围

- backend/app/local_data/runtime.py
- backend/app/backtest/runtime.py
- backend/app/main.py
- backend/app/research_data/runtime.py
- backend/tests/test_research_data_runtime.py
- backend/tests/test_local_offline_main_profile.py
- backend/tests/test_backtest_runtime.py

### 步骤

1. 从 LocalOfflineRuntime 提取 LocalDataRuntime。
2. LocalDataRuntime 唯一拥有 LocalDatasetService 和 LocalImportJobManager。
3. 把 OfflineNetworkGuard 移到 LocalOfflineBoundary。
4. BacktestRuntime.start 接受注入的 local_data_service。
5. BacktestWorker 使用共享线程安全 service 或只读 snapshot provider，不再创建可写所有者。
6. 调整 startup：
   - 创建 LocalDataRuntime。
   - 需要时创建 BacktestRuntime。
   - LOCAL_OFFLINE 最后安装网络边界。
7. 调整 shutdown，确保每个对象只关闭一次。
8. 增加部分启动失败的反向清理测试。

### 验证

- LIVE + Backtest 启动只有一个 writable LocalDatasetService。
- LOCAL_OFFLINE + Backtest 启动只有一个 writable LocalDatasetService。
- import job 与 Run 同时读取同一资料库时无 current pointer 撕裂。
- shutdown 后线程、job 和 lock 全部释放。
- 第二次 shutdown 幂等。
- 启动中途抛错不会遗留 worker 或 network guard。

### 退出标准

- app.state 只有一个明确 research/local data runtime owner。
- BacktestRuntime 构造不再只接受 local_data_dir 并隐式创建写 service。
- 现有本地导入、BacktestRun 和 offline profile 测试通过。

### 建议提交

    refactor(research): unify local dataset runtime ownership

### 回滚

恢复旧构造路径和生命周期；不改变磁盘数据格式，因此无需回滚用户数据。

## Phase 4：在 LIVE 中安全开放本机资料库 API

### 目标

让统一策略页在 LIVE 中导入和读取本地数据，同时阻断 LAN/远程来源访问本机资料库。

### 依赖

- Phase 3 唯一 runtime owner
- 可信本机 Origin 规则已在 ADR 补充

### 修改范围

- backend/app/main.py
- backend/app/api/v1/local_data.py
- backend/app/research_data/access.py
- backend/app/core/config.py
- backend/tests/test_research_data_access.py
- backend/tests/test_local_data_api.py
- frontend/vite.config.js

### 步骤

1. 增加严格解析的 CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED。
2. LOCAL_OFFLINE 保持原有本地 API。
3. LIVE 仅在旗标开启时挂载 /api/v1/local。
4. 移除 local_data._service 对 RUNTIME_MODE==LOCAL_OFFLINE 的硬编码，改查 app.state runtime 和 access policy。
5. 为所有 /api/v1/local 路由增加可信本机访问依赖。
6. 同时检查 client、Host 和 Origin；不使用 X-Forwarded-For 授权。
7. 明确 Vite proxy 转发时保留原始 Origin。
8. Electron 场景接入已有本机 handshake，不在前端 bundle 写静态 token。
9. 增加安全日志，只记录拒绝原因和来源类别，不记录绝对数据路径。

### 验证

必须覆盖：

- 本机 127.0.0.1 Origin 导入成功。
- localhost Origin 导入成功。
- 无 Origin 的 loopback CLI 按合同成功。
- LAN Origin 经直连后端被 403。
- LAN Origin 经 Vite proxy 被 403。
- 伪造 X-Forwarded-For: 127.0.0.1 仍被 403。
- remote Origin 的 GET datasets 和 GET klines 也被 403。
- flag=0 时 LIVE 不暴露本地资料库。
- LOCAL_OFFLINE 仍强制 loopback 和 network guard。

### 退出标准

- 威胁矩阵全部通过。
- CORS 未被描述成认证。
- 没有 remote_admin 裸开关。
- flag=0 可完整回滚到 Phase 3 行为。

### 建议提交

    feat(research): expose local data library to trusted live clients

### 回滚

关闭 CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED；LIVE 不再挂载本地资料库，LOCAL_OFFLINE 不受影响。

## Phase 5：建立统一 Research Data 状态与数据抽屉

### 目标

让前端在不运行策略的情况下选择、导入和查看数据来源。

### 依赖

- Phase 2 可复用组件
- Phase 4 LIVE 本机 API
- Phase 1 ResearchSourceRefV1

### 修改范围

- frontend/src/features/research-data/ResearchDataDrawer.tsx
- frontend/src/features/research-data/ResearchDataSourceBar.tsx
- frontend/src/features/research-data/useResearchDataLibrary.ts
- frontend/src/features/strategy-research/strategyResearchState.ts
- frontend/src/features/strategy-research/StrategyResearchRuntime.ts
- frontend/src/i18n/catalogs/en.ts
- frontend/src/i18n/catalogs/zh-CN.ts

### 步骤

1. 实现 source reducer，不与 BacktestRun 状态混在一起。
2. 加载 runtime mode 和 research-data capability。
3. 建立“当前图表”“本地资料库”“完成 Run”三种来源卡片。
4. 实现导入、选择、质量、revision、trash 和项目包流程。
5. source 变化立即清除未冻结 preview。
6. revision 变化发布 typed stale reason。
7. UI 只显示产品术语，内部 ID 进入可信度详情。
8. flag=0 时隐藏导入入口，不留下空栏。

### 验证

- reducer 的每个来源转换都有测试。
- malformed localStorage fail closed。
- source 切换不会删除旧偏好。
- revision 切换产生 DATA_REVISION_CHANGED。
- LOCAL_OFFLINE 隐藏 CURRENT_CHART 可运行动作并说明原因。
- 没有策略脚本时数据抽屉完全可用。

### 退出标准

- 数据查看不依赖创建 Run。
- 数据来源、策略状态和结果状态是三个独立 slice。
- 普通路径无 dataset/data epoch 文案。
- flag rollback 有测试。

### 建议提交

    feat(research): add unified strategy data source drawer

### 回滚

关闭 VITE_RESEARCH_DATA_LIBRARY_ENABLED；新抽屉不渲染，旧 local.html 仍可用。

## Phase 6：创建统一全屏 StrategyResearchApp

### 目标

建立 /strategy.html，并让 local.html 与 backtest.html 共用同一个 App 壳。

### 依赖

- Phase 5 数据抽屉
- 当前高级研究 launch context 已稳定
- 共享 MarketPageFrame/MarketWorkspaceFrame 可复用

### 修改范围

- frontend/strategy.html
- frontend/src/strategy-main.tsx
- frontend/src/features/strategy-research/StrategyResearchApp.tsx
- frontend/src/features/strategy-research/StrategyResearchShell.tsx
- frontend/src/features/strategy-research/strategyResearchLaunch.ts
- frontend/src/backtest-main.tsx
- frontend/src/local-main.tsx
- frontend/vite.config.js

### 步骤

1. 新增 canonical /strategy.html。
2. 建立 source-neutral StrategyResearchShell。
3. 接入数据抽屉、共享图表槽、策略槽和结果槽。
4. backtest-main 与 local-main 改为调用同一 bootstrap。
5. 保留原 URL、query 和 deep link。
6. 不删除 LocalApp/BacktestApp，先作为 legacy fallback。
7. 加入独立错误边界，数据抽屉失败不能清空脚本草稿。
8. 建立首屏、导入态、看图态、编辑态和完成态视觉合同。

### 验证

- /strategy.html 正常启动。
- /local.html 默认进入本地资料库。
- /backtest.html 默认进入高级研究。
- 三个入口使用同一 StrategyResearchApp。
- 旧 deep link run/compare/context 可解析。
- 首屏不加载不需要的 Monaco、Study 或 Python bundle。
- 1440×900 和 1366×768 无关键遮挡。

### 退出标准

- 产品评审通过五个核心状态。
- canonical URL 可用。
- legacy URL 尚未删除。
- 同一个 App 中不存在两份资料库 store。

### 建议提交

    feat(strategy): add unified full-screen research workspace

### 回滚

导航继续指向旧 URL；legacy App 仍在，可通过前端 flag 恢复。

## Phase 7：迁移本地图表与分析能力

### 目标

让统一策略页对导入数据达到现有 local.html 的行为等价。

### 依赖

- Phase 6 StrategyResearchShell
- Phase 2 组件提取完成

### 修改范围

- frontend/src/features/strategy-research/StrategyResearchChart.tsx
- frontend/src/features/local-data/useLocalChartRuntime.ts
- frontend/src/features/local-data/useLocalIndicatorRuntime.ts
- frontend/src/features/local-data/localAnalysisStore.ts
- frontend/src/features/local-data/localAnalysisMarkerSource.ts
- frontend/src/features/local-data/localIntervalPolicy.ts
- frontend/src/features/indicators/*
- frontend/src/features/drawings/*

### 步骤

1. 复用 SeriesDataFeed → SeriesWindowStore → chart adapter，不创建第二套图表真相。
2. IMPORTED_DATASET 使用 LocalKlineApi，无 stream URL。
3. 接入历史左翻页和 range 定位。
4. 接入源周期、可证明向上聚合和自定义周期。
5. 接入共享指标目录和显式-bars compute transport。
6. 接入绘图、事件、截图、主题、价格轴和视口持久化。
7. 所有状态继续以 dataset_id + data_epoch 隔离。
8. 增加网络请求 allowlist 测试，禁止 online kline/indicator fallback。

### 验证

场景：

- OHLC 与 OHLCV。
- 15m → 30m/1h/90m。
- 15m → 89m 明确拒绝。
- 数据缺口和两端 partial bucket 不产生假 K 线。
- VOL 在无 volume 时可见但禁用。
- revision 切换后旧指标、绘图和事件不串台。
- 定位窗口外事件只读同一数据集。
- 浏览器网络面板无 exchange、symbols、stream 和 online indicators 请求。

### 退出标准

- unified workspace 达到 local.html 功能等价。
- 同一数据身份贯穿图表、指标、绘图和事件。
- 所有 local-data 测试迁移后仍通过。
- legacy local.html 只剩兼容装配，不拥有独立业务逻辑。

### 建议提交

    feat(strategy): bring immutable local analysis into research workspace

### 回滚

关闭前端统一旗标并恢复 legacy LocalApp 装配；磁盘 revision 和浏览器旧键均不变。

## Phase 8：把导入数据接入 chart-first Run 流程

### 目标

让 IMPORTED_DATASET 与 CURRENT_CHART 使用同一个冻结、校验、运行和结果流程。

### 依赖

- Phase 7 本地图表等价
- FrozenResearchContextV1
- Backtest snapshot preview 和 Run API 稳定

### 修改范围

- frontend/src/features/backtest/chart-tester/chartStrategyRunRequest.ts
- frontend/src/features/backtest/chart-tester/ChartStrategyTesterRuntime.ts
- frontend/src/features/strategy-research/StrategyResearchScriptPanel.tsx
- frontend/src/features/strategy-research/StrategyResearchResultPanel.tsx
- backend/app/backtest/runtime.py
- backend/app/api/v1/backtests.py
- backend/tests/test_backtest_research_source.py

### 步骤

1. 把现有 run request 拆成 source resolve 和 frozen run 两段。
2. CURRENT_CHART 保持 chart-context resolve/materialize。
3. IMPORTED_DATASET 使用 manifest + preview，不调用 materialize online。
4. 两条路径都生成 FrozenResearchContextV1。
5. Run create 继续后端校验 dataset/data epoch/snapshot。
6. 结果缓存 key 加入完整 frozen identity。
7. 复用 TradeExplanation、RUN_COMPARE 和 marker source。
8. revision/source 变化时同一帧 stale 并隐藏旧 marker。
9. BAR_ONLY 数据不显示高精度已可用。

### 验证

- 同一 CSV、同一策略和参数重复运行得到确定性结果。
- IMPORTED_DATASET 运行期间没有联网请求。
- CURRENT_CHART 现有自动运行和 needs-data 用户确认无回归。
- data epoch 在 preview 后变化时 Run 创建失败。
- 旧 marker 不投影到新 revision。
- 完成 Run 可从高级研究和本地图表重新打开。

### 退出标准

- 两种来源在 Run 创建前汇合到同一 FrozenResearchContext。
- Run schema 无来源特判分叉。
- 普通 UI 不要求用户选择 dataset ID。
- chart-first 全部现有验收继续通过。

### 建议提交

    feat(strategy): run chart and imported data through one frozen context

### 回滚

关闭统一资料库旗标；CURRENT_CHART 流程继续使用现有 chart-context，导入数据暂时回到只看图。

## Phase 9：让 LOCAL_OFFLINE 使用同一个策略产品

### 目标

删除“离线页面等于另一套产品”的体验，同时保持进程级离线保证。

### 依赖

- Phase 8 IMPORTED_DATASET Run 完整
- LOCAL_OFFLINE Backtest flags 和能力投影明确

### 修改范围

- start-local-offline.ps1
- start-local-offline.sh
- frontend/src/local-main.tsx
- frontend/src/features/strategy-research/StrategyResearchApp.tsx
- backend/app/local_data/runtime.py
- backend/tests/test_local_offline_main_profile.py
- frontend/src/features/strategy-research/__tests__/*

### 步骤

1. start-local-offline 默认打开 /strategy.html?source=imported。
2. /local.html 保留兼容。
3. 统一 App 读取 /health runtime_mode。
4. LOCAL_OFFLINE 下隐藏 live source、live reference 和在线 materialize。
5. 根据 capabilities 隐藏插件、Replay、在线目录和不可用策略 runtime。
6. BAR 策略运行继续可用。
7. network guard diagnostics 进入可信度详情。
8. 对所有 IMPORTED_DATASET 场景做零外网验证。

### 验证

- /health 返回 LOCAL_OFFLINE。
- /api/v1/klines、stream、replay、plugin API 仍被拒绝。
- /api/v1/local 与 /api/v1/backtests 按能力可用。
- 导入、看图、指标和 BAR Run 成功。
- DNS/TCP/UDP 非 loopback 尝试为零或明确被 guard 阻断。
- 页面不显示可点击的实时来源。

### 退出标准

- LOCAL_OFFLINE 与 LIVE 使用同一个 StrategyResearchApp。
- 技术 profile 没有变成页面 toggle。
- offline network tests 和 browser network proof 均通过。

### 建议提交

    feat(strategy): use unified research workspace in offline profile

### 回滚

启动脚本恢复打开 /local.html；LocalOfflineBoundary 和磁盘数据不变。

## Phase 10：统一高级研究入口与上下文交接

### 目标

把独立“策略回测”导航收敛为“策略”内部的高级任务入口。

### 依赖

- Phase 6 unified app
- Phase 8 两类来源 Run
- 现有 research launch context 测试通过

### 修改范围

- frontend/src/app/TopBar.tsx
- frontend/src/features/backtest/chart-tester/ChartStrategyTesterPanel.tsx
- frontend/src/features/backtest/research/*
- frontend/src/features/strategy-research/strategyResearchLaunch.ts
- frontend/src/i18n/catalogs/*

### 步骤

1. 行情页保留一个“策略”入口。
2. 移除 TopBar 独立“策略回测”导航，但保留 /backtest.html URL。
3. 在策略面板和结果面板提供“高级研究”。
4. launch context 传递 source、frozen identity、脚本、参数、范围和最近 Run。
5. 高级任务入口保持五类：精确成交、稳健性、Python/模型、多市场、回放复盘。
6. 从高级页返回时只传引用，不复用可变 runtime。
7. 深链失效时显示可行动错误，不回到任意第一个 dataset。

### 验证

- TopBar 只有一个策略入口。
- 当前图表与导入数据都能无损进入高级研究。
- 用户不需要重新选择 symbol、interval 或数据集。
- /backtest.html?run=... 仍可打开。
- launch context tamper 被后端拒绝或前端 fail closed。

### 退出标准

- 产品导航不存在“本地模式 vs 策略回测”的并列关系。
- 普通和高级共享同一脚本草稿与不可变上下文引用。
- 两个 runtime 仍然隔离。

### 建议提交

    feat(strategy): unify quick and advanced research navigation

### 回滚

恢复 TopBar /backtest.html 链接；统一 StrategyResearchApp 与数据层无需回滚。

## Phase 11：兼容迁移与删除重复编排

### 目标

在功能等价和回滚证据存在后，删除重复页面业务逻辑，但保留兼容 URL。

### 依赖

- Phase 7 local parity
- Phase 8 Run parity
- Phase 10 navigation parity
- 至少一次完整 browser acceptance

### 修改范围

- frontend/src/features/local-data/LocalApp.tsx
- frontend/src/features/backtest/BacktestApp.tsx
- frontend/src/local-main.tsx
- frontend/src/backtest-main.tsx
- frontend/vite.config.js
- docs/local-offline-mode.md
- docs/BACKTEST_CHART_FIRST_UX_EXECUTION_zh.md
- README.md
- README_zh.md

### 步骤

1. 生成 legacy-to-unified 功能映射表。
2. 把仍只存在于 LocalApp/BacktestApp 的能力逐项迁移或明确延期。
3. LocalApp/BacktestApp 改为薄兼容 bootstrap，或在零引用后删除。
4. 保留 local.html 和 backtest.html 入口至少一个发布周期。
5. 兼容入口显示一次性说明，但不阻碍使用。
6. 更新文档术语：
   - 本地分析模式 → 策略中的本地资料库
   - 策略回测 → 策略/高级研究
   - LOCAL_OFFLINE 保留为启动 profile
7. 旧 localStorage 只读迁移，不删除。

### 验证

- rg 确认没有第二套 import polling、dataset selection 或 Run polling。
- legacy URL 全部通过。
- 旧项目包、事件、绘图、指标和脚本草稿可打开。
- flag rollback 仍能恢复兼容壳。
- README 不宣称未验证的 Pine/Pyne 离线能力。

### 退出标准

- 业务逻辑只有一套。
- 兼容 URL 无数据丢失。
- 文档和 UI 使用同一产品术语。
- 任何延期能力都有明确 issue/Phase，不被静默删除。

### 建议提交

    refactor(strategy): retire duplicate local and backtest app orchestration

### 回滚

恢复兼容 App 装配提交；旧存储键和磁盘数据未删除，可直接重新读取。

## Phase 12：发布验证、回滚演练与旧分支收口

### 目标

证明统一体验可以作为工程基线，并在用户明确授权后处理旧分支。

### 依赖

- Phase 0～11 全部退出
- 工作树无无关改动
- 发布候选 SHA 已冻结

### 修改范围

- backend/scripts/verify_strategy_research_unification.py
- frontend/scripts/strategy-research-smoke.mjs
- docs/evidence/STRATEGY_RESEARCH_UNIFICATION_PHASE_12_*
- docs/evidence/strategy-research-unification-release-*.json
- docs/LOCAL_DATA_STRATEGY_RESEARCH_UNIFICATION_EXECUTION_zh.md

### 步骤

1. 建立 release verifier 和证据 schema。
2. 运行 scoped、full、browser、security、offline 和 rollback 矩阵。
3. 运行至少 60 分钟 mixed soak：
   - LIVE 当前图表快测
   - LIVE 导入数据看图
   - LIVE 导入数据 Run
   - LOCAL_OFFLINE 导入与 Run
   - revision 切换和 stale
4. 执行双旗标关闭演练。
5. 验证 /strategy.html、/local.html、/backtest.html。
6. 冻结候选 SHA 和 artifact hash。
7. 只读审计 codex/local-offline-mode 的 37 项脏状态：
   - 本地模式相关已移植项
   - 非本地 package/release 项
   - 仍需保留的用户改动
8. 只有用户明确同意后，才归档分支或移除旧 worktree。
9. 不执行直接 merge。

### 验证

后端：

    cd backend
    .\.venv\Scripts\python.exe -m pytest -q tests/test_local_data_service.py tests/test_local_data_api.py tests/test_local_data_jobs.py
    .\.venv\Scripts\python.exe -m pytest -q tests/test_local_offline_main_profile.py tests/test_local_offline_network_guard.py tests/test_research_data_access.py
    .\.venv\Scripts\python.exe -m pytest -q tests/test_backtest_chart_context.py tests/test_backtest_research_source.py tests/test_backtest_release_gate.py
    .\.venv\Scripts\python.exe -m pytest -q tests/backtest_contract

前端：

    cd frontend
    npm.cmd run test:research-data
    npm.cmd run test:backtest
    npm.cmd test
    npm.cmd run typecheck
    npm.cmd run lint
    npm.cmd run build
    npm.cmd run smoke:backtest
    node scripts/strategy-research-smoke.mjs

Git：

    git status --short
    git diff --check
    git fsck --no-progress

### 退出标准

- 所有必跑测试和浏览器场景通过。
- security matrix 证明远程 Origin 不能访问本地资料库。
- LOCAL_OFFLINE 证明无外网 fallback。
- 两个旗标关闭后恢复当前已验证 chart-first 行为。
- legacy URL 兼容。
- 旧分支未未经授权删除。
- release manifest 绑定候选 SHA 和证据 hash。
- 文档中的全部 DoD 被逐项签署。

### 建议提交

    test(strategy): qualify unified local-data research release

### 回滚

1. 关闭 VITE_RESEARCH_DATA_LIBRARY_ENABLED。
2. 关闭 CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED。
3. 导航恢复当前 chart-first 和 legacy URL。
4. 不删除 local-data、backtest DB、revision、project package 或 localStorage。
5. 如需代码回滚，只 revert Phase 11→Phase 4 的提交；Phase 3 生命周期重构只有在独立回归失败时回滚。

---

## 10. 测试场景清单

### A. 当前图表

- A1：首次打开只显示三个脚本入口和“导入自己的数据”。
- A2：已有完整数据直接运行。
- A3：数据不足先显示缺口，用户确认后才联网。
- A4：用户拒绝准备数据，不创建 Run。
- A5：symbol/interval/range 变化立即 stale。
- A6：四图策略状态隔离。

### B. 导入数据

- B1：CSV 导入成功后自动打开图表。
- B2：错误时间格式逐行解释。
- B3：重复、乱序、OHLC 关系错误被拒绝。
- B4：OHLC-only 不伪造 volume=0。
- B5：导入取消不发布半成品。
- B6：重复导入幂等。
- B7：资料库 rename/archive/trash/restore。
- B8：revision compare/activate。
- B9：.csproject round-trip 和 collision remap。

### C. 本地图表

- C1：左翻页和窗口外事件定位。
- C2：15m→30m/1h/90m。
- C3：15m→89m fail closed。
- C4：缺口、错位和 partial bucket 不插值。
- C5：指标、绘图、事件按 dataset + epoch 隔离。
- C6：切 revision 时旧 marker 同帧隐藏。
- C7：网络请求只有本地资料库 API。

### D. 策略 Run

- D1：当前图表和导入数据汇合到同一 FrozenResearchContext。
- D2：导入数据 BAR Run 可复现。
- D3：preview 后 revision 变化被拒绝。
- D4：BAR 数据不宣称 trade precision。
- D5：TradeExplanation 只显示决定时证据。
- D6：不可比较 Run 不显示改善/恶化。
- D7：Run 可从完成记录重新打开。

### E. LOCAL_OFFLINE

- E1：统一策略页启动。
- E2：实时来源不可用且有原因。
- E3：导入、看图、指标和 BAR Run 可用。
- E4：live/replay/plugin/stream API 被拒绝。
- E5：非 loopback DNS/TCP/UDP 为零或被阻断。

### F. 安全

- F1：loopback + trusted local Origin 成功。
- F2：LAN Origin 直连后端被拒绝。
- F3：LAN Origin 经 Vite proxy 被拒绝。
- F4：伪造 X-Forwarded-For 不提权。
- F5：remote Origin 不能读取数据集和 K 线。
- F6：日志不泄露绝对本地路径、CSV 内容和 token。

### G. 兼容与回滚

- G1：/strategy.html canonical。
- G2：/local.html 兼容。
- G3：/backtest.html deep link 兼容。
- G4：旧 localStorage 和 .csproject 可读。
- G5：双旗标关闭恢复现状。
- G6：回滚不删除用户数据。

---

## 11. 可观测性和错误合同

### 11.1 必须记录

- runtime_mode
- source_kind
- research context status
- dataset identity 的短 hash
- data quality status
- capability decisions
- import job state
- Run state
- stale reason
- access policy allow/deny reason
- network guard diagnostics

### 11.2 禁止记录

- CSV 原文
- 策略 secret
- 绝对本地文件路径
- 完整项目包内容
- 可复用本机信任凭据
- 未截断用户脚本

### 11.3 固定错误族

建议统一以下用户动作：

| code | 用户解释 | 用户动作 |
| --- | --- | --- |
| RESEARCH_DATA_DISABLED | 本地资料库入口未启用 | 使用当前图表或启用本机功能 |
| LOCAL_RESEARCH_ORIGIN_REQUIRED | 只能从本机应用访问资料库 | 在本机页面打开 |
| DATASET_IDENTITY_CHANGED | 数据版本已变化 | 重新冻结并运行 |
| DATA_QUALITY_FAILED | 数据未通过质量检查 | 打开质量报告 |
| DATA_GAP | 所选区间存在缺口 | 缩短区间或导入完整数据 |
| UNSUPPORTED_INTERVAL | 无法精确生成周期 | 选择列出的可用周期 |
| UNSUPPORTED_FIDELITY | 当前数据不支持所选精度 | 使用 K 线估算或导入成交数据 |
| OFFLINE_LIVE_SOURCE_UNAVAILABLE | 离线运行时没有实时行情 | 选择本地资料库 |
| LEGACY_CONTEXT_MIGRATION_FAILED | 旧页面状态无法自动恢复 | 重新选择来源，旧数据仍保留 |

错误必须同时有：

- 稳定 code
- 面向用户的 message
- 可执行 action
- 可选 details
- 不泄露路径和内部异常堆栈

---

## 12. 性能和资源预算

统一界面不得把三个页面的 runtime 同时启动。

### 12.1 前端

- 数据抽屉关闭时不轮询 import jobs。
- 未选择策略时不加载 Monaco。
- 结果面板关闭时不重复创建图表。
- legacy URL 只能启动同一个 StrategyResearchRuntime。
- 不同时创建 LocalApp store 和 StrategyResearch store。
- IMPORTED_DATASET 没有 WebSocket。

### 12.2 后端

- 一个 LocalDataRuntime 写入所有者。
- import job 与 Run 读快照并发有硬上限。
- 本地指标继续受 bar ceiling 限制。
- Backtest 继续受 max active runs、row、event、memory 和 time ceiling 限制。
- project package 和 CSV upload 保留大小限制与 staging 原子发布。

### 12.3 必须测量

- /strategy.html 首屏 JS 和 lazy chunk。
- 导入 500 MiB 上限附近文件的内存峰值。
- 250,000 bar 图表和指标。
- import job 与 4 个 BAR Run 并发。
- revision 切换后的缓存释放。
- 60 分钟 mixed soak 的 heap、线程和文件句柄。

不得把旧 local.html 和新 strategy.html 的独立测量直接相加后称为统一页预算。

---

## 13. 发布与回滚旗标

| 旗标 | 开发期默认 | Phase 12 后候选 | 关闭结果 |
| --- | --- | --- | --- |
| CANDLESCOPE_RESEARCH_DATA_LIBRARY_ENABLED | 0 | 评审后决定 | LIVE 不挂载资料库 |
| VITE_RESEARCH_DATA_LIBRARY_ENABLED | 0 | 评审后决定 | 策略页隐藏导入入口 |
| 现有 chart strategy tester flag | 保持当前合同 | 不因本文改变 | 当前策略快测整体回滚 |

约束：

- 不添加更多细碎页面旗标。
- 后端打开、前端关闭是安全但不可见状态。
- 前端打开、后端关闭必须显示明确不可用，不重试风暴。
- LOCAL_OFFLINE 不依赖 LIVE 资料库旗标。
- 默认值变化只能在 Phase 12 release commit 中发生。

---

## 14. 立即停止实施的条件

出现以下任一情况必须停止进入下一 Phase：

1. 导入数据触发任何交易所、在线指标或 symbol catalog 请求。
2. LOCAL_OFFLINE 能访问 live/replay/plugin/stream API。
3. remote/LAN Origin 能通过 Vite proxy 访问本地资料库。
4. revision 切换后旧成交标记仍显示在新图上。
5. Run 接受前端伪造的 snapshot hash。
6. 统一页面需要同时启动 LocalApp 和 BacktestApp runtime。
7. 旧 .csproject、事件、绘图、指标或脚本草稿被删除。
8. 为了合并产品而直接 merge codex/local-offline-mode。
9. 全量测试有失败却被 scoped test 掩盖。
10. 文档声称 Pine/Pyne/插件在 LOCAL_OFFLINE 可用，但 capability 和运行证据不存在。

---

## 15. Definition of Done

### 15.1 产品

- [ ] 用户只看到一个“策略”一级入口。
- [ ] 当前图表和导入数据是同一产品中的两个来源。
- [ ] 用户可以导入后只看图，不必运行策略。
- [ ] 普通路径只有脚本、数据、运行和结果。
- [ ] 高级研究按任务进入，不要求重新配置。
- [ ] /strategy.html 是 canonical URL。
- [ ] /local.html 与 /backtest.html 兼容。

### 15.2 数据

- [ ] 两条来源都冻结成 dataset_id + data_epoch + snapshot_hash。
- [ ] 本地数据不联网、不插值、不静默换 revision。
- [ ] 质量、coverage、gap 和 revision 可审计。
- [ ] 图表、指标、绘图、事件和 Run 使用同一数据身份。
- [ ] revision 变化立即 stale。

### 15.3 后端

- [ ] LocalDataRuntime 是唯一写入 owner。
- [ ] BacktestRuntime 使用注入的数据服务。
- [ ] LIVE 本地资料库有真实的本机访问边界。
- [ ] LOCAL_OFFLINE network guard 和 API allowlist 继续生效。
- [ ] 失败启动和 shutdown 无泄漏。

### 15.4 前端

- [ ] LocalApp/BacktestApp 不再各自维护业务编排。
- [ ] 当前 chart-first 快测无回归。
- [ ] StrategyResearchApp source-neutral。
- [ ] legacy URL 只做 bootstrap。
- [ ] flag=0 不增加首屏负担。
- [ ] 多图 cell 状态隔离。

### 15.5 可信度

- [ ] BAR 数据只声明 BAR_APPROX。
- [ ] 解释来自决定时结构化证据。
- [ ] 不可比较 Run 不给方向性结论。
- [ ] 用户能查看数据版本、质量和执行精度。
- [ ] 报告不把回测结果描述成真实胜率保证。

### 15.6 发布

- [ ] scoped tests 通过。
- [ ] full backend/frontend tests 通过。
- [ ] browser acceptance 通过。
- [ ] security matrix 通过。
- [ ] LOCAL_OFFLINE 零外网证据通过。
- [ ] 60 分钟 mixed soak 通过。
- [ ] 双旗标 rollback drill 通过。
- [ ] release manifest 绑定候选 SHA 和证据 hash。
- [ ] 旧分支只在用户授权后归档。

---

## 16. 推荐实际开工顺序

建议按以下批次执行：

### 批次 A：合同与安全底座

1. Phase 0：ADR 与基线
2. Phase 1：数据来源合同
3. Phase 2：LocalApp 组件提取
4. Phase 3：唯一 runtime owner
5. Phase 4：LIVE 本机访问边界

完成批次 A 后，产品界面还可以保持原样，但后端和组件已经具备安全整合条件。

### 批次 B：统一产品体验

6. Phase 5：数据抽屉
7. Phase 6：StrategyResearchApp
8. Phase 7：本地图表等价
9. Phase 8：统一 FrozenResearchContext 和 Run

完成批次 B 后，用户已经可以在“策略”产品中导入、查看并运行本地数据。

### 批次 C：离线、导航和收口

10. Phase 9：LOCAL_OFFLINE 同壳
11. Phase 10：高级研究导航统一
12. Phase 11：移除重复编排
13. Phase 12：发布与旧分支收口

不得从 Phase 0 直接跳到 Phase 6。这样做会在没有唯一 runtime owner 和本机访问边界时，把资料库管理面暴露给 LIVE 页面。

---

## 17. 与现有文档的关系

本文不替代以下文档：

- docs/BACKTEST_SYSTEM_EXECUTION_zh.md：回测内核、精度、Provider、Run/Study 和发布总合同。
- docs/BACKTEST_CHART_FIRST_UX_EXECUTION_zh.md：当前图表普通快测与高级研究双层体验。
- docs/local-offline-mode.md：本地数据格式、导入、质量、revision、项目包和离线边界。
- docs/adr/ADR-BACKTEST-013-CHART-FIRST-STRATEGY-TESTER.md：chart-first 决策。
- docs/adr/ADR-BACKTEST-004-local-data-foundation.md：禁止整枝合并旧本地分支。

本文新增的唯一决策是：

> 把本地资料库纳入同一个“策略研究”产品，同时保留 local_data 数据领域、Backtest 执行领域和 LOCAL_OFFLINE 技术边界。

现有文档与本文冲突时：

1. 数据格式和不可变身份以 local_data/Backtest 已实现合同为准。
2. 当前图表快测以 ADR-BACKTEST-013 为准。
3. 产品导航和本地资料库整合顺序以本文为准。
4. 任何扩大网络、插件或执行权限的解释均无效，必须另写 ADR。
