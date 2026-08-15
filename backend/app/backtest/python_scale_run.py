"""Host-owned Python BAR scale runner used for the 1,000,000 reference."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Mapping

from app.backtest.service import BacktestService
from app.backtest.strategy.python_provider import PythonHostProvider
from app.backtest.strategy.python_scale import (
    SCALE_FLAG,
    iter_reference_bars,
)
from app.core.config import load_backtest_settings

TEMPLATE = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "candlescope-backtest-sdk"
    / "templates"
    / "buy_and_hold"
)


def run_python_bar_scale(
    tmp_path: Path,
    count: int,
    *,
    monkeypatch: Any | None = None,
) -> dict[str, Any]:
    if monkeypatch is not None:
        monkeypatch.setenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "1")
        monkeypatch.setenv(SCALE_FLAG, "1")
    else:
        import os

        os.environ["BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED"] = "1"
        os.environ[SCALE_FLAG] = "1"
    settings = load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            SCALE_FLAG: "1",
            "BACKTEST_MAX_BAR_ROWS": str(max(count, 1)),
            "BACKTEST_MAX_RUN_SECONDS": "14400",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    service = BacktestService.start(settings, now_ms=1)
    started = time.perf_counter()
    try:
        bundle = service.create_python_strategy_bundle(directory=str(TEMPLATE), now_ms=2)
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
                "parameters": {},
                "output_mode": "TARGET_POSITION",
            },
            idempotency_key=f"scale-{count}",
            now_ms=4,
        )
        completed = service.execute_bar_run(
            created["run_id"],
            events=iter_reference_bars(count),
            provider=PythonHostProvider(TEMPLATE, parameters={}),
            now_ms=5,
        )
        elapsed = time.perf_counter() - started
        try:
            import resource

            peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        except Exception:
            peak_mb = None
        return {
            "state": completed["state"],
            "bars": count,
            "decision_hash": completed["result"]["decision_hash"],
            "fill_hash": completed["result"]["fill_hash"],
            "report_hash": completed["result"]["report_hash"],
            "fill_count": len(completed["result"].get("fills") or []),
            "checkpoint_interval": settings.checkpoint_event_interval,
            "duration_s": elapsed,
            "peak_mb": peak_mb,
            "revision_id": revision["revision_id"],
            "run_id": created["run_id"],
        }
    finally:
        service.shutdown()
