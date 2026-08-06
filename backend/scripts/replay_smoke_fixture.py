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
from typing import Protocol


# Keep every fixture row on an exact UTC 1m boundary. The replay catalog
# deliberately rejects misaligned source bounds instead of rounding them.
FIXTURE_START_MS = 1_700_000_040_000
FIXTURE_ROWS = 4_000
INTERVAL_MS = 60_000
LEGACY_LIVE_TAIL_ROWS = 10
SOAK_LIVE_SYMBOL = "QAUSDT"
SOAK_LIVE_HISTORY_ROWS = 2_000
SOAK_LIVE_FUTURE_MS = 5 * 60 * 60 * 1_000
SOAK_LIVE_INTERVALS: tuple[tuple[str, int], ...] = (
    ("1m", 60_000),
    ("5m", 5 * 60_000),
    ("15m", 15 * 60_000),
    ("1h", 60 * 60_000),
)
AGG_TRADE_FIXTURE_MINUTES = 1_600
AGG_TRADE_ROWS_PER_MINUTE = 2
HISTORICAL_BOOK_FIXTURE_MINUTES = FIXTURE_ROWS
HEDGE_BROWSER_FORWARD_CACHE_MS = 30 * 24 * 60 * 60 * 1_000
HEDGE_BROWSER_WARMUP_BARS = 200
HEDGE_BROWSER_FIXTURE_MINUTES = (
    HEDGE_BROWSER_FORWARD_CACHE_MS // INTERVAL_MS + HEDGE_BROWSER_WARMUP_BARS
)
HEDGE_BROWSER_SYMBOLS: tuple[tuple[str, int], ...] = (
    ("BTCUSDT", 30_000),
    ("ETHUSDT", 2_000),
)
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


class _ReplayAdapterReleaseBoundary(Protocol):
    async def release_session_to_hub(self, session_id: str) -> None: ...


async def _release_replay_adapter_when_idle(
    service: _ReplayAdapterReleaseBoundary,
    session_id: str,
    *,
    max_attempts: int = 100,
    retry_delay_seconds: float = 0.05,
) -> int:
    """Retry only the service's explicit transient busy signal for local QA."""

    from app.replay.errors import ReplayDomainError, ReplayErrorCode

    for attempt in range(1, max_attempts + 1):
        try:
            await service.release_session_to_hub(session_id)
            return attempt
        except ReplayDomainError as exc:
            if (
                exc.code is not ReplayErrorCode.REVISION_CONFLICT
                or exc.message != "replay session is busy"
                or attempt >= max_attempts
            ):
                raise
            await asyncio.sleep(retry_delay_seconds)
    raise RuntimeError("unreachable replay adapter release retry state")


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


def _disable_fixture_gap_maintenance() -> None:
    """Disable storage repair loops that cannot succeed in the offline fixture."""

    from app.data_engine import runtime

    runtime._start_startup_gap_scan = lambda *_args, **_kwargs: None
    runtime._start_background_gap_audit = lambda *_args, **_kwargs: None


