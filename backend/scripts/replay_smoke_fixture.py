"""Start a deterministic, offline CandleScope backend for replay browser smoke.

The caller must provide isolated KLINES_DB_PATH/REPLAY_DB_PATH values. Upstream
Binance URLs are expected to point at a closed loopback port so this fixture can
never reach the public exchange network.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sqlite3
import time
from contextlib import closing
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path


# Keep every fixture row on an exact UTC 1m boundary. The replay catalog
# deliberately rejects misaligned source bounds instead of rounding them.
FIXTURE_START_MS = 1_700_000_040_000
FIXTURE_ROWS = 4_000
INTERVAL_MS = 60_000
LEGACY_LIVE_TAIL_ROWS = 10
AGG_TRADE_FIXTURE_MINUTES = 1_600
AGG_TRADE_ROWS_PER_MINUTE = 2
HISTORICAL_BOOK_FIXTURE_MINUTES = FIXTURE_ROWS
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


def _seed_agg_trades() -> int:
    """Seed an opt-in verified futures tape without enabling any upstream I/O."""

    from app.data_engine.storage.klines_repo import upsert_klines
    from app.data_engine.storage.raw_trade_archive import (
        ParquetRawAggTradeArchive,
        VerifiedRawAggTradeDay,
    )

    archive_root = os.environ.get("RAW_AGG_TRADE_ARCHIVE_DIR", "").strip()
    if not archive_root:
        raise RuntimeError("--agg-trades requires RAW_AGG_TRADE_ARCHIVE_DIR")
    if os.environ.get("RAW_AGG_TRADE_ARCHIVE_ENABLED") != "1":
        raise RuntimeError("--agg-trades requires RAW_AGG_TRADE_ARCHIVE_ENABLED=1")

    bars: list[dict[str, object]] = []
    for minute in range(AGG_TRADE_FIXTURE_MINUTES + 3):
        open_time = FIXTURE_START_MS + minute * INTERVAL_MS
        price = 30_000 + minute % 120
        bars.append(
            {
                "open_time": open_time,
                "close_time": open_time + INTERVAL_MS - 1,
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "volume": 3,
                "quote_volume": price * 3,
                "trades": AGG_TRADE_ROWS_PER_MINUTE,
                "taker_buy_base": 2,
                "taker_buy_quote": price * 2,
            }
        )
    inserted = upsert_klines(
        "BTCUSDT",
        "1m",
        bars,
        source="replay-smoke-agg-fixture",
        exchange="binance",
        market_type="futures",
    )
    if inserted != len(bars):
        raise RuntimeError(
            f"expected {len(bars)} futures BAR rows, wrote {inserted}"
        )

    first_agg_trade_id = 8_000_000
    rows_by_date: dict[str, list[dict[str, object]]] = {}
    for minute in range(AGG_TRADE_FIXTURE_MINUTES):
        price = 30_000 + minute % 120
        for within in range(AGG_TRADE_ROWS_PER_MINUTE):
            index = minute * AGG_TRADE_ROWS_PER_MINUTE + within
            timestamp = FIXTURE_START_MS + minute * INTERVAL_MS + 1_000 + within
            date = datetime.fromtimestamp(timestamp / 1_000, tz=UTC).date().isoformat()
            quantity = 1 + within
            rows_by_date.setdefault(date, []).append(
                {
                    "exchange": "binance",
                    "market_type": "futures",
                    "symbol": "BTCUSDT",
                    "agg_trade_id": first_agg_trade_id + index,
                    "first_trade_id": first_agg_trade_id * 10 + index,
                    "last_trade_id": first_agg_trade_id * 10 + index,
                    "price": price,
                    "quantity": quantity,
                    "quote_quantity": price * quantity,
                    "trade_time_ms": timestamp,
                    "event_time_ms": timestamp,
                    "received_at_ms": timestamp,
                    "is_buyer_maker": within == 0,
                    "source": "replay_smoke_verified_fixture",
                }
            )

    archive = ParquetRawAggTradeArchive(
        Path(archive_root),
        max_rows_per_file=10_000,
        max_scan_rows=100_000,
        max_physical_scan_rows=100_000,
    )
    imported = 0
    for date, rows in sorted(rows_by_date.items()):
        metadata = VerifiedRawAggTradeDay(
            exchange="binance",
            market_type="futures",
            symbol="BTCUSDT",
            date=date,
            source_url=f"fixture://replay-smoke/{date}/BTCUSDT",
            source_file=f"BTCUSDT-{date}.fixture",
            source_checksum_sha256=sha256(
                f"replay-smoke:{date}:{len(rows)}".encode("utf-8")
            ).hexdigest(),
            row_count=len(rows),
            first_agg_trade_id=int(rows[0]["agg_trade_id"]),
            last_agg_trade_id=int(rows[-1]["agg_trade_id"]),
            first_trade_time_ms=int(rows[0]["trade_time_ms"]),
            last_trade_time_ms=int(rows[-1]["trade_time_ms"]),
        )
        written = archive.import_verified_day(rows, metadata)
        if written not in {0, len(rows)}:
            raise RuntimeError(
                f"expected 0 or {len(rows)} verified rows, wrote {written}"
            )
        imported += len(rows)
    return imported


def _seed_historical_book_source() -> Path:
    """Create an opt-in trusted L2 capture outside replay-owned storage."""

    if os.environ.get("REPLAY_HISTORICAL_BOOK_ENABLED") != "1":
        raise RuntimeError(
            "--historical-book requires REPLAY_HISTORICAL_BOOK_ENABLED=1"
        )
    source_root = os.environ.get("REPLAY_SMOKE_BOOK_SOURCE_DIR", "").strip()
    if not source_root:
        raise RuntimeError(
            "--historical-book requires REPLAY_SMOKE_BOOK_SOURCE_DIR"
        )

    from app.replay.training.historical_book import (
        ARCHIVE_PROTOCOL,
        ARCHIVE_SCHEMA_VERSION,
        ARCHIVE_SOURCE_CONTRACT_URL,
    )

    root = Path(source_root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = root / "BTCUSDT-binance-usdm-diff-depth.sqlite3"
    if path.exists():
        path.unlink()
    dataset_epoch = "sha256:" + sha256(
        b"replay-smoke-historical-book:BTCUSDT:v1"
    ).hexdigest()
    def compact(levels: list[list[str]]) -> str:
        return json.dumps(levels, separators=(",", ":"))
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript(
            """
            CREATE TABLE archive_meta (
                singleton INTEGER PRIMARY KEY,
                protocol TEXT NOT NULL,
                schema_version TEXT NOT NULL,
                exchange TEXT NOT NULL,
                market_type TEXT NOT NULL,
                symbol TEXT NOT NULL,
                range_start_ms INTEGER NOT NULL,
                range_end_ms INTEGER NOT NULL,
                dataset_epoch TEXT NOT NULL,
                source TEXT NOT NULL,
                source_contract_url TEXT NOT NULL,
                max_depth_levels INTEGER NOT NULL
            );
            CREATE TABLE book_frame (
                ordinal INTEGER PRIMARY KEY,
                kind TEXT NOT NULL,
                event_time_ms INTEGER NOT NULL,
                transaction_time_ms INTEGER NOT NULL,
                first_update_id INTEGER,
                final_update_id INTEGER NOT NULL,
                previous_final_update_id INTEGER,
                bids_json TEXT NOT NULL,
                asks_json TEXT NOT NULL
            );
            """
        )
        connection.execute(
            """
            INSERT INTO archive_meta VALUES (
                1, ?, ?, 'binance', 'futures', 'BTCUSDT', ?, ?, ?,
                'BINANCE_USDM_DIFF_DEPTH_CAPTURE', ?, 1000
            )
            """,
            (
                ARCHIVE_PROTOCOL,
                ARCHIVE_SCHEMA_VERSION,
                FIXTURE_START_MS,
                FIXTURE_START_MS + HISTORICAL_BOOK_FIXTURE_MINUTES * INTERVAL_MS,
                dataset_epoch,
                ARCHIVE_SOURCE_CONTRACT_URL,
            ),
        )
        connection.execute(
            """
            INSERT INTO book_frame VALUES (
                0, 'SNAPSHOT', ?, ?, NULL, 1000000, NULL, ?, ?
            )
            """,
            (
                FIXTURE_START_MS,
                FIXTURE_START_MS,
                compact([["29999", "20"], ["29998", "30"]]),
                compact([["30001", "20"], ["30002", "30"]]),
            ),
        )
        previous_u = 1_000_000
        for minute in range(1, HISTORICAL_BOOK_FIXTURE_MINUTES + 1):
            final_u = previous_u + 1
            previous_bid = 29_998 + minute
            next_bid = 29_999 + minute
            previous_ask = 30_000 + minute
            next_ask = 30_001 + minute
            event_time_ms = FIXTURE_START_MS + minute * INTERVAL_MS
            connection.execute(
                """
                INSERT INTO book_frame VALUES (
                    ?, 'DELTA', ?, ?, ?, ?, ?, ?, ?
                )
                """,
                (
                    minute,
                    event_time_ms,
                    event_time_ms,
                    previous_u if minute == 1 else final_u,
                    final_u,
                    previous_u,
                    compact(
                        [[str(previous_bid), "0"], [str(next_bid), "20"]]
                    ),
                    compact(
                        [[str(previous_ask), "0"], [str(next_ask), "20"]]
                    ),
                ),
            )
            previous_u = final_u
        connection.commit()
    return path


def _seed_historical_book_futures_bars() -> int:
    """Extend the opt-in USD-M BAR catalog without inventing aggTrade rows."""

    from app.data_engine.storage.klines_repo import upsert_klines

    bars: list[dict[str, object]] = []
    for minute in range(HISTORICAL_BOOK_FIXTURE_MINUTES + 3):
        open_time = FIXTURE_START_MS + minute * INTERVAL_MS
        price = 30_000 + minute % 120
        bars.append(
            {
                "open_time": open_time,
                "close_time": open_time + INTERVAL_MS - 1,
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "volume": 3,
                "quote_volume": price * 3,
                "trades": AGG_TRADE_ROWS_PER_MINUTE,
                "taker_buy_base": 2,
                "taker_buy_quote": price * 2,
            }
        )
    written = upsert_klines(
        "BTCUSDT",
        "1m",
        bars,
        source="replay-smoke-book-fixture",
        exchange="binance",
        market_type="futures",
    )
    if written not in {0, len(bars)}:
        raise RuntimeError(
            f"expected 0 or {len(bars)} historical-book BAR rows, wrote {written}"
        )
    return len(bars)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--agg-trades", action="store_true")
    parser.add_argument("--historical-book", action="store_true")
    args = parser.parse_args()
    _require_isolated_environment()
    _force_offline_upstreams()
    _seed_klines()
    agg_trade_rows = _seed_agg_trades() if args.agg_trades else 0
    historical_book_bar_rows = (
        _seed_historical_book_futures_bars() if args.historical_book else 0
    )
    historical_book_source = (
        _seed_historical_book_source() if args.historical_book else None
    )

    import uvicorn
    from app.api.v1 import symbols as symbols_api

    async def _offline_exchange_metadata(_exchange: str = "") -> dict[str, int]:
        """Prevent full-app startup from making public metadata requests."""

        return {}

    symbols_api.refresh_exchange_metadata = _offline_exchange_metadata

    from app.main import app

    server_holder: dict[str, uvicorn.Server] = {}
    historical_book_archive: dict[str, object] | None = None

    @app.on_event("startup")
    async def import_replay_smoke_historical_book() -> None:
        nonlocal historical_book_archive
        if historical_book_source is None:
            return
        service = getattr(app.state, "replay_service", None)
        training = getattr(service, "training", None)
        if training is None:
            raise RuntimeError(
                "historical-book smoke fixture requires replay training runtime"
            )
        historical_book_archive = await training.historical_books.import_archive(
            historical_book_source,
            trusted_origin="REPLAY_SMOKE_FIXTURE",
        )

    @app.get("/__replay_smoke__/fixture")
    async def replay_smoke_fixture_status() -> dict[str, object]:
        return {
            "offline": True,
            "fixture_start_ms": FIXTURE_START_MS,
            "fixture_rows": FIXTURE_ROWS,
            "fixture_symbols": [symbol for symbol, _price in FIXTURE_SYMBOLS],
            "agg_trade_rows": agg_trade_rows,
            "historical_book_bar_rows": historical_book_bar_rows,
            "historical_book": historical_book_archive,
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
