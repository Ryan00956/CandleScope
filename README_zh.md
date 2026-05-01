# CandleScope

[![English](https://img.shields.io/badge/Language-English-blue)](README.md) [![简体中文](https://img.shields.io/badge/语言-简体中文-red)](#)

基于 FastAPI + React + Lightweight Charts 构建的轻量级交易看盘软件。当前已支持 Binance 与 OKX、现货与永续市场、多层级数据引擎、Pine Script 风格指标脚本语言，以及支持绘图工具和多窗格的全交互式图表前端。

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10+-blue?logo=python" />
  <img src="https://img.shields.io/badge/Node.js-20+-green?logo=node.js" />
  <img src="https://img.shields.io/badge/React-18+-61DAFB?logo=react" />
  <img src="https://img.shields.io/badge/FastAPI-009688?logo=fastapi" />
  <img src="https://img.shields.io/badge/License-GPL--3.0-orange" />
</p>

---

## 目录

- [快速开始](#-快速开始)
- [最近更新](#-最近更新)
- [当前特性](#当前特性)
- [核心能力](#-核心能力)
- [指标引擎](#-指标引擎)
- [Pyne — Pine风格脚本语言](#-pyne--pine风格脚本语言)
- [前端特性](#-前端特性)
- [项目结构与引擎模块](#-项目结构与引擎模块)
- [API 文档](#-api-文档)
- [说明](#-说明)
- [鸣谢](#鸣谢)

---

## 🚀 快速开始

### 环境要求

- Python 3.10+
- Node.js 20+
- npm 10+

### Windows

启动后端：

```powershell
cd backend
py -m pip install -r requirements.txt
py -m uvicorn app.main:app --reload
```

启动前端：

```powershell
cd frontend
npm install
npm run dev
```

### Linux / WSL

启动后端：

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

启动前端：

```bash
cd frontend
npm install
npm run dev
```

默认地址：
- **API 地址**: `http://localhost:8000`
- **Swagger 文档**: `http://localhost:8000/docs`
- **前端界面**: `http://localhost:5173`

> **提示：** Debian/Ubuntu 上如需 venv 支持，请先执行 `sudo apt-get install -y python3-pip python3-venv`。如果无法连接币安（网络/代理），程序会自动回退到 Mock 数据模式。

---

## ✨ 最近更新

从上次 README 更新到现在，项目已经补进了这些核心能力：

- **多交易所架构完成**：后端围绕交易所注册表与适配器重构，当前已接入 Binance 和 OKX，并暴露交易所能力与交易对元数据接口。
- **现货 / 合约统一支持**：请求、流推送、存储、符号规范化都带上了 `exchange` 与 `market_type` 维度，同一套前端流程即可覆盖现货和永续。
- **数据引擎统一收口**：正式 K 线、实时 K 线、价格快照、订阅状态和 settings 维护操作都通过 `DataManager`，旧 `services/collectors` 不再作为正式路径。
- **缺口修复链路明显增强**：新增回填规划、缺口探测、结果回灌、存储修复与 gap scan/fill，K 线断档防御比之前完整很多。
- **自选列表与订阅分级**：侧边栏支持持久化自选、拖拽整理、价格闪烁提示，后端支持 `full` / `price` / `none` 三档订阅策略。
- **画图工具扩充**：现在除了自由画笔、直线和文字，还支持斐波那契回撤、多空仓位工具，以及线段 / 射线 / 直线变体。
- **交易对搜索与元数据刷新**：搜索 UI 与符号接口都已升级为交易所感知模式，并可手动刷新交易所交易对缓存。
- **内置指标增加**：新增 `VOL` 成交量柱状图，内置指标由原先 6 个扩展到 7 个。
- **设置页具备运维能力**：支持代理测试、交易对元数据刷新、自定义周期存储修复、历史缺口扫描与补齐。

---

## 当前特性

- **极速周期切换** — 采用 Cache-First 策略。在 1m、1h、1d 等周期切换时，只要本地 SQLite 有缓存，即刻实现秒级渲染。
- **非阻塞异步架构** — 所有重型 I/O 操作（币安 API 请求）均被推送到后台线程池执行，确保 WebSocket 情报流和界面响应零延迟。
- **智能预取机制** — 前端自动"感知"用户需求并预热相邻周期（例如：当前查看 1h，后台会自动异步静默预读 15m 和 4h 的数据）。
- **并行数据补全** — 采用 `ThreadPoolExecutor` 实现历史回填 (Backfill) 与实时刷新 (Refresh) 的并行处理，数据加载效率加倍。
- **多交易所 K 线同步** — 通过统一适配器层对接 Binance 与 OKX，按交易所差异处理符号规范、能力描述、REST 与 WebSocket 接入。
- **现货 / 合约双市场支持** — 后端与前端都以 `exchange + market_type + symbol` 为主键组织数据，现货与永续可共存。
- **动态合成周期** — 除原生时间周期外，还支持自由定义合成任意非标周期（如 45m、91m 等），在内存中实时基于底层的细粒度数据聚合拼装。
- **完整指标引擎** — 内置 7 大核心指标（MA、EMA、MACD、RSI、BOLL、ATR、VOL），全部 O(1) 增量计算，另配脚本沙盒支持自定义指标。
- **Pyne 脚本语言** — 受 Pine Script 启发的 Python 库，提供 `ta.*`、`input.*`、`plot()` 等 API，让指标开发如写脚本般简单。
- **交互式绘图工具** — 自由画笔、线段 / 射线 / 直线、文字标注、斐波那契回撤、多空仓位工具都可直接在图表画布上操作，并支持持久化存储。
- **多窗格图表布局** — 价格主图、成交量面板、振荡器副图，窗格间支持拖拽调整大小。
- **自选与价格跟踪** — 持久化自选列表、价格快照 / 实时推送、订阅分级与价格跳动高亮都已接入。
- **数据维护工具** — 设置页内置代理测试、交易对元数据刷新、自定义周期修复与历史缺口扫描 / 补齐。
- **统一价格策略** — 采用共享价格曲线算法，彻底解决 Mock 模式下不同周期价格不一致的问题，保证同一时刻各个图表的现价完全一致。
- **抗崩溃能力** — 内置 **ErrorBoundary** 错误拦截与数据按时间强行去重逻辑，杜绝因交易所脏数据或网络错乱导致的"白屏"现象。

---

## 🛠️ 核心能力

### 1. 混合性能加载 (Two-Phase Loading)
CandleScope 采用两阶段加载方案：
- **阶段 1 (即时)**: 立即返回 SQLite 中的本地缓存 (~5ms)，让用户先看到数据。
- **阶段 2 (后台)**: 静默启动多线程任务，对历史时间段的缺口或最近空缺的 K 线进行智能切割与并行回填。

### 2. 并发 I/O 调度
后端通过 `asyncio.to_thread` 将同步阻塞的 API 请求彻底隔离到独立线程，绝不卡死 FastAPI 的主事件循环，确保看盘过程中价格的毫秒级跳动始终丝滑，互不干涉。

### 3. 智能预取与中断逻辑
前端时刻追踪用户的导航操作。快速切换周期时，通过 `AbortController` 原生切断无用连接，减轻服务端压力；成功加载后自动在后台"预热"相邻周期。

### 4. 稳定性保障
- **极微秒级跳动**: 即使是在查看周线级别时，全局依然监听着 1 分钟级的价格跳动流，未收盘的当期 K 线照样实时反馈市场的微弱呼吸。
- **网络波动熔断**: 当用户切换速度超过网络负担时，前端自动熔断无效连接。
- **确定性模拟**: Mock 数据生成器采用共享分钟级随机游走，确保所有周期图表的"当前价格"完全一致。

---

## 📊 指标引擎

CandleScope 内置了完整的**增量指标计算引擎**，同时支持内置指标和用户自定义脚本。

### 内置指标

| 指标 | 分类 | 输出 | 面板 |
|------|------|------|------|
| **MA** — 简单移动平均线 | 趋势 | `ma` | 主图 |
| **EMA** — 指数移动平均线 | 趋势 | `ema` | 主图 |
| **MACD** — 指数平滑异同移动平均线 | 趋势 | `dif`, `dea`, `hist` | 副图 |
| **RSI** — 相对强弱指数 | 振荡器 | `rsi` | 副图 |
| **BOLL** — 布林带 | 波动率 | `upper`, `middle`, `lower` | 主图 |
| **ATR** — 平均真实波幅 | 波动率 | `atr` | 副图 |
| **VOL** — 成交量柱状图 | 成交量 | `vol` | 成交量窗格 |

### 核心设计

- **O(1) 增量更新** — 所有指标维护滚动状态，每根新 K 线只需常数时间处理，无需重复遍历。
- **两阶段更新** — `update_partial(bar)` 计算预览值但绝不修改内部状态；`update_closed(bar)` 在收盘时推进状态。
- **实例缓存** — 相同参数的同一指标在所有消费者间共享单一实例，杜绝重复计算。
- **脚本模式** — 使用 NumPy 数组快速编写 Python 代码片段，无需注册，非常适合快速原型验证。
- **高度可扩展** — 通过继承 `Indicator` 基类添加新指标，文档中包含完整的 KDJ 手把手教程。

📖 **完整文档：** [指标开发指南](backend/app/indicator/README_zh.md)

---

## 🎨 Pyne — Pine风格脚本语言

**Pyne** 将 TradingView 的 Pine Script 的简单性带到了 Python 中。使用熟悉的 `ta.*`、`input.*`、`plot()` API 编写指标，同时保留 Python 的全部功能。

```python
# 无需导入 — 所有内容均已预先注入
length = input.int(20, "Period", minval=1)
src    = input.source(close, "Source")

upper, mid, lower = ta.bb(src, length, 2.0)
rsi = ta.rsi(close, 14)

p1 = plot(upper, "Upper", color=color.red)
plot(mid, "Mid", color=color.orange)
p2 = plot(lower, "Lower", color=color.green)
fill(p1, p2, color="rgba(59,130,246,0.05)")

marker(rsi > 70, shape="triangle_down", color=color.red, text="超买")
marker(rsi < 30, shape="triangle_up", color=color.green, text="超卖")
```

### 可用模块

| 模块 | 描述 |
|------|------|
| `ta.*` | 30+ 技术分析函数 — SMA、EMA、RSI、MACD、布林带、ATR、随机指标、ADX、超级趋势、肯特纳通道、唐奇安通道等 |
| `input.*` | 参数声明 — `int`、`float`、`bool`、`source`、`color`、`string`，支持范围校验 |
| `plot()`、`bar()`、`hline()`、`fill()`、`marker()`、`bgcolor()`、`barcolor()` | 丰富的绘图函数 — 折线、柱状图、填充、标记、背景色和K线着色 |
| `color.*` | 颜色常量与 `color.new()` 透明度辅助函数 |
| `math.*` | 支持数组的数学函数扩展 |
| 实用工具 | `crossover`（金叉）、`crossunder`（死叉）、`highest`、`lowest`、`change`、`pivothigh`、`pivotlow`、`barssince`、`valuewhen` 等 |

📖 **完整文档：** [Pyne 库参考](backend/app/indicator/pyne/README_zh.md)

---

## 🖥️ 前端特性

React 前端基于 **Lightweight Charts v5** 深度定制：

- **多窗格图表** — 价格主图、成交量面板、振荡器副图，窗格间支持拖拽调整大小。
- **绘图工具栏** — 自由画笔、线段 / 射线 / 直线、斐波那契回撤、多空仓位与文字标注，绘图数据持久化存储不丢失。
- **指标编辑器** — 功能完备的代码编辑器，支持 Pyne 语法高亮，所写即所见。
- **指标面板** — 浏览并添加内置指标，或编写自定义脚本实时预览效果。
- **自选侧边栏** — 支持多列表管理、拖拽排序、价格闪烁和每个标的的订阅等级控制。
- **设置面板** — 配置图表外观、代理与数据源参数，并直接执行存储维护动作。
- **无限滚动历史** — 向左拖拽时按需无缝加载历史数据，由回填引擎自动驱动数据生长。
- **实时 WebSocket 推送** — 多路复用的多周期实时 K 线流，一条连接承载所有周期。

---

## 📂 项目结构与引擎模块

```
CandleScope/
├── README.md / README_zh.md              # 项目文档（英/中）
├── API.md / API_zh.md                    # REST & WebSocket API 参考（英/中）
├── LICENSE                               # GNU GPL-3.0
│
├── backend/                              # FastAPI 后端与数据引擎
│   ├── requirements.txt
│   └── app/
│       ├── main.py                       # 应用入口
│       ├── api/v1/                       # REST & WebSocket 端点
│       │   ├── klines.py                 #   K 线数据接口
│       │   ├── indicators.py             #   指标计算/CRUD 接口
│       │   ├── stream.py                 #   WebSocket 实时流
│       │   └── settings.py               #   用户设置
│       ├── core/                         # 配置与市场定义
│       ├── realtime/                     # WebSocket 流推送中枢
│       ├── data_engine/                  # 📦 多层级数据引擎
│       │   ├── runtime.py                #   DataEngineRuntime 组合根
│       │   ├── interval_policy.py        #   周期解析与桶边界权威入口
│       │   ├── data_manager/             #   数据总闸门（缓存 + 查询 + 事件 + 维护）
│       │   ├── ingestion/                #   6层实时市场数据接入管道
│       │   ├── bar_aggregator/           #   标准/自定义周期聚合器
│       │   ├── backfill/                 #   历史缺口检测与修复 pipeline
│       │   └── storage/                  #   SQLite 持久化层
│       └── indicator/                    # 📦 指标计算引擎
│           ├── base.py                   #   指标抽象基类
│           ├── engine.py                 #   调度、缓存与生命周期
│           ├── registry.py               #   全局指标注册中心
│           ├── dependency.py             #   指标链式组合支持
│           ├── indicators/               #   内置实现（MA、EMA、MACD、RSI、BOLL、ATR）
│           └── pyne/                     #   Pine Script 风格 Python 库
│               ├── ta.py                 #     技术分析函数
│               ├── input.py              #     参数声明
│               ├── plot.py               #     绘图函数
│               ├── color.py              #     颜色常量
│               └── runtime.py            #     脚本执行引擎
│
└── frontend/                             # React + Vite 前端
    └── src/
        ├── App.jsx                       # 应用主框架
        ├── components/
        │   ├── ChartPane.jsx             #   单个图表窗格
        │   ├── ChartWidget.jsx           #   Lightweight Charts 封装
        │   ├── MultiPaneChart.jsx         #   多窗格布局管理器
        │   ├── PaneResizer.jsx           #   可拖拽窗格分隔条
        │   ├── DrawingToolbar.jsx        #   绘图工具栏
        │   ├── IndicatorEditor.jsx       #   指标脚本代码编辑器
        │   ├── IndicatorPanel.jsx        #   指标浏览与配置面板
        │   ├── SettingsModal.jsx         #   设置对话框
        │   └── primitives/              #   自定义图表绘图原语
        ├── hooks/                        # React Hooks（useDrawing、useIndicators）
        ├── services/                     # API 客户端与存储工具
        └── editor/                       # Pyne 语法高亮支持
```

### 数据引擎子模块文档

| 模块 | 说明 | 文档 |
|------|------|------|
| **Data Manager（数据管理器）** | 后端数据唯一入口，统筹 cache/storage/query/event/backfill/price/subscription/maintenance | [EN](backend/app/data_engine/data_manager/README.md) · [中文](backend/app/data_engine/data_manager/README_zh.md) |
| **Ingestion Layer（接入管道）** | 面向交易所适配器的实时 6 层行情接入、清洗、gap marker 与受控分发管道 | [EN](backend/app/data_engine/ingestion/README.md) · [中文](backend/app/data_engine/ingestion/README_zh.md) |
| **Bar Aggregator（K线聚合器）** | 标准/自定义周期状态机，提供 seed/replay/batch public API 给 DataManager 与 Backfill 使用 | [EN](backend/app/data_engine/bar_aggregator/README.md) · [中文](backend/app/data_engine/bar_aggregator/README_zh.md) |
| **Backfill Engine（回填引擎）** | 纯历史修复 pipeline，负责 detect/plan/fetch/reconcile/report，调度与回灌由 BackfillCoordinator 负责 | [EN](backend/app/data_engine/backfill/README.md) · [中文](backend/app/data_engine/backfill/README_zh.md) |

### 指标子模块文档

| 模块 | 说明 | 文档 |
|------|------|------|
| **Indicator Engine（指标引擎）** | O(1) 增量计算引擎，含 6 大内置指标和高度可扩展的架构 | [EN](backend/app/indicator/README.md) · [中文](backend/app/indicator/README_zh.md) |
| **Pyne Library（Pyne 库）** | 受 Pine Script 启发的 Python 库，让指标开发像写脚本一样简单 | [EN](backend/app/indicator/pyne/README.md) · [中文](backend/app/indicator/pyne/README_zh.md) |

---

## 📡 API 文档

完整的 REST 与 WebSocket API 参考文档已独立成篇：

- 📖 [**API Reference (English)**](API.md)
- 📖 [**API 文档 (中文)**](API_zh.md)

**核心端点一览：**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/klines` | GET | 获取 K 线数据（缓存优先） |
| `/api/v1/klines/history/before` | GET | 分页回溯历史数据 |
| `/api/v1/stream/klines_multi` | WebSocket | 多路复用实时 K 线流 |
| `/api/v1/subscriptions/prices` | GET | 从 DataManager price cache 获取价格快照 |
| `/api/v1/stream/prices` | WebSocket | 订阅 DataManager `PRICE_UPDATED` 价格事件 |
| `/api/v1/indicators/compute` | POST | 执行指标计算 |
| `/api/v1/indicators/registry` | GET | 列出所有可用指标 |
| `/api/v1/exchanges` | GET | 列出交易所能力信息 |
| `/api/v1/symbols/exchange-info` | GET | 查询交易所感知的交易对元数据 |
| `/api/v1/subscriptions` | GET/PUT/POST | 管理自选驱动的订阅等级 |

---

## 📝 说明

- 建议配置合适的网络代理以获取稳定的交易所实时行情连接。如果无法连接，程序会自动回退到 Mock 数据。
- 本地数据库文件夹与缓存文件 (`.db`, `.pyc` 等) 已被 `.gitignore` 清爽排除，初次运行会自动在本地建库。
- 指标脚本沙盒在隔离线程中执行用户代码，确保安全性。
- 本仓库许可证为 **GNU GPL-3.0**，完整文本见 `LICENSE`。

---

## 鸣谢

本项目基于多个优秀的开源库构建，在此向这些项目的原作者和维护者表示感谢：

*   **[Lightweight Charts™](https://github.com/tradingview/lightweight-charts)** by [TradingView](https://www.tradingview.com/)
    *   Licensed under the [Apache License, Version 2.0](https://github.com/tradingview/lightweight-charts/blob/master/LICENSE)
    *   *用于渲染高性能的金融图表和 K 线数据。*
