from __future__ import annotations

from decimal import Decimal
import json
import time
from pathlib import Path

from app.market_dataset.snapshot import MarketEvent
from app.simulation.cost_sensitivity import build_cost_sensitivity_matrix
from app.simulation.execution_realism import (
    BAR_PATH_SCENARIO,
    EXECUTION_REALISM_V2,
    parse_execution_realism,
)
from app.simulation.kernel import SimulationKernel
from app.simulation.trade_kernel import TradeSimulationKernel
from app.backtest.runtime import BacktestRuntime
from app.core.config import load_backtest_settings
from app.local_data.service import LocalDatasetService, LocalImportOptions


def _bar(sequence: int, volume: str = "10") -> MarketEvent:
    return MarketEvent(
        sequence=sequence,
        event_time_ms=sequence * 60_000,
        role="BARS",
        payload={
            "open": "100",
            "high": "101",
            "low": "99",
            "close": "100",
            "volume": volume,
        },
    )


def _trade(sequence: int, *, time_ms: int | None = None, qty: str = "2") -> MarketEvent:
    return MarketEvent(
        sequence=sequence,
        event_time_ms=sequence * 100 if time_ms is None else time_ms,
        role="TRADES",
        payload={
            "source_event_kind": "AGG_TRADE",
            "source_sequence": 10_000 + sequence,
            "tie_break": f"AGG_TRADE:{10_000 + sequence}",
            "price": "100",
            "qty": qty,
        },
    )


def _bar_v2(**values: object) -> SimulationKernel:
    return SimulationKernel(
        execution_model_revision=EXECUTION_REALISM_V2,
        participation_rate=Decimal(str(values.get("participation_rate") or "0.1")),
        bar_path_scenario=BAR_PATH_SCENARIO,
        order_end_policy=str(values.get("order_end_policy") or "CANCEL_AT_END"),
        slippage_bps=Decimal("0"),
    )


def _trade_v2(**values: object) -> TradeSimulationKernel:
    return TradeSimulationKernel(
        execution_model_revision=EXECUTION_REALISM_V2,
        participation_rate=Decimal(str(values.get("participation_rate") or "0.1")),
        latency_ms=int(values.get("latency_ms") or 0),
        latency_events=int(values.get("latency_events") or 0),
        order_end_policy=str(values.get("order_end_policy") or "CANCEL_AT_END"),
    )


def test_bar_volume_capacity_partially_fills_across_bars_and_traces_sources() -> None:
    events = tuple(_bar(index) for index in range(1, 5))
    result = _bar_v2().run(
        events,
        lambda _visible, event: (
            [{"side": "BUY", "type": "MARKET", "qty": "3"}]
            if event.sequence == 1
            else []
        ),
        finalize=True,
    )
    assert [fill["qty"] for fill in result.fills] == [
        Decimal("1"),
        Decimal("1"),
        Decimal("1"),
    ]
    assert [fill["source_sequence"] for fill in result.fills] == [2, 3, 4]
    assert all(
        str(fill["source_event_hash"]).startswith("sha256:") for fill in result.fills
    )
    states = [item["state"] for item in result.ledger["order_events"]]
    assert states == ["NEW", "ACCEPTED", "OPEN", "PARTIAL", "PARTIAL", "FILLED"]


def test_bar_capacity_is_shared_in_order_acceptance_order() -> None:
    result = _bar_v2(participation_rate="0.1").run(
        (_bar(1), _bar(2)),
        lambda _visible, event: (
            [
                {"side": "BUY", "type": "MARKET", "qty": "0.75"},
                {"side": "BUY", "type": "MARKET", "qty": "0.75"},
            ]
            if event.sequence == 1
            else []
        ),
        finalize=True,
    )
    assert [(fill["order_id"], fill["qty"]) for fill in result.fills] == [
        ("ord-1", Decimal("0.75")),
        ("ord-2", Decimal("0.25")),
    ]


def test_trade_requires_both_latency_dimensions_before_partial_fill() -> None:
    events = tuple(_trade(index) for index in range(1, 6))
    result = _trade_v2(latency_ms=250, latency_events=2).run(
        events,
        lambda _visible, event: (
            [{"side": "BUY", "type": "MARKET", "qty": "1"}]
            if event.sequence == 1
            else []
        ),
        finalize=True,
    )
    assert result.fills[0]["sequence"] == 4
    assert result.fills[0]["qty"] == Decimal("0.2")
    assert all(fill["sequence"] >= 4 for fill in result.fills)
    assert all(fill["source_event_kind"] == "AGG_TRADE" for fill in result.fills)


def test_ioc_expires_remainder_after_first_eligible_event() -> None:
    result = _trade_v2().run(
        (_trade(1), _trade(2), _trade(3)),
        lambda _visible, event: (
            [{"side": "BUY", "type": "MARKET", "qty": "1", "tif": "IOC"}]
            if event.sequence == 1
            else []
        ),
        finalize=True,
    )
    assert len(result.fills) == 1
    assert result.fills[0]["qty"] == Decimal("0.2")
    assert result.orders[0]["status"] == "EXPIRED"
    assert [item["state"] for item in result.ledger["order_events"]][-2:] == [
        "PARTIAL",
        "EXPIRED",
    ]


