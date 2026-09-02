from __future__ import annotations

import sqlite3
import time
import logging
import threading
from contextlib import nullcontext
from pathlib import Path
from typing import Any, Callable

from app.core.config import KLINES_DB_PATH
from app.core.executors import run_storage
from app.data_engine.kline_quality import source_rank_sql
from app.data_engine.history.calendar import (
    AlwaysOpenCalendar,
    CalendarRegistry,
    TradingCalendar,
)
from app.data_engine.interval_policy import INTERVAL_SECONDS, VALID_INTERVALS, parse_interval_ms
from app.data_engine.series_identity import (
    DEFAULT_ASSET_CLASS,
    DEFAULT_PRICE_ADJUSTMENT,
    DEFAULT_SERIES_VARIANT,
    DEFAULT_SESSION_VARIANT,
    DEFAULT_VOLUME_SEMANTICS,
    KlineSeriesIdentity,
    resolve_kline_series_identity,
)

from .sqlite_runtime import SQLiteConnectionPolicy, open_sqlite

# Valid market types
VALID_MARKET_TYPES = ("spot", "futures", "swap")
DEFAULT_EXCHANGE = "binance"
DEFAULT_MARKET_TYPE = "spot"
_SERIES_IDENTITY_COLUMNS = (
    "provider_id",
    "venue",
    "asset_class",
    "series_variant",
    "price_adjustment",
    "session_variant",
    "volume_semantics",
)
_KLINES_PRIMARY_KEY = (
    "exchange",
    "market_type",
    "provider_id",
    "venue",
    "asset_class",
    "symbol",
    "interval",
    "series_variant",
    "price_adjustment",
    "session_variant",
    "volume_semantics",
    "open_time",
)
_KLINES_CONFLICT_TARGET_SQL = ", ".join(_KLINES_PRIMARY_KEY)
_SERIES_IDENTITY_PREDICATE_SQL = " AND ".join(
    f"{column} = ?" for column in _SERIES_IDENTITY_COLUMNS
)
logger = logging.getLogger("candlescope.storage.klines")
CalendarResolver = Callable[
    [str, str, str],
    TradingCalendar | str | None,
]
_CALENDAR_REGISTRY = CalendarRegistry()
_ALWAYS_OPEN_CALENDAR = (
    _CALENDAR_REGISTRY.get("crypto.24x7.utc") or AlwaysOpenCalendar()
)
# SQLite already serializes writers, but this explicit process-wide guard
# prevents several archive reconciliation tasks from occupying storage-worker
# threads while waiting on the same database write lock.  The guard lives in
# synchronous code, so cancellation cannot release ownership before the
# physical transaction has committed or rolled back.
_ARCHIVE_IMPORT_WRITE_LOCK = threading.Lock()

KlineBarComponents = tuple[
    Any,
    Any,
    Any,
    Any,
    Any,
    Any,
    Any,
    Any,
    Any,
    Any,
    Any,
]
_BAR_COMPONENT_PROJECTION = """
    open_time, open, high, low, close, volume,
    quote_volume, trades, taker_buy_base, taker_buy_quote, source
"""


def _create_klines_table_sql(table_name: str) -> str:
    return f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            exchange TEXT NOT NULL DEFAULT '{DEFAULT_EXCHANGE}',
            market_type TEXT NOT NULL DEFAULT '{DEFAULT_MARKET_TYPE}',
            provider_id TEXT NOT NULL DEFAULT '{DEFAULT_EXCHANGE}',
            venue TEXT NOT NULL DEFAULT '{DEFAULT_EXCHANGE}',
            asset_class TEXT NOT NULL DEFAULT '{DEFAULT_ASSET_CLASS}',
            symbol TEXT NOT NULL,
            interval TEXT NOT NULL,
            series_variant TEXT NOT NULL DEFAULT '{DEFAULT_SERIES_VARIANT}',
            price_adjustment TEXT NOT NULL DEFAULT '{DEFAULT_PRICE_ADJUSTMENT}',
            session_variant TEXT NOT NULL DEFAULT '{DEFAULT_SESSION_VARIANT}',
            volume_semantics TEXT NOT NULL DEFAULT '{DEFAULT_VOLUME_SEMANTICS}',
            open_time INTEGER NOT NULL,
            close_time INTEGER,
            open REAL NOT NULL,
            high REAL NOT NULL,
            low REAL NOT NULL,
            close REAL NOT NULL,
            volume REAL NOT NULL,
            quote_volume REAL,
            trades INTEGER,
            taker_buy_base REAL,
            taker_buy_quote REAL,
            source TEXT NOT NULL DEFAULT '{DEFAULT_EXCHANGE}',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY ({', '.join(_KLINES_PRIMARY_KEY)})
        )
    """


def _resolved_identity(
    exchange: str,
    series_identity: KlineSeriesIdentity | None,
) -> KlineSeriesIdentity:
    return resolve_kline_series_identity(exchange, series_identity)


def _series_where(
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    interval: str,
    series_identity: KlineSeriesIdentity | None,
) -> tuple[list[str], list[object], KlineSeriesIdentity]:
    identity = _resolved_identity(exchange, series_identity)
    where = [
        "exchange = ?",
        "market_type = ?",
        "symbol = ?",
        "interval = ?",
        *[f"{column} = ?" for column in _SERIES_IDENTITY_COLUMNS],
    ]
    params: list[object] = [
        exchange,
        market_type,
        symbol,
        interval,
        *identity.storage_values,
    ]
    return where, params, identity


def interval_to_milliseconds(interval: str) -> int:
    if interval not in INTERVAL_SECONDS:
        raise ValueError(f"Unsupported interval: {interval}")
    return INTERVAL_SECONDS[interval] * 1000


def _connect(
    *,
    timeout_seconds: float = 30.0,
    configure_journal_mode: bool = True,
    use_row_factory: bool = True,
) -> sqlite3.Connection:
    return open_sqlite(
        KLINES_DB_PATH,
        policy=SQLiteConnectionPolicy(
            timeout_seconds=max(0.0, float(timeout_seconds)),
            busy_timeout_ms=max(0, round(float(timeout_seconds) * 1000)),
            use_row_factory=use_row_factory,
            configure_journal_mode=configure_journal_mode,
        ),
        logger=logger,
    )


def _migrate_kline_series_identity(conn: sqlite3.Connection) -> None:
    """Rebuild legacy K-line tables with the complete semantic primary key."""

    table_info = conn.execute("PRAGMA table_info(klines)").fetchall()
    columns = {str(row[1]) for row in table_info}
    primary_key = tuple(
        str(row[1])
        for row in sorted(table_info, key=lambda item: int(item[5]))
        if int(row[5]) > 0
    )
    if set(_SERIES_IDENTITY_COLUMNS) <= columns and primary_key == _KLINES_PRIMARY_KEY:
        return

    logger.info("Migrating K-line storage to semantic series identity")
    exchange_expr = (
        "COALESCE(NULLIF(TRIM(exchange), ''), "
        f"'{DEFAULT_EXCHANGE}')"
        if "exchange" in columns
        else f"'{DEFAULT_EXCHANGE}'"
    )
    market_type_expr = (
        "COALESCE(NULLIF(TRIM(market_type), ''), "
        f"'{DEFAULT_MARKET_TYPE}')"
        if "market_type" in columns
        else f"'{DEFAULT_MARKET_TYPE}'"
    )
    identity_expr = {
        "provider_id": (
            "COALESCE(NULLIF(TRIM(provider_id), ''), " + exchange_expr + ")"
            if "provider_id" in columns else exchange_expr
        ),
        "venue": (
            "COALESCE(NULLIF(TRIM(venue), ''), " + exchange_expr + ")"
            if "venue" in columns else exchange_expr
        ),
        "asset_class": (
            f"COALESCE(NULLIF(TRIM(asset_class), ''), '{DEFAULT_ASSET_CLASS}')"
            if "asset_class" in columns else f"'{DEFAULT_ASSET_CLASS}'"
        ),
        "series_variant": (
            f"COALESCE(NULLIF(TRIM(series_variant), ''), '{DEFAULT_SERIES_VARIANT}')"
            if "series_variant" in columns else f"'{DEFAULT_SERIES_VARIANT}'"
        ),
        "price_adjustment": (
            f"COALESCE(NULLIF(TRIM(price_adjustment), ''), '{DEFAULT_PRICE_ADJUSTMENT}')"
            if "price_adjustment" in columns else f"'{DEFAULT_PRICE_ADJUSTMENT}'"
        ),
        "session_variant": (
            f"COALESCE(NULLIF(TRIM(session_variant), ''), '{DEFAULT_SESSION_VARIANT}')"
            if "session_variant" in columns else f"'{DEFAULT_SESSION_VARIANT}'"
        ),
        "volume_semantics": (
            f"COALESCE(NULLIF(TRIM(volume_semantics), ''), '{DEFAULT_VOLUME_SEMANTICS}')"
            if "volume_semantics" in columns else f"'{DEFAULT_VOLUME_SEMANTICS}'"
        ),
    }
    conn.execute("DROP TABLE IF EXISTS klines_new")
    conn.execute(_create_klines_table_sql("klines_new"))
    conn.execute(
        f"""
        INSERT OR IGNORE INTO klines_new (
            exchange, market_type, provider_id, venue, asset_class,
            symbol, interval, series_variant, price_adjustment,
            session_variant, volume_semantics, open_time,
            close_time, open, high, low, close, volume,
            quote_volume, trades, taker_buy_base, taker_buy_quote,
            source, created_at, updated_at
        )
        SELECT
            {exchange_expr}, {market_type_expr},
            {identity_expr['provider_id']}, {identity_expr['venue']},
            {identity_expr['asset_class']}, symbol, interval,
            {identity_expr['series_variant']},
            {identity_expr['price_adjustment']},
            {identity_expr['session_variant']},
            {identity_expr['volume_semantics']}, open_time,
            close_time, open, high, low, close, volume,
            quote_volume, trades, taker_buy_base, taker_buy_quote,
            source, created_at, updated_at
        FROM klines
        """
    )
    conn.execute("DROP TABLE klines")
    conn.execute("ALTER TABLE klines_new RENAME TO klines")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_klines_lookup ON klines("
        + ", ".join(_KLINES_PRIMARY_KEY)
        + ")"
    )
    logger.info("K-line semantic identity migration complete")


def init_klines_storage() -> None:
    Path(KLINES_DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        # Step 1: Create the table if it doesn't exist (fresh install)
        conn.execute(_create_klines_table_sql("klines"))

        # Step 2: Migrate old schema if needed (adds exchange/market_type columns)
        _migrate_kline_series_identity(conn)

        # Step 3: Create index (safe after migration)
        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_klines_lookup
            ON klines(
                exchange, market_type, provider_id, venue, asset_class,
                symbol, interval, series_variant, price_adjustment,
                session_variant, volume_semantics, open_time
            );

            CREATE TABLE IF NOT EXISTS history_archive_imports (
                object_key TEXT PRIMARY KEY,
                provider_id TEXT NOT NULL,
                exchange TEXT NOT NULL,
                market_type TEXT NOT NULL,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                granularity TEXT NOT NULL,
                period TEXT NOT NULL,
                start_ms INTEGER NOT NULL,
                end_ms INTEGER NOT NULL,
                content_sha256 TEXT NOT NULL,
                provider_checksum TEXT,
                source_url TEXT NOT NULL,
                row_count INTEGER NOT NULL,
                revision_changed INTEGER NOT NULL DEFAULT 0,
                import_version TEXT NOT NULL DEFAULT 'history-archive-import.v1',
                imported_at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_history_archive_import_series
            ON history_archive_imports(
                exchange, market_type, symbol, interval, start_ms, end_ms
            );
            """
        )
        receipt_columns = {
            row[1]
            for row in conn.execute(
                "PRAGMA table_info(history_archive_imports)"
            ).fetchall()
        }
        if "import_version" not in receipt_columns:
            conn.execute(
                "ALTER TABLE history_archive_imports ADD COLUMN import_version "
                "TEXT NOT NULL DEFAULT 'history-archive-import.v1'"
            )

        from app.data_engine.manual_history.repository import init_manual_history_storage

        init_manual_history_storage(conn)


