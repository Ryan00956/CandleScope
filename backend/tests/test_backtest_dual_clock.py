from __future__ import annotations

import ast
from decimal import Decimal
import json
from pathlib import Path

import pytest

from app.market_dataset.snapshot import MarketDatasetError, MarketEvent
from app.backtest.service import BacktestService
from app.backtest.strategy.registry import build_default_strategy_registry
from app.core.config import load_backtest_settings
from app.simulation import DualClockSimulationKernel, SimulationKernel
from app.simulation.trade_bar_builder import (
    BAR_BUILDER_REVISION,
    derive_complete_trade_bars,
)


def _trade(sequence: int, time_ms: int, price: str, qty: str = "1") -> MarketEvent:
    return MarketEvent(
        sequence=sequence,
        event_time_ms=time_ms,
        role="TRADES",
        payload={
            "source_event_kind": "AGG_TRADE",
            "source_sequence": 1000 + sequence,
            "tie_break": f"AGG_TRADE:{1000 + sequence}",
            "price": price,
            "qty": qty,
        },
    )


def test_builder_emits_only_complete_buckets_and_never_copies_empty_close() -> None:
    events = (
        _trade(1, 1_000, "10", "2"),
        _trade(2, 59_999, "12", "3"),
        _trade(3, 60_000, "11", "4"),
    )
    bars = derive_complete_trade_bars(events, "1m")
    assert len(bars) == 1
    assert bars[0].sequence == 1
    assert bars[0].event_time_ms == 59_999
    assert bars[0].payload == {
        "event_kind": "DERIVED_BAR_CLOSE",
        "signal_sequence": 1,
        "tie_break": "DERIVED_BAR_CLOSE:1",
        "bar_builder": BAR_BUILDER_REVISION,
        "timezone": "UTC",
        "open_time_ms": 0,
        "close_time_ms": 59_999,
        "open": "10",
        "high": "12",
        "low": "10",
        "close": "12",
        "volume": "5",
    }
    with pytest.raises(MarketDatasetError, match="DATA_GAP_REJECTED"):
        derive_complete_trade_bars((events[0], _trade(4, 120_000, "9")), "1m")


def test_dual_clock_rejects_missing_aggregate_trade_id_without_bar_fallback() -> None:
    first = _trade(1, 1_000, "100")
    missing = MarketEvent(
        sequence=2,
        event_time_ms=2_000,
        role="TRADES",
        payload={**first.payload, "source_sequence": 1003, "tie_break": "AGG_TRADE:1003"},
    )
    with pytest.raises(MarketDatasetError, match="DATA_GAP_REJECTED"):
        DualClockSimulationKernel("1m").run((first, missing), lambda *_args: [])


def test_boundary_signal_can_fill_on_first_post_boundary_aggregate_trade() -> None:
    events = (
        _trade(1, 1_000, "100"),
        _trade(2, 60_000, "101"),
        _trade(3, 61_000, "102"),
    )

    def buy_first(_visible, bar):
        assert bar.event_time_ms == 59_999
        return [{"side": "BUY", "type": "MARKET", "qty": "1"}]

    result = DualClockSimulationKernel("1m").run(events, buy_first, finalize=True)
    assert result.fills[0]["sequence"] == 2
    assert result.fills[0]["event_time_ms"] == 60_000
    assert result.fills[0]["reason"] == "NEXT_PRINT"
    assert result.ledger["signal_event_count"] == 1
    assert result.ledger["execution_event_count"] == 3


def test_decision_hash_matches_bar_kernel_on_the_same_derived_bars() -> None:
    events = tuple(
        _trade(index + 1, index * 60_000 + 1_000, str(100 + index))
        for index in range(6)
    )
    bars = derive_complete_trade_bars(events, "1m")

    def target(_visible, event):
        return (
            [{"side": "BUY", "type": "MARKET", "qty": "1"}]
            if event.sequence == 2
            else []
        )

    bar_result = SimulationKernel(slippage_bps=Decimal("0")).run(bars, target)
    dual_result = DualClockSimulationKernel("1m").run(events, target)
    assert dual_result.decision_hash == bar_result.decision_hash
    assert dual_result.fill_hash != bar_result.fill_hash


