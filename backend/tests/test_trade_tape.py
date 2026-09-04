from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from app.backtest.errors import BacktestError
from app.backtest.reports import build_report
from app.backtest.service import BacktestService
from app.backtest.strategy.protocol import ProviderCapabilities
from app.core.config import load_backtest_settings
from app.market_dataset.adapters.trade_archive import TradeArchiveSnapshotProvider
from app.market_dataset.models import DatasetRef
from app.market_dataset.snapshot import MarketDatasetError, MarketEvent
from app.simulation.kernel import SimulationKernel
from app.simulation.trade_kernel import TRADE_FILL_POLICY, TradeSimulationKernel, derived_bar_feature

FIXTURES = Path(__file__).resolve().parents[0] / "fixtures" / "backtest"


def _ref(**overrides: object) -> DatasetRef:
    payload = {
        "dataset_id": "trade-raw-1",
        "data_epoch": "sha256:" + "ab" * 32,
        "snapshot_hash": "",
        "venue": "local",
        "market_type": "imported",
        "symbol": "BTC-USDT",
        "start_time_ms": 0,
        "end_time_ms": 2_000_000_000_000,
        "roles": ("TRADES",),
        "interval": None,
        "calendar_id": "UTC_FIXED",
        "source": "trade_archive",
        "retention_policy": "user_local",
    }
    payload.update(overrides)
    return DatasetRef(**payload)  # type: ignore[arg-type]


def _trade(
    sequence: int,
    *,
    kind: str = "RAW_TRADE",
    time_ms: int | None = None,
    price: str = "100",
    qty: str = "1",
    source_sequence: int | None = None,
    is_buyer_maker: bool = False,
) -> MarketEvent:
    return MarketEvent(
        sequence=sequence,
        event_time_ms=time_ms if time_ms is not None else sequence * 100,
        role="TRADES",
        payload={
            "source_event_kind": kind,
            "source_sequence": source_sequence if source_sequence is not None else sequence,
            "tie_break": f"{kind}:{sequence}",
            "price": price,
            "qty": qty,
            "is_buyer_maker": is_buyer_maker,
        },
    )


def test_raw_and_aggregate_archives_are_not_confused() -> None:
    raw = TradeArchiveSnapshotProvider(FIXTURES / "trade_tape_raw.json").open(_ref())
    agg = TradeArchiveSnapshotProvider(FIXTURES / "trade_tape_agg.json").open(
        _ref(dataset_id="trade-agg-1")
    )
    assert raw.fidelity_capabilities == ("TRADE_TAPE",)
    assert agg.fidelity_capabilities == ("AGG_TRADE_TAPE",)
    assert raw.quality["source_event_kind"] == "RAW_TRADE"
    assert agg.quality["source_event_kind"] == "AGG_TRADE"
    mixed = [
        {"source_event_kind": "RAW_TRADE", "event_time_ms": 1, "source_sequence": 1, "price": "1", "qty": "1"},
        {"source_event_kind": "AGG_TRADE", "event_time_ms": 2, "source_sequence": 2, "price": "1", "qty": "1"},
    ]
    with pytest.raises(MarketDatasetError, match="FIDELITY_MISLABEL"):
        TradeArchiveSnapshotProvider(mixed).open(_ref())


def test_new_order_fills_on_next_print_not_current() -> None:
    events = (_trade(1, price="100"), _trade(2, price="101"), _trade(3, price="102"))

    def buy_first(visible, event):
        if event.sequence == 1:
            return [{"side": "BUY", "type": "MARKET", "qty": "1"}]
        return []

    result = TradeSimulationKernel().run(events, buy_first)
    assert result.fills[0]["sequence"] == 2
    assert result.fills[0]["reason"] == "NEXT_PRINT"
    assert str(result.fills[0]["price"]) == "101"


def test_pending_order_can_fill_on_current_incoming_print() -> None:
    kernel = TradeSimulationKernel()
    kernel._enqueue({"side": "BUY", "type": "MARKET", "qty": "1"}, current_sequence=0)
    result = kernel.run((_trade(1, price="100"),), lambda visible, event: [])
    assert result.fills[0]["sequence"] == 1
    assert str(result.fills[0]["price"]) == "100"


def test_limit_uses_print_cross_not_bar_high_low() -> None:
    events = (_trade(1, price="105"), _trade(2, price="99"))

    def place_limit(visible, event):
        if event.sequence == 1:
            return [{"side": "BUY", "type": "LIMIT", "qty": "1", "limit_price": "100"}]
        return []

    trade = TradeSimulationKernel().run(events, place_limit)
    assert trade.fills[0]["reason"] == "PRINT_THROUGH"
    assert str(trade.fills[0]["price"]) == "100"
    bar_like = (
        MarketEvent(
            sequence=1,
            event_time_ms=1000,
            role="BARS",
            payload={"open": "105", "high": "110", "low": "90", "close": "100"},
        ),
    )
    with pytest.raises(MarketDatasetError):
        TradeSimulationKernel().run(bar_like, lambda *args: [])


