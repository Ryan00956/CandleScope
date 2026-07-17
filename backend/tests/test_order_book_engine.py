from __future__ import annotations

import dataclasses
import json
import math

import pytest

from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType
from app.data_engine.market_data.order_book import (
    OrderBookEngine,
    OrderBookLevel,
    OrderBookSnapshot,
)


def _snapshot(
    *,
    symbol: str = "BTCUSDT",
    market_type: str = "futures",
    depth_levels: int = 5,
    update_interval_ms: int = 100,
    last_update_id: int = 10,
    bids: object = ((99, 2), (100, 1)),
    asks: object = ((102, 1), (101, 3)),
) -> OrderBookSnapshot:
    return OrderBookSnapshot(
        exchange="BINANCE",
        market_type=market_type,
        symbol=symbol,
        depth_levels=depth_levels,
        update_interval_ms=update_interval_ms,
        last_update_id=last_update_id,
        bids=bids,  # type: ignore[arg-type]
        asks=asks,  # type: ignore[arg-type]
        event_time_ms=1_000,
        received_at_ms=1_005,
        source=DataSource.WEBSOCKET,
    )


def _market_event(
    *,
    event_type: StreamType = StreamType.DEPTH,
    depth_levels: int | None = 5,
    update_interval_ms: int | None = 100,
    last_update_id: int = 10,
    sequence: int | None = None,
) -> MarketEvent:
    data = {
        "last_update_id": last_update_id,
        "bids": [[100, 1], [99, 2]],
        "asks": [[101, 3], [102, 1]],
    }
    if depth_levels is not None:
        data["depth_levels"] = depth_levels
    if update_interval_ms is not None:
        data["update_interval_ms"] = update_interval_ms
    return MarketEvent(
        event_type=event_type,
        symbol="BTCUSDT",
        exchange="binance",
        event_time_ms=1_000,
        received_at_ms=1_005,
        source=DataSource.WEBSOCKET,
        data=data,
        sequence=last_update_id if sequence is None else sequence,
        market_type="futures",
    )


def test_snapshot_canonicalizes_levels_and_derives_metrics() -> None:
    snapshot = _snapshot()

    assert [level.price for level in snapshot.bids] == [100, 99]
    assert [level.price for level in snapshot.asks] == [101, 102]
    assert snapshot.stream_identity == ("binance", "futures", "BTCUSDT", 5, 100)
    assert snapshot.top_bid == 100
    assert snapshot.top_ask == 101
    assert snapshot.mid_price == 100.5
    assert snapshot.spread == 1
    assert snapshot.spread_bps == pytest.approx(1 / 100.5 * 10_000)
    assert snapshot.bid_base_quantity == 3
    assert snapshot.ask_base_quantity == 4
    assert snapshot.bid_notional == 298
    assert snapshot.ask_notional == 405
    assert snapshot.notional_imbalance == pytest.approx((298 - 405) / (298 + 405))


def test_snapshot_and_levels_are_immutable_and_json_safe() -> None:
    snapshot = _snapshot()

    with pytest.raises(dataclasses.FrozenInstanceError):
        snapshot.last_update_id = 11  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        snapshot.bids[0].quantity = 2  # type: ignore[misc]

    payload = snapshot.to_dict()
    assert json.loads(json.dumps(payload)) == payload
    assert payload["bids"] == [[100.0, 1.0], [99.0, 2.0]]
    assert payload["delivery"] == "snapshot"
    assert payload["partial"] is True
    assert payload["full_book"] is False
    assert payload["sequence_continuity"] is False
    assert all(
        math.isfinite(payload[name])
        for name in (
            "top_bid",
            "top_ask",
            "mid_price",
            "spread",
            "spread_bps",
            "bid_base_quantity",
            "ask_base_quantity",
            "bid_notional",
            "ask_notional",
            "notional_imbalance",
        )
    )


def test_snapshot_is_exchange_agnostic_and_accepts_spot_or_derivatives() -> None:
    spot = _snapshot(market_type="spot")
    swap = dataclasses.replace(
        spot,
        exchange="OKX",
        market_type="SWAP",
        symbol="btc-usdt",
    )

    assert spot.stream_identity == ("binance", "spot", "BTCUSDT", 5, 100)
    assert swap.stream_identity == ("okx", "swap", "BTC-USDT", 5, 100)


