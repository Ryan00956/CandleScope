from __future__ import annotations

import math
from types import SimpleNamespace

import pytest

from app.data_engine.ingestion.models import DataSource
from app.data_engine.market_data.liquidation import (
    SOURCE_QUALITY,
    LiquidationEngine,
    NormalizedLiquidation,
)


def _event(
    *,
    symbol: str = "BTCUSDT",
    order_side: str = "SELL",
    original_quantity: float = 2.0,
    order_price: float = 100.0,
    average_price: float = 99.5,
    last_filled_quantity: float = 0.5,
    filled_quantity: float = 1.5,
    trade_time_ms: int = 1_000,
    event_time_ms: int | None = None,
    received_at_ms: int | None = None,
    source: DataSource = DataSource.WEBSOCKET,
    order_status: str = "FILLED",
) -> NormalizedLiquidation:
    event_time = trade_time_ms + 2 if event_time_ms is None else event_time_ms
    received_at = event_time + 3 if received_at_ms is None else received_at_ms
    return NormalizedLiquidation(
        exchange="BINANCE",
        market_type="FUTURES",
        symbol=symbol,
        order_side=order_side,
        order_type="LIMIT",
        time_in_force="IOC",
        original_quantity=original_quantity,
        order_price=order_price,
        average_price=average_price,
        order_status=order_status,
        last_filled_quantity=last_filled_quantity,
        filled_quantity=filled_quantity,
        trade_time_ms=trade_time_ms,
        event_time_ms=event_time,
        received_at_ms=received_at,
        source=source,
        pair_symbol="BTCUSDT",
        symbol_type="PERPETUAL",
    )


def test_normalized_liquidation_uses_executed_decimal_notional_and_side() -> None:
    long_event = _event(average_price=0.1, filled_quantity=0.2)
    short_event = _event(order_side="BUY")

    assert long_event.position_side == "long"
    assert short_event.position_side == "short"
    assert long_event.executed_notional == 0.02
    assert math.isfinite(long_event.to_dict()["executed_notional"])
    assert long_event.source_quality == SOURCE_QUALITY
    assert long_event.to_dict()["source_quality"] == "sampled_best_effort"

    # The aggregate contract is executed average price * accumulated filled
    # quantity only.  Original order price/quantity must never be a fallback.
    unfilled = _event(
        original_quantity=50.0,
        order_price=100_000.0,
        average_price=0.0,
        filled_quantity=0.0,
        last_filled_quantity=0.0,
    )
    assert unfilled.executed_notional == 0.0


def test_normalized_liquidation_fingerprint_is_payload_stable() -> None:
    first = _event(received_at_ms=5_000, source=DataSource.WEBSOCKET)
    transport_duplicate = _event(received_at_ms=9_000, source=DataSource.MOCK)
    changed_status = _event(received_at_ms=5_000, order_status="PARTIALLY_FILLED")
    changed_event_time = _event(received_at_ms=5_000, event_time_ms=1_003)

    assert first.fingerprint == transport_duplicate.fingerprint
    assert first.fingerprint != changed_status.fingerprint
    assert first.fingerprint != changed_event_time.fingerprint
    assert len(first.fingerprint) == 64


@pytest.mark.parametrize(
    ("changes", "error"),
    [
        ({"market_type": "spot"}, "market_type='futures'"),
        ({"order_side": "BOTH"}, "BUY or SELL"),
        ({"average_price": float("inf")}, "finite and non-negative"),
        ({"filled_quantity": -1}, "finite and non-negative"),
        ({"trade_time_ms": -1}, "non-negative"),
    ],
)
def test_normalized_liquidation_rejects_invalid_values(
    changes: dict,
    error: str,
) -> None:
    values = {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "order_side": "SELL",
        "order_type": "LIMIT",
        "time_in_force": "IOC",
        "original_quantity": 1,
        "order_price": 100,
        "average_price": 100,
        "order_status": "FILLED",
        "last_filled_quantity": 1,
        "filled_quantity": 1,
        "trade_time_ms": 1,
        "event_time_ms": 2,
        "received_at_ms": 3,
        "source": DataSource.WEBSOCKET,
    }
    values.update(changes)
    with pytest.raises((TypeError, ValueError), match=error):
        NormalizedLiquidation(**values)


