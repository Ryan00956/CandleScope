# CandleScope

[![English](https://img.shields.io/badge/Language-English-blue)](README.md) [![简体中文](https://img.shields.io/badge/语言-简体中文-red)](#)

基于 FastAPI + React + Lightweight Charts 构建的轻量级交易看盘软件。

## 当前特性
- **极速周期切换**: 采用 Cache-First 策略。在 1m、1h、1d 等周期切换时，只要本地 SQLite 有缓存，即刻实现秒级渲染。
- **非阻塞异步架构**: 所有重型 I/O 操作（币安 API 请求）均被推送到后台线程池执行，确保 WebSocket 情报流和界面响应零延迟。
- **智能预取机制**: 前端自动“感知”用户需求并预热相邻周期（例如：当前查看 1h，后台会自动异步静默预读 15m 和 4h 的数据）。
- **并行数据补全**: 采用 `ThreadPoolExecutor` 实现历史回填 (Backfill) 与实时刷新 (Refresh) 的并行处理，数据加载效率加倍。
- **双模实时行情**: 优先 WebSocket 连接，支持自动感知断线并无缝向下回退至 HTTP 轮询模式。
- **动态合成周期**: 支持原生的时间周期外，还支持自由定义合成任意非标周期（如 45m、91m 等），在内存中实时基于底层的细粒度数据聚合拼装。
- **统一价格策略**: 采用共享价格曲线算法，彻底解决 Mock 模式下不同周期价格不一致的问题，保证同一时刻各个图表的现价完全一致。
- **抗崩溃能力**: 内置 **ErrorBoundary** 错误拦截与数据按时间强行去重逻辑，杜绝因交易所脏数据或网络错乱导致的“白屏”现象。

## 🚀 快速开始

### 1. 启动后端 (Backend)

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload
```

- **API 地址**: `http://localhost:8000`
- **Swagger 文档**: `http://localhost:8000/docs`

### 2. 启动前端 (Frontend)

```bash
cd frontend
npm install
npm run dev
```

- **前端界面**: `http://localhost:5173`

## 🛠️ 核心能力

### 1. 混合性能加载 (Two-Phase Loading)
CandleScope 采用两阶段加载方案：
- **阶段 1 (即时)**: 立即返回 SQLite 中的本地缓存 (~5ms)，让用户先看到数据。
- **阶段 2 (后台)**: 静默启动多线程任务，对历史时间段的缺口或最近空缺的 K 线进行智能切割与并行回填。

### 2. 并发 I/O 调度
后端通过 `asyncio.to_thread` 将同步阻塞的 API 请求彻底隔离到独立线程，绝不卡死 FastAPI 的主事件循环，确保看盘过程中价格的毫秒级跳动始终丝滑，互不干涉。

### 3. 海量无缝历史滚轮
即使请求长达数年的 1m 数据线，依靠底层的 GapDetector 智能缺口雷达与分段回填（Backfill）技术，系统会仅抓取本地 SQLite 残缺的部分缝补。当你在前端向左拖拽滚轮时，历史数据会无缝“生长”出来。

### 4. 稳定性监控
- **极微秒级跳动**: 即使是在查看周线级别时，全局依然监听着 1 分钟级的价格跳动流，未收盘的当期 K 线照样实时反馈市场的微弱呼吸。
- **网络波动熔断**: 当用户切换速度超过网络负担时，前端通过 `AbortController` 原生切断无用连接，减轻服务端压力。

## 📂 项目结构与引擎模块

- `backend/`: FastAPI 后端与高并发多线程数据引擎。
- `frontend/`: React 前端，包含了深度定制化以及支持插件化绘图的 Lightweight Charts v5。

本系统极其庞大且复杂的 **Data Engine (数据引擎)** 已经被彻底解耦并拆分为多个具有单一职责的精锐模块，更多架构细节与运行机理详情，请查阅各个子系统独立文档：

- 📖 [**Data Manager (数据资源管理器)**](backend/app/data_engine/data_manager/README.md) - 数据出入口的总闸门，负责三级查询流控、多级缓存统筹，与前端直接握手。
- 📖 [**Ingestion Layer (接入数据流管道)**](backend/app/data_engine/ingestion/README.md) - 连接币安服务器的实时 6 层网关清洗与消息重打包引擎。
- 📖 [**Bar Aggregator (K线状态聚合机)**](backend/app/data_engine/bar_aggregator/README.md) - 极其聪明的内存“反应堆”，可合成全平台任意定制周期的时间线状态机。
- 📖 [**Backfill Engine (后台回填挖掘引擎)**](backend/app/data_engine/backfill/README.md) - 拥有缺口感知雷达（Gap Detector）与任务拆分能力的智能多线程后台调度矿工。

## 📝 说明
- 建议配置合适的网络代理以获取稳定的币安实时行情 WebSocket 连接。
- 本地数据库文件夹与缓存文件 (`.db`, `.pyc` 等) 已被 `.gitignore` 清爽排除，初次运行会自动在本地建库。