def dataframe_to_rows(df: Any) -> list[dict]:
    # Pandas is only needed by this legacy conversion helper.  Keeping it out
    # of the module import path avoids paying its sizeable startup/RSS cost for
    # every API worker and storage subprocess.
    import pandas as pd

    if df is None or df.empty:
        return []

    rows: list[dict] = []
    for _, row in df.iterrows():
        rows.append(
            {
                "open_time": int(row["openTimeStamp"]),
                "close_time": int(row["closeTimeStamp"]),
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": float(row["Volume"]),
                "quote_volume": float(row["QuoteVolume"]),
                "trades": int(row["Trades"]) if pd.notna(row["Trades"]) else None,
                "taker_buy_base": float(row["TakerBuyBase"]),
                "taker_buy_quote": float(row["TakerBuyQuote"]),
            }
        )
    return rows


def upsert_klines(
    symbol: str,
    interval: str,
    rows: list[dict],
    source: str = "binance",
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    series_identity: KlineSeriesIdentity | None = None,
) -> int:
    if not rows:
        return 0

    identity = _resolved_identity(exchange, series_identity)
    now_ms = int(time.time() * 1000)
    payload = [
        (
            exchange,
            market_type,
            *identity.storage_values,
            symbol,
            interval,
            r["open_time"],
            r["close_time"],
            r["open"],
            r["high"],
            r["low"],
            r["close"],
            r["volume"],
            r["quote_volume"],
            r["trades"],
            r["taker_buy_base"],
            r["taker_buy_quote"],
            source,
            now_ms,
            now_ms,
        )
        for r in rows
    ]

    write_guard = (
        _ARCHIVE_IMPORT_WRITE_LOCK
        if str(source).startswith("backfill_archive_")
        else nullcontext()
    )
    with write_guard:
        with _connect() as conn:
            incoming_rank_sql = source_rank_sql("excluded.source")
            stored_rank_sql = source_rank_sql("klines.source")
            changes_before = conn.total_changes
            columns = {
                str(row[1]) for row in conn.execute("PRAGMA table_info(klines)")
            }
            semantic_schema = set(_SERIES_IDENTITY_COLUMNS) <= columns
            if not semantic_schema and not identity.is_legacy_default_for(exchange):
                raise RuntimeError(
                    "non-default series identity requires K-line schema version 2"
                )
            if semantic_schema:
                sql = f"""
                INSERT INTO klines (
                    exchange, market_type, provider_id, venue, asset_class,
                    series_variant, price_adjustment, session_variant,
                    volume_semantics, symbol, interval, open_time,
                    close_time, open, high, low, close, volume, quote_volume,
                    trades, taker_buy_base, taker_buy_quote,
                    source, created_at, updated_at
                ) VALUES ({', '.join('?' for _ in range(25))})
                ON CONFLICT({_KLINES_CONFLICT_TARGET_SQL}) DO UPDATE SET
                    close_time = excluded.close_time,
                    open = excluded.open,
                    high = excluded.high,
                    low = excluded.low,
                    close = excluded.close,
                    volume = excluded.volume,
                    quote_volume = excluded.quote_volume,
                    trades = excluded.trades,
                    taker_buy_base = excluded.taker_buy_base,
                    taker_buy_quote = excluded.taker_buy_quote,
                    source = excluded.source,
                    updated_at = excluded.updated_at
                WHERE {incoming_rank_sql} >= {stored_rank_sql}
                """
                write_payload = payload
            else:
                sql = f"""
                INSERT INTO klines (
                    exchange, market_type, symbol, interval, open_time,
                    close_time, open, high, low, close, volume, quote_volume,
                    trades, taker_buy_base, taker_buy_quote,
                    source, created_at, updated_at
                ) VALUES ({', '.join('?' for _ in range(18))})
                ON CONFLICT(exchange, market_type, symbol, interval, open_time) DO UPDATE SET
                    close_time = excluded.close_time,
                    open = excluded.open,
                    high = excluded.high,
                    low = excluded.low,
                    close = excluded.close,
                    volume = excluded.volume,
                    quote_volume = excluded.quote_volume,
                    trades = excluded.trades,
                    taker_buy_base = excluded.taker_buy_base,
                    taker_buy_quote = excluded.taker_buy_quote,
                    source = excluded.source,
                    updated_at = excluded.updated_at
                WHERE {incoming_rank_sql} >= {stored_rank_sql}
                """
                write_payload = [
                    (item[0], item[1], *item[9:])
                    for item in payload
                ]
            conn.executemany(sql, write_payload)
            affected = conn.total_changes - changes_before
            conn.commit()

    return int(affected)


