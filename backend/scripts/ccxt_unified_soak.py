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

from app.exchanges.ccxt_ext.unified_soak import CcxtUnifiedSoakRunner  # noqa: E402


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Soak generic CCXT unified streams through CandleScope sessions.",
    )
    parser.add_argument("--exchange", default="bybit")
    parser.add_argument("--market-type", default="swap.linear")
    parser.add_argument(
        "--symbol",
        action="append",
        default=[],
        help="Repeatable CCXT unified symbol; defaults to BTC/ETH USDT swaps.",
    )
    parser.add_argument("--interval", default="1m")
    parser.add_argument("--depth-levels", type=int, default=5)
    parser.add_argument("--duration", type=float, default=14_400.0)
    parser.add_argument("--startup-timeout", type=float, default=60.0)
    parser.add_argument("--heartbeat", type=float, default=30.0)
    parser.add_argument("--stale-after", type=float, default=90.0)
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
    runner = CcxtUnifiedSoakRunner(
        exchange_id=args.exchange,
        market_type=args.market_type,
        symbols=tuple(args.symbol) or ("BTC/USDT:USDT", "ETH/USDT:USDT"),
        interval=args.interval,
        depth_levels=args.depth_levels,
        duration_seconds=args.duration,
        startup_timeout_seconds=args.startup_timeout,
        heartbeat_seconds=args.heartbeat,
        stale_after_seconds=args.stale_after,
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
    return 0 if report["overall_verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