def test_derived_metrics_remain_json_safe_near_float_limits() -> None:
    snapshot = _snapshot(
        bids=((1e308, 1e-308),),
        asks=((1.1e308, 1e-308),),
    )

    assert math.isfinite(snapshot.mid_price)
    assert math.isfinite(snapshot.spread_bps)
    assert math.isfinite(snapshot.notional_imbalance)


def test_from_market_event_uses_explicit_snapshot_metadata() -> None:
    snapshot = OrderBookSnapshot.from_market_event(_market_event())

    assert snapshot.depth_levels == 5
    assert snapshot.update_interval_ms == 100
    assert snapshot.last_update_id == 10
    assert snapshot.source is DataSource.WEBSOCKET


def test_from_market_event_accepts_trusted_descriptor_overrides() -> None:
    event = _market_event(depth_levels=None, update_interval_ms=None)

    snapshot = OrderBookSnapshot.from_market_event(
        event,
        depth_levels=20,
        update_interval_ms=1_000,
    )

    assert snapshot.stream_identity == (
        "binance",
        "futures",
        "BTCUSDT",
        20,
        1_000,
    )


@pytest.mark.parametrize(
    ("changes", "error"),
    [
        ({"depth_levels": 7}, "one of"),
        ({"update_interval_ms": 0}, ">= 1"),
        ({"last_update_id": 0}, ">= 1"),
        ({"bids": ()}, "bids cannot be empty"),
        ({"asks": ()}, "asks cannot be empty"),
        ({"bids": ((100, 1), (100.0, 2))}, "duplicate prices"),
        ({"asks": ((101, 1), (101.0, 2))}, "duplicate prices"),
        ({"bids": ((100, 0),)}, "finite and positive"),
        ({"asks": ((101, -1),)}, "finite and positive"),
        ({"bids": ((float("inf"), 1),)}, "finite and positive"),
        ({"asks": ((101, float("nan")),)}, "finite and positive"),
        ({"bids": ((101, 1),), "asks": ((101, 1),)}, "crossed or locked"),
        ({"bids": ((102, 1),), "asks": ((101, 1),)}, "crossed or locked"),
        (
            {"bids": tuple((100 - index, 1) for index in range(6))},
            "exceed requested depth",
        ),
    ],
)
def test_snapshot_rejects_invalid_or_unsafe_books(
    changes: dict[str, object],
    error: str,
) -> None:
    values: dict[str, object] = {
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "depth_levels": 5,
        "update_interval_ms": 100,
        "last_update_id": 1,
        "bids": ((100, 1),),
        "asks": ((101, 1),),
        "event_time_ms": 1,
        "received_at_ms": 2,
        "source": DataSource.MOCK,
    }
    values.update(changes)

    with pytest.raises((TypeError, ValueError), match=error):
        OrderBookSnapshot(**values)  # type: ignore[arg-type]


def test_level_rejects_non_finite_notional() -> None:
    with pytest.raises(ValueError, match="notional"):
        OrderBookLevel(1e308, 1e308)
    with pytest.raises(ValueError, match="notional"):
        OrderBookLevel(1e-308, 1e-308)


@pytest.mark.parametrize(
    ("event", "kwargs", "error"),
    [
        (_market_event(event_type=StreamType.AGG_TRADE), {}, "only accepts DEPTH"),
        (_market_event(depth_levels=None), {}, "requires depth_levels"),
        (_market_event(update_interval_ms=None), {}, "requires update_interval_ms"),
        (_market_event(), {"depth_levels": 20}, "conflicts"),
        (_market_event(sequence=11), {}, "conflicts"),
    ],
)
def test_from_market_event_fails_closed_on_contract_conflicts(
    event: MarketEvent,
    kwargs: dict[str, int],
    error: str,
) -> None:
    with pytest.raises((TypeError, ValueError), match=error):
        OrderBookSnapshot.from_market_event(event, **kwargs)


