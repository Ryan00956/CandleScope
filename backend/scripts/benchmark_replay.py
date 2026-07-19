"""Replay v1 BAR and aggregate-trade release benchmark suite."""

from __future__ import annotations

import argparse
import asyncio
import json
import platform
import subprocess
import sys
from pathlib import Path
from typing import Mapping

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scripts.benchmark_replay_actor import run_benchmark as run_bar_benchmark  # noqa: E402
from scripts.benchmark_replay_trade import run_actor_benchmark  # noqa: E402


SCHEMA_VERSION = "replay-v1-benchmark-suite.v1"
DEFAULT_BASELINE = (
    BACKEND_ROOT.parent
    / "docs"
    / "perf-baselines"
    / "replay-v1-backend-20260718.json"
)


def _git_head() -> str | None:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=BACKEND_ROOT.parent,
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    value = completed.stdout.strip()
    return value if completed.returncode == 0 and value else None


def _required_number(payload: Mapping[str, object], key: str) -> float:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"benchmark metric {key} is unavailable")
    return float(value)


def _evaluate(
    report: Mapping[str, object],
    thresholds: Mapping[str, object],
) -> dict[str, object]:
    bar = report.get("bar")
    trade = report.get("agg_trade")
    if not isinstance(bar, Mapping) or not isinstance(trade, Mapping):
        raise ValueError("release verification requires both benchmark sources")
    bar_result = bar.get("result")
    bar_memory = bar.get("memory")
    bar_projection = bar.get("projection")
    bar_bounds = bar.get("bounds")
    trade_result = trade.get("result")
    trade_memory = trade.get("memory")
    trade_projection = trade.get("projection")
    trade_bounds = trade.get("bounds")
    sections = (
        bar_result,
        bar_memory,
        bar_projection,
        bar_bounds,
        trade_result,
        trade_memory,
        trade_projection,
        trade_bounds,
    )
    if not all(isinstance(section, Mapping) for section in sections):
        raise ValueError("benchmark report is missing a required metrics section")
    assert isinstance(bar_result, Mapping)
    assert isinstance(bar_memory, Mapping)
    assert isinstance(bar_projection, Mapping)
    assert isinstance(bar_bounds, Mapping)
    assert isinstance(trade_result, Mapping)
    assert isinstance(trade_memory, Mapping)
    assert isinstance(trade_projection, Mapping)
    assert isinstance(trade_bounds, Mapping)

    checks = {
        "bar_min_events_per_second": (
            _required_number(bar_result, "events_per_second")
            >= _required_number(thresholds, "bar_min_events_per_second")
        ),
        "bar_max_peak_delta_bytes": (
            _required_number(bar_memory, "peak_delta_bytes")
            <= _required_number(thresholds, "bar_max_peak_delta_bytes")
        ),
        "bar_max_late_half_growth_bytes": (
            _required_number(bar_memory, "late_half_growth_bytes")
            <= _required_number(thresholds, "bar_max_late_half_growth_bytes")
        ),
        "bar_projection_max_fps": (
            _required_number(bar_projection, "max_fps")
            <= _required_number(thresholds, "projection_max_fps")
        ),
        "bar_retained_structures_bounded": (
            bar_bounds.get("retained_structures_bounded") is True
        ),
        "trade_min_events_per_second": (
            _required_number(trade_result, "events_per_second")
            >= _required_number(thresholds, "trade_min_events_per_second")
        ),
        "trade_max_peak_delta_bytes": (
            _required_number(trade_memory, "peak_delta_bytes")
            <= _required_number(thresholds, "trade_max_peak_delta_bytes")
        ),
        "trade_max_late_half_growth_bytes": (
            _required_number(trade_memory, "late_half_growth_bytes")
            <= _required_number(thresholds, "trade_max_late_half_growth_bytes")
        ),
        "trade_projection_max_fps": (
            _required_number(trade_projection, "max_fps")
            <= _required_number(thresholds, "projection_max_fps")
        ),
        "trade_page_bound": (
            _required_number(trade_bounds, "archive_max_page_rows")
            <= _required_number(thresholds, "trade_max_page_rows")
        ),
        "trade_retained_structures_bounded": (
            trade_bounds.get("retained_structures_bounded") is True
        ),
        "trade_full_history_not_materialized": (
            trade_bounds.get("full_history_materialized") is False
        ),
    }
    return {
        "thresholds": dict(thresholds),
        "checks": checks,
        "passed": all(checks.values()),
    }


