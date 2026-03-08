# CandleScope

[![English](https://img.shields.io/badge/Language-English-blue)](#) [![简体中文](https://img.shields.io/badge/语言-简体中文-red)](README_zh.md)

Lightweight trading chart software built with FastAPI + React + Lightweight Charts.

## Current features
- **Zero-Latency Interval Switching**: Instant cache-first rendering. Switching between 1m, 1h, or 1d is near-instant if data exists in local SQLite.
- **Non-blocking Async Architecture**: All heavy I/O operations (Binance API) are offloaded to background thread pools, keeping the WebSocket and UI perfectly responsive.
- **Intelligent Prefetching**: Frontend automatically pre-warms adjacent intervals (e.g., if you view 1h, it silently fetches 15m and 4h in the background).
- **Parallel Data Filling**: Historical backfill and real-time refresh are executed concurrently using a specialized `ThreadPoolExecutor`.
- **Binance Spot K-line Sync**: Rapid synchronization of real market data with a local SQLite cache to avoid redundant network requests.
- **Dynamic Custom Intervals**: In addition to native intervals, the system synthesizes custom intervals (e.g., 45m, 3h) in real-time in-memory based on finer aggregated resolutions.
- **Unified Mock Data**: Deterministic price levels are perfectly consistent across all intervals (1m to 1M) using a shared minute-step price curve.
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

## Project Structure & Data Engine Modules

- `backend/`: FastAPI backend and multi-threaded data engine.
- `frontend/`: React frontend with customized Lightweight Charts v5.

The **Data Engine** provides multiple sub-modules with well-defined responsibilities. For detailed architecture and design, please refer to their respective documentation:

- 📖 [**Data Manager**](backend/app/data_engine/data_manager/README.md) - The central facade for querying, caching, and stream coordination.
- 📖 [**Ingestion Layer**](backend/app/data_engine/ingestion/README.md) - 6-layer pipeline for real-time WebSocket market data via Binance.
- 📖 [**Bar Aggregator**](backend/app/data_engine/bar_aggregator/README.md) - Real-time custom interval synthesizer (e.g., 45m, 3h).
- 📖 [**Backfill Engine**](backend/app/data_engine/backfill/README.md) - Intelligent historical data gap detection and multi-threaded backfilling.

## Notes

- If Binance cannot be reached (network/proxy), the app falls back to mock data.
- Local DB files are ignored in git via `.gitignore`.

## Acknowledgments

This project is built upon several excellent open-source libraries. We would like to express our gratitude to the creators and maintainers of these projects:

*   **[Lightweight Charts™](https://github.com/tradingview/lightweight-charts)** by [TradingView](https://www.tradingview.com/)
    *   Licensed under the [Apache License, Version 2.0](https://github.com/tradingview/lightweight-charts/blob/master/LICENSE)
    *   *Used for rendering high-performance financial charts and candlestick data.*