def import_history_archive(
    symbol: str,
    interval: str,
    rows: list[dict],
    receipt: dict[str, Any],
    source: str = "backfill_archive_verified",
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    series_identity: KlineSeriesIdentity | None = None,
) -> dict[str, Any]:
    """Atomically import one archive object and persist its receipt.

    The receipt is also the idempotency key.  A matching digest with complete
    storage coverage is a no-op; a changed digest replaces same/lower-rank
    rows and invalidates overlapping locally aggregated bars in this same
    SQLite transaction.
    """
    if not str(source).startswith("backfill_archive_"):
        raise ValueError("history archive import requires an archive source")
    object_key = str(receipt.get("object_key") or "").strip()
    content_sha256 = str(receipt.get("content_sha256") or "").strip().lower()
    import_version = str(
        receipt.get("import_version") or "history-archive-import.v1"
    )
    if not object_key or len(content_sha256) != 64:
        raise ValueError("history archive receipt is missing its object digest")
    if (
        str(receipt.get("exchange")) != exchange
        or str(receipt.get("market_type")) != market_type
        or str(receipt.get("symbol")) != symbol
        or str(receipt.get("interval")) != interval
    ):
        raise ValueError("history archive receipt identity does not match rows")
    if int(receipt.get("row_count") or 0) != len(rows):
        raise ValueError("history archive receipt row count does not match rows")
    if not rows:
        raise ValueError("history archive object cannot be empty")

    identity = _resolved_identity(exchange, series_identity)
    now_ms = int(time.time() * 1000)
    start_ms = int(receipt["start_ms"])
    end_ms = int(receipt["end_ms"])
    payload = [
        (
            exchange,
            market_type,
            *identity.storage_values,
            symbol,
            interval,
            row["open_time"],
            row["close_time"],
            row["open"],
            row["high"],
            row["low"],
            row["close"],
            row["volume"],
            row["quote_volume"],
            row["trades"],
            row["taker_buy_base"],
            row["taker_buy_quote"],
            source,
            now_ms,
            now_ms,
        )
        for row in rows
    ]

    with _ARCHIVE_IMPORT_WRITE_LOCK:
        with _connect() as conn:
            existing = conn.execute(
                "SELECT content_sha256, import_version, row_count "
                "FROM history_archive_imports WHERE object_key = ?",
                (object_key,),
            ).fetchone()
            if (
                existing is not None
                and str(existing["content_sha256"]).lower() == content_sha256
                and str(existing["import_version"]) == import_version
                and int(existing["row_count"]) == len(rows)
            ):
                stored_count = int(conn.execute(
                    "SELECT COUNT(*) FROM klines "
                    "WHERE exchange = ? AND market_type = ? AND symbol = ? "
                    "AND interval = ? AND " + _SERIES_IDENTITY_PREDICATE_SQL +
                    " AND open_time >= ? AND open_time <= ?",
                    (
                        exchange,
                        market_type,
                        symbol,
                        interval,
                        *identity.storage_values,
                        start_ms,
                        end_ms,
                    ),
                ).fetchone()[0])
                if stored_count >= len(rows):
                    return {
                        "written": 0,
                        "imported": False,
                        "skipped": True,
                        "invalidated": 0,
                        "revision_changed": False,
                    }

            digest_changed = bool(
                existing is not None
                and str(existing["content_sha256"]).lower() != content_sha256
            )
            revision_changed = digest_changed or bool(
                receipt.get("revision_changed")
            )
            invalidated = 0
            if revision_changed:
                changes_before = conn.total_changes
                conn.execute(
                    """
                    DELETE FROM klines
                    WHERE exchange = ? AND market_type = ? AND symbol = ?
                      AND provider_id = ? AND venue = ? AND asset_class = ?
                      AND series_variant = ? AND price_adjustment = ?
                      AND session_variant = ? AND volume_semantics = ?
                      AND source = 'backfill_aggregated'
                      AND open_time <= ?
                      AND COALESCE(close_time, open_time) >= ?
                    """,
                    (
                        exchange,
                        market_type,
                        symbol,
                        *identity.storage_values,
                        end_ms,
                        start_ms,
                    ),
                )
                invalidated = conn.total_changes - changes_before

            incoming_rank_sql = source_rank_sql("excluded.source")
            stored_rank_sql = source_rank_sql("klines.source")
            changes_before = conn.total_changes
            conn.executemany(
                f"""
                INSERT INTO klines (
                    exchange, market_type, provider_id, venue, asset_class,
                    series_variant, price_adjustment, session_variant,
                    volume_semantics, symbol, interval, open_time,
                    close_time, open, high, low, close, volume, quote_volume,
                    trades, taker_buy_base, taker_buy_quote,
                    source, created_at, updated_at
                ) VALUES ({', '.join('?' for _ in range(25))})
                ON CONFLICT({_KLINES_CONFLICT_TARGET_SQL}) DO UPDATE SET
                    close_time = excluded.close_time,
                    open = excluded.open,
                    high = excluded.high,
                    low = excluded.low,
                    close = excluded.close,
                    volume = excluded.volume,
                    quote_volume = excluded.quote_volume,
                    trades = excluded.trades,
                    taker_buy_base = excluded.taker_buy_base,
                    taker_buy_quote = excluded.taker_buy_quote,
                    source = excluded.source,
                    updated_at = excluded.updated_at
                WHERE {incoming_rank_sql} >= {stored_rank_sql}
                """,
                payload,
            )
            written = conn.total_changes - changes_before
            conn.execute(
                """
                INSERT INTO history_archive_imports (
                    object_key, provider_id, exchange, market_type, symbol,
                    interval, granularity, period, start_ms, end_ms,
                    content_sha256, provider_checksum, source_url, row_count,
                    revision_changed, import_version, imported_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(object_key) DO UPDATE SET
                    provider_id = excluded.provider_id,
                    exchange = excluded.exchange,
                    market_type = excluded.market_type,
                    symbol = excluded.symbol,
                    interval = excluded.interval,
                    granularity = excluded.granularity,
                    period = excluded.period,
                    start_ms = excluded.start_ms,
                    end_ms = excluded.end_ms,
                    content_sha256 = excluded.content_sha256,
                    provider_checksum = excluded.provider_checksum,
                    source_url = excluded.source_url,
                    row_count = excluded.row_count,
                    revision_changed = excluded.revision_changed,
                    import_version = excluded.import_version,
                    imported_at_ms = excluded.imported_at_ms
                """,
                (
                    object_key,
                    str(receipt["provider_id"]),
                    exchange,
                    market_type,
                    symbol,
                    interval,
                    str(receipt["granularity"]),
                    str(receipt["period"]),
                    start_ms,
                    end_ms,
                    content_sha256,
                    (
                        str(receipt["provider_checksum"])
                        if receipt.get("provider_checksum")
                        else None
                    ),
                    str(receipt["source_url"]),
                    len(rows),
                    1 if revision_changed else 0,
                    import_version,
                    now_ms,
                ),
            )
            conn.commit()

    return {
        "written": int(written),
        "imported": True,
        "skipped": False,
        "invalidated": int(invalidated),
        "revision_changed": revision_changed,
    }


