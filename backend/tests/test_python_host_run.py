from __future__ import annotations

from pathlib import Path

from app.backtest.service import BacktestService
from app.backtest.strategy.python_provider import PythonHostProvider
from app.core.config import load_backtest_settings
from app.market_dataset.snapshot import MarketEvent

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "candlescope-backtest-sdk"
    / "fixtures"
    / "sma_cross"
)


def _settings(tmp_path: Path):
    return load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )


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


def test_python_strategy_runs_through_host_bar_path(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "1")
    service = BacktestService.start(_settings(tmp_path), now_ms=1)
    bundle = service.create_python_strategy_bundle(directory=str(FIXTURE), now_ms=2)
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
            "parameters": {"fast": 2, "slow": 3},
        },
        idempotency_key="py-1",
        now_ms=4,
    )
    completed = service.execute_bar_run(
        created["run_id"],
        events=_events(),
        provider=PythonHostProvider(
            FIXTURE, parameters={"fast": 2, "slow": 3}
        ),
        now_ms=5,
    )
    assert completed["state"] == "COMPLETED"
    report = completed["result"]
    assert report["report_hash"].startswith("sha256:")
    assert "fills" in report
    service.shutdown()
