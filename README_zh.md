# CandleScope

[English](README.md)

CandleScope 是基于 FastAPI、React、Vite 和 Lightweight Charts 构建的本地优先交易看盘软件。当前支持 Binance 与 OKX 行情、现货与永续市场、多图表工作区、实时警报、确定性回放训练、多模块 Data Engine、交易所感知的交易对元数据、实时 WebSocket、内置指标，以及通过 Pyne 提供的 Pine 风格 Python 指标脚本。

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.12-blue?logo=python" />
  <img src="https://img.shields.io/badge/Node.js-20+-green?logo=node.js" />
  <img src="https://img.shields.io/badge/React-19+-61DAFB?logo=react" />
  <img src="https://img.shields.io/badge/FastAPI-009688?logo=fastapi" />
  <img src="https://img.shields.io/badge/License-GPL--3.0-orange" />
</p>

## 目录

- [快速开始](#快速开始)
- [项目能力](#项目能力)
- [多图表工作区](#多图表工作区)
- [警报](#警报)
- [回放训练](#回放训练)
- [架构](#架构)
- [Backfill 智能调度摘要](#backfill-智能调度摘要)
- [后端](#后端)
- [前端](#前端)
- [指标和 Pyne](#指标和-pyne)
- [Plugin SDK（开发者预览）](#plugin-sdk开发者预览)
- [API 文档](#api-文档)
- [项目结构](#项目结构)
- [开发检查](#开发检查)
- [说明](#说明)
- [鸣谢](#鸣谢)

## 快速开始

环境要求：

- Windows CPython 3.12（首方 Pyne/Pine 插件包的固定运行平台）
- Node.js 20+
- npm 10+

启动后端：

```bash
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 18080
```

Windows 下也可以直接用脚本：

```powershell
cd backend
.\dev-server.ps1
```

Windows 启动入口默认不启用 Uvicorn 热重载，因为 Selector event loop
无法启动 CandleScope 所需的 Pyne/Pine sidecar 子进程。

启动前端：

```bash
cd frontend
npm install
npm run dev
```

本地开发时，前端默认使用同源 `/api/v1`；Vite 会把 HTTP 和 WebSocket 请求代理到
`http://127.0.0.1:18080`。Vite 默认把前端服务跑在
`http://127.0.0.1:15173`。

默认地址：

| 服务 | URL |
|---|---|
| 前端 | `http://127.0.0.1:15173` |
| 后端 | `http://127.0.0.1:18080` |
| Swagger / OpenAPI | `http://127.0.0.1:18080/docs` |
| 健康检查 | `http://127.0.0.1:18080/health` |

Linux/WSL 可先创建虚拟环境：

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

## 项目能力

CandleScope 是本地优先的行情图表应用，当前包括：

- Binance 与 OKX 的交易所感知 K 线数据。
- 通过 `exchange` 和 `market_type` 区分现货与衍生品市场。
- 基于 SQLite 的 cache-first 历史查询。
- 单周期和多周期实时 K 线 WebSocket。
- 通过独立 backfill pipeline 进行后台缺口检测和修复。
- 自选列表三档订阅：不订阅、仅价格、完全订阅；包含实时价格快照，以及 full 档后台 K 线 warm cache。
- 内置指标：`MA`、`EMA`、`MACD`、`RSI`、`BOLL`、`ATR`、`VOL`。
- Pyne：Pine 风格 Python 自定义指标 runtime。
- 交互式绘图工具：线段/射线/直线、自由画笔、文字、斐波那契回撤、多空仓位工具。
- 价格、成交量、震荡指标的多窗格图表布局。
- 可持久化的多图表工作区：单图到 4 × 4、可编辑分割布局、已保存工作区；桌面壳可用时最多四个窗口。
- 分层图表联动组：可按范围同步市场、周期、十字线、时间范围、指标与绘图。
- 本地价格和指标警报：应用内、浏览器与声音通知；对显式白名单地址可选启用带签名、可恢复的 Webhook Outbox。
- 独立、确定性的回放训练工作台：服务端权威时钟、Run 级多市场账户和仅纸面委托模拟。
- 设置页运维能力：proxy 测试、交易对元数据刷新、storage repair、gap scan、retention limits。

## 多图表工作区

从顶部栏打开 **工作区**，即可在不挤占主图控件的情况下管理已保存布局、图表窗口和联动组。一个工作区可使用单图、分割、四图、6、8、9、12、16 图模板，也可编辑为递归分割布局。布局、各 Cell 的会话和联动组设置会保存在本地。

联动组是最大深度为四层的有向树。同组图表可共享选定的 peer 设置；子组可以选择接收父组传播，但不会反向影响父组。绘图图层仍仅在同组内共享，从而让确认图或下游分析图保持协同，且不会产生环路或意外的反向更新。

可选的桌面壳可把一个工作区分布到最多四个原生窗口。实际容量取决于硬件、显示器与 DPI、商品和周期、指标以及可用行情资源；4 × 4 是受支持的工作区模板，不代表所有机器都能稳定承载。实现边界和回滚说明见 [16×4 工作区执行记录](docs/MULTI_CHART_WORKSPACE_16X4_EXECUTION_zh.md)。

## 警报

本地价格和指标规则可通过应用内、浏览器或声音通知。浏览器通知权限由浏览器控制，警报状态和历史默认保留在本地。

Webhook 默认关闭。显式启用后，CandleScope 要求精确的目标主机白名单和高熵签名密钥；投递会写入 SQLite Outbox，对暂时性失败进行有上限重试，并采用至少一次投递语义。接收端必须验证 HMAC，并按 `X-CandleScope-Delivery` 去重。启用前请阅读 [警报投递边界](docs/ALERTS_DELIVERY_zh.md) 和 [`backend/.env.alerts.example`](backend/.env.alerts.example)。

## 回放训练

回放是独立、确定性的本地历史训练工作台。它使用服务端权威虚拟时钟和纸面账户，不会把实时页面的数据源或状态替换为回放数据。一个 TrainingRun 固定起点和账户范围后，可以加入经过权威目录验证且兼容的多个 MarketTrack，以便在多个市场上训练，而不会让每张图拥有独立的时钟或账户。

回放不是实时下单路由，也不声称拥有交易所私有队列、挂单优先级或隐藏流动性的保真度。可用数据与执行保真度会在 Run 中显式披露；缺少必需的历史数据时，对应操作会 fail closed。完整的数据和运行边界请见 [英文回放训练说明](README.md#replay-training) 与 [后端回放文档](backend/README.md#deterministic-replay-runtime)。

## 架构

当前后端数据流：

```text
Exchange WS / REST
        |
        v
ingestion
        | MarketEvent / GapMarker
        v
bar_aggregator
        | BarEvent
        v
data_manager
        | QueryResult / DataEvent / PriceSnapshot
        v
API / WebSocket / Indicator / Subscription / Settings
```

历史修复流：

```text
QueryEngine / Settings / Ingestion GapMarker
        |
        v
BackfillCoordinator
        |
        v
BackfillEngine
        |
        v
storage
        |
        v
DataManager cache + EventBus
```

## Backfill 智能调度摘要

当前历史数据修复已经接入 demand-aware backfill scheduler：

- 当前图表的 `/klines/history` 使用 `initial_history(priority=10)`，始终优先。
- `/klines/latest` 默认不触发 backfill，避免空库切换新商品时抢占首屏历史。
- 当前周期完成后，同商品其他周期以 `related_interval_warmup(priority=40)` 预热。
- `FULL` 自选商品的后台 K 线维护使用 `full_subscription_warmup(priority=60)`。
- `PRICE_ONLY` 只维护价格流和 `price_daily_open(priority=70)`，不主动补完整 K 线历史。
- `NONE` 不主动创建 K 线 backfill；只有用户打开图表才进入可见需求优先级。
- 大范围可见 backfill 会拆成 chunk，并从最新端优先执行。
- 前端只会在 `symbol / interval / range / reason` 匹配当前图表时解除首屏 loading。

更详细的后端说明见：

- [Backfill README](backend/app/data_engine/backfill/README_zh.md)
- [DataManager README](backend/app/data_engine/data_manager/README.md)
- [调度执行计划](local_docs/construction/backend/app/data_engine/backfill/SCHEDULER_EXECUTION_PLAN_zh.md)

当前正式后端路径围绕 `DataManager` 和 `DataEngineRuntime` 展开。代码树中可能仍有较早的 `data_engine/collectors`、`data_engine/services` 目录，但新功能和新文档不以它们作为主架构路径。

## 后端

后端是位于 [backend/app/main.py](backend/app/main.py) 的 FastAPI 应用。启动流程：

1. 初始化 SQLite K 线 storage。
2. best-effort 刷新交易所元数据。
3. 启动 `DataEngineRuntime`。
4. 挂载 `app.state.data_engine_runtime` 和 `app.state.data_manager`。
5. 将 `IndicatorEngine` 桥接到 DataManager events。

主要后端文档：

- [Backend README](backend/README.md)
- [Backend README 中文](backend/README_zh.md)
- [Data Engine](backend/app/data_engine/README.md)
- [Data Engine 中文](backend/app/data_engine/README_zh.md)
- [交易所插件模板](backend/app/exchanges/plugins/_template/README_zh.md)

核心后端模块：

| 模块 | 用途 |
|---|---|
| `app/api/v1` | HTTP 和 WebSocket API routers |
| `app/core` | 运行时配置、路径、proxy 持久化、market helpers |
| `app/exchanges` | 交易所 registry、adapter、plugin、symbol normalization |
| `app/data_engine/runtime.py` | Data Engine 组合根 |
| `app/data_engine/ingestion` | 实时交易所接入和标准化 |
| `app/data_engine/bar_aggregator` | K 线 bucket、merge、finalization 和事件生命周期 |
| `app/data_engine/data_manager` | query/cache/events/streams/backfill/prices/maintenance 公共门面 |
| `app/data_engine/backfill` | 历史 detect/plan/fetch/reconcile/report pipeline |
| `app/data_engine/storage` | SQLite K 线仓库和 gap ledger |
| `app/indicator` | 内置指标、sidecar runtime 路由、指标实时流 |

## 前端

前端是 React + Vite 应用，图表层使用 Lightweight Charts v5。

前端架构文档：

- [Frontend Architecture](frontend/ARCHITECTURE.md)
- [前端架构](frontend/ARCHITECTURE_zh.md)
- [Runtime Boundaries](frontend/src/runtime/README.md)

重要前端模块：

| 路径 | 用途 |
|---|---|
| `frontend/src/app/App.tsx` | 应用组合根与 live/replay 入口边界 |
| `frontend/src/app/MarketChartWorkspace.tsx` | 实时图表工作区组合 |
| `frontend/src/app/LiveChartCell.tsx` | 单个 Cell 的实时图表 runtime |
| `frontend/src/components/SingleChartPanes.tsx` | Lightweight Charts 图表窗格表面 |
| `frontend/src/components/DrawingToolbar.tsx` | 绘图工具控制 |
| `frontend/src/features/chart-workspace/WorkspacePanel.tsx` | 懒加载的工作区、布局、窗口和联动组管理 |
| `frontend/src/features/replay` | 独立回放训练工作台和纸面交易界面 |
| `frontend/src/features/alerts` | 警报规则和通知客户端模型 |
| `frontend/src/features/symbol-search` | 交易所感知 symbol search |
| `frontend/src/features/watchlist` | 自选列表、价格跟踪和订阅 runtime |
| `frontend/src/components/settings` | 懒加载的 proxy、数据、图表和维护设置 |

前端命令：

```bash
cd frontend
npm run dev
npm run build
npm run lint
npm run smoke -- --url http://127.0.0.1:15173/
npm run smoke:chart-types
npm run smoke:export
npm run smoke:release
```

`smoke:chart-types` 会逐一切换并刷新恢复全部 15 种主图类型；
`smoke:export` 会验证 PNG/JPEG/WebP、三个导出范围、绘图隐藏、水印和真实下载文件；
`smoke:release` 合并运行两套矩阵及绘图、指标覆盖。

## 指标和 Pyne

指标系统有两条执行路径：

- 由 `IndicatorEngine` 管理的内置增量指标。
- 通过后端脚本 runtime 执行的 Pyne 脚本。

内置指标：

| 指标 | 输出 | 面板 |
|---|---|---|
| `MA` | `ma` | 主图 |
| `EMA` | `ema` | 主图 |
| `MACD` | `dif`, `dea`, `hist` | 副图 |
| `RSI` | `rsi` | 副图 |
| `BOLL` | `middle`, `upper`, `lower` | 主图 |
| `ATR` | `atr` | 副图 |
| `VOL` | `volume` | 成交量 |

Pyne 提供 Pine 风格 API：

```python
length = input.int(20, "Period", minval=1)
upper, mid, lower = ta.bb(close, length, 2.0)

p1 = plot(upper, "Upper", color=color.red)
plot(mid, "Middle", color=color.orange)
p2 = plot(lower, "Lower", color=color.green)
fill(p1, p2, color="rgba(59,130,246,0.08)")
```

Pyne 支持 `safe`、`research`、`unsafe` security modes，并在由公共 sidecar
协议监督的隔离插件环境中运行。

文档：

- [Indicator Engine](backend/app/indicator/README.md)
- [Indicator Engine 中文](backend/app/indicator/README_zh.md)
- [Pyne Runtime 插件](packages/candlescope-plugin-pyne/README.md)
- [Pyne Runtime 插件中文](packages/candlescope-plugin-pyne/README_zh.md)
- [Pine Compatibility 插件](packages/candlescope-plugin-pine-compat/README.md)
- [Pine Compatibility 插件中文](packages/candlescope-plugin-pine-compat/README_zh.md)

## Plugin SDK（开发者预览）

社区 runtime 开发者可以直接使用零运行时依赖的
[`candlescope-plugin-sdk`](packages/candlescope-plugin-sdk/README_zh.md)。它冻结了
版本化的 `candlescope.script-runtime/1` JSON-RPC sidecar 契约、能力协商、类型化
OHLCV 批量输入、结构化诊断，以及第一版由 CandleScope 拥有的 line-series
Render IR；仓库同时提供可执行的 Hello Runtime 和固定 wire transcript。

Plugin platform Phase 2/3 已加入通用
[`app.plugin_runtime`](backend/app/plugin_runtime/README_zh.md) Host/Supervisor：
它可以从显式 activation registry 启动并监督外部 sidecar，并提供严格握手、超时、
消息上限、重启熔断和健康汇总。Phase 3 同时提供确定性 `.cspkg`、调用者固定的
SHA-256、每 bundle 独立 venv、离线 wheel 安装、结果探针、原子激活和逐插件回滚；
社区发布流程见
[`INSTALLER_zh.md`](backend/app/plugin_runtime/INSTALLER_zh.md)。Phase 4 已把 Indicator
HTTP、range、batch 和 WebSocket 统一接入 runtime 路由；Phase 8 缺省同时切换为
`pyne=sidecar,candlescope.pyne` 与 `pine=sidecar,candlescope.pine-compat`，任一 required
runtime 不可用都会 fail closed。Phase 7 新增
`GET /api/v1/indicators/runtimes` 描述符发现；编辑器接受任意已路由的社区 language ID，
未知语言使用 plaintext fallback，且不加载插件提供的前端代码。Phase 5 新增独立可构建的
[`candlescope-plugin-pyne`](packages/candlescope-plugin-pyne/README_zh.md)，通过发行锁固定
SDK、Pyne Runtime RC wheel 与 NumPy 版本，并已通过真实 `.cspkg` 离线安装和协议探针。
0.2.0 bridge 通过可协商的结构化 Render IR 覆盖 marker、hline、fill 等输出并通过冻结
golden。可信开发包已发布为
[`candlescope-plugin-pyne-v0.2.0-dev.1`](https://github.com/Ryan00956/CandleScope/releases/tag/candlescope-plugin-pyne-v0.2.0-dev.1)；
产品 bootstrap 固定其 URL、大小、平台和外层 SHA-256，通用社区安装器仍只接受本地
artifact。CandleScope 已删除 `packages/pyne-runtime` 和 in-process Pyne facade。完整执行记录见
[`PLUGIN_PLATFORM_V1_EXECUTION_zh.md`](docs/PLUGIN_PLATFORM_V1_EXECUTION_zh.md)。

独立演进的通用 Plugin Platform v2 已完成 Phase 1–12：在 SDK、业务无关 Host、
Bundle/Installer、权限与 Windows OS 沙箱之上，产品组合根已提供 command/settings/event/job、
私有存储、只读市场 consumer、Host-owned 图表图层、声明式与 opaque-origin sandbox UI、受控
HTTPS/文件/endpoint gateway、成对的公开 symbol/market-data provider，以及 Paper 与默认关闭的
WP-A～WP-F Live Broker 技术路径。Phase 12 新增默认关闭的 Ed25519 签名 Marketplace、不可变
artifact/index cache、SBOM/许可证绑定、透明日志、撤销、permission diff 和显式
prepare/apply/activate/健康回滚流程。

仓库默认 Marketplace roots 为空；`verified-publisher` 只证明发布来源，社区 backend 仍在 Windows
AppContainer 中按 `untrusted` 运行，权限由 Host 单独授予。`secrets.use`、社区 Live
`trade.submit`/`trade.cancel`、真实 Demo/真钱测试与 WP-G 仍未开放。最新执行记录见
[`PLUGIN_PLATFORM_V2_PHASE12_zh.md`](docs/PLUGIN_PLATFORM_V2_PHASE12_zh.md)。

Phase 8 新增独立可构建的
[`candlescope-plugin-pine-compat`](packages/candlescope-plugin-pine-compat/README_zh.md)：
它固定公开 `pine-compat-runtime` v0.2.0 Release wheel，不包含 Pine 引擎源码快照，也不
导入 CandleScope 私有模块，只声明闭合 K 线 batch 能力。开发 bundle 已发布为
[`candlescope-plugin-pine-compat-v0.2.0-dev.1`](https://github.com/Ryan00956/CandleScope/releases/tag/candlescope-plugin-pine-compat-v0.2.0-dev.1)；
realtime、strategy、`request.*`、import 和原生对象等未公开或无法忠实映射的能力继续
fail closed。

## API 文档

API 参考独立维护：

- [API Reference](API.md)
- [API 文档](API_zh.md)

重要 endpoints：

| Endpoint | 方法 | 用途 |
|---|---|---|
| `/api/v1/klines/` | `GET` | 最新 K 线数据 |
| `/api/v1/klines/history` | `GET` | 历史窗口 |
| `/api/v1/klines/range` | `GET` | 带连续性校验的精确范围查询 |
| `/api/v1/klines/history/before` | `GET` | 左滑分页历史 |
| `/api/v1/stream/klines` | WebSocket | 单周期 K 线流 |
| `/api/v1/stream/klines_multi` | WebSocket | 多周期 K 线流 |
| `/api/v1/stream/prices` | WebSocket | 实时价格流 |
| `/api/v1/stream/indicators` | WebSocket | 实时指标流 |
| `/api/v1/indicators/compute` | `POST` | 内置或 Pyne 脚本指标计算 |
| `/api/v1/subscriptions/` | `GET` | 列出自选订阅等级和 full 周期 |
| `/api/v1/settings/storage/health` | `GET` | gap/backfill 健康信息 |
| `/api/v1/exchanges/` | `GET` | 交易所能力 |
| `/api/v1/symbols/exchange-info` | `GET` | 交易对元数据搜索 |

## 项目结构

```text
CandleScope/
├── README.md / README_zh.md
├── API.md / API_zh.md
├── backend/
│   ├── README.md / README_zh.md
│   ├── requirements.txt
│   ├── app/
│   │   ├── main.py
│   │   ├── api/v1/
│   │   ├── core/
│   │   ├── exchanges/
│   │   │   └── plugins/
│   │   ├── data_engine/
│   │   │   ├── runtime.py
│   │   │   ├── interval_policy.py
│   │   │   ├── ingestion/
│   │   │   ├── bar_aggregator/
│   │   │   ├── data_manager/
│   │   │   ├── backfill/
│   │   │   └── storage/
│   │   ├── indicator/
│   │   │   ├── indicators/
│   │   │   └── runtime routing
│   │   ├── alerts/
│   │   ├── replay/
│   │   └── plugin_runtime/
│   └── tests/
├── packages/
│   ├── candlescope-plugin-pyne/
│   ├── candlescope-plugin-pyne-workbench/
│   ├── candlescope-plugin-sdk/
│   └── plugin-conformance/
└── frontend/
    ├── package.json
    └── src/
        ├── app/
        ├── components/
        ├── features/
        ├── services/
        └── utils/
```

## 开发检查

后端：

```bash
cd backend
python -m compileall app tests -q
python -m pytest -q
```

前端：

```bash
cd frontend
npm run build
npm run lint
```

渲染层 smoke 检查：启动后端和 Vite 后，运行
`npm run smoke -- --url http://127.0.0.1:15173/`。该检查会确认状态栏达到
`Connected to Binance`、显示非零 `bars`、显示 `Live (WebSocket)`，确认
drawing toolbar 已加载，并打开懒加载的 symbol search 和 Settings 面板。
主图类型或导出链路变更还应运行 `npm run smoke:release`。长时稳定性采集可分别运行
`npm run perf:soak:1h` 和 `npm run perf:soak:4h`，结果写入
`docs/perf-baselines/`。

## 说明

- 如果交易所访问需要代理，可在设置面板或 `/api/v1/settings/proxy` 配置。
- runtime proxy 设置默认持久化到 `backend/data/proxy_settings.json`。
- Windows 下如果后端启动时打印状态符号导致编码错误，可设置 `PYTHONIOENCODING=utf-8` 和 `PYTHONUTF8=1` 后再启动。
- SQLite 数据是本地文件，并已被 git 忽略。
- Pyne 脚本会按配置的 security mode 在本地隔离 sidecar 中执行。只对完全信任的脚本使用 `unsafe`。
- 本仓库使用 GNU GPL-3.0 许可证，见 [LICENSE](LICENSE)。

## 鸣谢

本项目使用了多个开源项目，包括：

- [Lightweight Charts](https://github.com/tradingview/lightweight-charts)，TradingView 出品，Apache-2.0 许可证。
- [FastAPI](https://fastapi.tiangolo.com/)
- [React](https://react.dev/)
- [Vite](https://vite.dev/)
