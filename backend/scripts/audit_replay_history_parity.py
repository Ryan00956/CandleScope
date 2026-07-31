"""Compare immutable replay history with a live K-line SQLite overlap."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Mapping, Sequence

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.data_engine.interval_policy import parse_interval_ms  # noqa: E402
from app.replay.history_archive import (  # noqa: E402
    ReplayHistoryArchiveError,
    ReplayHistoryRepository,
)


_VALUE_FIELDS = (
    "open",
    "high",
    "low",
    "close",
    "volume",
    "quote_volume",
    "taker_buy_base",
    "taker_buy_quote",
)
_INTEGER_FIELDS = ("close_time", "trades")
_SELECT_FIELDS = (
    "open_time",
    *_INTEGER_FIELDS,
    *_VALUE_FIELDS,
)


def _timestamp_ms(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("timestamp must be epoch milliseconds") from exc
    if parsed < 0:
        raise argparse.ArgumentTypeError("timestamp must be non-negative")
    return parsed


def _decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ReplayHistoryArchiveError(
            "parity input contains a non-numeric K-line value"
        ) from exc
    if not parsed.is_finite():
        raise ReplayHistoryArchiveError(
            "parity input contains a non-finite K-line value"
        )
    return parsed


def _iso(value: int) -> str:
    return (
        datetime.fromtimestamp(value / 1_000, timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Read one replay-history revision and one live SQLite database "
            "without mutation, then compare their exact overlap."
        )
    )
    parser.add_argument("--archive-dir", required=True, type=Path)
    parser.add_argument("--live-db", required=True, type=Path)
    parser.add_argument("--exchange", default="binance")
    parser.add_argument("--market-type", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--interval", default="1m")
    parser.add_argument("--source-revision")
    parser.add_argument("--start-ms", type=_timestamp_ms)
    parser.add_argument("--end-ms", type=_timestamp_ms)
    parser.add_argument("--page-rows", type=int, default=50_000)
    parser.add_argument("--max-samples", type=int, default=20)
    parser.add_argument(
        "--require-exact",
        action="store_true",
        help="Exit with status 3 when any row or compared field differs.",
    )
    return parser


def _live_bounds(
    connection: sqlite3.Connection,
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    interval: str,
) -> tuple[int, int]:
    row = connection.execute(
        """
        SELECT MIN(open_time), MAX(open_time)
        FROM klines
        WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ?
        """,
        (exchange, market_type, symbol, interval),
    ).fetchone()
    if row is None or row[0] is None or row[1] is None:
        raise ReplayHistoryArchiveError(
            "live SQLite has no matching K-line series"
        )
    return int(row[0]), int(row[1])


def _live_page(
    connection: sqlite3.Connection,
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    interval: str,
    start_ms: int,
    end_ms: int,
) -> dict[int, Mapping[str, object]]:
    fields = ", ".join(_SELECT_FIELDS)
    rows = connection.execute(
        f"""
        SELECT {fields}
        FROM klines
        WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ?
          AND open_time BETWEEN ? AND ?
        ORDER BY open_time ASC
        """,
        (exchange, market_type, symbol, interval, start_ms, end_ms),
    )
    return {int(row["open_time"]): dict(row) for row in rows}


def audit(args: argparse.Namespace) -> dict[str, object]:
    interval_ms = parse_interval_ms(args.interval)
    if interval_ms is None or interval_ms < 1:
        raise ReplayHistoryArchiveError("unsupported replay interval")
    if args.page_rows < 1 or args.page_rows > 1_000_000:
        raise ReplayHistoryArchiveError("--page-rows must be between 1 and 1000000")
    if args.max_samples < 0 or args.max_samples > 1_000:
        raise ReplayHistoryArchiveError("--max-samples must be between 0 and 1000")

    repository = ReplayHistoryRepository(args.archive_dir)
    catalog = repository.describe_catalog(
        args.symbol,
        args.interval,
        exchange=args.exchange,
        market_type=args.market_type,
        source_revision=args.source_revision,
    )
    revision = str(catalog["catalog_epoch"])
    live_path = args.live_db.expanduser().resolve()
    if not live_path.is_file():
        raise ReplayHistoryArchiveError("live SQLite path is not a file")

    connection = sqlite3.connect(
        f"file:{live_path.as_posix()}?mode=ro",
        uri=True,
    )
    connection.row_factory = sqlite3.Row
    try:
        live_start, live_end = _live_bounds(
            connection,
            exchange=args.exchange,
            market_type=args.market_type,
            symbol=args.symbol,
            interval=args.interval,
        )
        overlap_start = max(live_start, int(catalog["earliest_open_ms"]))
        overlap_end = min(live_end, int(catalog["latest_open_ms"]))
        if args.start_ms is not None:
            overlap_start = max(overlap_start, args.start_ms)
        if args.end_ms is not None:
            overlap_end = min(overlap_end, args.end_ms)
        if overlap_start > overlap_end:
            raise ReplayHistoryArchiveError(
                "live SQLite and replay history have no requested overlap"
            )

        live_rows = 0
        archive_rows = 0
        common_rows = 0
        only_live = 0
        only_archive = 0
        field_difference_rows = 0
        mismatches = {field: 0 for field in (*_INTEGER_FIELDS, *_VALUE_FIELDS)}
        max_abs_difference = {field: Decimal(0) for field in _VALUE_FIELDS}
        samples: list[dict[str, object]] = []
        cursor = overlap_start
        while cursor <= overlap_end:
            page_end = min(
                overlap_end,
                cursor + (args.page_rows - 1) * interval_ms,
            )
            live = _live_page(
                connection,
                exchange=args.exchange,
                market_type=args.market_type,
                symbol=args.symbol,
                interval=args.interval,
                start_ms=cursor,
                end_ms=page_end,
            )
            archive = {
                int(row["open_time"]): row
                for row in repository.query_bars_at_revision(
                    revision,
                    args.symbol,
                    args.interval,
                    start_ms=cursor,
                    end_ms=page_end,
                    limit=args.page_rows + 1,
                    order="ASC",
                    exchange=args.exchange,
                    market_type=args.market_type,
                )
            }
            live_times = set(live)
            archive_times = set(archive)
            common_times = sorted(live_times & archive_times)
            live_rows += len(live)
            archive_rows += len(archive)
            common_rows += len(common_times)
            only_live += len(live_times - archive_times)
            only_archive += len(archive_times - live_times)
            for open_time in sorted(live_times - archive_times):
                if len(samples) < args.max_samples:
                    samples.append(
                        {
                            "open_time_ms": open_time,
                            "open_time_utc": _iso(open_time),
                            "difference": "only_live",
                        }
                    )
            for open_time in sorted(archive_times - live_times):
                if len(samples) < args.max_samples:
                    samples.append(
                        {
                            "open_time_ms": open_time,
                            "open_time_utc": _iso(open_time),
                            "difference": "only_archive",
                        }
                    )

            for open_time in common_times:
                differences: dict[str, dict[str, object]] = {}
                for field in _INTEGER_FIELDS:
                    left = live[open_time].get(field)
                    right = archive[open_time].get(field)
                    if left != right:
                        mismatches[field] += 1
                        differences[field] = {"live": left, "archive": right}
                for field in _VALUE_FIELDS:
                    left = _decimal(live[open_time].get(field))
                    right = _decimal(archive[open_time].get(field))
                    if left != right:
                        mismatches[field] += 1
                        differences[field] = {
                            "live": None if left is None else str(left),
                            "archive": None if right is None else str(right),
                        }
                        if left is not None and right is not None:
                            difference = abs(left - right)
                            max_abs_difference[field] = max(
                                max_abs_difference[field],
                                difference,
                            )
                if differences:
                    field_difference_rows += 1
                    if len(samples) < args.max_samples:
                        samples.append(
                            {
                                "open_time_ms": open_time,
                                "open_time_utc": _iso(open_time),
                                "differences": differences,
                            }
                        )
            cursor = page_end + interval_ms
    except sqlite3.Error as exc:
        raise ReplayHistoryArchiveError(
            "live SQLite could not be read for parity"
        ) from exc
    finally:
        connection.close()

    exact = (
        only_live == 0
        and only_archive == 0
        and all(count == 0 for count in mismatches.values())
    )
    return {
        "schema_version": "replay-history-parity-report.v1",
        "exact": exact,
        "identity": {
            "exchange": args.exchange,
            "market_type": args.market_type,
            "symbol": args.symbol,
        },
        "interval": args.interval,
        "source_revision": revision,
        "overlap": {
            "start_ms": overlap_start,
            "start_utc": _iso(overlap_start),
            "end_ms": overlap_end,
            "end_utc": _iso(overlap_end),
            "expected_grid_rows": (
                (overlap_end - overlap_start) // interval_ms
            )
            + 1,
        },
        "rows": {
            "live": live_rows,
            "archive": archive_rows,
            "common": common_rows,
            "only_live": only_live,
            "only_archive": only_archive,
            "field_difference_rows": field_difference_rows,
        },
        "field_mismatches": mismatches,
        "max_abs_difference": {
            field: str(value)
            for field, value in max_abs_difference.items()
        },
        "samples": samples,
        "samples_truncated": (
            only_live + only_archive + field_difference_rows
        )
        > len(samples),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        report = audit(args)
    except (ReplayHistoryArchiveError, OSError, ValueError) as exc:
        parser.exit(2, f"audit_replay_history_parity: error: {exc}\n")
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 3 if args.require_exact and not report["exact"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
