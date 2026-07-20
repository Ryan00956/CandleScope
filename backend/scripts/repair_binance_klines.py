"""Verify and optionally repair ambiguous Binance K-lines offline.

Examples (run from ``backend``)::

    python scripts/repair_binance_klines.py --db data/candlescope.db \
        --symbol BTCUSDT --interval 1h --start 2026-07-10T00:00:00Z \
        --end 2026-07-20T00:00:00Z --report repair-dry-run.json

    # Stop CandleScope first.  Apply is refused unless both flags are present.
    python scripts/repair_binance_klines.py --db data/candlescope.db \
        --symbol BTCUSDT --interval 1h --apply --confirm
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


# Make ``app`` importable when this file is executed directly from either the
# repository root or the backend directory.
_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.data_engine.storage.kline_repair import (  # noqa: E402
    DEFAULT_CANDIDATE_SOURCE,
    RepairApplyError,
    RepairRequest,
    RepairValidationError,
    run_with_default_fetcher,
)


_MIN_EPOCH_MS = 946_684_800_000  # 2000-01-01T00:00:00Z
_MAX_EPOCH_MS = 4_102_444_800_000  # 2100-01-01T00:00:00Z


def _timestamp(value: str) -> int:
    text = str(value).strip()
    try:
        parsed_ms = int(text)
    except ValueError:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError(
                "ISO-8601 repair timestamps must include Z or an explicit UTC offset"
            )
        parsed_ms = int(parsed.astimezone(timezone.utc).timestamp() * 1000)
    if not _MIN_EPOCH_MS <= parsed_ms <= _MAX_EPOCH_MS:
        raise ValueError(
            "repair timestamps must be epoch milliseconds between 2000 and 2100; "
            "epoch seconds are not accepted"
        )
    return parsed_ms


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Dry-run Binance REST verification for ambiguous K-lines. "
            "Apply mode is an OFFLINE operation: stop CandleScope first."
        )
    )
    parser.add_argument("--db", required=True, type=Path, help="Explicit CandleScope SQLite database")
    parser.add_argument("--exchange", action="append", help="Repeatable; only binance is accepted")
    parser.add_argument("--market-type", action="append", choices=("spot", "futures"), help="Repeatable market filter")
    parser.add_argument("--symbol", action="append", help="Repeatable symbol filter, for example BTCUSDT")
    parser.add_argument("--interval", action="append", help="Repeatable Binance-native interval filter")
    parser.add_argument(
        "--source",
        action="append",
        help=f"Repeatable candidate source (default: {DEFAULT_CANDIDATE_SOURCE})",
    )
    parser.add_argument(
        "--start",
        type=_timestamp,
        help="Inclusive epoch milliseconds or timezone-qualified ISO-8601 timestamp",
    )
    parser.add_argument(
        "--end",
        type=_timestamp,
        help="Inclusive epoch milliseconds or timezone-qualified ISO-8601 timestamp",
    )
    parser.add_argument("--report", type=Path, help="JSON manifest path (default: beside database)")
    parser.add_argument(
        "--backup-dir",
        type=Path,
        help="Backup directory; safety policy requires the database directory",
    )
    parser.add_argument("--max-candidates", type=int, default=10_000, help="Explicit selection safety cap")
    parser.add_argument("--apply", action="store_true", help="Apply the verified batch atomically")
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Acknowledge CandleScope is stopped; required together with --apply",
    )
    return parser.parse_args(argv)


async def _run(args: argparse.Namespace) -> int:
    request = RepairRequest(
        db_path=args.db,
        exchanges=tuple(args.exchange or ("binance",)),
        market_types=tuple(args.market_type or ()),
        symbols=tuple(args.symbol or ()),
        intervals=tuple(args.interval or ()),
        sources=tuple(args.source or (DEFAULT_CANDIDATE_SOURCE,)),
        start_ms=args.start,
        end_ms=args.end,
        report_path=args.report,
        backup_dir=args.backup_dir,
        max_candidates=args.max_candidates,
        apply=args.apply,
        confirm=args.confirm,
    )
    try:
        manifest = await run_with_default_fetcher(request)
    except RepairApplyError as exc:
        print(json.dumps(exc.manifest, ensure_ascii=False, indent=2))
        status = exc.manifest.get("result", {}).get("status")
        if status == "applied_manifest_write_failed":
            print(
                f"repair committed; manifest write failed: {exc}",
                file=sys.stderr,
            )
        elif status == "rolled_back":
            print(f"repair rolled back: {exc}", file=sys.stderr)
        else:
            print(f"repair failed: {exc}", file=sys.stderr)
        return 3
    except RepairValidationError as exc:
        print(f"repair refused: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    status = manifest.get("result", {}).get("status")
    if status == "no_candidates":
        return 2 if args.apply else 0
    return 0 if status in {"dry_run_ready", "applied"} else 2


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.apply:
        print(
            "OFFLINE APPLY: CandleScope must be stopped. A SQLite backup, quick_check, "
            "candidate CAS and one atomic transaction will be used.",
            file=sys.stderr,
        )
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
