<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/brand/candlescope-lockup-on-dark.svg" />
    <img src="frontend/public/brand/candlescope-lockup.svg" width="500" alt="CandleScope" />
  </picture>
</p>

# CandleScope

<p align="center">
  CandleScope is a local market analysis and replay workstation for crypto traders.
</p>

<p align="center">
  Live charts · Order flow · Linked workspaces · Market replay · Programmable indicators
</p>

<p align="center">
  <a href="README_zh.md">简体中文</a>
  · <a href="#product">Product</a>
  · <a href="#quick-start">Quick start</a>
  · <a href="#documentation">Documentation</a>
</p>

<!-- Hero image: docs/assets/readme/hero-live-workspace.png -->

## Product

### Live market

Follow Binance and OKX spot and perpetual markets with realtime charts, order
book, trades, order-flow views, and contract context when available.

<!-- Product image: docs/assets/readme/live-order-flow.png -->

### Multi-chart workspace

Compare markets and intervals in a saved workspace. Link the symbol, interval,
crosshair, visible range, drawings, or indicators only where you need them.

<!-- Product image: docs/assets/readme/multi-chart-workspace.png -->

### Market replay

Train on historical data with synchronized markets, a shared paper account,
resumable sessions, review, and fork.

<!-- Product image: docs/assets/readme/replay-training.png -->

### Indicators and scripts

Use built-in studies or create local indicators with Pyne. Other runtimes can
connect through the plugin system.

<!-- Product image: docs/assets/readme/pyne-indicator.png -->

### Strategy research

Import your own data into the local library, or use the current chart, then run
a script and inspect trades, equity, drawdown, parameters, and the assumptions
attached to each result. Advanced research stays inside the same Strategy
product.

Strategy research is enabled by default. Set both research-data library flags to
`0` for an explicit rollback to the compatibility paths.
`/strategy.html` is the canonical URL; `/local.html` and `/backtest.html` remain
compatibility entries. Pine/Pyne custom scripts are not claimed as available in
the LOCAL_OFFLINE profile.

<!-- Product image: docs/assets/readme/backtest-research.png -->

## Quick start

Requirements: Python 3.11+, Node.js 20+, and npm 10+. Python 3.12 is
recommended.

Start the backend:

Linux or macOS:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
./dev-server.sh
```

Windows PowerShell:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\dev-server.ps1
```

Start the frontend in a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open [http://127.0.0.1:15173/](http://127.0.0.1:15173/). The API runs at
`http://127.0.0.1:18080/`.

## Current scope

- Replay uses paper orders and never routes live exchange orders.
- Advanced market views depend on data provided by the selected exchange and
  market.
- The standard workspace supports up to four charts. Higher-capacity layouts
  are opt-in.
- The current first-party Pyne and Pine plugin bundles target Windows with
  CPython 3.12. Pine compatibility covers a supported subset.
- The browser app runs on Windows, Linux, and macOS. The optional desktop shell
  currently targets Windows.

## Documentation

| Topic | Guide |
|---|---|
| Frontend | [Frontend architecture](frontend/ARCHITECTURE.md) |
| API | [API reference](API.md) |
| Market data and storage | [Data Engine guide](backend/app/data_engine/README.md) |
| Replay | [Replay training contract](docs/KLINE_REPLAY_TRAINING_PRODUCT_CONTRACT_zh.md) |
| Backtesting | [Local beta guide](docs/BACKTEST_PYTHON_LOCAL_BETA_GUIDE_zh.md) |
| Plugins | [Plugin author guide](docs/PLUGIN_PLATFORM_AUTHOR_RUNTIME_GUIDE_zh.md) |
| Offline data | [Local offline mode](docs/local-offline-mode.md) |
| Alerts | [Alert delivery guide](docs/ALERTS_DELIVERY_zh.md) |

## Development

Backend checks:

```bash
cd backend
python -m compileall app tests -q
python -m pytest -q
```

Frontend checks:

```bash
cd frontend
npm run typecheck
npm run lint
npm test
npm run build
```

## License

CandleScope is licensed under [GNU GPL-3.0](LICENSE).
