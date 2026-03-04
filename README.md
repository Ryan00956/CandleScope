# CandleScope

[English](#english) | [简体中文](#简体中文)

<a name="english"></a>
# CandleScope (English)

Lightweight trading chart software built with FastAPI + React + Lightweight Charts.

Current features:
- **Zero-Latency Interval Switching**: Instant cache-first rendering. Switching between 1m, 1h, or 1d is near-instant if data exists in local SQLite.
- **Non-blocking Async Architecture**: All heavy I/O operations (Binance API) are offloaded to background thread pools, keeping the WebSocket and UI perfectly responsive.
- **Intelligent Prefetching**: Frontend automatically pre-warms adjacent intervals (e.g., if you view 1h, it silently fetches 15m and 4h in the background).
- **Parallel Data Filling**: Historical backfill and real-time refresh are executed concurrently using a specialized `ThreadPoolExecutor`.
- **Binance Spot K-line Sync**: Rapid synchronization of real market data with a local SQLite cache to avoid redundant network requests.
- **Unified Mock Data**: Deterministic price levels are perfectly consistent across all intervals (1m to 1M) using a shared price curve.
- **Rendering Stability**: Built-in **ErrorBoundary** and time-based de-duplication to prevent "white screen" crashes from unstable network streams.

## Quick Start

### 1. Start backend

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Default URLs:
- API: `http://localhost:8000`
- Swagger: `http://localhost:8000/docs`

### 2. Start frontend

```bash
cd frontend
npm install
npm run dev
```

Default URL:
- Frontend: `http://localhost:5173`

## Core Capabilities

### 1. Hybrid Performance Engine

CandleScope uses a two-phase loading strategy:
- **Phase 1 (Instant)**: Return cached data from SQLite immediately (~5ms).
- **Phase 2 (Background)**: Silently trigger background threads to fill any gaps or fetch the latest bars from Binance.

### 2. Parallel & Concurrent I/O

The backend utilizes `asyncio.to_thread` and `ThreadPoolExecutor` to handle network requests. This ensures that a slow response from Binance never blocks the FastAPI event loop, allowing WebSocket updates to continue flowing smoothly.

### 3. Smart Prefetching & Abort Logic

The frontend keeps track of your navigation. Rapidly switching between intervals automatically cancels stale requests via `AbortController`, while successful loads trigger background "warming" of neighboring timeframes.

### 4. Stability & Precision

- **No White Screen**: Integrated React ErrorBoundaries and chart data sanitization ensure the UI stays up even if the underlying library hits data irregularities.
- **Deterministic Simulation**: The mock generator uses a shared minute-level random walk, ensuring the "current price" is identical across all charts.

## Project Structure

- `backend/`: FastAPI backend and multi-threaded data engine.
- `frontend/`: React frontend with customized Lightweight Charts v5.

## Notes

- If Binance cannot be reached (network/proxy), the app falls back to mock data.
- Local DB files are ignored in git via `.gitignore`.

<br/>

---

<a name="简体中文"></a>
# CandleScope (简体中文)

基于 FastAPI + React + Lightweight Charts 构建的轻量级交易看盘软件。

### 当前特性
- **极速周期切换**: 采用 Cache-First 策略。在 1m、1h、1d 等周期切换时，只要本地 SQLite 有缓存，即刻实现秒级渲染。
- **非阻塞异步架构**: 所有重型 I/O 操作（币安 API 请求）均被推送到后台线程池执行，确保 WebSocket 情报流和界面响应零延迟。
- **智能预取机制**: 前端自动“感知”用户需求并预热相邻周期（例如：当前查看 1h，后台会自动异步静默预读 15m 和 4h 的数据）。
- **并行数据补全**: 采用 `ThreadPoolExecutor` 实现历史回填 (Backfill) 与实时刷新 (Refresh) 的并行处理，数据加载效率加倍。
- **双模实时行情**: 优先 WebSocket 连接，支持 4s 自动感知并无缝切换至 HTTP 轮询。
- **统一价格模拟**: 采用共享价格曲线算法，彻底解决 Mock 模式下不同周期价格不一致的问题。
- **抗崩溃能力**: 内置 **ErrorBoundary** 错误拦截与数据去重逻辑，杜绝因数据异常导致的“白屏”现象。

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

### 1. 混合性能引擎 (Two-Phase Loading)
CandleScope 采用两阶段加载方案：
- **阶段 1 (即时)**: 立即返回 SQLite 中的本地缓存 (~5ms)，让用户先看到数据。
- **阶段 2 (后台)**: 静默启动后台任务，对数据空隙或最新 K 线进行补全。

### 2. 并行 I/O 调度
后端通过 `asyncio.to_thread` 将同步阻塞的 API 请求隔离到独立线程，避免卡死 FastAPI 事件循环，确保看盘过程中价格跳动始终丝滑。

### 3. 智能请求管理
前端引入 `AbortController` 机制，在用户快速连续切换周期时自动丢弃过时请求；同时利用闲置带宽对相邻周期进行后台预热。

### 4. 稳定性防护
- **防白屏设计**: 引入 React 错误边界和图表数据清洗逻辑（按时间戳强行去重），确保即使在网络波动的极端情况下界面依然可用。
- **高精度模拟**: 基于分钟步进的共享随机游走算法，保证同一 Symbol 在所有周期下的“当前价格”绝对对齐。

## 📂 项目结构

- `backend/`: FastAPI 后端与多线程数据引擎。
- `frontend/`: React 前端，包含 Lightweight Charts v5 的深度定制。

## 📝 说明
- 建议配置合适的网络代理以获取稳定的币安实时行情。
- 本地数据库文件夹 `data/` 已通过 `.gitignore` 排除。
