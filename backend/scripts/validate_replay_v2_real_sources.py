"""Validate real BAR data and one checksum-bound official aggTrade day.

This is a Phase 18 release-evidence command.  It is intentionally stricter than
the development smoke fixture:

* the K-line source is opened read-only and hashed before and after inspection;
* two real Binance spot identities must each contain a contiguous 1m window;
* the aggregate-trade source is downloaded from Binance Vision over HTTPS,
  verified against its official CHECKSUM, imported, frozen, and revalidated;
* the resulting evidence is bound to one clean Git HEAD and written outside the
  repository.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sqlite3
import sys
from collections.abc import Iterable, Mapping, Sequence
from datetime import date
from pathlib import Path

try:
    from scripts.replay_v2_release_common import (
        assert_clean_head,
        capture_clean_head,
        require_external_head_path,
        utc_now,
        write_json,
    )
except ModuleNotFoundError:
    from replay_v2_release_common import (  # type: ignore[no-redef]
        assert_clean_head,
        capture_clean_head,
        require_external_head_path,
        utc_now,
        write_json,
    )

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.data_engine.storage.raw_trade_archive import (  # noqa: E402
    ParquetRawAggTradeArchive,
)
from app.replay.trade_import import import_official_date_range  # noqa: E402


SCHEMA_VERSION = "replay.v2.real-source-validation.v1"
BAR_INTERVAL_MS = 60_000
DEFAULT_WINDOW_ROWS = 4_000
REQUIRED_KLINE_COLUMNS = {
    "exchange",
    "market_type",
    "symbol",
    "interval",
    "open_time",
    "close_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "quote_volume",
    "trades",
    "taker_buy_base",
    "taker_buy_quote",
    "source",
}
BAR_SYMBOLS = ("BTCUSDT", "ETHUSDT")


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _date(value: str) -> date:
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--agg-day must use YYYY-MM-DD") from exc
    if parsed.isoformat() != value:
        raise argparse.ArgumentTypeError("--agg-day must use canonical YYYY-MM-DD")
    return parsed


def _read_only_connection(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(
        f"file:{path.as_posix()}?mode=ro&immutable=1",
        uri=True,
    )


def _finite_non_negative(value: object, field: str) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"real BAR {field} is not numeric") from exc
    if not math.isfinite(parsed) or parsed < 0:
        raise ValueError(f"real BAR {field} is not finite and non-negative")
    return parsed


def _select_latest_contiguous_window(
    rows: Sequence[tuple[object, ...]],
    *,
    required_rows: int,
) -> list[tuple[object, ...]]:
    if required_rows < 2:
        raise ValueError("required BAR window must contain at least two rows")
    best_start = 0
    best_length = 0
    current_start = 0
    for index, row in enumerate(rows):
        if index > 0:
            previous = rows[index - 1]
            contiguous = (
                int(row[0]) == int(previous[0]) + BAR_INTERVAL_MS
                and int(previous[1]) == int(row[0]) - 1
            )
            if not contiguous:
                current_start = index
        current_length = index - current_start + 1
        if current_length >= best_length:
            best_start = current_start
            best_length = current_length
    if best_length < required_rows:
        raise ValueError(
            f"real BAR source has only {best_length} contiguous rows; "
            f"{required_rows} required"
        )
    # The latest part of the longest/latest equal-length run is most useful for
    # release QA while remaining completely deterministic.
    end = best_start + best_length
    return list(rows[end - required_rows : end])


def validate_kline_source(
    path: Path,
    *,
    required_rows: int = DEFAULT_WINDOW_ROWS,
    symbols: Iterable[str] = BAR_SYMBOLS,
) -> dict[str, object]:
    raw_source = path.expanduser()
    if raw_source.is_symlink():
        raise ValueError("real K-line source must be a regular non-symlink file")
    source = raw_source.resolve()
    if not source.is_file() or source.is_symlink():
        raise ValueError("real K-line source must be a regular non-symlink file")
    wal_path = source.with_name(f"{source.name}-wal")
    if wal_path.exists() and wal_path.stat().st_size:
        raise ValueError("real K-line source has an uncheckpointed WAL")
    size_before = source.stat().st_size
    digest_before = _file_sha256(source)
    identity_results: list[dict[str, object]] = []
    with _read_only_connection(source) as connection:
        quick_check = connection.execute("PRAGMA quick_check").fetchone()
        if quick_check != ("ok",):
            raise ValueError(f"real K-line SQLite quick_check failed: {quick_check}")
        columns = {
            str(row[1])
            for row in connection.execute("PRAGMA table_info(klines)").fetchall()
        }
        missing = sorted(REQUIRED_KLINE_COLUMNS - columns)
        if missing:
            raise ValueError(f"real K-line source is missing columns: {missing}")
        for raw_symbol in symbols:
            symbol = str(raw_symbol).strip().upper()
            rows = connection.execute(
                """
                SELECT
                    open_time, close_time, open, high, low, close, volume,
                    quote_volume, trades, taker_buy_base, taker_buy_quote, source
                FROM klines
                WHERE exchange = 'binance'
                  AND market_type = 'spot'
                  AND symbol = ?
                  AND interval = '1m'
                ORDER BY open_time
                """,
                (symbol,),
            ).fetchall()
            window = _select_latest_contiguous_window(
                rows,
                required_rows=required_rows,
            )
            sources: set[str] = set()
            semantic_rows: list[dict[str, object]] = []
            for row in window:
                open_time = int(row[0])
                close_time = int(row[1])
                if close_time != open_time + BAR_INTERVAL_MS - 1:
                    raise ValueError("real BAR close_time is not an exact 1m boundary")
                values = {
                    "open": _finite_non_negative(row[2], "open"),
                    "high": _finite_non_negative(row[3], "high"),
                    "low": _finite_non_negative(row[4], "low"),
                    "close": _finite_non_negative(row[5], "close"),
                    "volume": _finite_non_negative(row[6], "volume"),
                    "quote_volume": _finite_non_negative(
                        row[7],
                        "quote_volume",
                    ),
                    "trades": int(row[8]),
                    "taker_buy_base": _finite_non_negative(
                        row[9],
                        "taker_buy_base",
                    ),
                    "taker_buy_quote": _finite_non_negative(
                        row[10],
                        "taker_buy_quote",
                    ),
                }
                if (
                    values["open"] <= 0
                    or values["high"] <= 0
                    or values["low"] <= 0
                    or values["close"] <= 0
                    or values["trades"] < 0
                    or values["low"] > min(values["open"], values["close"])
                    or values["high"] < max(values["open"], values["close"])
                    or values["high"] < values["low"]
                ):
                    raise ValueError("real BAR OHLC/trade invariants failed")
                source_name = str(row[11]).strip()
                if not source_name:
                    raise ValueError("real BAR source provenance is blank")
                sources.add(source_name)
                semantic_rows.append(
                    {
                        "open_time": open_time,
                        "close_time": close_time,
                        **values,
                        "source": source_name,
                    }
                )
            identity_results.append(
                {
                    "exchange": "binance",
                    "market_type": "spot",
                    "symbol": symbol,
                    "interval": "1m",
                    "available_rows": len(rows),
                    "validated_rows": len(window),
                    "range_start_ms": int(window[0][0]),
                    "range_end_ms": int(window[-1][1]),
                    "source_labels": sorted(sources),
                    "semantic_sha256": hashlib.sha256(
                        _canonical_json(semantic_rows)
                    ).hexdigest(),
                    "contiguous": True,
                }
            )
    size_after = source.stat().st_size
    digest_after = _file_sha256(source)
    if size_after != size_before or digest_after != digest_before:
        raise RuntimeError("real K-line source changed during validation")
    return {
        "kind": "REAL_BAR_SQLITE",
        "file_name": source.name,
        "file_bytes": size_before,
        "file_sha256": digest_before,
        "sqlite_quick_check": "ok",
        "read_only": True,
        "identities": identity_results,
        "passed": True,
    }


def validate_official_agg_trade(
    archive_dir: Path,
    *,
    day: date,
) -> dict[str, object]:
    report = import_official_date_range(
        archive_dir=archive_dir,
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start=day,
        end=day,
        require_checksum=True,
    )
    days = report.get("days")
    if not isinstance(days, list) or len(days) != 1:
        raise RuntimeError("official aggTrade importer did not return one day")
    imported = days[0]
    if not isinstance(imported, Mapping):
        raise RuntimeError("official aggTrade import day is malformed")
    row_count = int(imported["row_count"])
    if row_count < 1:
        raise RuntimeError("official aggTrade import is empty")
    receipt_path = (
        archive_dir
        / "exchange=binance"
        / "market_type=futures"
        / "symbol=BTCUSDT"
        / f"date={day.isoformat()}"
        / "_verified_import.json"
    )
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    metadata = receipt.get("metadata")
    objects = receipt.get("objects")
    if not isinstance(metadata, Mapping) or not isinstance(objects, list) or not objects:
        raise RuntimeError("official aggTrade verified receipt is malformed")
    archive = ParquetRawAggTradeArchive(
        archive_dir,
        max_scan_rows=row_count + 1,
        max_physical_scan_rows=row_count + 1,
    )
    dataset = archive.freeze_dataset(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_time_ms=int(metadata["first_trade_time_ms"]),
        end_time_ms=int(metadata["last_trade_time_ms"]),
        page_rows=min(100_000, row_count),
    )
    archive.validate_dataset(dataset)
    if (
        dataset.row_count != row_count
        or dataset.expected_first_agg_trade_id
        != int(imported["first_agg_trade_id"])
        or dataset.expected_last_agg_trade_id
        != int(imported["last_agg_trade_id"])
        or dataset.source_quality != "binance_public_checksum"
    ):
        raise RuntimeError("official aggTrade frozen dataset drifted from import")
    return {
        "kind": "BINANCE_VISION_USDM_AGG_TRADE",
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "date": day.isoformat(),
        "source_url": metadata["source_url"],
        "official_checksum_sha256": imported["source_checksum_sha256"],
        "row_count": row_count,
        "first_agg_trade_id": dataset.expected_first_agg_trade_id,
        "last_agg_trade_id": dataset.expected_last_agg_trade_id,
        "range_start_ms": dataset.start_time_ms,
        "range_end_ms": dataset.end_time_ms,
        "object_count": len(dataset.objects),
        "dataset_epoch": dataset.data_epoch,
        "completeness": dataset.completeness,
        "source_quality": dataset.source_quality,
        "checksum_required": report["require_checksum"],
        "idempotent_import": bool(imported["idempotent"]),
        "passed": True,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--klines-db", type=Path, required=True)
    parser.add_argument("--agg-archive-dir", type=Path, required=True)
    parser.add_argument("--agg-day", type=_date, required=True)
    parser.add_argument("--bar-window-rows", type=int, default=DEFAULT_WINDOW_ROWS)
    args = parser.parse_args()
    if args.bar_window_rows < DEFAULT_WINDOW_ROWS:
        parser.error(
            f"--bar-window-rows must be at least {DEFAULT_WINDOW_ROWS} "
            "for release evidence"
        )
    return args


def main() -> int:
    args = parse_args()
    evidence = capture_clean_head()
    head = str(evidence["git_head"])
    output = require_external_head_path(args.out, head)
    archive_dir = require_external_head_path(args.agg_archive_dir, head)
    archive_dir.mkdir(parents=True, exist_ok=True)
    bar = validate_kline_source(
        args.klines_db,
        required_rows=args.bar_window_rows,
    )
    agg_trade = validate_official_agg_trade(
        archive_dir,
        day=args.agg_day,
    )
    checks = {
        "real_bar_two_identities": len(bar["identities"]) == len(BAR_SYMBOLS),
        "real_bar_contiguous": all(
            bool(item["contiguous"])
            for item in bar["identities"]  # type: ignore[union-attr]
        ),
        "real_bar_read_only": bar["read_only"] is True,
        "official_checksum_required": agg_trade["checksum_required"] is True,
        "official_agg_exact": (
            agg_trade["completeness"] == "exact"
            and agg_trade["source_quality"] == "binance_public_checksum"
        ),
        "official_agg_nonempty": int(agg_trade["row_count"]) > 0,
    }
    if not all(checks.values()):
        raise RuntimeError(f"real-source release validation failed: {checks}")
    assert_clean_head(head)
    report = {
        "schema_version": SCHEMA_VERSION,
        "recorded_at": utc_now(),
        "release_evidence": evidence,
        "passed": True,
        "checks": checks,
        "bar": bar,
        "agg_trade": agg_trade,
        "production_support_effect": {
            "BAR": "REAL_SOURCE_VALIDATED",
            "AGG_TRADE": "OFFICIAL_CHECKSUM_SOURCE_VALIDATED",
            "BOOK_ASSISTED_REQUIRED": "HOLD_NO_PRODUCTION_CAPTURE",
            "HISTORICAL_EXACT_ACCOUNT": "HOLD_NO_PRODUCTION_CAPTURE",
        },
    }
    write_json(output, report)
    assert_clean_head(head)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