def test_keep_open_end_policy_is_explicit_and_checkpoint_exact() -> None:
    kernel = _trade_v2(order_end_policy="KEEP_OPEN", latency_events=100)
    kernel.run(
        (_trade(1), _trade(2)),
        lambda _visible, event: (
            [{"side": "BUY", "type": "MARKET", "qty": "1"}]
            if event.sequence == 1
            else []
        ),
    )
    restored = _trade_v2(order_end_policy="KEEP_OPEN", latency_events=100)
    restored.restore(kernel.snapshot())
    result = restored.run((_trade(3),), lambda *_args: [], finalize=True)
    assert result.orders[0]["status"] == "OPEN"
    assert result.ledger["open_order_count"] == 1


def test_cost_sensitivity_replays_frozen_intents_outside_primary_hash() -> None:
    events = tuple(_trade(index, qty="10") for index in range(1, 8))
    kernel = _trade_v2(participation_rate="0.5")
    result = kernel.run(
        events,
        lambda _visible, event: (
            [{"side": "BUY", "type": "MARKET", "qty": "4"}]
            if event.sequence == 1
            else []
        ),
        finalize=True,
    )
    matrix = build_cost_sensitivity_matrix(kernel, events, result)
    assert matrix["included_in_primary_config_hash"] is False
    assert [item["name"] for item in matrix["scenarios"]] == [
        "BASELINE",
        "COSTS_PLUS_25_PERCENT",
        "COSTS_PLUS_50_PERCENT",
        "LATENCY_PLUS_ONE_TIER",
        "PARTICIPATION_DOWN_ONE_TIER",
    ]
    assert str(matrix["matrix_hash"]).startswith("sha256:")
    assert matrix["scenarios"][3]["hashes"]["fill"] != result.fill_hash


def test_execution_identity_is_versioned_and_bar_scenario_is_frozen() -> None:
    config = parse_execution_realism(
        {
            "execution_model_revision": EXECUTION_REALISM_V2,
            "participation_rate": "0.2",
            "order_end_policy": "KEEP_OPEN",
        },
        fidelity_mode="BAR_APPROX",
    )
    assert config.identity(fidelity_mode="BAR_APPROX") == {
        "execution_model_revision": EXECUTION_REALISM_V2,
        "participation_rate": "0.2",
        "order_end_policy": "KEEP_OPEN",
        "tif_supported": ["GTC", "IOC"],
        "equity_curve_event_interval": 100,
        "fill_policy": "BAR_VOLUME_PARTICIPATION_WORST_CASE_V2",
        "bar_path_scenario": BAR_PATH_SCENARIO,
    }


def test_public_runtime_report_contains_v2_trace_lifecycle_and_sensitivity(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local-data"
    csv_path = tmp_path / "bars.csv"
    csv_path.write_text(
        "\n".join(
            ["time,open,high,low,close,volume"]
            + [f"{index * 60000},100,101,99,100,10" for index in range(12)]
        ),
        encoding="utf-8",
    )
    manifest = LocalDatasetService(local_root).import_csv(
        csv_path,
        LocalImportOptions(
            name="m6 runtime",
            symbol="BTCUSDT",
            interval="1m",
            timestamp_unit="ms",
        ),
    )
    settings = load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    runtime = BacktestRuntime.start(settings, local_data_dir=local_root)
    try:
        preview = runtime.preview_snapshot(
            dataset_id=manifest["dataset_id"],
            data_epoch=manifest["data_epoch"],
            start_time_ms=0,
            end_time_ms=720_000,
            interval="1m",
        )
        created = runtime.service.create_run(
            {
                "strategy_revision_id": "builtin-order-command-v1",
                "dataset_id": manifest["dataset_id"],
                "data_epoch": manifest["data_epoch"],
                "snapshot_hash": preview["snapshot_hash"],
                "fidelity_mode": "BAR_APPROX",
                "start_time_ms": 0,
                "end_time_ms": 720_000,
                "interval": "1m",
                "strategy_source": json.dumps(
                    {"commands": [{"sequence": 2, "action": "OPEN_LONG", "qty": "3"}]}
                ),
                "output_mode": "ORDER_INTENT",
                "execution_model_revision": EXECUTION_REALISM_V2,
                "participation_rate": "0.1",
                "bar_path_scenario": BAR_PATH_SCENARIO,
                "order_end_policy": "CANCEL_AT_END",
            },
            idempotency_key="m6-runtime",
        )
        deadline = time.monotonic() + 8
        record = created
        while time.monotonic() < deadline:
            record = runtime.service.get_run(str(created["run_id"]))
            if record["state"] in {"COMPLETED", "FAILED"}:
                break
            time.sleep(0.05)
        assert record["state"] == "COMPLETED", record
        stored_config = json.loads(str(record["config_json"]))
        assert stored_config["fill_policy"] == "BAR_VOLUME_PARTICIPATION_WORST_CASE_V2"
        assert stored_config["equity_curve_event_interval"] == 100
        report = runtime.service.get_report(str(created["run_id"]))
        assert report["identity"]["execution_model_revision"] == EXECUTION_REALISM_V2
        assert (
            report["identity"]["fill_policy"]
            == "BAR_VOLUME_PARTICIPATION_WORST_CASE_V2"
        )
        assert report["fill_trace"]["complete"] is True
        assert report["order_events"]
        assert len(report["cost_sensitivity"]["scenarios"]) == 5
        assert report["cost_sensitivity"]["included_in_primary_config_hash"] is False
        assert "volume participation" not in report["unmodeled"]
        assert "intrabar path" in report["unmodeled"]
    finally:
        runtime.shutdown()