def test_resting_limit_fee_uses_trade_aggressor_side() -> None:
    events = (
        _trade(1, price="105"),
        _trade(2, price="100", is_buyer_maker=True),
    )

    def place_bid(_visible, event):
        if event.sequence == 1:
            return [{"side": "BUY", "type": "LIMIT", "qty": "1", "limit_price": "100"}]
        return []

    result = TradeSimulationKernel(
        maker_fee_bps=Decimal("2"),
        taker_fee_bps=Decimal("10"),
    ).run(events, place_bid)

    assert result.fills[0]["reason"] == "PRINT_THROUGH"
    assert Decimal(str(result.fills[0]["fee"])) == Decimal("0.02")


def test_gap_and_sequence_reset_fail_closed() -> None:
    with pytest.raises(MarketDatasetError, match="DATA_GAP_REJECTED"):
        TradeSimulationKernel().run(
            (_trade(1, source_sequence=5), _trade(2, source_sequence=2, time_ms=300)),
            lambda *args: [],
        )


def test_checkpoint_resume_matches_uninterrupted_hash() -> None:
    events = tuple(_trade(index, price=str(100 + index)) for index in range(1, 9))

    def buy_once(visible, event):
        if event.sequence == 1:
            return [{"side": "BUY", "type": "MARKET", "qty": "1"}]
        return []

    full = TradeSimulationKernel(checkpoint_event_interval=3).run(events, buy_once)
    paused = TradeSimulationKernel(checkpoint_event_interval=3)
    paused.run(events[:3], buy_once)
    resumed = TradeSimulationKernel()
    resumed.restore(paused.snapshot())
    resumed.run(events[3:], lambda *args: [])
    assert resumed.result().fill_hash == full.fill_hash
    assert resumed.result().ledger_hash == full.ledger_hash
    assert resumed.result().report_hash == full.report_hash


def test_open_order_workload_is_not_an_empty_path() -> None:
    events = tuple(_trade(index, price="100") for index in range(1, 5001))
    kernel = TradeSimulationKernel()
    kernel._enqueue({"side": "BUY", "type": "LIMIT", "qty": "1", "limit_price": "100"}, current_sequence=0)
    result = kernel.run(events, lambda *args: [])
    assert result.fills
    assert result.fills[0]["reason"] == "PRINT_THROUGH"


def test_partial_print_leaves_residual_quantity_open() -> None:
    kernel = TradeSimulationKernel()
    kernel._enqueue({"side": "BUY", "type": "MARKET", "qty": "10"}, current_sequence=0)
    result = kernel.run((_trade(1, price="100", qty="1"),), lambda *args: [])
    assert len(result.fills) == 1
    assert str(result.fills[0]["qty"]) == "1"
    assert kernel.orders[0].status == "PARTIAL"
    assert str(kernel.orders[0].qty) == "9"
    assert str(kernel.position_qty) == "1"
    assert str(kernel.projected_position_qty) == "10"


def test_trade_oco_fill_cancels_sibling_before_later_print() -> None:
    events = (
        _trade(1, price="100", qty="10"),
        _trade(2, price="110", qty="10"),
        _trade(3, price="90", qty="10"),
    )

    def brackets(_visible, event):
        if event.sequence == 1:
            return [
                {"side": "SELL", "type": "LIMIT", "qty": "1", "limit_price": "110"},
                {"side": "SELL", "type": "STOP", "qty": "1", "stop_price": "90"},
            ]
        return []

    kernel = TradeSimulationKernel()
    result = kernel.run(events, brackets)
    assert len(result.fills) == 1
    assert str(kernel.position_qty) == "-1"
    assert {order.status for order in kernel.orders} == {"FILLED", "CANCELLED_OCO"}


def test_trade_kernel_reports_accept_reject_and_fill_truth() -> None:
    reports: list[dict] = []
    kernel = TradeSimulationKernel(execution_reporter=reports.append)
    kernel._enqueue_many(
        [
            {"side": "BUY", "type": "MARKET", "qty": "1"},
            {"side": "BUY", "type": "UNKNOWN", "qty": "1"},
        ],
        current_sequence=0,
    )
    kernel.run((_trade(1),), lambda *_args: [])
    assert [report["accepted"] for report in reports] == [True, False, True]
    assert reports[-1]["fill"]["side"] == "BUY"