def test_normalized_liquidation_rejects_non_finite_serialized_notional() -> None:
    with pytest.raises(ValueError, match="executed_notional"):
        _event(average_price=1e308, filled_quantity=1e308)


def test_from_market_event_preserves_force_order_fields_and_checks_projection() -> None:
    raw = SimpleNamespace(
        event_type=SimpleNamespace(value="forceOrder"),
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        event_time_ms=2_000,
        received_at_ms=2_005,
        source=DataSource.WEBSOCKET,
        data={
            "order_side": "SELL",
            "position_side": "long",
            "order_type": "LIMIT",
            "time_in_force": "IOC",
            "original_quantity": 2,
            "order_price": 100,
            "average_price": 99,
            "order_status": "FILLED",
            "last_filled_quantity": 1,
            "filled_quantity": 2,
            "trade_time_ms": 1_999,
            "pair_symbol": "BTCUSDT",
            "symbol_type": "perpetual",
        },
    )

    event = NormalizedLiquidation.from_market_event(raw)

    assert event.position_side == "long"
    assert event.trade_time_ms == 1_999
    assert event.event_time_ms == 2_000
    assert event.pair_symbol == "BTCUSDT"
    assert event.symbol_type == "PERPETUAL"

    raw.data = {**raw.data, "position_side": "short"}
    with pytest.raises(ValueError, match="conflicts"):
        NormalizedLiquidation.from_market_event(raw)

    raw.event_type = SimpleNamespace(value="aggTrade")
    with pytest.raises(ValueError, match="forceOrder"):
        NormalizedLiquidation.from_market_event(raw)


def test_engine_rolls_up_one_row_per_minute_and_position_side() -> None:
    engine = LiquidationEngine()
    first = engine.ingest(
        _event(
            order_side="SELL",
            average_price=100,
            filled_quantity=2,
            trade_time_ms=10_000,
        ),
    )
    second = engine.ingest(
        _event(
            order_side="SELL",
            average_price=110,
            filled_quantity=1,
            trade_time_ms=20_000,
        ),
    )
    third = engine.ingest(
        _event(
            order_side="BUY",
            average_price=90,
            filled_quantity=3,
            trade_time_ms=30_000,
        ),
    )

    assert first.accepted and second.accepted and third.accepted
    rows = engine.rollup_snapshot(("binance", "futures", "BTCUSDT"))
    assert [(row.bucket_start_ms, row.position_side) for row in rows] == [
        (0, "long"),
        (0, "short"),
    ]
    long_row, short_row = rows
    assert long_row.filled_quantity == 3
    assert long_row.filled_notional == 310
    assert long_row.event_count == 2
    assert long_row.max_event_notional == 200
    assert long_row.first_event_time_ms == 10_000
    assert long_row.last_event_time_ms == 20_000
    assert long_row.revision == 2
    assert short_row.filled_quantity == 3
    assert short_row.filled_notional == 270
    assert short_row.event_count == 1
    assert short_row.revision == 1


def test_engine_exact_fingerprint_dedupe_is_bounded_by_raw_ring() -> None:
    engine = LiquidationEngine(raw_ring_size=1)
    original = _event(trade_time_ms=1_000, received_at_ms=2_000)
    duplicate = _event(trade_time_ms=1_000, received_at_ms=9_000)

    assert engine.ingest(original).accepted is True
    rejected = engine.ingest(duplicate)
    assert rejected.accepted is False
    assert rejected.reason == "duplicate"
    assert rejected.rollups == ()

    engine.ingest(_event(trade_time_ms=2_000))
    # Once the exact fingerprint leaves the configured recent ring, accepting
    # it again is safer than pretending the exchange supplied a unique ID.
    assert engine.ingest(duplicate).accepted is True
    diagnostics = engine.diagnostics()
    assert diagnostics["raw_records"] == 1
    assert diagnostics["duplicates_rejected"] == 1
    assert diagnostics["raw_events_evicted"] == 2