def test_checkpoint_resume_and_page_sizes_preserve_all_hashes() -> None:
    events = tuple(
        _trade(index + 1, index * 30_000 + 1_000, str(100 + index))
        for index in range(12)
    )

    def alternating(_visible, event):
        if event.sequence == 2:
            return [{"side": "BUY", "type": "MARKET", "qty": "1"}]
        if event.sequence == 4:
            return [{"side": "SELL", "type": "MARKET", "qty": "2"}]
        return []

    full = DualClockSimulationKernel("1m").run(events, alternating, finalize=True)
    paused = DualClockSimulationKernel("1m")
    paused.run(events[:7], alternating)
    restored = DualClockSimulationKernel("1m")
    restored.restore(paused.snapshot())
    resumed = restored.run(events[7:], alternating, finalize=True)
    assert resumed.decision_hash == full.decision_hash
    assert resumed.fill_hash == full.fill_hash
    assert resumed.ledger_hash == full.ledger_hash
    assert resumed.report_hash == full.report_hash


def test_same_millisecond_boundary_golden_uses_aggregate_trade_id_order() -> None:
    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "backtest" / "dual_clock_boundary_golden.json")
        .read_text(encoding="utf-8")
    )
    events = tuple(
        MarketEvent(
            sequence=int(item["sequence"]),
            event_time_ms=int(item["event_time_ms"]),
            role="TRADES",
            payload={
                "source_event_kind": "AGG_TRADE",
                "source_sequence": int(item["agg_trade_id"]),
                "tie_break": f"AGG_TRADE:{item['agg_trade_id']}",
                "agg_trade_id": int(item["agg_trade_id"]),
                "price": item["price"],
                "qty": item["qty"],
            },
        )
        for item in fixture["trades"]
    )
    result = DualClockSimulationKernel(fixture["interval"]).run(
        events,
        lambda _visible, _bar: [{"side": "BUY", "type": "MARKET", "qty": "1"}],
        finalize=True,
    )
    expected = fixture["expected"]
    assert result.fills[0]["sequence"] == expected["first_fill_sequence"]
    assert str(result.fills[0]["price"]) == expected["first_fill_price"]


