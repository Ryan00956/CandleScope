from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.backtest.service import BacktestService
from app.backtest.study import grid_sampler, plan_trials, walk_forward_splits
from app.core.config import load_backtest_settings
from app.market_dataset.snapshot import MarketEvent
from app.simulation.kernel import SimulationKernel
from app.simulation.trade_kernel import TradeSimulationKernel
from app.backtest.strategy.builtin import BuiltinSmaCrossProvider


def _trade(sequence: int, price: str) -> MarketEvent:
    return MarketEvent(
        sequence=sequence,
        event_time_ms=sequence * 100,
        role="TRADES",
        payload={
            "source_event_kind": "RAW_TRADE",
            "source_sequence": sequence,
            "tie_break": str(sequence),
            "price": price,
            "qty": "1",
        },
    )


def _buy_first(visible, event):
    if event.sequence == 1:
        return [{"side": "BUY", "type": "MARKET", "qty": "1"}]
    return []


def test_bar_pause_resume_matches_uninterrupted_hash() -> None:
    events = tuple(
        MarketEvent(
            sequence=index,
            event_time_ms=index * 60_000,
            role="BARS",
            payload={
                "open": "100",
                "high": "101",
                "low": "99",
                "close": "100",
                "volume": "1",
            },
        )
        for index in range(1, 5)
    )
    full = SimulationKernel().run(events, _buy_first)
    paused = SimulationKernel()
    paused.run(events[:2], _buy_first)
    resumed = SimulationKernel()
    resumed.restore(paused.snapshot())
    resumed.run(events[2:], lambda *args: [])
    assert resumed.result().fill_hash == full.fill_hash
    assert resumed.result().ledger_hash == full.ledger_hash


def test_strategy_crash_then_restore_matches_uninterrupted() -> None:
    events = tuple(_trade(index, str(100 + index)) for index in range(1, 6))
    full = TradeSimulationKernel().run(events, _buy_first)
    crashed = TradeSimulationKernel(checkpoint_event_interval=2)

    def boom(visible, event):
        if event.sequence == 3:
            raise RuntimeError("forced crash")
        return _buy_first(visible, event)

    try:
        crashed.run(events, boom)
    except RuntimeError:
        pass
    assert crashed.checkpoints
    restored = TradeSimulationKernel()
    restored.restore(crashed.checkpoints[0])
    restored.run(events[2:], lambda *args: [])
    assert restored.result().fill_hash == full.fill_hash
    assert restored.result().ledger_hash == full.ledger_hash


def test_concurrent_and_serial_study_plans_match() -> None:
    splits = walk_forward_splits(start_ms=0, end_ms=1000, train_ms=400, test_ms=100, step_ms=100)
    space = {"fast": [3, 5], "slow": [7, 9]}

    def plan():
        return [
            item.params_hash
            for item in plan_trials(splits, grid_sampler(space), max_trials=8)
        ]

    serial = [plan(), plan()]
    with ThreadPoolExecutor(max_workers=2) as pool:
        concurrent = list(pool.map(lambda _: plan(), range(2)))
    assert serial[0] == serial[1] == concurrent[0] == concurrent[1]


def test_service_rerun_keeps_report_hash(tmp_path: Path) -> None:
    settings = load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    from app.backtest.strategy.protocol import DeterministicFakeProvider

    events = tuple(
        MarketEvent(
            sequence=index,
            event_time_ms=index * 1000,
            role="BARS",
            payload={"open": "101", "high": "102", "low": "100", "close": "101", "volume": "1"},
        )
        for index in range(1, 4)
    )
    payload = {
        "strategy_revision_id": "rev",
        "dataset_id": "ds",
        "data_epoch": "sha256:" + "ab" * 32,
        "snapshot_hash": "sha256:" + "cd" * 32,
        "fidelity_mode": "BAR_APPROX",
        "start_time_ms": 1,
        "end_time_ms": 2,
    }
    hashes = []
    for key in ("a", "b"):
        service = BacktestService.start(settings, now_ms=1)
        created = service.create_run(payload, idempotency_key=key, now_ms=2)
        done = service.execute_bar_run(
            created["run_id"],
            events=events,
            provider=DeterministicFakeProvider(),
            now_ms=3,
        )
        hashes.append(done["result"]["report_hash"])
        service.shutdown()
    assert hashes[0] == hashes[1]


def test_durable_checkpoint_resume_matches_clean_run(tmp_path: Path) -> None:
    settings = load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_CHECKPOINT_EVENT_INTERVAL": "2",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    events = tuple(
        MarketEvent(
            sequence=index,
            event_time_ms=index * 60_000,
            role="BARS",
            payload={
                "open": str(100 + index),
                "high": str(101 + index),
                "low": str(99 + index),
                "close": str(100 + index),
                "volume": "1",
            },
        )
        for index in range(1, 9)
    )
    payload = {
        "strategy_revision_id": "builtin-sma-cross-v1",
        "dataset_id": "ds",
        "data_epoch": "sha256:" + "ab" * 32,
        "snapshot_hash": "sha256:" + "cd" * 32,
        "fidelity_mode": "BAR_APPROX",
        "start_time_ms": 1,
        "end_time_ms": 600_000,
        "parameters": {"fast": 2, "slow": 3},
    }

    class CrashAfterCheckpoint(BuiltinSmaCrossProvider):
        def __init__(self, *, crash: bool) -> None:
            super().__init__()
            self._crash = crash

        def step(self, frame):
            if self._crash and frame.sequence == 3:
                raise KeyboardInterrupt("simulated worker death")
            return super().step(frame)

    service = BacktestService.start(settings, now_ms=1)
    crashed = service.create_run(payload, idempotency_key="crashed", now_ms=2)
    try:
        service.execute_bar_run(
            str(crashed["run_id"]),
            events=events,
            provider=CrashAfterCheckpoint(crash=True),
            now_ms=3,
        )
    except KeyboardInterrupt:
        pass
    checkpoint = service.repository.latest_checkpoint(str(crashed["run_id"]))
    assert checkpoint is not None and checkpoint["sequence"] == 2
    record = service.get_run(str(crashed["run_id"]))
    assert service.repository.compare_and_set_run_state(
        str(crashed["run_id"]),
        expected_state="RUNNING",
        state="QUEUED",
        updated_at_ms=4,
        generation=int(record["generation"]) + 1,
    )
    resumed = service.execute_bar_run(
        str(crashed["run_id"]),
        events=events,
        provider=CrashAfterCheckpoint(crash=False),
        now_ms=5,
    )
    clean = service.create_run(payload, idempotency_key="clean", now_ms=6)
    completed = service.execute_bar_run(
        str(clean["run_id"]),
        events=events,
        provider=CrashAfterCheckpoint(crash=False),
        now_ms=7,
    )
    assert resumed["result"]["report_hash"] == completed["result"]["report_hash"]
    assert service.repository.latest_checkpoint(str(crashed["run_id"])) is None
    service.shutdown()