def test_finalize_due_closes_sparse_bucket_without_a_later_event() -> None:
    engine = LiquidationEngine()
    engine.ingest(_event(trade_time_ms=61_000, event_time_ms=61_001))

    assert engine.rollup_snapshot(("binance", "futures", "BTCUSDT"))[0].is_final is False
    assert engine.finalize_due(119_999) == ()

    finalized = engine.finalize_due(120_000)
    assert len(finalized) == 1
    assert finalized[0].bucket_start_ms == 60_000
    assert finalized[0].is_final is True
    assert finalized[0].revision == 2
    assert finalized[0].updated_at_ms == 120_000
    assert engine.finalize_due(180_000) == ()


def test_engine_never_synthesizes_zero_rows_for_missing_minutes() -> None:
    engine = LiquidationEngine()
    engine.ingest(_event(trade_time_ms=1_000))
    engine.ingest(_event(trade_time_ms=181_000))
    engine.finalize_due(300_000)

    rows = engine.rollup_snapshot(("binance", "futures", "BTCUSDT"))
    assert [row.bucket_start_ms for row in rows] == [0, 180_000]
    assert all(row.event_count > 0 for row in rows)


def test_late_event_updates_an_already_finalized_bucket_monotonically() -> None:
    engine = LiquidationEngine()
    engine.ingest(_event(trade_time_ms=1_000, filled_quantity=1, average_price=10))
    finalized = engine.finalize_due(60_000)[0]

    result = engine.ingest(
        _event(
            trade_time_ms=2_000,
            event_time_ms=60_100,
            filled_quantity=2,
            average_price=10,
        ),
    )
    row = engine.rollup_snapshot(("binance", "futures", "BTCUSDT"))[0]

    assert result.accepted
    assert row.is_final is True
    assert row.event_count == 2
    assert row.filled_notional == 30
    assert row.revision == finalized.revision + 1


def test_active_stream_reservation_prevents_live_state_eviction() -> None:
    engine = LiquidationEngine(max_streams=1)
    btc = ("binance", "futures", "BTCUSDT")
    eth = ("binance", "futures", "ETHUSDT")

    assert engine.activate_stream(btc) is True
    assert engine.activate_stream(btc) is False
    with pytest.raises(RuntimeError, match="active stream limit"):
        engine.activate_stream(eth)
    with pytest.raises(RuntimeError, match="active stream limit"):
        engine.ingest(_event(symbol="ETHUSDT"))

    assert engine.deactivate_stream(btc) is True
    assert engine.deactivate_stream(btc) is False
    assert engine.activate_stream(eth) is True
    assert engine.raw_snapshot(btc) == ()
    diagnostics = engine.diagnostics()
    assert diagnostics["streams"] == 1
    assert diagnostics["active_streams"] == 1
    assert diagnostics["streams_evicted"] == 1


def test_engine_bounds_rollup_rows_and_orders_snapshots() -> None:
    engine = LiquidationEngine(raw_ring_size=2, max_buckets_per_stream=2)
    engine.ingest(_event(trade_time_ms=121_000))
    engine.ingest(_event(trade_time_ms=1_000))
    engine.ingest(_event(trade_time_ms=61_000))

    raw = engine.raw_snapshot(("binance", "futures", "BTCUSDT"))
    rows = engine.rollup_snapshot(("binance", "futures", "BTCUSDT"))

    assert [item.trade_time_ms for item in raw] == [1_000, 61_000]
    assert [row.bucket_start_ms for row in rows] == [60_000, 120_000]
    diagnostics = engine.diagnostics()
    assert diagnostics["raw_events_evicted"] == 1
    assert diagnostics["rollup_rows_evicted"] == 1
    assert diagnostics["source_quality"] == "sampled_best_effort"
    assert diagnostics["limits"] == {
        "raw_ring_per_stream": 2,
        "rollup_rows_per_stream": 2,
        "streams": 64,
    }


def test_raw_tail_selects_newest_events_without_sorting_the_full_ring() -> None:
    engine = LiquidationEngine(raw_ring_size=10)
    engine.ingest(_event(trade_time_ms=3_000))
    engine.ingest(_event(trade_time_ms=1_000))
    engine.ingest(_event(trade_time_ms=2_000))

    assert [
        event.trade_time_ms
        for event in engine.raw_tail(("binance", "futures", "BTCUSDT"), 2)
    ] == [2_000, 3_000]
    assert engine.raw_tail(("binance", "futures", "BTCUSDT"), 0) == ()
