"""Independent verification probe: one official template through Host BAR.

Does not enable production HTTP flags. Uses TRUSTED_LOCAL only for this process.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "1")

from app.backtest.service import BacktestService
from app.backtest.strategy.python_bundle import inspect_directory
from app.backtest.strategy.python_provider import PythonHostProvider
from app.core.config import load_backtest_settings
from app.market_dataset.snapshot import MarketEvent


def _events() -> tuple[MarketEvent, ...]:
    closes = (10, 10, 10, 11, 12, 13, 20, 21)
    events = []
    for index, close in enumerate(closes, start=1):
        events.append(
            MarketEvent(
                sequence=index,
                event_time_ms=(1_700_000_000 + index * 60) * 1000,
                role="BARS",
                payload={
                    "open_time_ms": (1_700_000_000 + (index - 1) * 60) * 1000,
                    "close_time_ms": (1_700_000_000 + index * 60) * 1000,
                    "open": str(close),
                    "high": str(close),
                    "low": str(close),
                    "close": str(close),
                    "volume": "1",
                    "time": 1_700_000_000 + index * 60,
                },
            )
        )
    return tuple(events)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", default="sma_cross")
    parser.add_argument("--work-dir", default="")
    args = parser.parse_args()
    templates = ROOT / "packages" / "candlescope-backtest-sdk" / "templates"
    if args.work_dir:
        candidate = Path(args.work_dir) / "templates" / args.template
        if candidate.is_dir():
            templates = Path(args.work_dir) / "templates"
    directory = templates / args.template
    golden_path = (
        ROOT / "packages" / "candlescope-backtest-sdk" / "templates" / "goldens" / f"{args.template}.json"
    )
    work = Path(args.work_dir) if args.work_dir else Path(os.environ.get("TEMP", ".")) / "cs-py-probe"
    work.mkdir(parents=True, exist_ok=True)
    settings = load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=work / "host",
        klines_db_path=work / "host" / "candlescope.db",
        replay_db_path=work / "host" / "replay.db",
    )
    inspected = inspect_directory(directory)
    parameters = {
        "sma_cross": {"fast": 2, "slow": 3},
        "rsi_wilder_24": {"length": 3, "oversold": 30, "overbought": 70},
        "donchian_breakout": {"lookback": 2},
        "mean_reversion": {"lookback": 3, "band": 0.5},
        "snapshot_restore": {"fast": 2, "slow": 3},
    }.get(args.template, {})
    service = BacktestService.start(settings, now_ms=1)
    try:
        bundle = service.create_python_strategy_bundle(directory=str(directory), now_ms=2)
        revision = service.create_python_strategy_revision(bundle["bundle_id"], now_ms=3)
        created = service.create_run(
            {
                "strategy_revision_id": revision["revision_id"],
                "dataset_id": "local-0123456789abcdef0123456789abcdef",
                "data_epoch": "sha256:" + "ab" * 32,
                "snapshot_hash": "sha256:" + "cd" * 32,
                "fidelity_mode": "BAR_APPROX",
                "start_time_ms": 1,
                "end_time_ms": 2,
                "parameters": parameters,
                "output_mode": inspected["manifest"]["outputModes"][0],
            },
            idempotency_key="probe-1",
            now_ms=4,
        )
        completed = service.execute_bar_run(
            created["run_id"],
            events=_events(),
            provider=PythonHostProvider(directory, parameters=parameters),
            now_ms=5,
        )
    finally:
        service.shutdown()
    report_hash = completed["result"]["report_hash"]
    decision_hash = completed["result"]["decision_hash"]
    if golden_path.is_file():
        expected = json.loads(golden_path.read_text(encoding="utf-8"))
        if expected["bundle_hash"] != inspected["bundle_hash"]:
            raise SystemExit("bundle hash mismatch")
        if expected["decision_hash"] != decision_hash:
            raise SystemExit("decision hash mismatch")
    print(
        json.dumps(
            {
                "template": args.template,
                "state": completed["state"],
                "bundle_hash": inspected["bundle_hash"],
                "decision_hash": decision_hash,
                "report_hash": report_hash,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
