"""Phase 15 real-input period-summary preparation and jump benchmark."""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import os
import sqlite3
import sys
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import TypeVar

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.config import ReplaySettings  # noqa: E402
from app.data_engine.interval_policy import parse_interval_ms  # noqa: E402
from app.data_engine.storage.raw_trade_archive import (  # noqa: E402
    ParquetRawAggTradeArchive,
    RawAggTradeCursor,
)
from app.replay.canonical import canonical_sha256  # noqa: E402
from app.replay.constants import REPLAY_PROTOCOL, CommandType  # noqa: E402
from app.replay.internal_commands import InternalCommandType  # noqa: E402
from app.replay.models import ReplayCommand  # noqa: E402
from app.replay.service import ReplayService  # noqa: E402
from app.replay.storage import ReplaySQLiteStore  # noqa: E402
from app.replay.training.commands import ReplayV2Command  # noqa: E402
from app.replay.training.models import (  # noqa: E402
    ReplayV2CommandType,
    TrainingCursor,
    TrainingRunCreateRequest,
)


SCHEMA_VERSION = "replay-period-summary-benchmark.v1"
INTERVAL = "1m"
INTERVAL_MS = 60_000
WARMUP_BARS = 100
CLIENT_ID = "phase15-real-benchmark"
_T = TypeVar("_T")


class _SessionIdFactory:
    def __init__(self, prefix: str) -> None:
        self._prefix = prefix
        self._counter = 0

    def __call__(self) -> str:
        self._counter += 1
        return f"{self._prefix}-{self._counter}"


def _utc_ms(value: str) -> int:
    normalized = value.strip()
    if len(normalized) == 10:
        normalized += "T00:00:00+00:00"
    elif normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "start must be YYYY-MM-DD or an ISO-8601 UTC timestamp"
        ) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc)
    return int(parsed.timestamp() * 1_000)


def _read_only_uri(path: Path) -> str:
    return f"{path.resolve().as_uri()}?mode=ro"


