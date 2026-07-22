# CandleScope

[English](README.md)

CandleScope 是基于 FastAPI、React、Vite 和 Lightweight Charts 构建的轻量级交易看盘软件。当前支持 Binance 与 OKX 行情、现货与永续市场、多模块 Data Engine、交易所感知的交易对元数据、实时 WebSocket、内置指标，以及通过 Pyne 提供的 Pine 风格 Python 指标脚本。

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.11+-blue?logo=python" />
  <img src="https://img.shields.io/badge/Node.js-20+-green?logo=node.js" />
  <img src="https://img.shields.io/badge/React-19+-61DAFB?logo=react" />
  <img src="https://img.shields.io/badge/FastAPI-009688?logo=fastapi" />
  <img src="https://img.shields.io/badge/License-GPL--3.0-orange" />
</p>

## 目录

- [快速开始](#快速开始)
- [项目能力](#项目能力)
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

- Python 3.11+
- Node.js 20+
- npm 10+

启动后端：

```bash
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 18080
```

Windows 下也可以直接用脚本：

```powershell
cd backend
.\dev-server.ps1
```

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
- 设置页运维能力：proxy 测试、交易对元数据刷新、storage repair、gap scan、retention limits。

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
| `frontend/src/App.jsx` | runtime hooks 和 UI surface 的组合根 |
| `frontend/src/components/MultiPaneChart.jsx` | 多窗格图表布局 |
| `frontend/src/components/ChartWidget.jsx` | Lightweight Charts 封装 |
| `frontend/src/components/DrawingToolbar.jsx` | 绘图工具控制 |
| `frontend/src/components/IndicatorPanel.jsx` | 懒加载的指标浏览和配置 |
| `frontend/src/components/IndicatorEditor.jsx` | 通过指标工作流加载的 Pyne/自定义指标编辑器 |
| `frontend/src/components/SymbolSearch*.jsx` | 交易所感知 symbol search |
| `frontend/src/components/WatchlistSidebar.jsx` | 自选列表和价格跟踪 |
| `frontend/src/components/SettingsModal.jsx` | 懒加载的 proxy、数据、图表和维护设置 |
| `frontend/src/runtime` | 按 chart、streams、exchange、preferences、workflows 分组的 runtime 编排层 |
| `frontend/src/services/apiConfig.js` | API base 和 HTTP 到 WebSocket URL 配置 |
| `frontend/src/services/api.js` | 主要后端 API client |
| `frontend/src/services/indicatorApi.js` | 指标 API client |
| `frontend/src/hooks/useIndicators.js` | 指标 HTTP/WS 集成 |
| `frontend/src/hooks/useDrawing.js` | 绘图状态 |

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

独立演进的通用 Plugin Platform v2 已完成 SDK、业务无关 Host、Bundle/Installer，以及
权限与 Windows OS 沙箱四个基础阶段。显式 `candlescope-plugin v2` 命令现支持独立 Grant
Store、permission diff、grant/deny/revoke、scope、哈希链审计和安全 staging；Host 通过代际
opaque capability、速率/消息配额与 AppContainer/Job Object/ACL 隔离受控 sidecar。真实恶意
探针已证明用户文件、direct network、fork、内存、CPU、磁盘和 stderr 边界。当前 v2 registry
和受保护 management router 仍未接入产品默认启动，publisher identity 也尚未签名，因此默认
路径继续只用于 first-party-pinned/local-trusted 插件，不开放 Marketplace。执行记录见
[`PLUGIN_PLATFORM_V2_PHASE4_zh.md`](docs/PLUGIN_PLATFORM_V2_PHASE4_zh.md)。

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
│   │   │   └── pyne/
│   │   └── plugin_runtime/
│   └── tests/
├── packages/
│   ├── candlescope-plugin-pyne/
│   ├── candlescope-plugin-sdk/
│   └── pyne-runtime/
└── frontend/
    ├── package.json
    └── src/
        ├── components/
        ├── hooks/
        ├── services/
        ├── editor/
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
