"""Host-owned Python BAR / aggTrade lifecycle used by N10 smoke and soak."""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from app.backtest.service import BacktestService
from app.backtest.strategy.python_provider import PythonHostProvider
from app.core.config import load_backtest_settings
from app.market_dataset.snapshot import MarketEvent
from app.simulation.trade_bar_builder import derive_complete_trade_bars

SMA_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "candlescope-backtest-sdk"
    / "fixtures"
    / "sma_cross"
)


def _agg_trade(sequence: int, time_ms: int, price: str) -> MarketEvent:
    return MarketEvent(
        sequence=sequence,
        event_time_ms=time_ms,
        role="TRADES",
        payload={
            "source_event_kind": "AGG_TRADE",
            "source_sequence": 1000 + sequence,
            "tie_break": f"AGG_TRADE:{1000 + sequence}",
            "price": price,
            "qty": "1",
        },
    )


def run_python_host_lifecycle(
    root: Path,
    *,
    cycles: int = 1,
    include_aggtrade: bool = True,
) -> dict[str, Any]:
    if cycles < 1:
        raise ValueError("cycles must be positive")
    os.environ.setdefault("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "1")
    started = time.monotonic()
    settings = load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_TRADE_TAPE_ENABLED": "1",
        },
        data_dir=root,
        klines_db_path=root / "candlescope.db",
        replay_db_path=root / "replay.db",
    )
    service = BacktestService.start(settings, now_ms=1)
    completed: list[dict[str, Any]] = []
    try:
        bundle = service.create_python_strategy_bundle(
            directory=str(SMA_FIXTURE), now_ms=2
        )
        revision = service.create_python_strategy_revision(
            bundle["bundle_id"], now_ms=3
        )
        closes = (10, 10, 10, 11, 12, 13, 20, 21)
        trades = tuple(
            _agg_trade(index + 1, index * 60_000 + 1_000, str(price))
            for index, price in enumerate(closes)
        )
        bars = derive_complete_trade_bars(trades, "1m")
        for cycle in range(cycles):
            bar_run = service.create_run(
                {
                    "strategy_revision_id": revision["revision_id"],
                    "dataset_id": "local-0123456789abcdef0123456789abcdef",
                    "data_epoch": "sha256:" + "ab" * 32,
                    "snapshot_hash": "sha256:" + "cd" * 32,
                    "fidelity_mode": "BAR_APPROX",
                    "start_time_ms": 0,
                    "end_time_ms": 600_000,
                    "interval": "1m",
                    "parameters": {"fast": 2, "slow": 3},
                    "output_mode": "TARGET_POSITION",
                    "slippage_bps": "0",
                },
                idempotency_key=f"n10-bar-{cycle}",
                now_ms=10 + cycle,
            )
            bar_done = service.execute_bar_run(
                bar_run["run_id"],
                events=bars,
                provider=PythonHostProvider(
                    SMA_FIXTURE, parameters={"fast": 2, "slow": 3}
                ),
                now_ms=100 + cycle,
            )
            item: dict[str, Any] = {
                "cycle": cycle + 1,
                "barState": bar_done["state"],
                "barReportHash": bar_done["result"]["report_hash"],
                "barDecisionHash": bar_done["result"].get("decision_hash"),
                "barFillHash": bar_done["result"].get("fill_hash"),
            }
            if include_aggtrade:
                trade_run = service.create_run(
                    {
                        "strategy_revision_id": revision["revision_id"],
                        "dataset_id": "local-0123456789abcdef0123456789abcdef",
                        "data_epoch": "sha256:" + "ab" * 32,
                        "snapshot_hash": "sha256:" + "cd" * 32,
                        "fidelity_mode": "AGG_TRADE_EXECUTION",
                        "source_event_kind": "AGG_TRADE",
                        "signal_clock": "DERIVED_BAR_CLOSE",
                        "signal_interval": "1m",
                        "execution_clock": "NEXT_AGG_TRADE",
                        "bar_builder": "TRADE_DERIVED_COMPLETE_BUCKETS_V1",
                        "timezone": "UTC",
                        "start_time_ms": 0,
                        "end_time_ms": 600_000,
                        "interval": "1m",
                        "parameters": {"fast": 2, "slow": 3},
                        "output_mode": "TARGET_POSITION",
                        "slippage_bps": "0",
                    },
                    idempotency_key=f"n10-agg-{cycle}",
                    now_ms=200 + cycle,
                )
                trade_done = service.execute_dual_clock_run(
                    trade_run["run_id"],
                    events=trades,
                    provider=PythonHostProvider(
                        SMA_FIXTURE, parameters={"fast": 2, "slow": 3}
                    ),
                    now_ms=300 + cycle,
                )
                item["aggState"] = trade_done["state"]
                item["aggReportHash"] = trade_done["result"]["report_hash"]
                item["aggDecisionHash"] = trade_done["result"].get("decision_hash")
            completed.append(item)
            if (
                item["barState"] != "COMPLETED"
                or item.get("aggState", "COMPLETED") != "COMPLETED"
            ):
                raise RuntimeError(
                    f"python host lifecycle cycle {cycle + 1} failed: {item}"
                )
    finally:
        service.shutdown()
    return {
        "cycles": cycles,
        "durationSeconds": time.monotonic() - started,
        "bundleHash": bundle["bundle_hash"],
        "revisionId": revision["revision_id"],
        "runs": completed,
        "ok": all(item["barState"] == "COMPLETED" for item in completed),
    }
