# CandleScope

[![English](https://img.shields.io/badge/Language-English-blue)](#) [![简体中文](https://img.shields.io/badge/语言-简体中文-red)](README_zh.md)

Lightweight trading chart software built with FastAPI + React + Lightweight Charts. It now supports Binance and OKX market access, spot and perpetual market types, a multi-layered data engine, a Pine Script–inspired indicator scripting language, and a fully interactive charting frontend.

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10+-blue?logo=python" />
  <img src="https://img.shields.io/badge/Node.js-20+-green?logo=node.js" />
  <img src="https://img.shields.io/badge/React-18+-61DAFB?logo=react" />
  <img src="https://img.shields.io/badge/FastAPI-009688?logo=fastapi" />
  <img src="https://img.shields.io/badge/License-GPL--3.0-orange" />
</p>

---

## Table of Contents

- [Quick Start](#quick-start)
- [Recent Updates](#recent-updates)
- [Current Features](#current-features)
- [Core Capabilities](#core-capabilities)
- [Indicator Engine](#indicator-engine)
- [Pyne — Pine-style Scripting](#pyne--pine-style-scripting)
- [Frontend Features](#frontend-features)
- [Project Structure](#project-structure)
- [API Documentation](#api-documentation)
- [Notes](#notes)
- [Acknowledgments](#acknowledgments)

---

## Quick Start

### Requirements

- Python 3.10+
- Node.js 20+
- npm 10+

### Windows

Backend:

```powershell
cd backend
py -m pip install -r requirements.txt
py -m uvicorn app.main:app --reload
```

Frontend:

```powershell
cd frontend
npm install
npm run dev
```

### Linux / WSL

Backend:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Default URLs:
- API: `http://localhost:8000`
- Swagger: `http://localhost:8000/docs`
- Frontend: `http://localhost:5173`

> **Note:** On Debian/Ubuntu, install venv support first if needed: `sudo apt-get install -y python3-pip python3-venv`. If Binance is blocked in your region, the app falls back to mock data automatically.

---

## Recent Updates

Since the last README refresh, the project has gained several major user-facing capabilities:

- **Multi-exchange architecture** — The backend was refactored around an exchange registry and adapter layer. Binance and OKX are both supported, and the API now exposes exchange capabilities and symbol metadata.
- **Spot + futures market support** — Symbol metadata, history queries, streaming, and storage all carry `exchange` and `market_type`, so the same frontend flow works across spot and perpetual contracts.
- **Much stronger gap repair pipeline** — The data engine now includes a dedicated backfill planner/reconciler, storage repair tools, gap scanning, and more defensive continuity logic against missing K-lines.
- **Watchlist + price subscription system** — The frontend sidebar now supports persistent watchlists, drag-and-drop organization, real-time price flashes, and backend subscription tiers (`full` / `price` / `none`).
- **Expanded chart interaction tools** — Drawing support now includes Fibonacci retracements, long/short position tools, line variants, and persistent drawing storage.
- **Symbol search and exchange metadata refresh** — Search UI and backend symbol APIs were expanded for exchange-aware discovery and manual metadata refresh.
- **Indicator set expanded** — Built-in indicators now include `VOL` in addition to MA, EMA, MACD, RSI, BOLL, and ATR.
- **Operational controls in settings** — The settings panel can test proxies, refresh symbol metadata, repair stored custom intervals, and scan/fill historical gaps.

---

## Current Features

- **Zero-Latency Interval Switching** — Instant cache-first rendering. Switching between 1m, 1h, or 1d is near-instant if data exists in local SQLite.
- **Non-blocking Async Architecture** — All heavy I/O operations (Binance API) are offloaded to background thread pools, keeping the WebSocket and UI perfectly responsive.
- **Intelligent Prefetching** — Frontend automatically pre-warms adjacent intervals (e.g., if you view 1h, it silently fetches 15m and 4h in the background).
- **Parallel Data Filling** — Historical backfill and real-time refresh are executed concurrently using a specialized `ThreadPoolExecutor`.
- **Multi-Exchange K-line Sync** — Unified adapter-based synchronization for Binance and OKX, with exchange-specific symbol normalization, capabilities, and REST/WS transport handling.
- **Spot + Futures Support** — The backend and frontend both understand exchange + market-type scoped symbols, enabling spot and perpetual market flows in one codebase.
- **Dynamic Custom Intervals** — In addition to native intervals, the system synthesizes custom intervals (e.g., 45m, 3h) in real-time in-memory based on finer aggregated resolutions.
- **Full Indicator Engine** — 7 built-in indicators (MA, EMA, MACD, RSI, BOLL, ATR, VOL) with O(1) incremental computation, plus a script sandbox for custom indicators.
- **Pyne Scripting Language** — A Pine Script–inspired Python library with `ta.*`, `input.*`, `plot()` APIs for rapid indicator development.
- **Interactive Drawing Tools** — Freehand drawing, segment/ray/infinite lines, text annotations, Fibonacci retracements, and long/short position tools directly on the chart canvas.
- **Multi-Pane Chart Layout** — Separate panes for price, volume, and oscillator indicators with resizable dividers.
- **Watchlist & Price Tracking** — Persistent watchlists, symbol grouping, price-only subscription tiers, and real-time price snapshots/streams for sidebar monitoring.
- **Data Maintenance Toolkit** — Built-in proxy testing, exchange metadata refresh, custom-interval storage repair, and gap scan/fill operations.
- **Unified Mock Data** — Deterministic price levels are perfectly consistent across all intervals (1m to 1M) using a shared minute-step price curve.
- **Rendering Stability** — Built-in **ErrorBoundary** and time-based de-duplication to prevent "white screen" crashes from unstable network streams.

---

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

---

## Indicator Engine

CandleScope includes a comprehensive **incremental indicator computation engine** with support for both built-in indicators and user-defined custom scripts.

### Built-in Indicators

| Indicator | Category | Output | Pane |
|-----------|----------|--------|------|
| **MA** — Simple Moving Average | Trend | `ma` | Main |
| **EMA** — Exponential Moving Average | Trend | `ema` | Main |
| **MACD** — Moving Average Convergence Divergence | Trend | `dif`, `dea`, `hist` | Separate |
| **RSI** — Relative Strength Index | Oscillator | `rsi` | Separate |
| **BOLL** — Bollinger Bands | Volatility | `upper`, `middle`, `lower` | Main |
| **ATR** — Average True Range | Volatility | `atr` | Separate |
| **VOL** — Volume Histogram | Volume | `vol` | Volume |

### Key Design

- **O(1) Incremental Updates** — All indicators maintain rolling state, so each new bar requires only constant time to process.
- **Two-Phase Update** — `update_partial(bar)` computes preview values without modifying state; `update_closed(bar)` advances state on bar close.
- **Instance Caching** — Same indicator with same parameters shares a single instance across all consumers.
- **Script Mode** — Write a quick Python snippet using NumPy arrays; no registration needed. Perfect for prototyping.
- **Extensible** — Add new indicators by extending the `Indicator` base class with a comprehensive KDJ tutorial in the docs.

📖 **Full documentation:** [Indicator Development Guide](backend/app/indicator/README.md)

---

## Pyne — Pine-style Scripting

**Pyne** brings the simplicity of TradingView's Pine Script to Python. Write indicators using familiar `ta.*`, `input.*`, `plot()` APIs while retaining full Python power.

```python
# No imports needed — everything is pre-injected
length = input.int(20, "Period", minval=1)
src    = input.source(close, "Source")

upper, mid, lower = ta.bb(src, length, 2.0)
rsi = ta.rsi(close, 14)

p1 = plot(upper, "Upper", color=color.red)
plot(mid, "Mid", color=color.orange)
p2 = plot(lower, "Lower", color=color.green)
fill(p1, p2, color="rgba(59,130,246,0.05)")

marker(rsi > 70, shape="triangle_down", color=color.red, text="OB")
marker(rsi < 30, shape="triangle_up", color=color.green, text="OS")
```

### Available Modules

| Module | Description |
|--------|-------------|
| `ta.*` | 30+ technical analysis functions — SMA, EMA, RSI, MACD, Bollinger Bands, ATR, Stochastic, ADX, Supertrend, Keltner, Donchian, and more |
| `input.*` | Parameter declarations — `int`, `float`, `bool`, `source`, `color`, `string` with validation |
| `plot()`, `bar()`, `hline()`, `fill()`, `marker()`, `bgcolor()`, `barcolor()` | Rich drawing functions for lines, histograms, fills, markers, and coloring |
| `color.*` | Color constants and `color.new()` transparency helper |
| `math.*` | Array-aware math functions |
| Utilities | `crossover`, `crossunder`, `highest`, `lowest`, `change`, `pivothigh`, `pivotlow`, `barssince`, `valuewhen`, etc. |

📖 **Full documentation:** [Pyne Library Reference](backend/app/indicator/pyne/README.md)

---

## Frontend Features

The React frontend is built on **Lightweight Charts v5** with extensive customizations:

- **Multi-Pane Chart** — Price chart, volume pane, and oscillator sub-panes with draggable resizers.
- **Drawing Tools** — Freehand pen, line variants, Fibonacci retracement, long/short position tools, and text annotations with persistent storage.
- **Indicator Editor** — Full-featured code editor with Pyne syntax highlighting, powered by Monaco-style editing.
- **Indicator Panel** — Browse and add built-in indicators or write custom scripts with live preview.
- **Watchlist Sidebar** — Persistent watchlists with drag-and-drop ordering, real-time price flashes, and per-symbol subscription tiers.
- **Settings Modal** — Configure chart appearance, proxy/data source parameters, and run storage maintenance actions.
- **Infinite Scroll History** — Seamless left-scroll to load historical data on demand, backed by the backfill engine.
- **Real-time WebSocket Updates** — Live candlestick updates with multiplexed multi-interval streaming.

---

## Project Structure

```
CandleScope/
├── README.md / README_zh.md              # Project documentation (EN/CN)
├── API.md / API_zh.md                    # REST & WebSocket API reference (EN/CN)
├── LICENSE                               # GNU GPL-3.0
│
├── backend/                              # FastAPI backend & data engine
│   ├── requirements.txt
│   └── app/
│       ├── main.py                       # Application entry point
│       ├── api/v1/                       # REST & WebSocket endpoints
│       │   ├── klines.py                 #   K-line data endpoints
│       │   ├── indicators.py             #   Indicator compute/CRUD endpoints
│       │   ├── stream.py                 #   WebSocket streaming
│       │   └── settings.py               #   User settings
│       ├── core/                         # Configuration & market definitions
│       ├── realtime/                     # WebSocket stream hub
│       ├── data_engine/                  # 📦 Multi-layered data engine
│       │   ├── data_manager/             #   Central facade (cache + query + events)
│       │   ├── ingestion/                #   6-layer real-time market data pipeline
│       │   ├── bar_aggregator/           #   Custom interval synthesizer
│       │   ├── backfill/                 #   Historical gap detection & repair
│       │   ├── collectors/               #   Exchange-specific data fetchers
│       │   ├── services/                 #   K-line aggregation & caching services
│       │   └── storage/                  #   SQLite persistence layer
│       └── indicator/                    # 📦 Indicator computation engine
│           ├── base.py                   #   Indicator abstract base class
│           ├── engine.py                 #   Dispatch, caching & lifecycle
│           ├── registry.py               #   Global indicator registry
│           ├── dependency.py             #   Indicator chaining support
│           ├── indicators/               #   Built-in implementations (MA, EMA, MACD, RSI, BOLL, ATR)
│           └── pyne/                     #   Pine Script–style Python library
│               ├── ta.py                 #     Technical analysis functions
│               ├── input.py              #     Parameter declarations
│               ├── plot.py               #     Drawing functions
│               ├── color.py              #     Color constants
│               └── runtime.py            #     Script execution engine
│
└── frontend/                             # React + Vite frontend
    └── src/
        ├── App.jsx                       # Main application shell
        ├── components/
        │   ├── ChartPane.jsx             #   Single chart pane
        │   ├── ChartWidget.jsx           #   Lightweight Charts wrapper
        │   ├── MultiPaneChart.jsx         #   Multi-pane layout manager
        │   ├── PaneResizer.jsx           #   Draggable pane dividers
        │   ├── DrawingToolbar.jsx        #   Drawing tool controls
        │   ├── IndicatorEditor.jsx       #   Code editor for custom indicators
        │   ├── IndicatorPanel.jsx        #   Indicator browser & configurator
        │   ├── SettingsModal.jsx         #   Settings dialog
        │   └── primitives/              #   Custom chart drawing primitives
        ├── hooks/                        # React hooks (useDrawing, useIndicators)
        ├── services/                     # API clients & storage helpers
        └── editor/                       # Pyne language support for editor
```

### Data Engine Sub-Module Documentation

| Module | Description | Docs |
|--------|-------------|------|
| **Data Manager** | Central facade for querying, caching, and stream coordination | [EN](backend/app/data_engine/data_manager/README.md) · [中文](backend/app/data_engine/data_manager/README_zh.md) |
| **Ingestion Layer** | 6-layer pipeline for real-time market data ingestion through exchange adapters | [EN](backend/app/data_engine/ingestion/README.md) · [中文](backend/app/data_engine/ingestion/README_zh.md) |
| **Bar Aggregator** | Real-time custom interval synthesizer (e.g., 45m, 3h) | [EN](backend/app/data_engine/bar_aggregator/README.md) · [中文](backend/app/data_engine/bar_aggregator/README_zh.md) |
| **Backfill Engine** | Intelligent historical data gap detection and multi-threaded backfilling | [EN](backend/app/data_engine/backfill/README.md) · [中文](backend/app/data_engine/backfill/README_zh.md) |

### Indicator Sub-Module Documentation

| Module | Description | Docs |
|--------|-------------|------|
| **Indicator Engine** | Incremental computation engine with built-in indicators and extensible architecture | [EN](backend/app/indicator/README.md) · [中文](backend/app/indicator/README_zh.md) |
| **Pyne Library** | Pine Script–inspired Python library for rapid indicator development | [EN](backend/app/indicator/pyne/README.md) · [中文](backend/app/indicator/pyne/README_zh.md) |

---

## API Documentation

Full REST and WebSocket API reference is available in a separate document:

- 📖 [**API Reference (English)**](API.md)
- 📖 [**API 文档 (中文)**](API_zh.md)

**Key endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/klines` | GET | Fetch K-line data (cache-first) |
| `/api/v1/klines/history/before` | GET | Paginated historical scroll |
| `/api/v1/stream/klines_multi` | WebSocket | Multiplexed real-time K-line stream |
| `/api/v1/indicators/compute` | POST | Execute indicator computation |
| `/api/v1/indicators/registry` | GET | List all available indicators |
| `/api/v1/exchanges` | GET | List exchange capabilities |
| `/api/v1/symbols/exchange-info` | GET | Query exchange-aware symbol metadata |
| `/api/v1/subscriptions` | GET/PUT/POST | Manage watchlist-driven subscription tiers |

---

## Notes

- If exchange access fails because of network or proxy issues, the app can fall back to mock data for chart development.
- Local DB files are ignored in git via `.gitignore`.
- The indicator script sandbox executes user code in an isolated thread for safety.
- This repository is licensed under **GNU GPL-3.0**. See `LICENSE` for the full text.

---

## Acknowledgments

This project is built upon several excellent open-source libraries. We would like to express our gratitude to the creators and maintainers of these projects:

*   **[Lightweight Charts™](https://github.com/tradingview/lightweight-charts)** by [TradingView](https://www.tradingview.com/)
    *   Licensed under the [Apache License, Version 2.0](https://github.com/tradingview/lightweight-charts/blob/master/LICENSE)
    *   *Used for rendering high-performance financial charts and candlestick data.*
