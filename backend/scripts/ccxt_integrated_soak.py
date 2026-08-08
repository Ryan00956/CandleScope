from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from collections.abc import Sequence
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.exchanges.ccxt_ext.soak import BinanceCcxtIntegratedSoakRunner  # noqa: E402


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Soak CCXT streams through CandleScope recovery and full-book.",
    )
    parser.add_argument("--symbol", default="BTCUSDT")
    parser.add_argument("--interval", default="1m")
    parser.add_argument("--depth-update-ms", type=int, default=250)
    parser.add_argument("--duration", type=float, default=14_400.0)
    parser.add_argument("--startup-timeout", type=float, default=45.0)
    parser.add_argument("--heartbeat", type=float, default=30.0)
    parser.add_argument("--full-book-max-levels", type=int, default=5_000)
    parser.add_argument(
        "--inject-disconnect-at",
        type=float,
        action="append",
        default=[],
        metavar="SECONDS",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--progress", type=Path)
    return parser


async def _run(args: argparse.Namespace) -> dict:
    progress = args.progress or args.output.with_suffix(".progress.json")
    runner = BinanceCcxtIntegratedSoakRunner(
        symbol=args.symbol,
        interval=args.interval,
        depth_update_interval_ms=args.depth_update_ms,
        duration_seconds=args.duration,
        startup_timeout_seconds=args.startup_timeout,
        heartbeat_seconds=args.heartbeat,
        full_book_max_levels_per_side=args.full_book_max_levels,
        disconnect_at_seconds=tuple(args.inject_disconnect_at),
        progress_path=progress,
    )
    return await runner.run()


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    report = asyncio.run(_run(args))
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    verdict = report["overall_verdict"]
    return 0 if verdict == "PASS" else (1 if verdict == "FAIL" else 2)


if __name__ == "__main__":
    raise SystemExit(main())