def record_history_archive_imports(receipts: list[dict[str, Any]]) -> int:
    """Persist advisory archive receipts after their K-line transaction commits."""
    if not receipts:
        return 0
    now_ms = int(time.time() * 1000)
    payload = [
        (
            str(item["object_key"]),
            str(item["provider_id"]),
            str(item["exchange"]),
            str(item["market_type"]),
            str(item["symbol"]),
            str(item["interval"]),
            str(item["granularity"]),
            str(item["period"]),
            int(item["start_ms"]),
            int(item["end_ms"]),
            str(item["content_sha256"]),
            (
                str(item["provider_checksum"])
                if item.get("provider_checksum")
                else None
            ),
            str(item["source_url"]),
            int(item["row_count"]),
            1 if item.get("revision_changed") else 0,
            str(item.get("import_version") or "history-archive-import.v1"),
            now_ms,
        )
        for item in receipts
    ]
    with _connect() as conn:
        conn.executemany(
            """
            INSERT INTO history_archive_imports (
                object_key, provider_id, exchange, market_type, symbol,
                interval, granularity, period, start_ms, end_ms,
                content_sha256, provider_checksum, source_url, row_count,
                revision_changed, import_version, imported_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(object_key) DO UPDATE SET
                provider_id = excluded.provider_id,
                exchange = excluded.exchange,
                market_type = excluded.market_type,
                symbol = excluded.symbol,
                interval = excluded.interval,
                granularity = excluded.granularity,
                period = excluded.period,
                start_ms = excluded.start_ms,
                end_ms = excluded.end_ms,
                content_sha256 = excluded.content_sha256,
                provider_checksum = excluded.provider_checksum,
                source_url = excluded.source_url,
                row_count = excluded.row_count,
                revision_changed = excluded.revision_changed,
                import_version = excluded.import_version,
                imported_at_ms = excluded.imported_at_ms
            """,
            payload,
        )
        conn.commit()
    return len(payload)


def invalidate_archive_dependents(receipts: list[dict[str, Any]]) -> int:
    """Remove stale locally-derived bars after an official archive revision."""
    revised = [item for item in receipts if item.get("revision_changed")]
    if not revised:
        return 0
    deleted = 0
    with _connect() as conn:
        for item in revised:
            exchange = str(item["exchange"])
            identity = KlineSeriesIdentity.for_exchange(exchange)
            before = conn.total_changes
            conn.execute(
                """
                DELETE FROM klines
                WHERE exchange = ? AND market_type = ? AND symbol = ?
                  AND provider_id = ? AND venue = ? AND asset_class = ?
                  AND series_variant = ? AND price_adjustment = ?
                  AND session_variant = ? AND volume_semantics = ?
                  AND source = 'backfill_aggregated'
                  AND open_time <= ?
                  AND COALESCE(close_time, open_time) >= ?
                """,
                (
                    exchange,
                    str(item["market_type"]),
                    str(item["symbol"]),
                    *identity.storage_values,
                    int(item["end_ms"]),
                    int(item["start_ms"]),
                ),
            )
            deleted += conn.total_changes - before
        conn.commit()
    return int(deleted)


def query_klines(
    symbol: str,
    interval: str,
    start_ms: int | None = None,
    end_ms: int | None = None,
    limit: int | None = None,
    order: str = "ASC",
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    series_identity: KlineSeriesIdentity | None = None,
) -> list[dict]:
    where, params, _ = _series_where(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        interval=interval,
        series_identity=series_identity,
    )

    if start_ms is not None:
        where.append("open_time >= ?")
        params.append(start_ms)
    if end_ms is not None:
        where.append("open_time <= ?")
        params.append(end_ms)

    order_sql = "DESC" if order.upper() == "DESC" else "ASC"
    sql = f"""
        SELECT exchange, market_type, provider_id, venue, asset_class,
               series_variant, price_adjustment, session_variant,
               volume_semantics, symbol, interval, open_time, close_time,
               open, high, low, close, volume, quote_volume,
               trades, taker_buy_base, taker_buy_quote, source
        FROM klines
        WHERE {" AND ".join(where)}
        ORDER BY open_time {order_sql}
    """
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)

    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()

    return [dict(r) for r in rows]


def query_kline_bar_components(
    symbol: str,
    interval: str,
    start_ms: int | None = None,
    end_ms: int | None = None,
    limit: int | None = None,
    order: str = "ASC",
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    series_identity: KlineSeriesIdentity | None = None,
) -> list[KlineBarComponents]:
    """Query only fields required to construct and aggregate ``BarData``.

    The resolved series key already owns exchange, market type, symbol, and
    interval.  Durable rows are closed by definition, so copying identity,
    close-time columns into every Python object only adds SQLite I/O and
    allocation cost. Source remains in the projection because it determines
    finality and replacement quality for each durable row.
    """
    where, params, _ = _series_where(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        interval=interval,
        series_identity=series_identity,
    )

    if start_ms is not None:
        where.append("open_time >= ?")
        params.append(start_ms)
    if end_ms is not None:
        where.append("open_time <= ?")
        params.append(end_ms)

    order_sql = "DESC" if order.upper() == "DESC" else "ASC"
    sql = f"""
        SELECT {_BAR_COMPONENT_PROJECTION}
        FROM klines
        WHERE {" AND ".join(where)}
        ORDER BY open_time {order_sql}
    """
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)

    with _connect(use_row_factory=False) as conn:
        rows = conn.execute(sql, params).fetchall()

    return rows


def fetch_before(
    symbol: str,
    interval: str,
    before_ms: int,
    limit: int = 500,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    series_identity: KlineSeriesIdentity | None = None,
) -> list[dict]:
    where, params, _ = _series_where(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        interval=interval,
        series_identity=series_identity,
    )
    where.append("open_time < ?")
    params.extend((before_ms, limit))
    with _connect() as conn:
        rows = conn.execute(
            f"""
            SELECT exchange, market_type, provider_id, venue, asset_class,
                   series_variant, price_adjustment, session_variant,
                   volume_semantics, symbol, interval, open_time, close_time,
                   open, high, low, close, volume, quote_volume,
                   trades, taker_buy_base, taker_buy_quote, source
            FROM klines
            WHERE {' AND '.join(where)}
            ORDER BY open_time DESC
            LIMIT ?
            """,
            params,
        ).fetchall()

    records = [dict(r) for r in rows]
    records.reverse()
    return records


def fetch_before_kline_bar_components(
    symbol: str,
    interval: str,
    before_ms: int,
    limit: int = 500,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    series_identity: KlineSeriesIdentity | None = None,
) -> list[KlineBarComponents]:
    """Fetch a compact ascending page strictly before ``before_ms``."""
    where, params, _ = _series_where(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        interval=interval,
        series_identity=series_identity,
    )
    where.append("open_time < ?")
    params.extend((before_ms, limit))
    with _connect(use_row_factory=False) as conn:
        rows = conn.execute(
            f"""
            SELECT {_BAR_COMPONENT_PROJECTION}
            FROM klines
            WHERE {' AND '.join(where)}
            ORDER BY open_time DESC
            LIMIT ?
            """,
            params,
        ).fetchall()

    rows.reverse()
    return rows


