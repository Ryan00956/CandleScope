from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Sequence
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.exchanges.ccxt_ext.shadow import BinanceCcxtShadowRunner


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compare CandleScope native and CCXT Binance USD-M public streams.",
    )
    parser.add_argument("--symbol", default="BTCUSDT")
    parser.add_argument("--ccxt-symbol")
    parser.add_argument("--interval", default="1m")
    parser.add_argument("--depth-update-ms", type=int, default=100)
    parser.add_argument("--duration", type=float, default=65.0)
    parser.add_argument("--startup-timeout", type=float, default=30.0)
    parser.add_argument("--output", type=Path)
    return parser


async def _run(args: argparse.Namespace) -> dict:
    runner = BinanceCcxtShadowRunner(
        symbol=args.symbol,
        ccxt_symbol=args.ccxt_symbol,
        interval=args.interval,
        depth_update_interval_ms=args.depth_update_ms,
        duration_seconds=args.duration,
        startup_timeout_seconds=args.startup_timeout,
    )
    return await runner.run()


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    report = asyncio.run(_run(args))
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    verdict = report["overall_verdict"]
    return 0 if verdict == "PASS" else (1 if verdict == "FAIL" else 2)


if __name__ == "__main__":
    raise SystemExit(main())
