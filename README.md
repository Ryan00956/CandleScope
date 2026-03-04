# CandleScope

[English](#english) | [简体中文](#简体中文)

<a name="english"></a>
# CandleScope (English)

Lightweight trading chart software built with FastAPI + React + Lightweight Charts.

Current features:
- Binance spot kline fetching
- Local SQLite cache (avoid repeated full fetches)
- Auto load older klines when dragging chart to the far left
- WebSocket real-time kline streaming (with HTTP polling fallback)
- Real-time persistence: WebSocket closed candles are automatically saved to local storage
- Data management APIs (meta, delete, indicator example)
- Deterministic mock data: constant price levels across timeframes even when offline

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

Default DB path:
- `backend/data/candlescope.db`

Env overrides:
- `KLINES_DB_PATH`
- `CANDLE_DATA_DIR`

### 2. Auto backfill on left drag

When you drag to the left edge, frontend requests older data and prepends it.

Interaction behavior:
- Timeframe switch: full-screen loading overlay is shown.
- Left-drag backfill: no full-screen overlay, only status-bar hint.

### 3. Data and management APIs

Primary data APIs:
- `GET /api/v1/klines/`
- `GET /api/v1/klines/history`
- `GET /api/v1/klines/history/before`
- `WS  /api/v1/stream/klines?symbol=BTCUSDT&interval=1m`

Management and extension APIs:
- `GET /api/v1/klines/storage/meta`
- `DELETE /api/v1/klines/storage`
- `GET /api/v1/klines/indicators/sma`

### 4. Real-time & Auto-Persistence

The app employs a "Dual-Mode" real-time engine:
- **WebSocket First**: Connects directly to Binance streams for sub-second updates.
- **Polling Fallback**: Automatically switches to HTTP polling (every 3s) if WebSocket is blocked (common with proxies).
- **Auto-Sync**: Any "closed" candle received via WebSocket is instantly persisted to the local SQLite database, ensuring your history grows while you watch.

## Project Structure

- `backend/`: FastAPI backend and data engine
- `frontend/`: React frontend and chart interaction

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
- **双模实时行情**: 优先 WebSocket 连接，环境受限时自动降级为 HTTP 轮询，确报 K 线持续跳动。
- **确定性模拟数据**: 即使在离线状态下，同一币种在不同时间周期（如 1m vs 1h）的价格也是对齐一致的。
- **实时数据落库**: WebSocket 接收到的已闭合 K 线会自动同步到本地数据库。

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
- **配置项**: 可通过环境变量 `KLINES_DB_PATH` 定义。

### 2. 交互式回填 (Backfill)
当感知到用户将图表时间轴拉至最左端（可见范围开始处），系统将发起补全请求。
- **流畅性**: 回填过程不触发全屏 Loading，仅通过底部状态栏提示，确保护眼、不间断的看盘体验。

### 3. 数据管理
- **历史增量**: 支持基于特定 Unix 时间戳向前寻找数据 `GET /api/v1/klines/history/before`。
- **存储维护**: 随时通过 `DELETE` 接口清理冗余数据。

### 4. 实时动态与自动持久化

- **双模引擎**: 优先采用 WebSocket 建立毫秒级行情链接；若网络或代理不支持 WS，系统会在 4 秒内感知并自动切换至 **HTTP 轮询模式**（最新价兜底），保证看盘不中断。
- **自动增量存储**: WebSocket 接收到的每根“已闭合” K 线都会在后台静默写入本地 SQLite，无需手动刷新即可完成数据积累。
- **价格一致性**: 改进后的模拟算法确保了同一 Symbol 在不同周期下的价格底色一致，解决了“模拟数据打架”的问题。

## 📂 项目结构

- `backend/`: 核心数据引擎，负责采集、清洗、存储。
- `frontend/`: 渲染层，包含 Lightweight Charts v5 的深度定制。

## 📝 说明
- 建议在中国大陆环境下配置合适的网络代理以获取稳定的币安实时行情。
- 本地数据库文件夹 `data/` 已通过 `.gitignore` 排除，保证仓库轻量化。
