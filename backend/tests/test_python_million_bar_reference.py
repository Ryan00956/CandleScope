from __future__ import annotations

from pathlib import Path

from app.backtest.python_scale_run import run_python_bar_scale
from app.backtest.strategy.python_scale import OFFICIAL_BAR_CAPACITY


def test_million_bar_python_reference_run(tmp_path: Path, monkeypatch) -> None:
    result = run_python_bar_scale(
        tmp_path / "million", OFFICIAL_BAR_CAPACITY, monkeypatch=monkeypatch
    )
    assert result["state"] == "COMPLETED"
    assert result["bars"] == OFFICIAL_BAR_CAPACITY
    assert result["decision_hash"]
    assert result["report_hash"].startswith("sha256:")
    assert result["checkpoint_interval"] == 10_000
    payload = {
        "schemaVersion": "candlescope.backtest-python-scale/1",
        "bars": result["bars"],
        "state": result["state"],
        "decisionHash": result["decision_hash"],
        "fillHash": result["fill_hash"],
        "reportHash": result["report_hash"],
        "fillCount": result["fill_count"],
        "durationSeconds": result["duration_s"],
        "peakMb": result["peak_mb"],
        "checkpointInterval": result["checkpoint_interval"],
        "ok": True,
    }
    # Tests must not rewrite the committed release evidence. The official probe
    # owns evidence collection; this gate validates the live result in memory.
    assert payload["bars"] == 1_000_000
    assert payload["ok"] is True