def _load_thresholds(path: Path) -> Mapping[str, object]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError("benchmark baseline must be a JSON object")
    thresholds = payload.get("acceptance_thresholds")
    if not isinstance(thresholds, Mapping):
        raise ValueError("benchmark baseline has no acceptance_thresholds")
    return thresholds


async def run_suite(args: argparse.Namespace) -> dict[str, object]:
    report: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "environment": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "machine": platform.machine(),
            "git_head": _git_head(),
        },
        "scope": {
            "bar": "generated source -> ReplaySessionActor -> bounded projection/checkpoint",
            "agg_trade": (
                "generated paged source -> ReplaySessionActor -> "
                "AGG_TRADE_TAPE_V1 broker -> trade bar builder"
            ),
            "sqlite_persistence": False,
            "browser_heap": False,
        },
    }
    if not args.skip_bar:
        report["bar"] = await run_bar_benchmark(
            bar_count=args.bars,
            command_queue_size=args.command_queue_size,
            event_buffer_size=args.event_buffer_size,
            checkpoint_event_interval=args.checkpoint_event_interval,
            checkpoint_virtual_ms=args.checkpoint_virtual_ms,
        )
    if not args.skip_trade:
        report["agg_trade"] = await run_actor_benchmark(
            trade_count=args.trades,
            page_rows=args.trade_page_rows,
            max_closed_bars=args.max_closed_bars,
            command_queue_size=args.command_queue_size,
            event_buffer_size=args.event_buffer_size,
            checkpoint_event_interval=args.checkpoint_event_interval,
            checkpoint_virtual_ms=args.checkpoint_virtual_ms,
        )
    if args.baseline is not None:
        report["acceptance"] = _evaluate(
            report,
            _load_thresholds(args.baseline.resolve()),
        )
    else:
        report["acceptance"] = {
            "passed": None,
            "status": "candidate_unfrozen",
        }
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run bounded BAR and AGG_TRADE actor benchmarks and optionally "
            "verify the frozen release baseline."
        )
    )
    parser.add_argument("--bars", type=int, default=43_200)
    parser.add_argument("--trades", type=int, default=1_000_000)
    parser.add_argument("--trade-page-rows", type=int, default=50_000)
    parser.add_argument("--max-closed-bars", type=int, default=128)
    parser.add_argument("--command-queue-size", type=int, default=32)
    parser.add_argument("--event-buffer-size", type=int, default=512)
    parser.add_argument("--checkpoint-event-interval", type=int, default=10_000)
    parser.add_argument("--checkpoint-virtual-ms", type=int, default=300_000)
    parser.add_argument("--skip-bar", action="store_true")
    parser.add_argument("--skip-trade", action="store_true")
    parser.add_argument(
        "--baseline",
        type=Path,
        default=None,
        help=(
            "Baseline JSON containing acceptance_thresholds. The default "
            f"release path is {DEFAULT_BASELINE}."
        ),
    )
    args = parser.parse_args()
    if args.skip_bar and args.skip_trade:
        parser.error("cannot skip both benchmark sources")
    for name in (
        "bars",
        "trades",
        "trade_page_rows",
        "max_closed_bars",
        "command_queue_size",
        "event_buffer_size",
        "checkpoint_event_interval",
        "checkpoint_virtual_ms",
    ):
        if getattr(args, name) < 1:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    return args


def main() -> int:
    args = parse_args()
    report = asyncio.run(run_suite(args))
    print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
    acceptance = report.get("acceptance")
    if isinstance(acceptance, Mapping) and acceptance.get("passed") is False:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
