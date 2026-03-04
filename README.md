# CandleScope

[English](#english) | [简体中文](#简体中文)

<a name="english"></a>
# CandleScope (English)

Lightweight trading chart software built with FastAPI + React + Lightweight Charts.

Current features:
- **Binance spot kline fetching**: Rapid synchronization of real market data.
- **Local SQLite cache**: Avoid repeated full fetches and significantly boost loading speed.
- **Auto backfill on left drag**: Older klines are fetched automatically when dragging chart to the far left.
- **WebSocket real-time kline streaming**: Sub-second updates with a robust HTTP polling fallback.
- **Real-time persistence**: WebSocket closed candles are automatically saved to local storage.
- **Unified Mock Data**: Deterministic price levels are perfectly consistent across all intervals (1m to 1M) using a shared price curve.
- **Rendering Stability**: Built-in **ErrorBoundary** and data de-duplication to prevent "white screen" crashes even with unstable network streams.
- **Data management APIs**: Comprehensive endpoints for history, storage meta, and basic indicators (SMA).

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

### 1. Persistent kline cache

Klines are stored in SQLite with unique key:
- `symbol + interval + open_time`

Default DB path: `backend/data/candlescope.db`

### 2. Auto backfill on left drag

When you drag to the left edge, frontend requests older data and prepends it without a full-screen loading overlay, ensuring a smooth visual experience.

### 3. Real-time & Auto-Persistence

The app employs a "Dual-Mode" real-time engine:
- **WebSocket First**: Connects directly to Binance streams.
- **Polling Fallback**: Automatically switches to HTTP polling if WebSocket is blocked.
- **Auto-Sync**: Any "closed" candle received is instantly persisted.

### 4. Stability & Precision

- **No White Screen**: Integrated React ErrorBoundaries and chart data sanitization (time-based deduplication) ensure the UI stays up even if the underlying library hits data irregularities.
- **Shared Price Logic**: The mock generator uses a deterministic minute-level random walk. This ensures that the "current price" is identical whether you are looking at a 1-minute chart or a daily chart.

## Project Structure

- `backend/`: FastAPI backend and data engine.
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
- **币安 (Binance) 现货 K 线抓取**: 快速同步真实的行情数据。
- **本地 SQLite 缓存**: 自动存储已加载的 K 线，避免重复网络请求，极大提升加载速度。
- **历史数据自动回填**: 向左拖拽图表至边缘时，自动触发向后（更早的时间）拉取数据。
- **强健的实时行情**: 优先 WebSocket 连接，支持 4s 自动感知并无缝切换至 HTTP 轮询。
- **统一价格模拟**: 彻底解决 Mock 模式下不同周期（1m/1h/1d）价格不一致的问题，共用同一条确定性价格曲线。
- **抗崩溃能力**: 内置 **ErrorBoundary** 错误拦截与数据去重逻辑，杜绝因数据异常导致的“白屏”现象。
- **实时数据落库**: WebSocket 接收到的已闭合 K 线会自动同步到本地数据库。
- **丰富的数据接口**: 包含历史补全、存储状态查询、移动平均线 (SMA) 指标计算等。

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

### 1. 持久化存储
K 线数据持久化存储于 SQLite，唯一键由 `symbol + interval + open_time` 组成。
- **默认路径**: `backend/data/candlescope.db`

### 2. 交互式回填 (Backfill)
当感知到用户将图表时间轴拉至最左端（可见范围开始处），系统将发起补全请求。回填过程不触发全屏 Loading，仅通过底部状态栏提示。

### 3. 实时动态与自动持久化
- **双模引擎**: 优先采用 WebSocket 建立毫秒级行情链接；由于网络环境（如代理）无法建立 WS 时，自动切换至 HTTP 轮询。
- **增量存储**: WebSocket 接收到的每根“已闭合” K 线都会在后台静默写入本地数据库。

### 4. 稳定性与精确度
- **防白屏设计**: 引入 React 错误边界和图表数据清晰化逻辑（按时间戳强行去重），确保即使在数据流不稳定的情况下界面依然可用。
- **确定性模拟**: 采用基于分钟步进的共享随机游走算法，保证同一 Symbol 在所有周期下的“当前价格”绝对对齐。

## 📂 项目结构

- `backend/`: 核心数据引擎，负责采集、清洗、存储。
- `frontend/`: 渲染层，包含 Lightweight Charts v5 的深度定制。

## 📝 说明
- 建议在中国大陆环境下配置合适的网络代理以获取稳定的币安实时行情。
- 本地数据库文件夹 `data/` 已通过 `.gitignore` 排除。
