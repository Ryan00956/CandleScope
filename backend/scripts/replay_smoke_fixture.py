"""Start a deterministic, offline CandleScope backend for replay browser smoke.

The caller must provide isolated KLINES_DB_PATH/REPLAY_DB_PATH values. Upstream
Binance URLs are expected to point at a closed loopback port so this fixture can
never reach the public exchange network.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import time
from pathlib import Path


# Keep every fixture row on an exact UTC 1m boundary. The replay catalog
# deliberately rejects misaligned source bounds instead of rounding them.
FIXTURE_START_MS = 1_700_000_040_000
FIXTURE_ROWS = 4_000
INTERVAL_MS = 60_000
LEGACY_LIVE_TAIL_ROWS = 10
FIXTURE_SYMBOLS: tuple[tuple[str, float], ...] = (
    ("BTCUSDT", 30_000.0),
    ("ETHUSDT", 2_000.0),
    ("SOLUSDT", 100.0),
    ("XRPUSDT", 500.0),
    ("ADAUSDT", 400.0),
    ("BNBUSDT", 300.0),
    ("DOGEUSDT", 80.0),
    ("AVAXUSDT", 35.0),
)


def _require_isolated_environment() -> None:
    klines = os.environ.get("KLINES_DB_PATH", "")
    replay = os.environ.get("REPLAY_DB_PATH", "")
    if not klines or not replay or klines == replay:
        raise RuntimeError(
            "smoke fixture requires distinct KLINES_DB_PATH and REPLAY_DB_PATH"
        )
    forbidden_hosts = ("binance.com", "binance.me")
    upstream_values = (
        os.environ.get("BINANCE_BASE_URL", ""),
        os.environ.get("BINANCE_WS_URL", ""),
        os.environ.get("BINANCE_FUTURES_BASE_URL", ""),
        os.environ.get("BINANCE_FUTURES_WS_URL", ""),
    )
    if any(host in value for host in forbidden_hosts for value in upstream_values):
        raise RuntimeError("smoke fixture refuses public Binance upstream URLs")


def _force_offline_upstreams() -> None:
    """Remove the production fallback URLs before data-engine modules import them."""

    from app.core import config

    config.BINANCE_BASE_URLS[:] = [config.BINANCE_BASE_URL]
    config.BINANCE_WS_URLS[:] = [config.BINANCE_WS_URL]
    config.BINANCE_FUTURES_BASE_URLS[:] = [config.BINANCE_FUTURES_BASE_URL]
    config.BINANCE_FUTURES_WS_URLS[:] = [config.BINANCE_FUTURES_WS_URL]
    os.environ["INGESTION_HTTP_BASE_URLS"] = config.BINANCE_BASE_URL
    os.environ["INGESTION_WS_BASE_URLS"] = config.BINANCE_WS_URL
    os.environ["INGESTION_HTTP_BASE_URLS_FUTURES"] = (
        config.BINANCE_FUTURES_BASE_URL
    )
    os.environ["INGESTION_WS_BASE_URLS_FUTURES"] = config.BINANCE_FUTURES_WS_URL
    os.environ["INGESTION_PROXY_MODE"] = "none"


def _fixture_row(*, index: int, open_time: int, price_origin: float = 30_000.0) -> dict[str, object]:
    base = price_origin + (index % 80) * 2.0 + (index // 80) * 0.25
    return {
        "open_time": open_time,
        "close_time": open_time + INTERVAL_MS - 1,
        "open": base,
        "high": base + 12.0,
        "low": base - 12.0,
        "close": base + (4.0 if index % 2 == 0 else -3.0),
        "volume": 10.0 + index % 7,
        "quote_volume": (10.0 + index % 7) * base,
        "trades": 100 + index % 20,
        "taker_buy_base": 5.0,
        "taker_buy_quote": 5.0 * base,
    }


def _legacy_live_tail_rows(*, now_ms: int | None = None) -> list[dict[str, object]]:
    """Build an opt-in, closed live tail for the pre-replay rollback build.

    The fixed 4,000-row archive remains the only normal fixture dataset. Old
    live builds reject that deliberately historical tail as stale, so the
    rollback drill alone opts into these rows to prove its live chart path.
    """

    current_ms = int(time.time() * 1_000) if now_ms is None else now_ms
    last_closed_open_ms = (current_ms // INTERVAL_MS - 1) * INTERVAL_MS
    first_open_ms = last_closed_open_ms - (LEGACY_LIVE_TAIL_ROWS - 1) * INTERVAL_MS
    return [
        _fixture_row(index=index, open_time=first_open_ms + index * INTERVAL_MS, price_origin=31_000.0)
        for index in range(LEGACY_LIVE_TAIL_ROWS)
    ]


def _legacy_live_tail_required(
    *,
    runtime_backend_root: Path | None = None,
    fixture_backend_root: Path | None = None,
) -> bool:
    """Detect the rollback drill's cross-root legacy backend invocation."""

    runtime_root = (runtime_backend_root or Path.cwd()).resolve()
    fixture_root = (
        fixture_backend_root or Path(__file__).resolve().parent.parent
    ).resolve()
    return runtime_root != fixture_root