def _stable_storage_rows(
    rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    return [
        {
            key: (
                format(value, ".17g")
                if isinstance(value, float)
                else value
            )
            for key, value in row.items()
        }
        for row in rows
    ]


def _rows_gap_report(
    opens: Sequence[int],
    *,
    start_ms: int | None,
    end_ms: int | None,
    limit: int,
) -> dict[str, object]:
    selected = sorted(set(int(value) for value in opens))
    truncated = len(selected) > limit
    selected = selected[:limit]
    gaps: list[dict[str, object]] = []
    if start_ms is not None and end_ms is not None:
        expected = start_ms
        selected_set = set(selected)
        missing_start: int | None = None
        previous_missing: int | None = None
        while expected <= end_ms:
            if expected not in selected_set:
                if missing_start is None:
                    missing_start = expected
                previous_missing = expected
            elif missing_start is not None and previous_missing is not None:
                gaps.append(
                    {
                        "start_ms": missing_start,
                        "end_ms": previous_missing,
                        "missing_bars": (
                            (previous_missing - missing_start) // INTERVAL_MS
                        )
                        + 1,
                        "reason": "benchmark_source_gap",
                        "status": "detected",
                    }
                )
                missing_start = None
                previous_missing = None
            expected += INTERVAL_MS
        if missing_start is not None and previous_missing is not None:
            gaps.append(
                {
                    "start_ms": missing_start,
                    "end_ms": previous_missing,
                    "missing_bars": (
                        (previous_missing - missing_start) // INTERVAL_MS
                    )
                    + 1,
                    "reason": "benchmark_source_gap",
                    "status": "detected",
                }
            )
    return {
        "gaps": gaps,
        "gap_count": len(gaps),
        "missing_bars": sum(int(gap["missing_bars"]) for gap in gaps),
        "scanned_bars": len(selected),
        "truncated": truncated,
        "calendar_id": "crypto.24x7.utc",
    }


class _SQLiteKlinesRepository:
    """Minimal production repository contract over one explicit read-only DB."""

    def __init__(
        self,
        path: Path,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
    ) -> None:
        self.path = path.resolve()
        self.exchange = exchange
        self.market_type = market_type
        self.symbol = symbol

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            _read_only_uri(self.path),
            uri=True,
            timeout=30,
        )
        connection.row_factory = sqlite3.Row
        return connection

    def list_all_series(
        self,
        custom_only: bool = False,
    ) -> list[dict[str, object]]:
        del custom_only
        return self.list_series()

    def list_series(
        self,
        custom_only: bool = False,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> list[dict[str, object]]:
        del custom_only
        if exchange not in {None, self.exchange} or market_type not in {
            None,
            self.market_type,
        }:
            return []
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT exchange, market_type, symbol, interval,
                       MIN(open_time) AS earliest_open_time,
                       MAX(open_time) AS latest_open_time,
                       COUNT(*) AS total_count
                FROM klines
                WHERE exchange = ? AND market_type = ? AND symbol = ?
                  AND interval = ?
                GROUP BY exchange, market_type, symbol, interval
                """,
                (self.exchange, self.market_type, self.symbol, INTERVAL),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_bounds(
        self,
        symbol: str,
        interval: str,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> dict[str, object]:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT MIN(open_time) AS earliest_open_time,
                       MAX(open_time) AS latest_open_time,
                       COUNT(*) AS total_count
                FROM klines
                WHERE exchange = ? AND market_type = ? AND symbol = ?
                  AND interval = ?
                """,
                (
                    exchange or self.exchange,
                    market_type or self.market_type,
                    symbol,
                    interval,
                ),
            ).fetchone()
        assert row is not None
        return dict(row)

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
    ) -> list[dict[str, object]]:
        direction = "DESC" if order.upper() == "DESC" else "ASC"
        clauses = [
            "exchange = ?",
            "market_type = ?",
            "symbol = ?",
            "interval = ?",
        ]
        values: list[object] = [
            exchange or self.exchange,
            market_type or self.market_type,
            symbol,
            interval,
        ]
        if start_ms is not None:
            clauses.append("open_time >= ?")
            values.append(start_ms)
        if end_ms is not None:
            clauses.append("open_time <= ?")
            values.append(end_ms)
        limit_sql = ""
        if limit is not None:
            limit_sql = " LIMIT ?"
            values.append(limit)
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT exchange, market_type, symbol, interval, open_time,
                       close_time, open, high, low, close, volume,
                       quote_volume, trades, taker_buy_base,
                       taker_buy_quote, source
                FROM klines
                WHERE {" AND ".join(clauses)}
                ORDER BY open_time {direction}{limit_sql}
                """,
                values,
            ).fetchall()
        return [dict(row) for row in rows]

    def scan_gaps(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str | None = None,
        market_type: str | None = None,
        limit: int = 50_000,
        calendar: object | None = None,
    ) -> dict[str, object]:
        del calendar
        rows = self.query_bars(
            symbol,
            interval,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit + 1,
            exchange=exchange,
            market_type=market_type,
        )
        report = _rows_gap_report(
            [int(row["open_time"]) for row in rows],
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit,
        )
        return {
            "exchange": exchange or self.exchange,
            "market_type": market_type or self.market_type,
            "symbol": symbol,
            "interval": interval,
            "start_ms": start_ms,
            "end_ms": end_ms,
            **report,
        }


class _MemoryKlinesRepository:
    def __init__(
        self,
        rows: Sequence[Mapping[str, object]],
        *,
        exchange: str,
        market_type: str,
        symbol: str,
    ) -> None:
        self.rows = tuple(dict(row) for row in rows)
        self.exchange = exchange
        self.market_type = market_type
        self.symbol = symbol

    def list_all_series(
        self,
        custom_only: bool = False,
    ) -> list[dict[str, object]]:
        del custom_only
        return self.list_series()

    def list_series(
        self,
        custom_only: bool = False,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> list[dict[str, object]]:
        del custom_only
        if exchange not in {None, self.exchange} or market_type not in {
            None,
            self.market_type,
        }:
            return []
        bounds = self.get_bounds(self.symbol, INTERVAL)
        return [
            {
                "exchange": self.exchange,
                "market_type": self.market_type,
                "symbol": self.symbol,
                "interval": INTERVAL,
                **bounds,
            }
        ]

    def get_bounds(
        self,
        symbol: str,
        interval: str,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> dict[str, object]:
        if (
            symbol != self.symbol
            or interval != INTERVAL
            or exchange not in {None, self.exchange}
            or market_type not in {None, self.market_type}
        ):
            return {
                "earliest_open_time": None,
                "latest_open_time": None,
                "total_count": 0,
            }
        opens = [int(row["open_time"]) for row in self.rows]
        return {
            "earliest_open_time": min(opens),
            "latest_open_time": max(opens),
            "total_count": len(opens),
        }

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
    ) -> list[dict[str, object]]:
        if (
            symbol != self.symbol
            or interval != INTERVAL
            or exchange not in {None, self.exchange}
            or market_type not in {None, self.market_type}
        ):
            return []
        rows = [
            dict(row)
            for row in self.rows
            if (start_ms is None or int(row["open_time"]) >= start_ms)
            and (end_ms is None or int(row["open_time"]) <= end_ms)
        ]
        rows.sort(
            key=lambda row: int(row["open_time"]),
            reverse=order.upper() == "DESC",
        )
        return rows if limit is None else rows[:limit]

    def scan_gaps(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str | None = None,
        market_type: str | None = None,
        limit: int = 50_000,
        calendar: object | None = None,
    ) -> dict[str, object]:
        del calendar
        rows = self.query_bars(
            symbol,
            interval,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit + 1,
            exchange=exchange,
            market_type=market_type,
        )
        return {
            "exchange": exchange or self.exchange,
            "market_type": market_type or self.market_type,
            "symbol": symbol,
            "interval": interval,
            "start_ms": start_ms,
            "end_ms": end_ms,
            **_rows_gap_report(
                [int(row["open_time"]) for row in rows],
                start_ms=start_ms,
                end_ms=end_ms,
                limit=limit,
            ),
        }


_SQLiteKlinesRepository.__module__ = "phase15.benchmark"
_MemoryKlinesRepository.__module__ = "phase15.benchmark"


@dataclass(slots=True)
class _TradeBucket:
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal
    quote_volume: Decimal
    trades: int
    taker_buy_base: Decimal
    taker_buy_quote: Decimal


def _derive_trade_bars(
    archive: ParquetRawAggTradeArchive,
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    start_ms: int,
    end_ms: int,
    page_rows: int,
) -> tuple[list[dict[str, object]], dict[str, object]]:
    dataset = archive.freeze_dataset(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        start_time_ms=start_ms,
        end_time_ms=end_ms,
        page_rows=page_rows,
    )
    buckets: dict[int, _TradeBucket] = {}
    cursor: RawAggTradeCursor | None = None
    scanned = 0
    while True:
        page = archive.scan_page(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            start_time_ms=dataset.start_time_ms,
            end_time_ms=dataset.end_time_ms,
            start_agg_trade_id=dataset.expected_first_agg_trade_id,
            end_agg_trade_id=dataset.expected_last_agg_trade_id,
            after=cursor,
            limit=page_rows,
            dataset_ref=dataset,
        )
        for row in page.rows:
            trade_time = int(row["trade_time_ms"])
            bucket_open = trade_time - (trade_time % INTERVAL_MS)
            price = Decimal(str(row["price"]))
            quantity = Decimal(str(row["quantity"]))
            quote = Decimal(str(row["quote_quantity"]))
            bucket = buckets.get(bucket_open)
            if bucket is None:
                bucket = _TradeBucket(
                    open=price,
                    high=price,
                    low=price,
                    close=price,
                    volume=Decimal(0),
                    quote_volume=Decimal(0),
                    trades=0,
                    taker_buy_base=Decimal(0),
                    taker_buy_quote=Decimal(0),
                )
                buckets[bucket_open] = bucket
            bucket.high = max(bucket.high, price)
            bucket.low = min(bucket.low, price)
            bucket.close = price
            bucket.volume += quantity
            bucket.quote_volume += quote
            bucket.trades += (
                int(row["last_trade_id"]) - int(row["first_trade_id"]) + 1
            )
            if not bool(row["is_buyer_maker"]):
                bucket.taker_buy_base += quantity
                bucket.taker_buy_quote += quote
            scanned += 1
        if page.exhausted:
            break
        if page.next_cursor is None or page.next_cursor == cursor:
            raise RuntimeError("trade archive cursor did not advance")
        cursor = page.next_cursor

    first_open = start_ms - (start_ms % INTERVAL_MS)
    last_open = end_ms - (end_ms % INTERVAL_MS)
    rows: list[dict[str, object]] = []
    previous_close: Decimal | None = None
    for open_time in range(first_open, last_open + 1, INTERVAL_MS):
        bucket = buckets.get(open_time)
        if bucket is None:
            if previous_close is None:
                raise RuntimeError(
                    "the first derived trade bar is empty; extend the archive warmup"
                )
            bucket = _TradeBucket(
                open=previous_close,
                high=previous_close,
                low=previous_close,
                close=previous_close,
                volume=Decimal(0),
                quote_volume=Decimal(0),
                trades=0,
                taker_buy_base=Decimal(0),
                taker_buy_quote=Decimal(0),
            )
        previous_close = bucket.close
        rows.append(
            {
                "exchange": exchange,
                "market_type": market_type,
                "symbol": symbol,
                "interval": INTERVAL,
                "open_time": open_time,
                "close_time": open_time + INTERVAL_MS - 1,
                "open": str(bucket.open),
                "high": str(bucket.high),
                "low": str(bucket.low),
                "close": str(bucket.close),
                "volume": str(bucket.volume),
                "quote_volume": str(bucket.quote_volume),
                "trades": bucket.trades,
                "taker_buy_base": str(bucket.taker_buy_base),
                "taker_buy_quote": str(bucket.taker_buy_quote),
                "source": "checksum_verified_agg_trade_derived",
            }
        )
    return rows, {
        "data_epoch": dataset.data_epoch,
        "row_count": dataset.row_count,
        "object_count": len(dataset.objects),
        "first_agg_trade_id": dataset.expected_first_agg_trade_id,
        "last_agg_trade_id": dataset.expected_last_agg_trade_id,
        "start_time_ms": dataset.start_time_ms,
        "end_time_ms": dataset.end_time_ms,
        "derived_bar_count": len(rows),
        "scanned_trade_rows": scanned,
    }


def _rss_bytes() -> int | None:
    if sys.platform == "win32":
        class _MemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
                ("PrivateUsage", ctypes.c_size_t),
            ]

        counters = _MemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        kernel32 = ctypes.windll.kernel32
        psapi = ctypes.windll.psapi
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        psapi.GetProcessMemoryInfo.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_ulong,
        ]
        psapi.GetProcessMemoryInfo.restype = ctypes.c_int
        handle = kernel32.GetCurrentProcess()
        if psapi.GetProcessMemoryInfo(
            handle,
            ctypes.byref(counters),
            counters.cb,
        ):
            return int(counters.WorkingSetSize)
        return None
    if sys.platform.startswith("linux"):
        try:
            resident_pages = int(
                Path("/proc/self/statm").read_text(encoding="ascii").split()[1]
            )
            return resident_pages * int(os.sysconf("SC_PAGE_SIZE"))
        except (OSError, ValueError, IndexError):
            return None
    return None


def _read_bytes() -> int | None:
    if sys.platform == "win32":
        class _IoCounters(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        counters = _IoCounters()
        kernel32 = ctypes.windll.kernel32
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.GetProcessIoCounters.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
        ]
        kernel32.GetProcessIoCounters.restype = ctypes.c_int
        handle = kernel32.GetCurrentProcess()
        if kernel32.GetProcessIoCounters(
            handle,
            ctypes.byref(counters),
        ):
            return int(counters.ReadTransferCount)
        return None
    if sys.platform.startswith("linux"):
        try:
            for line in Path("/proc/self/io").read_text(encoding="ascii").splitlines():
                if line.startswith("read_bytes:"):
                    return int(line.split(":", 1)[1])
        except (OSError, ValueError):
            return None
    return None


async def _measure(
    operation: Callable[[], Awaitable[_T]],
) -> tuple[_T, dict[str, object]]:
    wall_start = time.perf_counter()
    cpu_start = time.process_time()
    read_start = _read_bytes()
    rss_start = _rss_bytes()
    peak_rss = rss_start
    task = asyncio.create_task(operation())
    while not task.done():
        done, _pending = await asyncio.wait({task}, timeout=0.01)
        current = _rss_bytes()
        if current is not None:
            peak_rss = current if peak_rss is None else max(peak_rss, current)
        if done:
            break
    result = await task
    rss_end = _rss_bytes()
    if rss_end is not None:
        peak_rss = rss_end if peak_rss is None else max(peak_rss, rss_end)
    read_end = _read_bytes()
    return result, {
        "wall_ms": round((time.perf_counter() - wall_start) * 1_000, 3),
        "cpu_ms": round((time.process_time() - cpu_start) * 1_000, 3),
        "rss_start_bytes": rss_start,
        "rss_end_bytes": rss_end,
        "peak_rss_bytes": peak_rss,
        "read_bytes": (
            None
            if read_start is None or read_end is None
            else max(0, read_end - read_start)
        ),
    }


def _settings(path: Path, *, optimized: bool) -> ReplaySettings:
    return ReplaySettings(
        enabled=True,
        db_path=path,
        max_active_sessions=8,
        command_queue_size=64,
        event_buffer_size=10_000,
        max_emit_fps=30,
        max_warmup_bars=5_000,
        max_bar_dataset_rows=100_000,
        max_horizon_days=30,
        trade_page_rows=50_000,
        checkpoint_event_interval=10_000,
        checkpoint_virtual_ms=300_000,
        event_subscriber_queue=64,
        controller_ttl_seconds=3_600,
        idle_ttl_seconds=3_600,
        product_v2_enabled=True,
        replay_fast_forward_optimization_enabled=optimized,
    )


async def _service(
    *,
    path: Path,
    repository: object,
    archive: ParquetRawAggTradeArchive | None,
    now_ms: int,
    optimized: bool,
    prefix: str,
) -> ReplayService:
    service = ReplayService(
        settings=_settings(path, optimized=optimized),
        store=ReplaySQLiteStore(path, now_ms=lambda: now_ms),
        repository=repository,  # type: ignore[arg-type]
        raw_trade_archive=archive,
        now_ms=lambda: now_ms,
        session_id_factory=_SessionIdFactory(f"{prefix}-session"),
        training_run_id_factory=_SessionIdFactory(f"{prefix}-run"),
        native_intervals=lambda _identity: (INTERVAL,),
    )
    await service.start()
    return service


async def _create_run(
    service: ReplayService,
    *,
    source_kind: str,
    exchange: str,
    market_type: str,
    symbol: str,
    start_ms: int,
    forward_cache_ms: int,
    prefix: str,
) -> tuple[str, str, dict[str, object]]:
    catalog = await service.catalog(
        warmup_bars=WARMUP_BARS,
        horizon_ms=forward_cache_ms,
        quality_mode="exact",
        blind_mode=False,
    )
    request = TrainingRunCreateRequest.from_dict(
        {
            "protocol": "replay.v2",
            "catalog_epoch": catalog["catalog_epoch"],
            "name": f"Phase 15 real {source_kind} benchmark",
            "source_kind": source_kind,
            "start_mode": "MANUAL",
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol,
            "settlement_asset": "USDT",
            "base_interval": INTERVAL,
            "display_interval": INTERVAL,
            "requested_start_ms": start_ms,
            "warmup_bars": WARMUP_BARS,
            "forward_cache_ms": forward_cache_ms,
            "random_seed": 15,
            "initial_equity": "10000",
            "max_leverage": "3",
            "maker_fee_bps": "2",
            "taker_fee_bps": "5",
            "market_slippage_bps": "1",
            "integrity_mode": "CHALLENGE",
            "time_disclosure_policy": "NONE",
            "book_mode": "OFF",
            "margin_mode": "CROSS",
            "funding_mode": "OFF",
            "allow_rule_changes": False,
        }
    )
    assert service.training is not None
    created = await service.training.create_run(request)
    run = created["run"]
    assert isinstance(run, dict)
    run_id = str(run["run_id"])
    session_id = str(run["adapter_session_id"])
    session = await service.get_session(session_id)
    acquired = await service.training.command(
        run_id,
        _v2_command(
            run_id=run_id,
            command_id=f"{prefix}-acquire",
            command_type=ReplayV2CommandType.ACQUIRE_CONTROLLER,
            session=session,
            payload={"takeover": False},
        ),
    )
    return run_id, session_id, acquired


async def _execute_full_actor_reference(
    service: ReplayService,
    *,
    session_id: str,
    target_virtual_time_ms: int,
) -> dict[str, object]:
    """Run every source event through the actor without a period-summary jump.

    The internal empty-account command uses the same ordered source-event
    reducer as STEP while coalescing projection delivery.  That distinction is
    essential for multi-million-event evidence: publishing and hashing a
    growing public snapshot after every event measures UI delivery, not the
    Phase 15 reducer-call comparison.
    """

    consumed = 0
    chunks = 0
    while True:
        session = await service.get_session(session_id)
        snapshot = session["snapshot"]
        if not isinstance(snapshot, Mapping):
            raise TypeError("reference snapshot is invalid")
        cursor = snapshot["cursor"]
        if not isinstance(cursor, Mapping):
            raise TypeError("reference cursor is invalid")
        current = int(cursor["virtual_time_ms"])
        if current >= target_virtual_time_ms or snapshot["state"] == "ENDED":
            break
        chunk = await service.plan_source_chunk(
            session_id,
            target_time_ms=target_virtual_time_ms,
            max_events=service.settings.event_buffer_size,
        )
        count = int(chunk["event_count"])
        if count > 0:
            command_type: CommandType | InternalCommandType = (
                InternalCommandType.FAST_FORWARD_EMPTY_ACCOUNT
            )
            payload = {"count": count, "tail_events": 0}
        else:
            command_type = CommandType.ADVANCE_BY
            payload = {
                "ms": min(
                    target_virtual_time_ms - current,
                    30 * 86_400_000,
                )
            }
        result = await service.command(
            session_id,
            ReplayCommand(
                protocol=REPLAY_PROTOCOL,
                command_id=f"reference-step-{chunks + 1}",
                client_instance_id=CLIENT_ID,
                expected_revision=int(snapshot["revision"]),
                type=command_type,
                payload=payload,
            ),
            _training_internal=isinstance(command_type, InternalCommandType),
        )
        data = result["data"]
        if not isinstance(data, Mapping):
            raise TypeError("reference command data is invalid")
        consumed += int(data.get("consumed", 0))
        chunks += 1
        if result.get("state") != "ENDED":
            await service.heartbeat(session_id, CLIENT_ID)
        await asyncio.sleep(0)
    return {
        "data": {
            "consumed": consumed,
            "chunks": chunks,
            "path": "FULL_EVENT_SCAN_ACTOR_REDUCER",
        }
    }


def _v2_command(
    *,
    run_id: str,
    command_id: str,
    command_type: ReplayV2CommandType,
    session: Mapping[str, object],
    payload: Mapping[str, object],
) -> ReplayV2Command:
    snapshot = session.get("snapshot", session)
    if not isinstance(snapshot, Mapping):
        raise TypeError("benchmark adapter snapshot is invalid")
    cursor = snapshot.get("cursor")
    if not isinstance(cursor, Mapping):
        raise TypeError("benchmark adapter cursor is invalid")
    revision = int(snapshot["revision"])
    return ReplayV2Command(
        protocol="replay.v2",
        run_id=run_id,
        command_id=command_id,
        client_instance_id=CLIENT_ID,
        expected_revision=revision,
        expected_cursor=TrainingCursor(
            virtual_time_ms=int(cursor["virtual_time_ms"]),
            source_sequence=int(cursor["source_sequence"]),
            revision=revision,
        ),
        type=command_type,
        payload=dict(payload),
    )


def _database_bytes(path: Path) -> int:
    return sum(
        candidate.stat().st_size
        for candidate in (
            path,
            Path(f"{path}-wal"),
            Path(f"{path}-shm"),
        )
        if candidate.exists()
    )


def _database_checks(path: Path) -> dict[str, object]:
    with sqlite3.connect(path) as connection:
        quick = connection.execute("PRAGMA quick_check").fetchall()
        foreign = connection.execute("PRAGMA foreign_key_check").fetchall()
        summary = connection.execute(
            """
            SELECT candidate_count, source_event_count, raw_state_bytes,
                   compressed_bytes, build_wall_ms, build_cpu_ms,
                   build_proof_hash
            FROM replay_training_fast_forward_summary_set
            WHERE active = 1 AND status = 'READY'
            LIMIT 1
            """
        ).fetchone()
    return {
        "quick_check": [str(row[0]) for row in quick],
        "foreign_key_violations": len(foreign),
        "database_bytes": _database_bytes(path),
        "active_summary_set": (
            None
            if summary is None
            else {
                "candidate_count": int(summary[0]),
                "source_event_count": int(summary[1]),
                "raw_state_bytes": int(summary[2]),
                "compressed_bytes": int(summary[3]),
                "build_wall_ms": int(summary[4]),
                "build_cpu_ms": int(summary[5]),
                "build_proof_hash": str(summary[6]),
            }
        ),
    }


async def _run(args: argparse.Namespace) -> dict[str, object]:
    start_ms = int(args.start)
    span_ms = args.span_days * 86_400_000
    forward_cache_ms = span_ms
    target_bar_open_ms = start_ms + span_ms - INTERVAL_MS
    advance_request_ms = start_ms + span_ms
    warmup_start_ms = start_ms - WARMUP_BARS * INTERVAL_MS
    replay_end_close_ms = target_bar_open_ms + INTERVAL_MS - 1
    now_ms = replay_end_close_ms + 2 * INTERVAL_MS
    work_dir = args.work_dir.resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    optimized_db = work_dir / "optimized-replay.db"
    reference_db = work_dir / "reference-replay.db"
    if any(
        candidate.exists()
        for base in (optimized_db, reference_db)
        for candidate in (base, Path(f"{base}-wal"), Path(f"{base}-shm"))
    ):
        raise RuntimeError("benchmark replay databases already exist")

    input_proof: dict[str, object]
    input_stage: dict[str, object]
    archive: ParquetRawAggTradeArchive | None = None
    if args.kind == "BAR":
        if args.klines_db is None or not args.klines_db.is_file():
            raise RuntimeError("--klines-db must identify a real SQLite database")
        repository: object = _SQLiteKlinesRepository(
            args.klines_db,
            exchange=args.exchange,
            market_type=args.market_type,
            symbol=args.symbol,
        )

        async def inspect_bar_input() -> dict[str, object]:
            assert isinstance(repository, _SQLiteKlinesRepository)
            rows = await asyncio.to_thread(
                repository.query_bars,
                args.symbol,
                INTERVAL,
                warmup_start_ms,
                target_bar_open_ms,
                None,
                "ASC",
                args.exchange,
                args.market_type,
            )
            with sqlite3.connect(
                _read_only_uri(args.klines_db),
                uri=True,
            ) as connection:
                quick = connection.execute("PRAGMA quick_check").fetchall()
            return {
                "backend": "read_only_sqlite",
                "path": str(args.klines_db.resolve()),
                "file_bytes": args.klines_db.stat().st_size,
                "quick_check": [str(row[0]) for row in quick],
                "selected_rows": len(rows),
                "selected_range_hash": canonical_sha256(
                    _stable_storage_rows(rows)
                ),
                "warmup_start_ms": warmup_start_ms,
                "target_bar_open_ms": target_bar_open_ms,
                "replay_end_close_ms": replay_end_close_ms,
            }

        input_proof, input_stage = await _measure(inspect_bar_input)
    else:
        if args.archive_dir is None or not args.archive_dir.is_dir():
            raise RuntimeError(
                "--archive-dir must identify a checksum-verified Parquet archive"
            )
        archive = ParquetRawAggTradeArchive(
            args.archive_dir,
            max_rows_per_file=100_000,
            max_scan_files=4_096,
            max_scan_rows=5_000_000,
            max_physical_scan_rows=10_000_000,
        )

        async def prepare_trade_input() -> tuple[
            _MemoryKlinesRepository,
            dict[str, object],
        ]:
            assert archive is not None
            bars, proof = await asyncio.to_thread(
                _derive_trade_bars,
                archive,
                exchange=args.exchange,
                market_type=args.market_type,
                symbol=args.symbol,
                start_ms=warmup_start_ms,
                end_ms=replay_end_close_ms,
                page_rows=50_000,
            )
            formal = await asyncio.to_thread(
                archive.freeze_dataset,
                exchange=args.exchange,
                market_type=args.market_type,
                symbol=args.symbol,
                start_time_ms=start_ms,
                end_time_ms=replay_end_close_ms,
                page_rows=50_000,
            )
            return (
                _MemoryKlinesRepository(
                    bars,
                    exchange=args.exchange,
                    market_type=args.market_type,
                    symbol=args.symbol,
                ),
                {
                    "backend": "checksum_verified_parquet",
                    "path": str(args.archive_dir.resolve()),
                    **proof,
                    "formal_replay_data_epoch": formal.data_epoch,
                    "formal_replay_row_count": formal.row_count,
                    "formal_replay_first_agg_trade_id": (
                        formal.expected_first_agg_trade_id
                    ),
                    "formal_replay_last_agg_trade_id": (
                        formal.expected_last_agg_trade_id
                    ),
                },
            )

        prepared_input, input_stage = await _measure(prepare_trade_input)
        repository, input_proof = prepared_input

    optimized = await _service(
        path=optimized_db,
        repository=repository,
        archive=archive,
        now_ms=now_ms,
        optimized=True,
        prefix="optimized",
    )
    reference = await _service(
        path=reference_db,
        repository=repository,
        archive=archive,
        now_ms=now_ms,
        optimized=False,
        prefix="reference",
    )
    try:
        async def create_optimized() -> tuple[str, str, dict[str, object]]:
            return await _create_run(
                optimized,
                source_kind=args.kind,
                exchange=args.exchange,
                market_type=args.market_type,
                symbol=args.symbol,
                start_ms=start_ms,
                forward_cache_ms=forward_cache_ms,
                prefix="optimized",
            )

        optimized_created, optimized_setup = await _measure(create_optimized)
        optimized_run, optimized_session, _optimized_acquired = optimized_created

        async def create_reference() -> tuple[str, str, dict[str, object]]:
            return await _create_run(
                reference,
                source_kind=args.kind,
                exchange=args.exchange,
                market_type=args.market_type,
                symbol=args.symbol,
                start_ms=start_ms,
                forward_cache_ms=forward_cache_ms,
                prefix="reference",
            )

        reference_created, reference_setup = await _measure(create_reference)
        reference_run, reference_session, _reference_acquired = reference_created
        assert optimized.training is not None
        assert reference.training is not None
        summary_db_before = _database_bytes(optimized_db)

        async def prepare_summaries() -> dict[str, object]:
            return await optimized.training.prepare_period_summaries(
                optimized_run
            )

        prepared, summary_prepare = await _measure(prepare_summaries)
        summary_db_after = _database_bytes(optimized_db)
        plan = await optimized.training.get_fast_forward_plan(
            optimized_run,
            target_virtual_time_ms=advance_request_ms,
        )
        optimized_before = await optimized.get_session(optimized_session)

        async def execute_optimized() -> dict[str, object]:
            return await optimized.training.command(
                optimized_run,
                _v2_command(
                    run_id=optimized_run,
                    command_id="optimized-advance",
                    command_type=ReplayV2CommandType.ADVANCE_TO,
                    session=optimized_before,
                    payload={"virtual_time_ms": advance_request_ms},
                ),
            )

        optimized_result, optimized_execute = await _measure(execute_optimized)

        async def execute_reference() -> dict[str, object]:
            return await _execute_full_actor_reference(
                reference,
                session_id=reference_session,
                target_virtual_time_ms=advance_request_ms,
            )

        reference_result, reference_execute = await _measure(execute_reference)
        optimized_after = await optimized.get_session(optimized_session)
        reference_after = await reference.get_session(reference_session)
        optimized_report = await optimized.report(optimized_session)
        reference_report = await reference.report(reference_session)
        optimized_snapshot = optimized_after["snapshot"]
        reference_snapshot = reference_after["snapshot"]
        assert isinstance(optimized_snapshot, Mapping)
        assert isinstance(reference_snapshot, Mapping)
        optimized_data = optimized_result["data"]
        reference_data = reference_result["data"]
        assert isinstance(optimized_data, Mapping)
        assert isinstance(reference_data, Mapping)
        prepared_build = prepared["build"]
        assert isinstance(prepared_build, Mapping)
        expected_source_events = (
            span_ms // INTERVAL_MS
            if args.kind == "BAR"
            else int(input_proof["formal_replay_row_count"])
        )
        optimized_cursor = optimized_snapshot["cursor"]
        reference_cursor = reference_snapshot["cursor"]
        assert isinstance(optimized_cursor, Mapping)
        assert isinstance(reference_cursor, Mapping)
        optimized_storage = _database_checks(optimized_db)
        reference_storage = _database_checks(reference_db)
        checks = {
            "plan_is_checkpoint_jump": (
                plan["plan"]["mode"] == "CHECKPOINT_JUMP"  # type: ignore[index]
            ),
            "cursor_equal": (
                optimized_cursor == reference_cursor
            ),
            "intended_terminal_time_equal": (
                int(optimized_cursor["virtual_time_ms"]) == replay_end_close_ms
                and int(reference_cursor["virtual_time_ms"])
                == replay_end_close_ms
            ),
            "expected_source_event_count": (
                int(optimized_data["consumed"]) == expected_source_events
                and int(reference_data["consumed"]) == expected_source_events
                and int(optimized_cursor["source_sequence"])
                == expected_source_events
                and int(reference_cursor["source_sequence"])
                == expected_source_events
            ),
            "components_equal": (
                optimized_snapshot["components"]
                == reference_snapshot["components"]
            ),
            "state_hash_equal": (
                optimized_snapshot["state_hash"]
                == reference_snapshot["state_hash"]
            ),
            "report_hash_equal": (
                optimized_report["report"]["report_hash"]  # type: ignore[index]
                == reference_report["report"]["report_hash"]  # type: ignore[index]
            ),
            "summary_skipped_events_positive": (
                int(optimized_data["summary_skipped_events"]) > 0
            ),
            "tail_reducer_calls_less_than_reference": (
                int(optimized_data["tail_reducer_events"])
                < int(reference_data["consumed"])
            ),
            "prepare_reducer_calls_exact": (
                int(prepared_build["source_event_count"])
                >= int(optimized_data["summary_skipped_events"])
            ),
            "optimized_sqlite_quick_and_foreign_key_clean": (
                optimized_storage["quick_check"] == ["ok"]
                and optimized_storage["foreign_key_violations"] == 0
            ),
            "reference_sqlite_quick_and_foreign_key_clean": (
                reference_storage["quick_check"] == ["ok"]
                and reference_storage["foreign_key_violations"] == 0
            ),
        }
        return {
            "schema_version": SCHEMA_VERSION,
            "kind": args.kind,
            "identity": {
                "exchange": args.exchange,
                "market_type": args.market_type,
                "symbol": args.symbol,
                "interval": INTERVAL,
            },
            "window": {
                "start_ms": start_ms,
                "target_bar_open_ms": target_bar_open_ms,
                "advance_request_ms": advance_request_ms,
                "actual_terminal_time_ms": replay_end_close_ms,
                "span_days": args.span_days,
                "forward_cache_ms": forward_cache_ms,
                "warmup_bars": WARMUP_BARS,
            },
            "input": input_proof,
            "stages": {
                "input_prepare": input_stage,
                "optimized_run_setup": optimized_setup,
                "reference_run_setup": reference_setup,
                "summary_prepare": {
                    **summary_prepare,
                    "database_bytes_before": summary_db_before,
                    "database_bytes_after": summary_db_after,
                    "database_growth_bytes": max(
                        0,
                        summary_db_after - summary_db_before,
                    ),
                    "reducer_calls": int(
                        prepared_build["source_event_count"]
                    ),
                    "candidate_count": int(
                        prepared_build["candidate_count"]
                    ),
                    "compressed_bytes": int(
                        prepared_build["compressed_bytes"]
                    ),
                },
                "checkpoint_jump_execute": {
                    **optimized_execute,
                    "summary_skipped_events": int(
                        optimized_data["summary_skipped_events"]
                    ),
                    "tail_reducer_calls": int(
                        optimized_data["tail_reducer_events"]
                    ),
                    "consumed_source_events": int(
                        optimized_data["consumed"]
                    ),
                },
                "full_reference_execute": {
                    **reference_execute,
                    "reducer_calls": int(reference_data["consumed"]),
                    "chunks": int(reference_data["chunks"]),
                    "path": str(reference_data["path"]),
                },
            },
            "storage": {
                "optimized": optimized_storage,
                "reference": reference_storage,
            },
            "proof": {
                "plan": plan["plan"],
                "optimized_cursor": optimized_snapshot["cursor"],
                "reference_cursor": reference_snapshot["cursor"],
                "optimized_state_hash": optimized_snapshot["state_hash"],
                "reference_state_hash": reference_snapshot["state_hash"],
                "optimized_component_hash": canonical_sha256(
                    optimized_snapshot["components"]
                ),
                "reference_component_hash": canonical_sha256(
                    reference_snapshot["components"]
                ),
                "optimized_report_hash": optimized_report["report"]["report_hash"],  # type: ignore[index]
                "reference_report_hash": reference_report["report"]["report_hash"],  # type: ignore[index]
                "checks": checks,
                "passed": all(checks.values()),
            },
        }
    finally:
        await optimized.shutdown(step_timeout=5)
        await reference.shutdown(step_timeout=5)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Benchmark Phase 15 summary prepare/jump against a full exact "
            "reference over explicit real local inputs."
        )
    )
    parser.add_argument("--kind", required=True, choices=("BAR", "AGG_TRADE"))
    parser.add_argument("--exchange", required=True)
    parser.add_argument("--market-type", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--start", required=True, type=_utc_ms)
    parser.add_argument("--span-days", required=True, type=int, choices=(1, 7))
    parser.add_argument("--klines-db", type=Path)
    parser.add_argument("--archive-dir", type=Path)
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    return parser


def main() -> int:
    args = _parser().parse_args()
    if parse_interval_ms(INTERVAL) != INTERVAL_MS:
        raise RuntimeError("benchmark interval policy changed")
    result = asyncio.run(_run(args))
    payload = json.dumps(
        result,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    )
    print(payload)
    if args.output is not None:
        output = args.output.resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(payload + "\n", encoding="utf-8")
    return 0 if result["proof"]["passed"] else 2  # type: ignore[index]


if __name__ == "__main__":
    raise SystemExit(main())