def test_rsi_wilder_service_decisions_match_on_derived_bars(tmp_path: Path) -> None:
    settings = load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_TRADE_TAPE_ENABLED": "1",
            "BACKTEST_CHECKPOINT_EVENT_INTERVAL": "3",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    registry = build_default_strategy_registry()
    service = BacktestService.start(
        settings,
        strategy_registry=registry,
        enforce_registered_revisions=True,
        now_ms=1,
    )
    closes = [100, 90, 80, 70, 80, 90, 100, 110, 100]
    trades = tuple(
        _trade(index + 1, index * 60_000 + 1_000, str(price), "10")
        for index, price in enumerate(closes)
    )
    bars = derive_complete_trade_bars(trades, "1m")
    common = {
        "strategy_revision_id": "builtin-rsi-wilder-long-short-v1",
        "dataset_id": "agg-rsi",
        "data_epoch": "sha256:" + "a1" * 32,
        "snapshot_hash": "sha256:" + "b2" * 32,
        "source_event_kind": "BAR",
        "start_time_ms": 0,
        "end_time_ms": 600_000,
        "interval": "1m",
        "warmup_bars": 3,
        "parameters": {
            "length": 2,
            "oversold": 30,
            "overbought": 70,
            "trigger_mode": "LEVEL_TARGET_V1",
            "debug_trace": False,
        },
        "output_mode": "SIGNAL",
        "slippage_bps": "0",
    }
    bar_run = service.create_run(
        {**common, "fidelity_mode": "BAR_APPROX"},
        idempotency_key="dual-rsi-bar",
        now_ms=2,
    )
    bar_completed = service.execute_bar_run(
        str(bar_run["run_id"]),
        events=bars,
        provider=registry.require("builtin-rsi-wilder-long-short-v1").factory(),
        now_ms=3,
    )
    dual_payload = {
        **common,
        "fidelity_mode": "AGG_TRADE_EXECUTION",
        "source_event_kind": "AGG_TRADE",
        "signal_clock": "DERIVED_BAR_CLOSE",
        "signal_interval": "1m",
        "execution_clock": "NEXT_AGG_TRADE",
        "bar_builder": "TRADE_DERIVED_COMPLETE_BUCKETS_V1",
        "timezone": "UTC",
    }
    dual_run = service.create_run(dual_payload, idempotency_key="dual-rsi-trades", now_ms=4)
    dual_completed = service.execute_dual_clock_run(
        str(dual_run["run_id"]),
        events=trades,
        provider=registry.require("builtin-rsi-wilder-long-short-v1").factory(),
        now_ms=5,
    )
    assert dual_completed["result"]["decision_hash"] == bar_completed["result"]["decision_hash"]
    assert dual_completed["report"]["metrics"]["signal_event_count"] == len(bars)
    assert dual_completed["report"]["metrics"]["execution_event_count"] == len(trades)
    assert dual_completed["report"]["identity"]["bar_builder"] == BAR_BUILDER_REVISION
    assert dual_completed["report"]["report_label"] == "AGGREGATED_TRADE_SEQUENCE"

    interrupted_run = service.create_run(
        dual_payload,
        idempotency_key="dual-rsi-interrupted",
        now_ms=6,
    )
    original_save = service.repository.save_checkpoint
    saves = 0

    def save_then_interrupt(payload):
        nonlocal saves
        saved = original_save(payload)
        saves += 1
        if saves == 1:
            raise KeyboardInterrupt("simulated worker interruption after durable checkpoint")
        return saved

    service.repository.save_checkpoint = save_then_interrupt  # type: ignore[method-assign]
    with pytest.raises(KeyboardInterrupt):
        service.execute_dual_clock_run(
            str(interrupted_run["run_id"]),
            events=trades,
            provider=registry.require("builtin-rsi-wilder-long-short-v1").factory(),
            now_ms=7,
        )
    service.repository.save_checkpoint = original_save  # type: ignore[method-assign]
    checkpoint = service.repository.latest_checkpoint(str(interrupted_run["run_id"]))
    assert checkpoint is not None
    checkpoint_payload = json.loads(str(checkpoint["payload_json"]))
    assert set(checkpoint_payload) >= {"engine", "provider", "planner", "sequence"}
    assert set(checkpoint_payload["engine"]) >= {
        "execution",
        "bar_builder",
        "last_source_sequence",
    }
    assert service.requeue_interrupted_run(
        str(interrupted_run["run_id"]),
        expected_generation=1,
        now_ms=8,
    )
    resumed_completed = service.execute_dual_clock_run(
        str(interrupted_run["run_id"]),
        events=trades,
        provider=registry.require("builtin-rsi-wilder-long-short-v1").factory(),
        now_ms=9,
    )
    assert resumed_completed["result"]["decision_hash"] == dual_completed["result"]["decision_hash"]
    assert resumed_completed["result"]["fill_hash"] == dual_completed["result"]["fill_hash"]
    assert resumed_completed["result"]["ledger_hash"] == dual_completed["result"]["ledger_hash"]
    assert resumed_completed["result"]["report_hash"] == dual_completed["result"]["report_hash"]
    service.shutdown()


def test_every_production_backtest_runtime_receives_the_verified_trade_archive() -> None:
    main_path = Path(__file__).parents[1] / "app" / "main.py"
    tree = ast.parse(main_path.read_text(encoding="utf-8"))
    starts = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "start"
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "BacktestRuntime"
    ]
    assert len(starts) == 2
    assert all(
        any(keyword.arg == "trade_archive_dir" for keyword in call.keywords)
        for call in starts
    )
