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

from app.exchanges.ccxt_ext.shadow_matrix import (  # noqa: E402
    CcxtShadowMatrixRunner,
    CcxtShadowMatrixSpec,
    CcxtShadowTarget,
    load_shadow_matrix_spec,
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run a strict native-versus-CCXT parity matrix through one shared "
            "exchange profile."
        ),
    )
    parser.add_argument(
        "--config",
        type=Path,
        help="JSON matrix spec; explicit CLI values override top-level defaults",
    )
    parser.add_argument(
        "--profile",
        choices=("binance_spot", "binance_usdm", "okx_spot", "okx_swap"),
    )
    parser.add_argument("--symbols", nargs="+", metavar="SYMBOL")
    parser.add_argument("--interval")
    parser.add_argument("--depth-update-ms", type=int)
    parser.add_argument("--duration", type=float)
    parser.add_argument("--startup-timeout", type=float)
    parser.add_argument("--output", type=Path)
    return parser


def _spec_from_args(args: argparse.Namespace) -> CcxtShadowMatrixSpec:
    base = (
        load_shadow_matrix_spec(args.config)
        if args.config is not None
        else CcxtShadowMatrixSpec()
    )
    if args.symbols is None and args.interval is None and args.depth_update_ms is None:
        targets = base.targets
    else:
        source_symbols = args.symbols or [target.symbol for target in base.targets]
        base_by_symbol = {target.symbol: target for target in base.targets}
        targets = tuple(
            CcxtShadowTarget(
                symbol=symbol,
                ccxt_symbol=(
                    base_by_symbol.get(str(symbol).upper().strip()).ccxt_symbol
                    if str(symbol).upper().strip() in base_by_symbol
                    else None
                ),
                interval=args.interval
                or (
                    base_by_symbol.get(str(symbol).upper().strip()).interval
                    if str(symbol).upper().strip() in base_by_symbol
                    else "1m"
                ),
                depth_update_interval_ms=(
                    args.depth_update_ms
                    if args.depth_update_ms is not None
                    else (
                        base_by_symbol.get(
                            str(symbol).upper().strip()
                        ).depth_update_interval_ms
                        if str(symbol).upper().strip() in base_by_symbol
                        else 100
                    )
                ),
            )
            for symbol in source_symbols
        )
    return CcxtShadowMatrixSpec(
        profile=args.profile or base.profile,
        targets=targets,
        duration_seconds=(
            args.duration if args.duration is not None else base.duration_seconds
        ),
        startup_timeout_seconds=(
            args.startup_timeout
            if args.startup_timeout is not None
            else base.startup_timeout_seconds
        ),
    )


async def _run(args: argparse.Namespace) -> dict:
    return await CcxtShadowMatrixRunner(_spec_from_args(args)).run()


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