def test_engine_replaces_latest_snapshot_monotonically() -> None:
    engine = OrderBookEngine()
    identity = ("binance", "futures", "BTCUSDT", 5, 100)

    first = engine.ingest(_snapshot(last_update_id=10))
    second = engine.ingest(_snapshot(last_update_id=12, bids=((100, 2),)))

    assert first.accepted and first.reason == "accepted"
    assert second.accepted and second.snapshot is not None
    assert engine.snapshot(identity) is second.snapshot
    assert engine.snapshot(identity).last_update_id == 12  # type: ignore[union-attr]
    assert engine.snapshot(identity).bid_base_quantity == 2  # type: ignore[union-attr]


def test_engine_rejects_duplicate_and_stale_update_ids() -> None:
    engine = OrderBookEngine()
    identity = ("binance", "futures", "BTCUSDT", 5, 100)
    accepted = _snapshot(last_update_id=10)
    engine.ingest(accepted)

    duplicate = engine.ingest(_snapshot(last_update_id=10, bids=((100, 9),)))
    stale = engine.ingest(_snapshot(last_update_id=9))

    assert duplicate.accepted is False
    assert duplicate.reason == "duplicate_update_id"
    assert duplicate.snapshot is None
    assert stale.accepted is False
    assert stale.reason == "stale_update_id"
    assert stale.snapshot is None
    assert engine.snapshot(identity) is accepted
    diagnostics = engine.diagnostics()
    assert diagnostics["duplicate_update_ids_rejected"] == 1
    assert diagnostics["stale_update_ids_rejected"] == 1


def test_depth_and_update_interval_are_distinct_stream_identities() -> None:
    engine = OrderBookEngine()
    snapshots = (
        _snapshot(depth_levels=5, update_interval_ms=100, last_update_id=10),
        _snapshot(depth_levels=20, update_interval_ms=100, last_update_id=9),
        _snapshot(depth_levels=5, update_interval_ms=1_000, last_update_id=8),
    )

    assert all(engine.ingest(snapshot).accepted for snapshot in snapshots)
    assert engine.diagnostics()["streams"] == 3
    assert engine.snapshots() == snapshots


def test_inactive_stream_is_evicted_at_capacity() -> None:
    engine = OrderBookEngine(max_streams=1)
    btc = _snapshot(symbol="BTCUSDT")
    eth = _snapshot(symbol="ETHUSDT")

    engine.ingest(btc)
    engine.ingest(eth)

    assert engine.snapshot(btc.stream_identity) is None
    assert engine.snapshot(eth.stream_identity) is eth
    assert engine.diagnostics()["streams_evicted"] == 1


def test_active_streams_are_never_silently_evicted() -> None:
    engine = OrderBookEngine(max_streams=1)
    btc = _snapshot(symbol="BTCUSDT")
    eth = _snapshot(symbol="ETHUSDT")

    assert engine.activate_stream(btc.stream_identity) is True
    assert engine.activate_stream(btc.stream_identity) is False
    engine.ingest(btc)
    with pytest.raises(RuntimeError, match="active stream limit"):
        engine.ingest(eth)
    assert engine.snapshot(btc.stream_identity) is btc

    assert engine.deactivate_stream(btc.stream_identity) is True
    assert engine.deactivate_stream(btc.stream_identity) is False
    assert engine.ingest(eth).accepted is True
    diagnostics = engine.diagnostics()
    assert diagnostics["capacity_rejections"] == 1
    assert diagnostics["active_streams"] == 0
    assert diagnostics["stream_activations"] == 1
    assert diagnostics["stream_deactivations"] == 1


def test_process_counts_invalid_market_events_without_storing_them() -> None:
    engine = OrderBookEngine()

    with pytest.raises(ValueError, match="only accepts DEPTH"):
        engine.process(_market_event(event_type=StreamType.TRADE))

    diagnostics = engine.diagnostics()
    assert diagnostics["ingest_attempts"] == 1
    assert diagnostics["invalid_snapshots_rejected"] == 1
    assert diagnostics["snapshots_accepted"] == 0
    assert diagnostics["streams"] == 0
    assert diagnostics["delivery"] == "snapshot"
    assert diagnostics["full_book"] is False
    assert diagnostics["sequence_continuity"] is False
    assert diagnostics["supported_depth_levels"] == [5, 10, 20]