def _fixture_row(
    *,
    index: int,
    open_time: int,
    price_origin: float = 30_000.0,
    interval_ms: int = INTERVAL_MS,
) -> dict[str, object]:
    base = price_origin + (index % 80) * 2.0 + (index // 80) * 0.25
    return {
        "open_time": open_time,
        "close_time": open_time + interval_ms - 1,
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


def _soak_live_window_rows(
    *,
    interval_ms: int,
    now_ms: int | None = None,
) -> list[dict[str, object]]:
    """Build a closed-loop live window that remains gap-free for a 4h soak."""

    current_ms = int(time.time() * 1_000) if now_ms is None else now_ms
    last_closed_open_ms = (current_ms // interval_ms - 1) * interval_ms
    first_open_ms = last_closed_open_ms - (SOAK_LIVE_HISTORY_ROWS - 1) * interval_ms
    last_future_open_ms = (
        (current_ms + SOAK_LIVE_FUTURE_MS) // interval_ms
    ) * interval_ms
    row_count = (last_future_open_ms - first_open_ms) // interval_ms + 1
    return [
        _fixture_row(
            index=index,
            open_time=first_open_ms + index * interval_ms,
            price_origin=25_000.0,
            interval_ms=interval_ms,
        )
        for index in range(row_count)
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


def _smoke_live_tail_required(
    *,
    explicit: bool,
    runtime_backend_root: Path | None = None,
    fixture_backend_root: Path | None = None,
) -> bool:
    """Enable the bounded current tail only for an explicit QA lane or rollback."""

    return explicit or _legacy_live_tail_required(
        runtime_backend_root=runtime_backend_root,
        fixture_backend_root=fixture_backend_root,
    )


def _seed_klines(
    *,
    include_live_tail: bool = False,
    include_soak_live_window: bool = False,
    real_rows_by_symbol: dict[str, list[dict[str, object]]] | None = None,
) -> dict[str, int]:
    from app.data_engine.storage.klines_repo import init_klines_storage, upsert_klines

    init_klines_storage()
    for symbol, price_origin in FIXTURE_SYMBOLS:
        real_rows = (
            None
            if real_rows_by_symbol is None
            else real_rows_by_symbol.get(symbol)
        )
        rows = (
            list(real_rows)
            if real_rows is not None
            else [
                _fixture_row(
                    index=index,
                    open_time=FIXTURE_START_MS + index * INTERVAL_MS,
                    price_origin=price_origin,
                )
                for index in range(FIXTURE_ROWS)
            ]
        )
        if symbol == "BTCUSDT" and include_live_tail:
            rows.extend(_legacy_live_tail_rows())
        inserted = upsert_klines(
            symbol,
            "1m",
            rows,
            source=(
                "replay-real-source-release"
                if real_rows is not None
                else "replay-smoke-fixture"
            ),
            exchange="binance",
            market_type="spot",
        )
        if inserted != len(rows):
            raise RuntimeError(
                f"expected {len(rows)} {symbol} fixture rows, wrote {inserted}"
            )
    live_window_rows: dict[str, int] = {}
    if include_soak_live_window:
        now_ms = int(time.time() * 1_000)
        for interval, interval_ms in SOAK_LIVE_INTERVALS:
            rows = _soak_live_window_rows(
                interval_ms=interval_ms,
                now_ms=now_ms,
            )
            inserted = upsert_klines(
                SOAK_LIVE_SYMBOL,
                interval,
                rows,
                source="replay-soak-live-window",
                exchange="binance",
                market_type="spot",
            )
            if inserted != len(rows):
                raise RuntimeError(
                    f"expected {len(rows)} {SOAK_LIVE_SYMBOL} {interval} live rows, "
                    f"wrote {inserted}"
                )
            live_window_rows[interval] = len(rows)
    return live_window_rows


def _seed_replay_history_archive() -> list[dict[str, object]]:
    """Publish the isolated K-line fixture through the production archive seam."""

    from app.replay.catalog import ReplaySeriesIdentity
    from app.replay.history_archive import (
        ReplayHistoryArchiveWriter,
        ReplayHistoryImportBatch,
    )

    database = Path(os.environ["KLINES_DB_PATH"]).expanduser().resolve()
    archive_root = Path(
        os.environ.get(
            "REPLAY_HISTORY_ARCHIVE_DIR",
            str(
                Path(os.environ["CANDLE_DATA_DIR"]).expanduser().resolve()
                / "replay-history"
            ),
        )
    ).expanduser().resolve()
    writer = ReplayHistoryArchiveWriter(archive_root)
    manifests: list[dict[str, object]] = []
    with closing(sqlite3.connect(database)) as connection:
        connection.row_factory = sqlite3.Row
        series = connection.execute(
            """
            SELECT DISTINCT exchange, market_type, symbol, interval
            FROM klines
            ORDER BY exchange, market_type, symbol, interval
            """
        ).fetchall()
        for item in series:
            identity = ReplaySeriesIdentity(
                exchange=str(item["exchange"]),
                market_type=str(item["market_type"]),
                symbol=str(item["symbol"]),
            )
            interval = str(item["interval"])
            rows = [
                dict(row)
                for row in connection.execute(
                    """
                    SELECT open_time, close_time, open, high, low, close,
                           volume, quote_volume, trades, taker_buy_base,
                           taker_buy_quote, source
                    FROM klines
                    WHERE exchange = ? AND market_type = ?
                      AND symbol = ? AND interval = ?
                    ORDER BY open_time
                    """,
                    (
                        identity.exchange,
                        identity.market_type,
                        identity.symbol,
                        interval,
                    ),
                ).fetchall()
            ]
            content_sha256 = "sha256:" + sha256(
                json.dumps(
                    rows,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                ).encode("utf-8")
            ).hexdigest()
            manifest = writer.import_batches(
                identity,
                interval,
                [
                    ReplayHistoryImportBatch(
                        rows=rows,
                        source_provider="replay-browser-qa-verified-sqlite-v1",
                        source_object_key=(
                            f"{identity.exchange}/{identity.market_type}/"
                            f"{identity.symbol}/{interval}"
                        ),
                        source_period="bounded-release-fixture",
                        source_content_sha256=content_sha256,
                        source_row_count=len(rows),
                    )
                ],
                merge_current=False,
                listing_boundary_source="verified_fixture_first_bar",
            )
            manifests.append(
                {
                    "exchange": identity.exchange,
                    "market_type": identity.market_type,
                    "symbol": identity.symbol,
                    "interval": interval,
                    "catalog_epoch": manifest.catalog_epoch,
                    "total_count": manifest.total_count,
                }
            )
    return manifests


def _load_real_kline_profile(
    source_path: Path,
    *,
    required_rows: int | None = None,
) -> tuple[dict[str, list[dict[str, object]]], dict[str, object]]:
    """Validate and copy only the bounded real identities used by release QA."""

    from scripts.validate_replay_v2_real_sources import (
        DEFAULT_WINDOW_ROWS,
        _read_only_connection,
        validate_kline_source,
    )

    window_rows = DEFAULT_WINDOW_ROWS if required_rows is None else required_rows
    if (
        isinstance(window_rows, bool)
        or not isinstance(window_rows, int)
        or window_rows < 2
    ):
        raise ValueError("real K-line profile requires at least two rows")
    raw_source = source_path.expanduser()
    if raw_source.is_symlink():
        raise RuntimeError("real K-line release source must not be a symlink")
    source = raw_source.resolve()
    target = Path(os.environ["KLINES_DB_PATH"]).expanduser().resolve()
    if source == target:
        raise RuntimeError("real K-line source cannot be the isolated fixture target")
    validation = validate_kline_source(
        source,
        required_rows=window_rows,
    )
    rows_by_symbol: dict[str, list[dict[str, object]]] = {}
    identities = validation.get("identities")
    if not isinstance(identities, list):
        raise RuntimeError("real K-line validation did not return identities")
    with _read_only_connection(source) as connection:
        for identity in identities:
            if not isinstance(identity, dict):
                raise RuntimeError("real K-line identity evidence is malformed")
            symbol = str(identity["symbol"])
            rows = connection.execute(
                """
                SELECT
                    open_time, close_time, open, high, low, close, volume,
                    quote_volume, trades, taker_buy_base, taker_buy_quote
                FROM klines
                WHERE exchange = 'binance'
                  AND market_type = 'spot'
                  AND symbol = ?
                  AND interval = '1m'
                  AND open_time >= ?
                  AND close_time <= ?
                ORDER BY open_time
                """,
                (
                    symbol,
                    int(identity["range_start_ms"]),
                    int(identity["range_end_ms"]),
                ),
            ).fetchall()
            if len(rows) != window_rows:
                raise RuntimeError(
                    f"real K-line release window drifted for {symbol}: {len(rows)}"
                )
            rows_by_symbol[symbol] = [
                {
                    "open_time": int(row[0]),
                    "close_time": int(row[1]),
                    "open": row[2],
                    "high": row[3],
                    "low": row[4],
                    "close": row[5],
                    "volume": row[6],
                    "quote_volume": row[7],
                    "trades": int(row[8]),
                    "taker_buy_base": row[9],
                    "taker_buy_quote": row[10],
                }
                for row in rows
            ]
    return rows_by_symbol, {
        "kind": validation["kind"],
        "file_name": validation["file_name"],
        "file_bytes": validation["file_bytes"],
        "file_sha256": validation["file_sha256"],
        "read_only": validation["read_only"],
        "window_rows": window_rows,
        "identities": identities,
    }


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


def _seed_historical_book_source(
    *,
    symbol: str = "BTCUSDT",
    price_origin: int = 30_000,
    fixture_minutes: int = HISTORICAL_BOOK_FIXTURE_MINUTES,
) -> Path:
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
    path = root / f"{symbol}-binance-usdm-diff-depth.sqlite3"
    if path.exists():
        path.unlink()
    dataset_epoch = "sha256:" + sha256(
        f"replay-smoke-historical-book:{symbol}:v2:{fixture_minutes}".encode()
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
                1, ?, ?, 'binance', 'futures', ?, ?, ?, ?,
                'BINANCE_USDM_DIFF_DEPTH_CAPTURE', ?, 1000
            )
            """,
            (
                ARCHIVE_PROTOCOL,
                ARCHIVE_SCHEMA_VERSION,
                symbol,
                FIXTURE_START_MS,
                FIXTURE_START_MS + fixture_minutes * INTERVAL_MS,
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
                compact(
                    [
                        [str(price_origin - 1), "20"],
                        [str(price_origin - 2), "30"],
                    ]
                ),
                compact(
                    [
                        [str(price_origin + 1), "20"],
                        [str(price_origin + 2), "30"],
                    ]
                ),
            ),
        )
        previous_u = 1_000_000
        previous_bid_levels = {
            str(price_origin - 1): "20",
            str(price_origin - 2): "30",
        }
        previous_ask_levels = {
            str(price_origin + 1): "20",
            str(price_origin + 2): "30",
        }
        for minute in range(1, fixture_minutes + 1):
            final_u = previous_u + 1
            mid = price_origin + minute % 120
            next_bid_levels = {str(mid - 1): "20", str(mid - 2): "30"}
            next_ask_levels = {str(mid + 1): "20", str(mid + 2): "30"}
            bid_changes = {
                **{
                    price: "0"
                    for price in previous_bid_levels
                    if price not in next_bid_levels
                },
                **next_bid_levels,
            }
            ask_changes = {
                **{
                    price: "0"
                    for price in previous_ask_levels
                    if price not in next_ask_levels
                },
                **next_ask_levels,
            }
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
                    compact([[price, quantity] for price, quantity in bid_changes.items()]),
                    compact([[price, quantity] for price, quantity in ask_changes.items()]),
                ),
            )
            previous_u = final_u
            previous_bid_levels = next_bid_levels
            previous_ask_levels = next_ask_levels
        connection.commit()
    return path


def _seed_historical_book_futures_bars(
    *,
    symbols: tuple[tuple[str, int], ...] = (("BTCUSDT", 30_000),),
    fixture_minutes: int = HISTORICAL_BOOK_FIXTURE_MINUTES,
) -> int:
    """Extend the opt-in USD-M BAR catalog without inventing aggTrade rows."""

    from app.data_engine.storage.klines_repo import upsert_klines

    total = 0
    for symbol, price_origin in symbols:
        bars: list[dict[str, object]] = []
        for minute in range(fixture_minutes + 1):
            open_time = FIXTURE_START_MS + minute * INTERVAL_MS
            price = price_origin + minute % 120
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
            symbol,
            "1m",
            bars,
            source="replay-smoke-book-fixture",
            exchange="binance",
            market_type="futures",
        )
        if written not in {0, len(bars)}:
            raise RuntimeError(
                f"expected 0 or {len(bars)} {symbol} historical-book BAR rows, "
                f"wrote {written}"
            )
        total += len(bars)
    return total


async def _seed_hedge_browser_inputs(
    training: object,
    *,
    book_archives: dict[str, dict[str, object]],
    source_root: Path,
) -> dict[str, object]:
    """Build immutable public archives and one versioned private-state model.

    These inputs are deterministic browser-QA captures.  They exercise the
    production verifiers and owned archive path, but never claim to be a
    historical exchange insurance fund or ADL queue.
    """

    from app.replay.training.hedge_inputs import (
        build_hedge_public_history_archive,
        build_hedge_simulation_manifest,
    )

    range_start_ms = FIXTURE_START_MS
    range_end_ms = FIXTURE_START_MS + HEDGE_BROWSER_FIXTURE_MINUTES * INTERVAL_MS
    public_refs: dict[str, dict[str, object]] = {}
    rule = {
        "rule_version": "BINANCE_USDM_LINEAR_V1",
        "price_tick": "0.1",
        "quantity_step": "0.001",
        "min_quantity": "0.001",
        "max_quantity": "100",
        "min_notional": "5",
        "max_notional": "1000000",
        "quote_step": "0.01",
        "contract_size": "1",
        "max_leverage": "20",
        "liquidation_fee_bps": "25",
        "maintenance_tiers": [
            {
                "notional_cap": "50000",
                "maintenance_rate": "0.005",
                "maintenance_deduction": "0",
            },
            {
                "notional_cap": "1000000",
                "maintenance_rate": "0.01",
                "maintenance_deduction": "250",
            },
        ],
    }
    fee_policy = {
        "policy_version": "BINANCE_VIP0_V1",
        "account_tier": "VIP0",
        "maker_fee_bps": "2",
        "taker_fee_bps": "5",
        "liquidation_fee_bps": "25",
    }
    for symbol, price_origin in HEDGE_BROWSER_SYMBOLS:
        book = book_archives[symbol]
        events: list[dict[str, object]] = [
            {"event_time_ms": range_start_ms, "event_kind": "RULE", "payload": rule},
            {
                "event_time_ms": range_start_ms,
                "event_kind": "FEE_POLICY",
                "payload": fee_policy,
            },
        ]
        for minute in range(HEDGE_BROWSER_FIXTURE_MINUTES + 1):
            mark = str(price_origin + minute % 120)
            events.append(
                {
                    "event_time_ms": range_start_ms + minute * INTERVAL_MS,
                    "event_kind": "MARK_INDEX",
                    "payload": {"mark_price": mark, "index_price": mark},
                }
            )
        for minute in range(480, HEDGE_BROWSER_FIXTURE_MINUTES + 1, 480):
            mark = str(price_origin + minute % 120)
            events.append(
                {
                    "event_time_ms": range_start_ms + minute * INTERVAL_MS,
                    "event_kind": "FUNDING",
                    "payload": {"funding_rate": "0.0001", "mark_price": mark},
                }
            )
        events.sort(
            key=lambda item: (
                int(item["event_time_ms"]),
                {"RULE": 10, "FEE_POLICY": 10, "MARK_INDEX": 30, "FUNDING": 40}[
                    str(item["event_kind"])
                ],
                str(item["event_kind"]),
            )
        )
        public_path = source_root / f"{symbol}-hedge-public.json"
        public_ref = build_hedge_public_history_archive(
            public_path,
            archive_id=f"replay-browser-qa-{symbol.lower()}-public-v1",
            exchange="binance",
            market_type="futures",
            symbol=symbol,
            settlement_asset="USDT",
            range_start_ms=range_start_ms,
            range_end_ms=range_end_ms,
            max_mark_gap_ms=INTERVAL_MS,
            source_identity="REPLAY_BROWSER_QA_PINNED_PUBLIC_CAPTURE",
            capture_receipt=f"receipt:replay-browser-qa:{symbol}:v1",
            historical_l2_ref={
                "archive_id": book["archive_id"],
                "dataset_epoch": book["dataset_epoch"],
                "checksum_sha256": book["checksum_sha256"],
            },
            events=events,
        )
        await training.hedge_inputs.import_public(public_path)
        public_refs[symbol] = public_ref

    simulation_path = source_root / "hedge-simulation.json"
    simulation_ref = build_hedge_simulation_manifest(
        simulation_path,
        manifest_id="replay-browser-qa-simulation-v1",
        range_start_ms=range_start_ms,
        range_end_ms=range_end_ms,
        settlement_asset="USDT",
        required_symbols=[symbol for symbol, _ in HEDGE_BROWSER_SYMBOLS],
        insurance_events=[
            {
                "effective_time_ms": range_start_ms,
                "kind": "OPENING_BALANCE",
                "amount": "1000000000",
            }
        ],
        adl_snapshots=[
            {
                "symbol": symbol,
                "effective_time_ms": range_start_ms,
                "valid_until_ms": range_end_ms,
                "candidates": [
                    {
                        "candidate_id": f"replay-browser-qa-{symbol.lower()}-short-1",
                        "symbol": symbol,
                        "position_side": "SHORT",
                        "quantity": "100",
                        "entry_price": str(price_origin + 100),
                        "mark_price": str(price_origin),
                        "initial_margin": "500",
                        "margin_balance": "1000",
                    }
                ],
            }
            for symbol, price_origin in HEDGE_BROWSER_SYMBOLS
        ],
    )
    await training.hedge_inputs.import_simulation(simulation_path)
    return {
        "fidelity": "PINNED_PUBLIC_EXACT_PRIVATE_DETERMINISTIC_SIMULATION",
        "fallback_applied": False,
        "range_start_ms": range_start_ms,
        "range_end_ms": range_end_ms,
        "public_refs": public_refs,
        "simulation_ref": simulation_ref,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--agg-trades", action="store_true")
    parser.add_argument("--historical-book", action="store_true")
    parser.add_argument("--hedge", action="store_true")
    parser.add_argument("--live-tail", action="store_true")
    parser.add_argument("--live-window", action="store_true")
    parser.add_argument("--real-klines-source", type=Path)
    parser.add_argument("--real-kline-window-rows", type=int)
    parser.add_argument("--disable-gap-maintenance", action="store_true")
    args = parser.parse_args()
    if args.real_kline_window_rows is not None and args.real_klines_source is None:
        parser.error("--real-kline-window-rows requires --real-klines-source")
    if args.hedge and not args.historical_book:
        parser.error("--hedge requires --historical-book")
    if (
        args.real_kline_window_rows is not None
        and args.real_kline_window_rows < 2
    ):
        parser.error("--real-kline-window-rows must be >= 2")
    _require_isolated_environment()
    _force_offline_upstreams()
    live_tail_enabled = _smoke_live_tail_required(explicit=args.live_tail)
    real_rows_by_symbol: dict[str, list[dict[str, object]]] | None = None
    real_source_evidence: dict[str, object] | None = None
    if args.real_klines_source is not None:
        real_rows_by_symbol, real_source_evidence = _load_real_kline_profile(
            args.real_klines_source,
            required_rows=args.real_kline_window_rows,
        )
    live_window_rows = _seed_klines(
        include_live_tail=live_tail_enabled,
        include_soak_live_window=args.live_window,
        real_rows_by_symbol=real_rows_by_symbol,
    )
    agg_trade_rows = _seed_agg_trades() if args.agg_trades else 0
    historical_book_symbols = (
        HEDGE_BROWSER_SYMBOLS if args.hedge else (("BTCUSDT", 30_000),)
    )
    historical_book_minutes = (
        HEDGE_BROWSER_FIXTURE_MINUTES
        if args.hedge
        else HISTORICAL_BOOK_FIXTURE_MINUTES
    )
    historical_book_bar_rows = (
        _seed_historical_book_futures_bars(
            symbols=historical_book_symbols,
            fixture_minutes=historical_book_minutes,
        )
        if args.historical_book
        else 0
    )
    historical_book_sources = (
        {
            symbol: _seed_historical_book_source(
                symbol=symbol,
                price_origin=price_origin,
                fixture_minutes=historical_book_minutes,
            )
            for symbol, price_origin in historical_book_symbols
        }
        if args.historical_book
        else {}
    )
    replay_history_manifests = _seed_replay_history_archive()
    if args.disable_gap_maintenance:
        _disable_fixture_gap_maintenance()

    import uvicorn
    from app.api.v1 import symbols as symbols_api

    async def _offline_exchange_metadata(_exchange: str = "") -> dict[str, int]:
        """Prevent full-app startup from making public metadata requests."""

        return {}

    symbols_api.refresh_exchange_metadata = _offline_exchange_metadata

    from app.main import app

    server_holder: dict[str, uvicorn.Server] = {}
    historical_book_archives: dict[str, dict[str, object]] = {}
    hedge_inputs: dict[str, object] | None = None

    @app.on_event("startup")
    async def import_replay_smoke_historical_book() -> None:
        nonlocal hedge_inputs
        if not historical_book_sources:
            return
        service = getattr(app.state, "replay_service", None)
        training = getattr(service, "training", None)
        if training is None:
            raise RuntimeError(
                "historical-book smoke fixture requires replay training runtime"
            )
        for symbol, source in historical_book_sources.items():
            historical_book_archives[symbol] = (
                await training.historical_books.import_archive(
                    source,
                    trusted_origin="REPLAY_SMOKE_FIXTURE",
                )
            )
        if args.hedge:
            hedge_inputs = await _seed_hedge_browser_inputs(
                training,
                book_archives=historical_book_archives,
                source_root=Path(
                    os.environ["REPLAY_SMOKE_BOOK_SOURCE_DIR"]
                ).expanduser().resolve(),
            )

    @app.get("/__replay_smoke__/fixture")
    async def replay_smoke_fixture_status() -> dict[str, object]:
        return {
            "offline": True,
            "source_profile": (
                "HEDGE_EXACT_ARCHIVE_QA"
                if args.hedge
                else "REAL_BAR_SQLITE"
                if real_source_evidence is not None
                else "SYNTHETIC_DETERMINISTIC"
            ),
            "real_source": real_source_evidence is not None,
            "real_source_evidence": real_source_evidence,
            "fixture_start_ms": FIXTURE_START_MS,
            "fixture_rows": FIXTURE_ROWS,
            "fixture_symbols": [symbol for symbol, _price in FIXTURE_SYMBOLS],
            "live_tail_rows": LEGACY_LIVE_TAIL_ROWS if live_tail_enabled else 0,
            "live_window": (
                {
                    "symbol": SOAK_LIVE_SYMBOL,
                    "rows_by_interval": live_window_rows,
                    "future_horizon_ms": SOAK_LIVE_FUTURE_MS,
                }
                if live_window_rows
                else None
            ),
            "gap_maintenance_enabled": not args.disable_gap_maintenance,
            "agg_trade_rows": agg_trade_rows,
            "historical_book_bar_rows": historical_book_bar_rows,
            "replay_history_manifests": replay_history_manifests,
            "historical_book": historical_book_archives or None,
            "hedge_inputs": hedge_inputs,
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

    @app.post("/__replay_smoke__/evict-replay-adapter/{session_id}")
    async def evict_replay_adapter(session_id: str) -> dict[str, object]:
        """Force one durable adapter eviction for browser recovery QA."""

        from fastapi import HTTPException

        service = getattr(app.state, "replay_service", None)
        if service is None:
            raise HTTPException(status_code=404, detail="fixture replay service not found")
        before = service.diagnostics(redact_paths=True)
        release_attempts = await _release_replay_adapter_when_idle(service, session_id)
        after = service.diagnostics(redact_paths=True)
        return {
            "evicted": True,
            "session_id": session_id,
            "release_attempts": release_attempts,
            "sessions_evicted_before": int(before["sessions_evicted"]),
            "sessions_evicted_after": int(after["sessions_evicted"]),
            "hub_sessions_evicted_before": int(before["hub_sessions_evicted"]),
            "hub_sessions_evicted_after": int(after["hub_sessions_evicted"]),
        }

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