def test_stop_limit_fills_only_after_stop_then_limit() -> None:
    events = (
        _trade(1, price="100"),
        _trade(2, price="111"),
        _trade(3, price="109"),
    )

    def place(visible, event):
        if event.sequence == 1:
            return [
                {
                    "side": "BUY",
                    "type": "STOP_LIMIT",
                    "qty": "1",
                    "stop_price": "110",
                    "limit_price": "109",
                }
            ]
        return []

    result = TradeSimulationKernel().run(events, place)
    assert len(result.fills) == 1
    assert result.fills[0]["sequence"] == 3
    assert str(result.fills[0]["price"]) == "109"


def test_derived_bar_is_observation_only() -> None:
    feature = derived_bar_feature((_trade(1, price="10"), _trade(2, price="12")))
    assert feature is not None
    assert feature["authority"] == "OBSERVATION_ONLY"
    assert TRADE_FILL_POLICY != SimulationKernel().fill_policy


def test_trade_report_never_claims_perfect_or_queue_exact() -> None:
    report = build_report(
        {
            "run_id": "bt_t",
            "fidelity_mode": "TRADE_TAPE",
            "source_event_kind": "RAW_TRADE",
        },
        {"fills": [], "report_hash": "sha256:x"},
    )
    blob = str(report).lower()
    assert report["report_label"] == "TRADE_SEQUENCE"
    assert "queue position" in report["unmodeled"]
    assert "完美" not in blob
    assert "queue-exact" in " ".join(report["not_suitable_for"])
    assert report["report_label"] != "ORDER_LEVEL_REQUIRED"


class _HoldProvider:
    def describe(self):
        return ProviderCapabilities()

    def prepare(self, context):
        return None

    def warmup(self, frame):
        return None

    def step(self, frame):
        return None

    def on_execution_report(self, report):
        return None

    def snapshot(self):
        return {}

    def restore(self, payload):
        return None

    def close(self):
        return "sha256:close"

    def identity(self):
        return {"adapter": "hold"}


def _payload() -> dict[str, object]:
    return {
        "strategy_revision_id": "rev",
        "dataset_id": "ds",
        "data_epoch": "sha256:" + "ab" * 32,
        "snapshot_hash": "sha256:" + "cd" * 32,
        "fidelity_mode": "TRADE_TAPE",
        "start_time_ms": 1,
        "end_time_ms": 2,
    }


def test_service_trade_run_requires_trade_flag(tmp_path: Path) -> None:
    closed = BacktestService.start(
        load_backtest_settings(
            {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=1,
    )
    with pytest.raises(BacktestError, match="FLAG_DISABLED"):
        closed.create_run(_payload(), idempotency_key="no-trade-flag", now_ms=2)
    closed.shutdown()

    opened = BacktestService.start(
        load_backtest_settings(
            {
                "BACKTEST_ENABLED": "1",
                "BACKTEST_TRADE_TAPE_ENABLED": "1",
            },
            data_dir=tmp_path / "on",
            klines_db_path=tmp_path / "on" / "candlescope.db",
            replay_db_path=tmp_path / "on" / "replay.db",
        ),
        now_ms=1,
    )
    created = opened.create_run(_payload(), idempotency_key="trade-on", now_ms=2)
    completed = opened.execute_trade_run(
        created["run_id"],
        events=(_trade(1), _trade(2)),
        provider=_HoldProvider(),
        now_ms=3,
    )
    assert completed["state"] == "COMPLETED"
    assert completed["report"]["report_label"] == "TRADE_SEQUENCE"
    assert completed["report"]["source_event_kind"] == "RAW_TRADE"
    opened.shutdown()


class _TapeProvider:
    def __init__(self) -> None:
        self.frames = []

    def describe(self):
        return ProviderCapabilities(input_modes=("BAR_CLOSE", "TRADE_EVENT"))

    def prepare(self, context):
        return None

    def warmup(self, frame):
        self.frames.append(frame)
        return None

    def step(self, frame):
        self.frames.append(frame)
        return None

    def on_execution_report(self, report):
        return None

    def snapshot(self):
        return {}

    def restore(self, payload):
        return None

    def close(self):
        return "sha256:close"


def test_service_trade_run_passes_tape_and_derived_bar(tmp_path: Path) -> None:
    service = BacktestService.start(
        load_backtest_settings(
            {"BACKTEST_ENABLED": "1", "BACKTEST_TRADE_TAPE_ENABLED": "1"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=1,
    )
    created = service.create_run(_payload(), idempotency_key="tape-frame", now_ms=2)
    provider = _TapeProvider()
    service.execute_trade_run(
        created["run_id"],
        events=(_trade(1, price="101"), _trade(2, price="102")),
        provider=provider,
        now_ms=3,
    )
    assert provider.frames
    assert provider.frames[0].trade is not None
    assert provider.frames[0].trade["price"] == "101"
    assert provider.frames[0].bar is not None
    assert provider.frames[0].bar["close"] == "101"
    service.shutdown()