def get_bounds(
    symbol: str,
    interval: str,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    series_identity: KlineSeriesIdentity | None = None,
) -> dict:
    where, params, _ = _series_where(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        interval=interval,
        series_identity=series_identity,
    )
    with _connect() as conn:
        row = conn.execute(
            f"""
            SELECT
                MIN(open_time) AS earliest_open_time,
                MAX(open_time) AS latest_open_time,
                COUNT(*) AS total_count
            FROM klines
            WHERE {' AND '.join(where)}
            """,
            params,
        ).fetchone()

    if row is None:
        return {"earliest_open_time": None, "latest_open_time": None, "total_count": 0}
    return dict(row)


def list_series_summaries(
    custom_only: bool = False,
    *,
    exchange: str | None = None,
    market_type: str | None = None,
    read_only: bool = False,
) -> list[dict]:
    """List stored series with bounds/count metadata.

    ``read_only`` is intended for diagnostics surfaces.  It opens the SQLite
    file through a read-only URI, so a first-run inventory request cannot
    create a database or change journal mode as a side effect.
    """
    sql = """
        SELECT
            exchange,
            market_type,
            provider_id,
            venue,
            asset_class,
            symbol,
            interval,
            series_variant,
            price_adjustment,
            session_variant,
            volume_semantics,
            MIN(open_time) AS earliest_open_time,
            MAX(open_time) AS latest_open_time,
            COUNT(*) AS total_count
        FROM klines
    """
    params: list[object] = []
    where: list[str] = []
    if exchange:
        where.append("exchange = ?")
        params.append(exchange)
    if market_type:
        where.append("market_type = ?")
        params.append(market_type)
    if custom_only:
        placeholders = ", ".join("?" for _ in VALID_INTERVALS)
        where.append(f"interval NOT IN ({placeholders})")
        params.extend(VALID_INTERVALS)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += """
        GROUP BY exchange, market_type, provider_id, venue, asset_class,
                 symbol, interval, series_variant, price_adjustment,
                 session_variant, volume_semantics
        ORDER BY exchange ASC, market_type ASC, provider_id ASC, venue ASC,
                 asset_class ASC, symbol ASC, interval ASC,
                 series_variant ASC, price_adjustment ASC,
                 session_variant ASC, volume_semantics ASC
    """

    if read_only:
        db_path = Path(KLINES_DB_PATH)
        if not db_path.exists():
            return []
        uri = f"{db_path.resolve().as_uri()}?mode=ro"
        with sqlite3.connect(uri, uri=True, timeout=2.0, check_same_thread=False) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA query_only=ON")
            rows = conn.execute(sql, params).fetchall()
    else:
        with _connect() as conn:
            rows = conn.execute(sql, params).fetchall()

    return [dict(r) for r in rows]


def _resolve_trading_calendar(
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    calendar: TradingCalendar | None,
    calendar_resolver: CalendarResolver | None,
    calendar_registry: CalendarRegistry | None,
) -> TradingCalendar | None:
    if calendar is not None:
        return calendar
    if calendar_resolver is None:
        return _ALWAYS_OPEN_CALENDAR
    try:
        resolved = calendar_resolver(exchange, market_type, symbol)
    except Exception as exc:
        logger.warning(
            "Trading calendar resolver failed for %s:%s:%s: %s",
            exchange,
            market_type,
            symbol,
            exc,
        )
        return None
    if resolved is None:
        return _ALWAYS_OPEN_CALENDAR
    if isinstance(resolved, str):
        registry = calendar_registry or _CALENDAR_REGISTRY
        selected = registry.get(resolved)
        if selected is None:
            logger.warning(
                "Unknown trading calendar %r for %s:%s:%s; gap scan skipped",
                resolved,
                exchange,
                market_type,
                symbol,
            )
        return selected
    if isinstance(resolved, TradingCalendar):
        return resolved
    logger.warning(
        "Invalid trading calendar resolver result for %s:%s:%s: %r",
        exchange,
        market_type,
        symbol,
        resolved,
    )
    return None


def _gap_payload(
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    interval: str,
    start_ms: int,
    end_ms: int,
    reason: str,
    calendar: TradingCalendar,
) -> dict:
    missing_bars = calendar.count_expected(start_ms, end_ms, interval)
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol,
        "interval": interval,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "missing_bars": missing_bars,
        "reason": reason,
        "status": "detected",
    }


def scan_klines_gaps(
    symbol: str,
    interval: str,
    start_ms: int | None = None,
    end_ms: int | None = None,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    series_identity: KlineSeriesIdentity | None = None,
    limit: int = 50_000,
    calendar: TradingCalendar | None = None,
    calendar_resolver: CalendarResolver | None = None,
    calendar_registry: CalendarRegistry | None = None,
) -> dict:
    """Scan one stored series for continuity gaps in a bounded range."""
    interval_ms = parse_interval_ms(interval)
    if interval_ms is None or interval_ms <= 0:
        return {
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol,
            "interval": interval,
            "gaps": [],
            "gap_count": 0,
            "missing_bars": 0,
            "scanned_bars": 0,
            "truncated": False,
            "first_open_time": None,
            "last_open_time": None,
            "resume_from_ms": None,
            "error": f"Unsupported interval: {interval}",
        }

    selected_calendar = _resolve_trading_calendar(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        calendar=calendar,
        calendar_resolver=calendar_resolver,
        calendar_registry=calendar_registry,
    )
    if selected_calendar is None:
        return {
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol,
            "interval": interval,
            "gaps": [],
            "gap_count": 0,
            "missing_bars": 0,
            "scanned_bars": 0,
            "truncated": False,
            "first_open_time": None,
            "last_open_time": None,
            "resume_from_ms": None,
            "error": "Trading calendar could not be resolved",
        }

    where, params, _ = _series_where(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        interval=interval,
        series_identity=series_identity,
    )
    if start_ms is not None:
        where.append("open_time >= ?")
        params.append(start_ms)
    if end_ms is not None:
        where.append("open_time <= ?")
        params.append(end_ms)

    sql = f"""
        SELECT open_time
        FROM klines
        WHERE {" AND ".join(where)}
        ORDER BY open_time ASC
        LIMIT ?
    """
    params.append(max(1, limit + 1))

    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()

    opens = [int(row["open_time"]) for row in rows[:limit]]
    truncated = len(rows) > limit
    gaps: list[dict] = []

    if not opens:
        if start_ms is not None and end_ms is not None and start_ms <= end_ms:
            gap_start = selected_calendar.first_expected_open(
                start_ms, end_ms, interval
            )
            gap_end = selected_calendar.last_expected_open(
                start_ms, end_ms, interval
            )
            if (
                gap_start is not None
                and gap_end is not None
                and gap_start <= gap_end
            ):
                gaps.append(_gap_payload(
                    exchange=exchange,
                    market_type=market_type,
                    symbol=symbol,
                    interval=interval,
                    start_ms=gap_start,
                    end_ms=gap_end,
                    reason="empty_range",
                    calendar=selected_calendar,
                ))
        return {
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol,
            "interval": interval,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "gaps": gaps,
            "gap_count": len(gaps),
            "missing_bars": sum(gap["missing_bars"] for gap in gaps),
            "scanned_bars": 0,
            "truncated": truncated,
            "first_open_time": None,
            "last_open_time": None,
            "resume_from_ms": None,
            "calendar_id": selected_calendar.calendar_id,
        }

    if start_ms is not None:
        first_expected = selected_calendar.first_expected_open(
            start_ms,
            min(end_ms if end_ms is not None else opens[0] - 1, opens[0] - 1),
            interval,
        )
        if first_expected is not None and opens[0] > first_expected:
            gap_end = selected_calendar.previous_expected_open(opens[0], interval)
            if gap_end is None or first_expected > gap_end:
                gap_end = None
        else:
            gap_end = None
        if gap_end is not None:
            gaps.append(_gap_payload(
                exchange=exchange,
                market_type=market_type,
                symbol=symbol,
                interval=interval,
                start_ms=first_expected,
                end_ms=gap_end,
                reason="head_gap",
                calendar=selected_calendar,
            ))

    previous = opens[0]
    for current in opens[1:]:
        expected_next = selected_calendar.next_expected_open(previous, interval)
        if expected_next is not None and current > expected_next:
            gap_end = selected_calendar.previous_expected_open(current, interval)
            if gap_end is None or expected_next > gap_end:
                previous = current
                continue
            gaps.append(_gap_payload(
                exchange=exchange,
                market_type=market_type,
                symbol=symbol,
                interval=interval,
                start_ms=expected_next,
                end_ms=gap_end,
                reason="interior_gap",
                calendar=selected_calendar,
            ))
        previous = current

    if end_ms is not None and not truncated:
        last_expected = selected_calendar.last_expected_open(
            opens[-1] + 1, end_ms, interval
        )
        next_expected = selected_calendar.next_expected_open(opens[-1], interval)
        if (
            next_expected is not None
            and last_expected is not None
            and next_expected <= last_expected
        ):
            gaps.append(_gap_payload(
                exchange=exchange,
                market_type=market_type,
                symbol=symbol,
                interval=interval,
                start_ms=next_expected,
                end_ms=last_expected,
                reason="tail_gap",
                calendar=selected_calendar,
            ))

    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol,
        "interval": interval,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "gaps": gaps,
        "gap_count": len(gaps),
        "missing_bars": sum(gap["missing_bars"] for gap in gaps),
        "scanned_bars": len(opens),
        "truncated": truncated,
        "first_open_time": opens[0],
        "last_open_time": opens[-1],
        # Resume inclusively so the next page retains the boundary pair used
        # to detect a gap between this page and the next one.
        "resume_from_ms": opens[-1] if truncated else None,
        "calendar_id": selected_calendar.calendar_id,
    }


