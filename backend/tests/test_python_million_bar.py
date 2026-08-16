from __future__ import annotations

import json
from pathlib import Path

from app.backtest.python_scale_run import run_python_bar_scale
from app.backtest.strategy.python_scale import OFFICIAL_BAR_CAPACITY
from app.core.config import _BACKTEST_BUDGETS

EVIDENCE = (
    Path(__file__).resolve().parents[2]
    / "docs"
    / "evidence"
    / "backtest-python-first-n8-1m-bar-20260815.json"
)


def test_scale_run_can_cancel_queued_job(tmp_path: Path, monkeypatch) -> None:
    from app.backtest.service import BacktestService
    from app.backtest.strategy.python_scale import SCALE_FLAG
    from app.core.config import load_backtest_settings

    monkeypatch.setenv(SCALE_FLAG, "1")
    service = BacktestService.start(
        load_backtest_settings(
            {
                "BACKTEST_ENABLED": "1",
                "BACKTEST_BAR_ENABLED": "1",
                SCALE_FLAG: "1",
                "BACKTEST_MAX_BAR_ROWS": "10000",
            },
            data_dir=tmp_path,
            klines_db_path=tmp_path / "c.db",
            replay_db_path=tmp_path / "r.db",
        ),
        now_ms=1,
    )
    created = service.create_run(
        {
            "strategy_revision_id": "builtin-sma-cross-v1",
            "dataset_id": "local-0123456789abcdef0123456789abcdef",
            "data_epoch": "sha256:" + "ab" * 32,
            "snapshot_hash": "sha256:" + "cd" * 32,
            "fidelity_mode": "BAR_APPROX",
            "start_time_ms": 1,
            "end_time_ms": 2,
            "parameters": {"fast": 2, "slow": 3},
        },
        idempotency_key="cancel-scale",
        now_ms=2,
    )
    cancelled = service.cancel_run(created["run_id"])
    assert cancelled["state"] == "CANCELLED"
    service.shutdown()


def test_two_million_aggtrade_cap_unchanged() -> None:
    assert _BACKTEST_BUDGETS["BACKTEST_MAX_TRADE_EVENTS"] == 2_000_000


def test_committed_million_bar_evidence_is_complete() -> None:
    payload = json.loads(EVIDENCE.read_text(encoding="utf-8"))
    assert payload["ok"] is True
    assert payload["bars"] == OFFICIAL_BAR_CAPACITY
    assert payload["state"] == "COMPLETED"
    assert str(payload["decisionHash"]).startswith("sha256:")
    assert str(payload["reportHash"]).startswith("sha256:")
    assert payload["checkpointInterval"] == 10_000


def test_chunked_python_bar_scale_is_deterministic(tmp_path: Path, monkeypatch) -> None:
    first = run_python_bar_scale(tmp_path / "a", 2_000, monkeypatch=monkeypatch)
    second = run_python_bar_scale(tmp_path / "b", 2_000, monkeypatch=monkeypatch)
    assert first["state"] == "COMPLETED"
    assert first["decision_hash"] == second["decision_hash"]
    assert first["fill_hash"] == second["fill_hash"]


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
