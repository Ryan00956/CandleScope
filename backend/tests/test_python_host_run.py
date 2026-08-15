from __future__ import annotations

from pathlib import Path

from app.backtest.service import BacktestService
from app.backtest.strategy.python_provider import PythonHostProvider
from app.core.config import load_backtest_settings
from app.market_dataset.snapshot import MarketEvent
from app.simulation.trade_bar_builder import derive_complete_trade_bars

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


def test_python_bar_close_strategy_runs_on_aggtrade_dual_clock(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "1")
    settings = load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_TRADE_TAPE_ENABLED": "1",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    service = BacktestService.start(settings, now_ms=1)
    closes = (10, 10, 10, 11, 12, 13, 20, 21)
    trades = tuple(
        _agg_trade(index + 1, index * 60_000 + 1_000, str(price))
        for index, price in enumerate(closes)
    )
    bars = derive_complete_trade_bars(trades, "1m")
    bundle = service.create_python_strategy_bundle(directory=str(FIXTURE), now_ms=2)
    revision = service.create_python_strategy_revision(bundle["bundle_id"], now_ms=3)
    common = {
        "strategy_revision_id": revision["revision_id"],
        "dataset_id": "local-0123456789abcdef0123456789abcdef",
        "data_epoch": "sha256:" + "ab" * 32,
        "snapshot_hash": "sha256:" + "cd" * 32,
        "start_time_ms": 0,
        "end_time_ms": 600_000,
        "interval": "1m",
        "parameters": {"fast": 2, "slow": 3},
        "output_mode": "TARGET_POSITION",
        "slippage_bps": "0",
    }
    bar_run = service.create_run(
        {**common, "fidelity_mode": "BAR_APPROX"},
        idempotency_key="py-bar",
        now_ms=4,
    )
    bar_completed = service.execute_bar_run(
        bar_run["run_id"],
        events=bars,
        provider=PythonHostProvider(FIXTURE, parameters={"fast": 2, "slow": 3}),
        now_ms=5,
    )
    dual_run = service.create_run(
        {
            **common,
            "fidelity_mode": "AGG_TRADE_EXECUTION",
            "source_event_kind": "AGG_TRADE",
            "signal_clock": "DERIVED_BAR_CLOSE",
            "signal_interval": "1m",
            "execution_clock": "NEXT_AGG_TRADE",
            "bar_builder": "TRADE_DERIVED_COMPLETE_BUCKETS_V1",
            "timezone": "UTC",
        },
        idempotency_key="py-dual",
        now_ms=6,
    )
    dual_completed = service.execute_dual_clock_run(
        dual_run["run_id"],
        events=trades,
        provider=PythonHostProvider(FIXTURE, parameters={"fast": 2, "slow": 3}),
        now_ms=7,
    )
    assert bar_completed["state"] == "COMPLETED"
    assert dual_completed["state"] == "COMPLETED"
    assert dual_completed["result"]["decision_hash"] == bar_completed["result"]["decision_hash"]
    service.shutdown()