def _seed_klines() -> None:
    from app.data_engine.storage.klines_repo import init_klines_storage, upsert_klines

    init_klines_storage()
    for symbol, price_origin in FIXTURE_SYMBOLS:
        rows = [
            _fixture_row(
                index=index,
                open_time=FIXTURE_START_MS + index * INTERVAL_MS,
                price_origin=price_origin,
            )
            for index in range(FIXTURE_ROWS)
        ]
        if symbol == "BTCUSDT" and _legacy_live_tail_required():
            rows.extend(_legacy_live_tail_rows())
        inserted = upsert_klines(
            symbol,
            "1m",
            rows,
            source="replay-smoke-fixture",
            exchange="binance",
            market_type="spot",
        )
        if inserted != len(rows):
            raise RuntimeError(
                f"expected {len(rows)} {symbol} fixture rows, wrote {inserted}"
            )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    _require_isolated_environment()
    _force_offline_upstreams()
    _seed_klines()

    import uvicorn
    from app.api.v1 import symbols as symbols_api

    async def _offline_exchange_metadata(_exchange: str = "") -> dict[str, int]:
        """Prevent full-app startup from making public metadata requests."""

        return {}

    symbols_api.refresh_exchange_metadata = _offline_exchange_metadata

    from app.main import app

    server_holder: dict[str, uvicorn.Server] = {}

    @app.get("/__replay_smoke__/fixture")
    async def replay_smoke_fixture_status() -> dict[str, object]:
        return {
            "offline": True,
            "fixture_start_ms": FIXTURE_START_MS,
            "fixture_rows": FIXTURE_ROWS,
            "fixture_symbols": [symbol for symbol, _price in FIXTURE_SYMBOLS],
        }

    @app.get("/__replay_smoke__/diagnostics")
    async def replay_smoke_diagnostics() -> dict[str, object]:
        """Expose bounded, path-redacted replay diagnostics to local QA only."""

        service = getattr(app.state, "replay_service", None)
        if service is None:
            return {"available": False, "reason": "REPLAY_DISABLED"}
        return {
            "available": True,
            "replay": service.diagnostics(redact_paths=True),
        }

    @app.post("/__replay_smoke__/disconnect-replay/{session_id}")
    async def disconnect_replay_stream(session_id: str) -> dict[str, object]:
        """Drop only replay subscribers while the live backend stays online."""

        from fastapi import HTTPException

        service = getattr(app.state, "replay_service", None)
        handle = None if service is None else service._sessions.get(session_id)
        if handle is None:
            raise HTTPException(
                status_code=404, detail="fixture replay session not found"
            )
        overflow_signals = [
            subscriber.overflow
            for subscriber in tuple(handle.actor._subscribers.values())
        ]
        if not overflow_signals:
            raise HTTPException(
                status_code=409, detail="fixture replay stream not connected"
            )

        # Hold only new replay subscriptions long enough for the browser to
        # render its recovery state. Existing live HTTP/WS paths stay online.
        original_subscribe = service.subscribe
        reconnect_gate = asyncio.Event()

        async def gated_subscribe(*args, **kwargs):
            await reconnect_gate.wait()
            return await original_subscribe(*args, **kwargs)

        service.subscribe = gated_subscribe
        try:
            for overflow in overflow_signals:
                overflow.set()
            await asyncio.sleep(0.75)
        finally:
            reconnect_gate.set()
            service.subscribe = original_subscribe
        return {"disconnected_subscribers": len(overflow_signals)}

    @app.post("/__replay_smoke__/shutdown")
    async def replay_smoke_graceful_shutdown() -> dict[str, object]:
        """Request Uvicorn shutdown after the response reaches the caller."""

        server = server_holder.get("server")
        if server is None:
            raise RuntimeError("fixture server is not ready for shutdown")
        asyncio.get_running_loop().call_later(
            0.05,
            setattr,
            server,
            "should_exit",
            True,
        )
        return {"shutdown": "requested", "graceful": True}

    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=args.port,
        log_level="warning",
    )
    server = uvicorn.Server(config)
    server_holder["server"] = server
    server.run()


if __name__ == "__main__":
    main()