# ═══════════════════════════════════════════════════════════════
#  KlinesRepoAdapter — implements data_manager.StorageBackend protocol
# ═══════════════════════════════════════════════════════════════


class KlinesRepoAdapter:
    """Wraps the module-level klines_repo functions into an object
    that satisfies the ``data_manager.models.StorageBackend`` protocol.

    Usage::

        from app.data_engine.storage.klines_repo import KlinesRepoAdapter
        dm = DataManager()
        dm.set_storage(KlinesRepoAdapter())
    """

    # DataManager holds its protection ordering guard while invoking one GC
    # batch.  Only backends that explicitly publish a bounded latency/row
    # contract are eligible for that destructive path.
    storage_gc_delete_max_batch_rows = 1_000
    storage_gc_delete_deadline_ms = 50

    def __init__(
        self,
        exchange: str = DEFAULT_EXCHANGE,
        market_type: str = DEFAULT_MARKET_TYPE,
        *,
        series_identity: KlineSeriesIdentity | None = None,
        calendar_resolver: CalendarResolver | None = None,
        calendar_registry: CalendarRegistry | None = None,
    ) -> None:
        self._exchange = exchange
        self._market_type = market_type
        self._series_identity = series_identity
        self._calendar_resolver = calendar_resolver
        self._calendar_registry = calendar_registry

    def set_calendar_resolver(
        self,
        resolver: CalendarResolver | None,
        *,
        registry: CalendarRegistry | None = None,
    ) -> None:
        """Inject the per-series calendar lookup used by ``scan_gaps``."""
        self._calendar_resolver = resolver
        if registry is not None:
            self._calendar_registry = registry

    def query_bars(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int | None = None,
        order: str = "ASC",
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> list[dict]:
        """Query bars from SQLite storage."""
        return query_klines(
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit,
            order=order,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
            series_identity=series_identity or self._series_identity,
        )

    def query_bar_components(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int | None = None,
        order: str = "ASC",
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> list[KlineBarComponents]:
        """Query the compact projection consumed by ``QueryEngine``."""
        return query_kline_bar_components(
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit,
            order=order,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
            series_identity=series_identity or self._series_identity,
        )

    def upsert_bars(
        self,
        symbol: str,
        interval: str,
        rows: list[dict],
        source: str = "data_manager",
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> int:
        """Insert or update bars in SQLite storage."""
        return upsert_klines(
            symbol=symbol,
            interval=interval,
            rows=rows,
            source=source,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
            series_identity=series_identity or self._series_identity,
        )

    def get_bounds(
        self,
        symbol: str,
        interval: str,
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> dict:
        """Return {earliest_open_time, latest_open_time, total_count}."""
        return get_bounds(
            symbol=symbol,
            interval=interval,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
            series_identity=series_identity or self._series_identity,
        )

    def count_bars(
        self,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> int:
        """Count one exact series range without materialising its rows."""
        resolved_exchange = exchange or self._exchange
        resolved_market_type = market_type or self._market_type
        where, params, _ = _series_where(
            exchange=resolved_exchange,
            market_type=resolved_market_type,
            symbol=symbol,
            interval=interval,
            series_identity=series_identity or self._series_identity,
        )
        where.extend(("open_time >= ?", "open_time <= ?"))
        params.extend((int(start_ms), int(end_ms)))
        with _connect() as conn:
            row = conn.execute(
                f"""
                SELECT COUNT(*) AS cnt
                FROM klines
                WHERE {' AND '.join(where)}
                """,
                params,
            ).fetchone()
        return int(row["cnt"] if row is not None else 0)

    def verify_contiguous_range(
        self,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> dict:
        """Exactly compare stored opens with the calendar sequence.

        The SQLite cursor streams rows from one read snapshot, so this remains
        bounded-memory even for a range that needed several audit passes.
        Unlike a count-only check it also rejects off-grid replacements.
        """
        resolved_exchange = exchange or self._exchange
        resolved_market_type = market_type or self._market_type
        where, params, _ = _series_where(
            exchange=resolved_exchange,
            market_type=resolved_market_type,
            symbol=symbol,
            interval=interval,
            series_identity=series_identity or self._series_identity,
        )
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None or interval_ms <= 0:
            return {
                "verified_contiguous": None,
                "error": f"Unsupported interval: {interval}",
            }
        selected_calendar = _resolve_trading_calendar(
            exchange=resolved_exchange,
            market_type=resolved_market_type,
            symbol=symbol,
            calendar=None,
            calendar_resolver=self._calendar_resolver,
            calendar_registry=self._calendar_registry,
        )
        if selected_calendar is None:
            return {
                "verified_contiguous": None,
                "error": "Trading calendar could not be resolved",
            }

        range_start = int(start_ms)
        range_end = int(end_ms)
        if range_end < range_start:
            return {
                "verified_contiguous": False,
                "error": "Invalid verification range",
            }
        expected_open = selected_calendar.first_expected_open(
            range_start,
            range_end,
            interval,
        )
        actual_count = 0
        expected_count = 0
        where.extend(("open_time >= ?", "open_time <= ?"))
        params.extend((range_start, range_end))
        with _connect() as conn:
            cursor = conn.execute(
                f"""
                SELECT open_time
                FROM klines
                WHERE {' AND '.join(where)}
                ORDER BY open_time ASC
                """,
                params,
            )
            for row in cursor:
                actual_open = int(row["open_time"])
                actual_count += 1
                if expected_open is None or actual_open != expected_open:
                    return {
                        "verified_contiguous": False,
                        "actual_count": actual_count,
                        "expected_count": expected_count,
                        "expected_open_time": expected_open,
                        "actual_open_time": actual_open,
                    }
                expected_count += 1
                next_expected = selected_calendar.next_expected_open(
                    expected_open,
                    interval,
                )
                if next_expected is not None and next_expected <= expected_open:
                    return {
                        "verified_contiguous": None,
                        "actual_count": actual_count,
                        "expected_count": expected_count,
                        "error": "Trading calendar did not advance",
                    }
                expected_open = (
                    next_expected
                    if next_expected is not None and next_expected <= range_end
                    else None
                )

        verified = expected_open is None
        return {
            "verified_contiguous": verified,
            "actual_count": actual_count,
            "expected_count": expected_count + (0 if verified else 1),
            "expected_open_time": expected_open,
        }

    def list_series(
        self,
        custom_only: bool = False,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> list[dict]:
        """Return stored series summaries."""
        return list_series_summaries(
            custom_only=custom_only,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
        )

    def list_all_series(self, custom_only: bool = False) -> list[dict]:
        """Return stored series summaries across all exchanges and markets."""
        return list_series_summaries(custom_only=custom_only)

    def scan_gaps(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
        limit: int = 50_000,
        calendar: TradingCalendar | None = None,
    ) -> dict:
        """Scan a stored series for continuity gaps."""
        return scan_klines_gaps(
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
            series_identity=series_identity or self._series_identity,
            limit=limit,
            calendar=calendar,
            calendar_resolver=self._calendar_resolver,
            calendar_registry=self._calendar_registry,
        )

    def delete_bars(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> int:
        """Delete bars in range."""
        return delete_klines(
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
            series_identity=series_identity or self._series_identity,
        )

    def fetch_before(
        self,
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int = 500,
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> list[dict]:
        """Fetch bars before a timestamp, ordered ASC."""
        return fetch_before(
            symbol=symbol,
            interval=interval,
            before_ms=before_ms,
            limit=limit,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
            series_identity=series_identity or self._series_identity,
        )

    def fetch_before_bar_components(
        self,
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int = 500,
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> list[KlineBarComponents]:
        """Fetch the compact projection consumed by ``QueryEngine``."""
        return fetch_before_kline_bar_components(
            symbol=symbol,
            interval=interval,
            before_ms=before_ms,
            limit=limit,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
            series_identity=series_identity or self._series_identity,
        )

    def delete_oldest(
        self,
        symbol: str,
        interval: str,
        keep: int,
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> int:
        """Delete oldest bars, keeping only the most recent *keep* rows."""
        return delete_oldest_klines(
            symbol=symbol,
            interval=interval,
            keep=keep,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
            series_identity=series_identity or self._series_identity,
        )

    def count_rows_before(
        self,
        symbol: str,
        interval: str,
        before_ms: int,
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> int:
        """Count durable rows strictly earlier than *before_ms*."""
        return count_klines_before(
            symbol=symbol,
            interval=interval,
            before_ms=before_ms,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
            series_identity=series_identity or self._series_identity,
        )

    def delete_oldest_batch(
        self,
        symbol: str,
        interval: str,
        keep: int,
        batch_size: int = 10_000,
        exchange: str | None = None,
        market_type: str | None = None,
        delete_before_ms: int | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> int:
        """Delete one bounded batch of oldest bars while keeping newest rows."""
        return delete_oldest_klines_batch(
            symbol=symbol,
            interval=interval,
            keep=keep,
            batch_size=batch_size,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
            delete_before_ms=delete_before_ms,
            series_identity=series_identity or self._series_identity,
        )

    def wal_checkpoint_truncate(self) -> dict:
        """Run a WAL truncate checkpoint."""
        return wal_checkpoint_truncate()

    def vacuum(self) -> dict:
        """Run VACUUM manually."""
        return vacuum_database()


# ═══════════════════════════════════════════════════════════════
#  AsyncKlinesRepoAdapter — implements backfill.models.StorageBackend protocol
# ═══════════════════════════════════════════════════════════════


class AsyncKlinesRepoAdapter:
    """Async wrapper that satisfies the ``backfill.models.StorageBackend``
    protocol (all methods are async).

    The BackfillEngine's GapDetector, Reconciler, etc. require async storage
    methods like ``get_latest_time``, ``get_earliest_time``, ``count_bars``,
    ``get_existing_open_times`` — which the sync ``KlinesRepoAdapter`` does
    not provide.

    This adapter wraps the module-level sync functions using
    the shared storage executor so the backfill pipeline can call them with
    ``await``.

    Usage::

        from app.data_engine.storage.klines_repo import AsyncKlinesRepoAdapter
        backfill_engine = BackfillEngine(storage=AsyncKlinesRepoAdapter(), ...)
    """

    def __init__(
        self,
        exchange: str = DEFAULT_EXCHANGE,
        market_type: str = DEFAULT_MARKET_TYPE,
    ) -> None:
        self._exchange = exchange
        self._market_type = market_type

    async def get_latest_time(
        self,
        symbol: str,
        interval: str,
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> int | None:
        """Return the latest open_time (ms) stored, or None if empty."""
        def _sync():
            bounds = get_bounds(
                symbol, interval,
                exchange=exchange or self._exchange,
                market_type=market_type or self._market_type,
                series_identity=series_identity,
            )
            return bounds.get("latest_open_time")
        return await run_storage(_sync)

    async def get_earliest_time(
        self,
        symbol: str,
        interval: str,
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> int | None:
        """Return the earliest open_time (ms) stored, or None if empty."""
        def _sync():
            bounds = get_bounds(
                symbol, interval,
                exchange=exchange or self._exchange,
                market_type=market_type or self._market_type,
                series_identity=series_identity,
            )
            return bounds.get("earliest_open_time")
        return await run_storage(_sync)

    async def query_time_range(
        self, symbol: str, interval: str, start_ms: int, end_ms: int,
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> list[dict]:
        """Return all bars within [start_ms, end_ms], ordered by open_time ASC."""
        resolved_exchange = exchange or self._exchange
        resolved_market_type = market_type or self._market_type
        def _sync():
            return query_klines(
                symbol, interval, start_ms, end_ms, None, "ASC",
                exchange=resolved_exchange, market_type=resolved_market_type,
                series_identity=series_identity,
            )
        return await run_storage(_sync)

    async def upsert_bars(
        self,
        symbol: str,
        interval: str,
        bars: list[dict],
        source: str = "backfill",
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> int:
        """Insert or update bars. Return number of rows affected."""
        resolved_exchange = exchange or self._exchange
        resolved_market_type = market_type or self._market_type
        def _sync():
            return upsert_klines(
                symbol, interval, bars, source,
                exchange=resolved_exchange, market_type=resolved_market_type,
                series_identity=series_identity,
            )
        return await run_storage(_sync)

    async def record_history_archive_imports(
        self,
        receipts: list[dict[str, Any]],
    ) -> int:
        return await run_storage(record_history_archive_imports, receipts)

    async def import_history_archive(
        self,
        symbol: str,
        interval: str,
        rows: list[dict],
        receipt: dict[str, Any],
        source: str = "backfill_archive_verified",
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> dict[str, Any]:
        return await run_storage(
            import_history_archive,
            symbol,
            interval,
            rows,
            receipt,
            source,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
        )

    async def invalidate_archive_dependents(
        self,
        receipts: list[dict[str, Any]],
    ) -> int:
        return await run_storage(invalidate_archive_dependents, receipts)

    async def count_bars(
        self, symbol: str, interval: str, start_ms: int, end_ms: int,
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> int:
        """Count bars within [start_ms, end_ms]."""
        resolved_exchange = exchange or self._exchange
        resolved_market_type = market_type or self._market_type
        def _sync():
            where, params, _ = _series_where(
                exchange=resolved_exchange,
                market_type=resolved_market_type,
                symbol=symbol,
                interval=interval,
                series_identity=series_identity,
            )
            where.extend(("open_time >= ?", "open_time <= ?"))
            params.extend((start_ms, end_ms))
            with _connect() as conn:
                row = conn.execute(
                    f"SELECT COUNT(*) AS cnt FROM klines WHERE {' AND '.join(where)}",
                    params,
                ).fetchone()
                return row["cnt"] if row else 0
        return await run_storage(_sync)

    async def get_existing_open_times(
        self, symbol: str, interval: str, start_ms: int, end_ms: int,
        exchange: str | None = None,
        market_type: str | None = None,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> set[int]:
        """Return the set of open_time values that exist in [start_ms, end_ms]."""
        resolved_exchange = exchange or self._exchange
        resolved_market_type = market_type or self._market_type
        def _sync():
            where, params, _ = _series_where(
                exchange=resolved_exchange,
                market_type=resolved_market_type,
                symbol=symbol,
                interval=interval,
                series_identity=series_identity,
            )
            where.extend(("open_time >= ?", "open_time <= ?"))
            params.extend((start_ms, end_ms))
            with _connect() as conn:
                rows = conn.execute(
                    f"SELECT open_time FROM klines WHERE {' AND '.join(where)}",
                    params,
                ).fetchall()
                return {r["open_time"] for r in rows}
        return await run_storage(_sync)


def has_older_than(
    symbol: str,
    interval: str,
    open_time_ms: int,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    series_identity: KlineSeriesIdentity | None = None,
) -> bool:
    where, params, _ = _series_where(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        interval=interval,
        series_identity=series_identity,
    )
    where.append("open_time < ?")
    params.append(open_time_ms)
    with _connect() as conn:
        row = conn.execute(
            f"""
            SELECT 1
            FROM klines
            WHERE {' AND '.join(where)}
            LIMIT 1
            """,
            params,
        ).fetchone()
    return row is not None


def delete_klines(
    symbol: str,
    interval: str,
    start_ms: int | None = None,
    end_ms: int | None = None,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    series_identity: KlineSeriesIdentity | None = None,
) -> int:
    where, params, _ = _series_where(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        interval=interval,
        series_identity=series_identity,
    )

    if start_ms is not None:
        where.append("open_time >= ?")
        params.append(start_ms)
    if end_ms is not None:
        where.append("open_time <= ?")
        params.append(end_ms)

    sql = f"DELETE FROM klines WHERE {' AND '.join(where)}"
    with _connect() as conn:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur.rowcount


def delete_oldest_klines(
    symbol: str,
    interval: str,
    keep: int,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    series_identity: KlineSeriesIdentity | None = None,
) -> int:
    """Delete oldest bars, keeping only the most recent *keep* rows.

    Uses a subquery to find the cutoff open_time, then deletes everything
    older.  Returns the number of rows actually deleted.

    If total rows <= keep, nothing is deleted (returns 0).
    """
    if keep < 0:
        keep = 0

    where, params, _ = _series_where(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        interval=interval,
        series_identity=series_identity,
    )
    predicate = " AND ".join(where)
    with _connect() as conn:
        # First check total count
        count_row = conn.execute(
            f"SELECT COUNT(*) AS cnt FROM klines WHERE {predicate}",
            params,
        ).fetchone()
        total = count_row["cnt"] if count_row else 0

        if total <= keep:
            return 0

        # Find the cutoff: the open_time of the (keep)-th newest bar
        cutoff_row = conn.execute(
            "SELECT open_time FROM klines WHERE " + predicate + " "
            "ORDER BY open_time DESC LIMIT 1 OFFSET ?",
            (*params, keep),
        ).fetchone()

        if cutoff_row is None:
            return 0

        cutoff_ms = cutoff_row["open_time"]

        # Delete everything at or before the cutoff
        cur = conn.execute(
            "DELETE FROM klines WHERE " + predicate + " "
            "AND open_time <= ?",
            (*params, cutoff_ms),
        )
        conn.commit()
        return cur.rowcount


def count_klines_before(
    symbol: str,
    interval: str,
    before_ms: int,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    series_identity: KlineSeriesIdentity | None = None,
) -> int:
    """Count rows with ``open_time`` strictly earlier than *before_ms*."""
    where, params, _ = _series_where(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        interval=interval,
        series_identity=series_identity,
    )
    where.append("open_time < ?")
    params.append(int(before_ms))
    with _connect() as conn:
        row = conn.execute(
            f"SELECT COUNT(*) AS cnt FROM klines WHERE {' AND '.join(where)}",
            params,
        ).fetchone()
    return int(row["cnt"] if row is not None else 0)


def delete_oldest_klines_batch(
    symbol: str,
    interval: str,
    keep: int,
    batch_size: int = 10_000,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    delete_before_ms: int | None = None,
    series_identity: KlineSeriesIdentity | None = None,
) -> int:
    """Delete at most *batch_size* oldest bars while keeping newest *keep* rows."""
    if keep < 0:
        keep = 0
    batch_size = min(1_000, max(1, int(batch_size or 1)))
    ceiling_ms = None if delete_before_ms is None else int(delete_before_ms)
    where, params, _ = _series_where(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        interval=interval,
        series_identity=series_identity,
    )
    predicate = " AND ".join(where)

    # Storage GC is ordered with stream/subscription activation.  Fail fast on
    # lock contention instead of holding that ordering guard through SQLite's
    # normal 30-second busy timeout.
    with _connect(
        timeout_seconds=0.05,
        configure_journal_mode=False,
    ) as conn:
        execution_deadline = time.perf_counter() + 0.05
        conn.set_progress_handler(
            lambda: 1 if time.perf_counter() >= execution_deadline else 0,
            1_000,
        )
        count_row = conn.execute(
            f"SELECT COUNT(*) AS cnt FROM klines WHERE {predicate}",
            params,
        ).fetchone()
        total = count_row["cnt"] if count_row else 0
        if ceiling_ms is None:
            prefix_count = total
        else:
            prefix_row = conn.execute(
                f"SELECT COUNT(*) AS cnt FROM klines WHERE {predicate} "
                "AND open_time < ?",
                (*params, ceiling_ms),
            ).fetchone()
            prefix_count = int(prefix_row["cnt"] if prefix_row else 0)
        to_delete = min(batch_size, prefix_count, max(0, total - keep))
        if to_delete <= 0:
            return 0

        if ceiling_ms is None:
            cur = conn.execute(
                f"""
                DELETE FROM klines
                WHERE rowid IN (
                    SELECT rowid FROM klines
                    WHERE {predicate}
                    ORDER BY open_time ASC
                    LIMIT ?
                )
                """,
                (*params, to_delete),
            )
        else:
            cur = conn.execute(
                f"""
                DELETE FROM klines
                WHERE rowid IN (
                    SELECT rowid FROM klines
                    WHERE {predicate} AND open_time < ?
                    ORDER BY open_time ASC
                    LIMIT ?
                )
                """,
                (
                    *params,
                    ceiling_ms,
                    to_delete,
                ),
            )
        conn.commit()
        return cur.rowcount


def wal_checkpoint_truncate() -> dict:
    """Run a WAL truncate checkpoint and return SQLite's result tuple."""
    # Automatic checkpointing must never occupy the storage executor through
    # the normal 30-second busy timeout.  Do not negotiate journal mode here;
    # an initialized database is already in WAL mode and contention fails
    # closed through the returned busy flag.
    with _connect(
        timeout_seconds=0.05,
        configure_journal_mode=False,
    ) as conn:
        row = conn.execute("PRAGMA wal_checkpoint(TRUNCATE);").fetchone()
    values = tuple(row) if row is not None else ()
    return {
        "mode": "TRUNCATE",
        "result": list(values),
        "busy": int(values[0]) if len(values) > 0 else None,
        "log": int(values[1]) if len(values) > 1 else None,
        "checkpointed": int(values[2]) if len(values) > 2 else None,
    }


def vacuum_database() -> dict:
    """Run VACUUM. This can lock the database and should be manually triggered."""
    started = time.time()
    with _connect() as conn:
        conn.execute("VACUUM;")
    return {
        "status": "ok",
        "elapsed_ms": int((time.time() - started) * 1000),
    }
