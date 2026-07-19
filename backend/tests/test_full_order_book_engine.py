from __future__ import annotations

import dataclasses
import json
import math

import pytest

from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType
from app.data_engine.market_data.full_order_book import (
    DepthDelta,
    DepthLevelUpdate,
    FullOrderBookAction,
    FullOrderBookEngine,
    FullOrderBookFailure,
    FullOrderBookLevel,
    FullOrderBookSeed,
    FullOrderBookState,
    FullOrderBookStateError,
)


IDENTITY = ("binance", "futures", "BTCUSDT", 100)
SPOT_IDENTITY = ("binance", "spot", "BTCUSDT", 100)


def _seed(
    *,
    exchange: str = "binance",
    market_type: str = "futures",
    symbol: str = "BTCUSDT",
    update_interval_ms: int = 100,
    snapshot_limit: int = 1_000,
    last_update_id: int = 100,
    bids: object = ((100, 1), (99, 2)),
    asks: object = ((101, 3), (102, 4)),
) -> FullOrderBookSeed:
    return FullOrderBookSeed(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        update_interval_ms=update_interval_ms,
        snapshot_limit=snapshot_limit,
        last_update_id=last_update_id,
        bids=bids,  # type: ignore[arg-type]
        asks=asks,  # type: ignore[arg-type]
        event_time_ms=1_000,
        received_at_ms=1_005,
        source=DataSource.HTTP,
    )


def _delta(
    first_update_id: int,
    final_update_id: int,
    previous_final_update_id: int | None,
    *,
    exchange: str = "binance",
    market_type: str = "futures",
    symbol: str = "BTCUSDT",
    update_interval_ms: int = 100,
    bids: object = (),
    asks: object = (),
    event_time_ms: int | None = None,
) -> DepthDelta:
    return DepthDelta(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        update_interval_ms=update_interval_ms,
        first_update_id=first_update_id,
        final_update_id=final_update_id,
        previous_final_update_id=previous_final_update_id,
        bids=bids,  # type: ignore[arg-type]
        asks=asks,  # type: ignore[arg-type]
        event_time_ms=event_time_ms or 1_100 + final_update_id,
        transaction_time_ms=(
            None if market_type == "spot" else 1_090 + final_update_id
        ),
        received_at_ms=1_105 + final_update_id,
        source=DataSource.WEBSOCKET,
    )


def _event(
    *,
    kind: str,
    event_type: StreamType = StreamType.FULL_DEPTH,
    exchange: str = "binance",
    market_type: str = "futures",
    symbol: str = "BTCUSDT",
    update_interval_ms: int | None = 100,
    snapshot_limit: int = 1_000,
    last_update_id: int = 100,
    first_update_id: int = 100,
    final_update_id: int = 101,
    previous_final_update_id: int | None = 99,
    sequence: int | None = None,
    bids: object | None = None,
    asks: object | None = None,
) -> MarketEvent:
    if kind == "snapshot":
        data: dict[str, object] = {
            "kind": kind,
            "snapshot_limit": snapshot_limit,
            "last_update_id": last_update_id,
            "bids": [[100, 1], [99, 2]] if bids is None else bids,
            "asks": [[101, 3], [102, 4]] if asks is None else asks,
        }
        resolved_sequence = last_update_id if sequence is None else sequence
        source = DataSource.HTTP
    else:
        data = {
            "kind": kind,
            "first_update_id": first_update_id,
            "final_update_id": final_update_id,
            "previous_final_update_id": previous_final_update_id,
            "event_time_ms": 2_000,
            "transaction_time_ms": 1_999,
            "bids": [] if bids is None else bids,
            "asks": [] if asks is None else asks,
        }
        resolved_sequence = final_update_id if sequence is None else sequence
        source = DataSource.WEBSOCKET
    if update_interval_ms is not None:
        data["update_interval_ms"] = update_interval_ms
    return MarketEvent(
        event_type=event_type,
        symbol=symbol,
        exchange=exchange,
        event_time_ms=2_000,
        received_at_ms=2_005,
        source=source,
        data=data,
        sequence=resolved_sequence,
        market_type=market_type,
    )


def _started(engine: FullOrderBookEngine) -> int:
    assert engine.activate_stream(IDENTITY) is True
    return engine.begin_sync(IDENTITY)


def _awaiting(engine: FullOrderBookEngine) -> int:
    epoch = _started(engine)
    result = engine.install_snapshot(IDENTITY, _seed(), epoch=epoch)
    assert result.accepted is True
    assert result.state is FullOrderBookState.AWAITING_BRIDGE
    assert result.snapshot is None
    return epoch


def _live(engine: FullOrderBookEngine) -> int:
    epoch = _awaiting(engine)
    result = engine.apply_delta(
        IDENTITY,
        _delta(100, 101, 99),
        epoch=epoch,
    )
    assert result.accepted is True
    assert result.snapshot is not None
    return epoch


def test_public_enums_have_wire_value_string_form() -> None:
    assert str(FullOrderBookState.LIVE) == "live"
    assert str(FullOrderBookAction.APPLIED) == "applied"
    assert str(FullOrderBookFailure.GAP) == "gap"


def test_seed_canonicalizes_identity_levels_and_is_immutable() -> None:
    seed = _seed(
        exchange=" BINANCE ",
        market_type=" FUTURES ",
        symbol="btcusdt",
        bids=((99, 2), (100, 1)),
        asks=((102, 4), (101, 3)),
    )

    assert seed.stream_identity == IDENTITY
    assert [level.price for level in seed.bids] == [100, 99]
    assert [level.price for level in seed.asks] == [101, 102]
    with pytest.raises(dataclasses.FrozenInstanceError):
        seed.last_update_id = 101  # type: ignore[misc]


@pytest.mark.parametrize(
    ("changes", "error"),
    [
        ({"bids": ()}, "bids cannot be empty"),
        ({"asks": ()}, "asks cannot be empty"),
        ({"bids": ((100, 1), (100, 2))}, "duplicate prices"),
        ({"asks": ((101, 1), (101, 2))}, "duplicate prices"),
        ({"bids": ((100, 0),)}, "finite and positive"),
        ({"asks": ((101, -1),)}, "finite and positive"),
        ({"bids": ((float("inf"), 1),)}, "finite and positive"),
        ({"asks": ((101, float("nan")),)}, "finite and positive"),
        ({"bids": ((101, 1),), "asks": ((101, 1),)}, "crossed or locked"),
        ({"bids": ((102, 1),), "asks": ((101, 1),)}, "crossed or locked"),
        ({"snapshot_limit": 1, "bids": ((100, 1), (99, 1))}, "snapshot_limit"),
        ({"last_update_id": 0}, ">= 1"),
    ],
)
def test_seed_rejects_invalid_or_unsafe_snapshot(
    changes: dict[str, object],
    error: str,
) -> None:
    values: dict[str, object] = {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "update_interval_ms": 100,
        "snapshot_limit": 1_000,
        "last_update_id": 100,
        "bids": ((100, 1),),
        "asks": ((101, 1),),
        "event_time_ms": 1,
        "received_at_ms": 2,
        "source": DataSource.HTTP,
    }
    values.update(changes)

    with pytest.raises((TypeError, ValueError), match=error):
        FullOrderBookSeed(**values)  # type: ignore[arg-type]


def test_delta_keeps_zero_quantity_as_absolute_delete() -> None:
    delta = _delta(
        101,
        102,
        100,
        bids=((100, 0), (99, 2.5)),
        asks=((101, 0),),
    )

    assert delta.stream_identity == IDENTITY
    assert delta.level_update_count == 3
    assert delta.bids[0] == DepthLevelUpdate(100, 0)
    assert delta.bids[0].deletes_level is True
    assert delta.bids[1].deletes_level is False
    assert delta.to_dict()["bids"] == [[100.0, 0.0], [99.0, 2.5]]


@pytest.mark.parametrize(
    ("changes", "error"),
    [
        ({"first_update_id": 102, "final_update_id": 101}, "cannot exceed"),
        ({"previous_final_update_id": 101, "final_update_id": 101}, "must precede"),
        ({"bids": ((100, 1), (100, 0))}, "duplicate prices"),
        ({"asks": ((101, -1),)}, "non-negative"),
        ({"bids": ((0, 1),)}, "finite and positive"),
    ],
)
def test_delta_rejects_invalid_sequence_or_updates(
    changes: dict[str, object],
    error: str,
) -> None:
    values: dict[str, object] = {
        "first_update_id": 101,
        "final_update_id": 101,
        "previous_final_update_id": 100,
    }
    values.update(changes)
    with pytest.raises((TypeError, ValueError), match=error):
        _delta(**values)  # type: ignore[arg-type]


def test_market_event_adapters_preserve_full_depth_contract() -> None:
    seed = FullOrderBookSeed.from_market_event(_event(kind="snapshot"))
    delta = DepthDelta.from_market_event(
        _event(
            kind="delta",
            bids=[[100, "0"]],
            asks=[[101, "4.5"]],
        ),
    )

    assert seed.last_update_id == 100
    assert seed.snapshot_limit == 1_000
    assert seed.source is DataSource.HTTP
    assert delta.final_update_id == 101
    assert delta.previous_final_update_id == 99
    assert delta.bids[0].deletes_level is True
    assert delta.transaction_time_ms == 1_999


@pytest.mark.parametrize(
    ("event", "adapter", "error"),
    [
        (
            _event(kind="snapshot", event_type=StreamType.DEPTH),
            FullOrderBookSeed.from_market_event,
            "FULL_DEPTH",
        ),
        (
            _event(kind="delta"),
            FullOrderBookSeed.from_market_event,
            "snapshot",
        ),
        (
            _event(kind="snapshot"),
            DepthDelta.from_market_event,
            "delta",
        ),
        (
            _event(kind="snapshot", sequence=101),
            FullOrderBookSeed.from_market_event,
            "conflicts",
        ),
        (
            _event(kind="delta", sequence=102),
            DepthDelta.from_market_event,
            "conflicts",
        ),
    ],
)
def test_market_event_adapters_fail_closed_on_contract_conflicts(
    event: MarketEvent,
    adapter: object,
    error: str,
) -> None:
    with pytest.raises((TypeError, ValueError), match=error):
        adapter(event)  # type: ignore[operator]


def test_event_descriptor_override_must_match_payload() -> None:
    missing = _event(kind="delta", update_interval_ms=None)
    parsed = DepthDelta.from_market_event(missing, update_interval_ms=250)
    assert parsed.update_interval_ms == 250

    with pytest.raises(ValueError, match="conflicts"):
        DepthDelta.from_market_event(
            _event(kind="delta", update_interval_ms=100),
            update_interval_ms=250,
        )


def test_lifecycle_epochs_are_monotonic_and_stale_events_are_ignored() -> None:
    engine = FullOrderBookEngine()
    assert engine.activate_stream(IDENTITY) is True
    assert engine.activate_stream(IDENTITY) is False
    activation_epoch = engine.epoch(IDENTITY)
    assert activation_epoch is not None
    sync_epoch = engine.begin_sync(IDENTITY)
    assert sync_epoch > activation_epoch

    stale = engine.apply_delta(
        IDENTITY,
        _delta(101, 101, 100),
        epoch=activation_epoch,
    )
    assert stale.accepted is False
    assert stale.action is FullOrderBookAction.STALE_EPOCH
    assert engine.state(IDENTITY) is FullOrderBookState.BUFFERING

    assert engine.deactivate_stream(IDENTITY) is True
    inactive_epoch = engine.epoch(IDENTITY)
    assert inactive_epoch is not None and inactive_epoch > sync_epoch
    assert engine.state(IDENTITY) is FullOrderBookState.INACTIVE
    assert engine.snapshot(IDENTITY) is None
    assert engine.deactivate_stream(IDENTITY) is False
    with pytest.raises(FullOrderBookStateError, match="not active"):
        engine.apply_delta(IDENTITY, _delta(101, 101, 100), epoch=inactive_epoch)


def test_snapshot_without_bridge_is_fail_closed_until_successor_arrives() -> None:
    engine = FullOrderBookEngine()
    epoch = _awaiting(engine)

    stale = engine.apply_delta(IDENTITY, _delta(99, 99, 98), epoch=epoch)
    assert stale.action is FullOrderBookAction.STALE
    assert stale.state is FullOrderBookState.AWAITING_BRIDGE
    assert engine.snapshot(IDENTITY) is None

    bridge = engine.apply_delta(
        IDENTITY,
        _delta(100, 101, 99, bids=((100, 2),)),
        epoch=epoch,
    )
    assert bridge.accepted is True
    assert bridge.action is FullOrderBookAction.APPLIED
    assert bridge.state is FullOrderBookState.LIVE
    assert bridge.snapshot is not None
    assert bridge.snapshot.bids[0] == FullOrderBookLevel(100, 2)


def test_buffered_bridge_and_chain_replay_atomically_on_snapshot_install() -> None:
    engine = FullOrderBookEngine()
    epoch = _started(engine)
    first = _delta(99, 101, 98, bids=((100, 2),), asks=((102, 0),))
    second = _delta(102, 103, 101, bids=((98, 5),), asks=((103, 6),))

    assert engine.apply_delta(IDENTITY, first, epoch=epoch).action is FullOrderBookAction.BUFFERED
    assert engine.apply_delta(IDENTITY, second, epoch=epoch).action is FullOrderBookAction.BUFFERED
    assert engine.snapshot(IDENTITY) is None

    installed = engine.install_snapshot(IDENTITY, _seed(), epoch=epoch)
    assert installed.accepted is True
    assert installed.action is FullOrderBookAction.SNAPSHOT_INSTALLED
    assert installed.state is FullOrderBookState.LIVE
    assert installed.last_update_id == 103
    assert installed.snapshot is not None
    assert installed.snapshot.revision == 1
    assert [level.price for level in installed.snapshot.bids] == [100, 99, 98]
    assert [level.price for level in installed.snapshot.asks] == [101, 103]


def test_snapshot_discards_only_strictly_older_buffered_events() -> None:
    engine = FullOrderBookEngine()
    epoch = _started(engine)
    engine.apply_delta(IDENTITY, _delta(98, 99, 97), epoch=epoch)
    engine.apply_delta(
        IDENTITY,
        _delta(100, 101, 99, bids=((100, 7),)),
        epoch=epoch,
    )

    result = engine.install_snapshot(IDENTITY, _seed(), epoch=epoch)

    assert result.state is FullOrderBookState.LIVE
    assert result.snapshot is not None
    assert result.snapshot.bids[0].quantity == 7
    assert engine.diagnostics()["buffered_old_discarded"] == 1


def test_spot_snapshot_discards_u_at_snapshot_and_bridges_next_update_range() -> None:
    engine = FullOrderBookEngine()
    engine.activate_stream(SPOT_IDENTITY)
    epoch = engine.begin_sync(SPOT_IDENTITY)
    stale_at_snapshot = _delta(
        98,
        100,
        None,
        market_type="spot",
    )
    bridge = _delta(
        100,
        102,
        None,
        market_type="spot",
        bids=((100, 7),),
    )

    assert engine.apply_delta(
        SPOT_IDENTITY,
        stale_at_snapshot,
        epoch=epoch,
    ).action is FullOrderBookAction.BUFFERED
    assert engine.apply_delta(
        SPOT_IDENTITY,
        bridge,
        epoch=epoch,
    ).action is FullOrderBookAction.BUFFERED
    result = engine.install_snapshot(
        SPOT_IDENTITY,
        _seed(market_type="spot"),
        epoch=epoch,
    )

    assert result.state is FullOrderBookState.LIVE
    assert result.last_update_id == 102
    assert result.snapshot is not None
    assert result.snapshot.bids[0].quantity == 7
    assert engine.diagnostics()["buffered_old_discarded"] == 1


def test_invalid_first_bridge_requires_resync_and_clears_seed() -> None:
    engine = FullOrderBookEngine()
    epoch = _awaiting(engine)

    failed = engine.apply_delta(
        IDENTITY,
        _delta(102, 102, 101),
        epoch=epoch,
    )

    assert failed.accepted is False
    assert failed.action is FullOrderBookAction.RESYNC_REQUIRED
    assert failed.failure is FullOrderBookFailure.GAP
    assert engine.state(IDENTITY) is FullOrderBookState.RESYNC_REQUIRED
    assert engine.snapshot(IDENTITY) is None
    stream = engine.diagnostics()["stream_states"][0]
    assert stream["bid_levels"] == 0
    assert stream["ask_levels"] == 0


def test_live_sequence_requires_exact_previous_final_update_id() -> None:
    engine = FullOrderBookEngine()
    epoch = _live(engine)

    failed = engine.apply_delta(
        IDENTITY,
        _delta(102, 102, 99),
        epoch=epoch,
    )

    assert failed.failure is FullOrderBookFailure.GAP
    assert failed.state is FullOrderBookState.RESYNC_REQUIRED
    assert engine.snapshot(IDENTITY) is None


def test_live_sequence_allows_non_consecutive_u_ranges_when_pu_links() -> None:
    engine = FullOrderBookEngine()
    epoch = _live(engine)

    applied = engine.apply_delta(
        IDENTITY,
        _delta(150, 175, 101, bids=((100, 2),)),
        epoch=epoch,
    )

    assert applied.accepted is True
    assert applied.state is FullOrderBookState.LIVE
    assert applied.last_update_id == 175
    assert applied.snapshot is not None


def test_spot_live_sequence_accepts_overlap_but_fails_closed_on_missing_range() -> None:
    engine = FullOrderBookEngine()
    engine.activate_stream(SPOT_IDENTITY)
    epoch = engine.begin_sync(SPOT_IDENTITY)
    engine.apply_delta(
        SPOT_IDENTITY,
        _delta(100, 102, None, market_type="spot"),
        epoch=epoch,
    )
    installed = engine.install_snapshot(
        SPOT_IDENTITY,
        _seed(market_type="spot"),
        epoch=epoch,
    )
    assert installed.state is FullOrderBookState.LIVE

    overlap = engine.apply_delta(
        SPOT_IDENTITY,
        _delta(101, 103, None, market_type="spot", bids=((100, 2),)),
        epoch=epoch,
    )
    assert overlap.state is FullOrderBookState.LIVE
    assert overlap.last_update_id == 103

    gap = engine.apply_delta(
        SPOT_IDENTITY,
        _delta(105, 105, None, market_type="spot"),
        epoch=epoch,
    )
    assert gap.failure is FullOrderBookFailure.GAP
    assert gap.state is FullOrderBookState.RESYNC_REQUIRED
    assert engine.snapshot(SPOT_IDENTITY) is None


def test_buffered_sequence_gap_fails_before_rest_snapshot() -> None:
    engine = FullOrderBookEngine()
    epoch = _started(engine)
    engine.apply_delta(IDENTITY, _delta(99, 101, 98), epoch=epoch)

    failed = engine.apply_delta(IDENTITY, _delta(102, 102, 100), epoch=epoch)

    assert failed.failure is FullOrderBookFailure.GAP
    assert engine.state(IDENTITY) is FullOrderBookState.RESYNC_REQUIRED


def test_absolute_upsert_and_zero_delete_are_applied_exactly() -> None:
    engine = FullOrderBookEngine()
    epoch = _awaiting(engine)
    bridge = engine.apply_delta(
        IDENTITY,
        _delta(
            100,
            101,
            99,
            bids=((100, 2), (98, 5), (97, 0)),
            asks=((102, 6),),
        ),
        epoch=epoch,
    )
    assert bridge.snapshot is not None
    old_projection = bridge.snapshot

    applied = engine.apply_delta(
        IDENTITY,
        _delta(
            102,
            102,
            101,
            bids=((99, 0), (97, 0)),
            asks=((102, 8),),
        ),
        epoch=epoch,
    )

    assert applied.snapshot is not None
    assert [(item.price, item.quantity) for item in applied.snapshot.bids] == [
        (100, 2),
        (98, 5),
    ]
    assert [(item.price, item.quantity) for item in applied.snapshot.asks] == [
        (101, 3),
        (102, 8),
    ]
    assert old_projection.last_update_id == 101
    assert old_projection.asks[-1].quantity == 6


def test_exact_duplicate_and_older_delta_do_not_mutate_live_book() -> None:
    engine = FullOrderBookEngine()
    epoch = _awaiting(engine)
    last = _delta(100, 102, 99, bids=((100, 2),))
    accepted = engine.apply_delta(IDENTITY, last, epoch=epoch)
    assert accepted.snapshot is not None

    duplicate = engine.apply_delta(IDENTITY, last, epoch=epoch)
    stale = engine.apply_delta(IDENTITY, _delta(100, 101, 99), epoch=epoch)

    assert duplicate.action is FullOrderBookAction.DUPLICATE
    assert duplicate.accepted is False
    assert duplicate.snapshot is None
    assert stale.action is FullOrderBookAction.STALE
    current = engine.snapshot(IDENTITY)
    assert current is not None
    assert current.last_update_id == 102
    assert current.revision == 1


def test_conflicting_duplicate_requires_resync() -> None:
    engine = FullOrderBookEngine()
    epoch = _awaiting(engine)
    engine.apply_delta(
        IDENTITY,
        _delta(100, 101, 99, bids=((100, 2),)),
        epoch=epoch,
    )

    failed = engine.apply_delta(
        IDENTITY,
        _delta(100, 101, 99, bids=((100, 9),)),
        epoch=epoch,
    )

    assert failed.failure is FullOrderBookFailure.CONFLICTING_DUPLICATE
    assert failed.state is FullOrderBookState.RESYNC_REQUIRED


@pytest.mark.parametrize(
    ("delta", "failure"),
    [
        (_delta(102, 102, 101, asks=((100, 2),)), FullOrderBookFailure.CROSSED_BOOK),
        (
            _delta(102, 102, 101, asks=((101, 0), (102, 0))),
            FullOrderBookFailure.EMPTY_BOOK,
        ),
    ],
)
def test_crossed_or_empty_live_book_fails_closed(
    delta: DepthDelta,
    failure: FullOrderBookFailure,
) -> None:
    engine = FullOrderBookEngine()
    epoch = _live(engine)

    result = engine.apply_delta(IDENTITY, delta, epoch=epoch)

    assert result.failure is failure
    assert result.snapshot is None
    assert engine.snapshot(IDENTITY) is None


def test_failed_buffered_replay_never_exposes_partial_snapshot() -> None:
    engine = FullOrderBookEngine()
    epoch = _started(engine)
    engine.apply_delta(
        IDENTITY,
        _delta(100, 101, 99, asks=((100, 5),)),
        epoch=epoch,
    )

    failed = engine.install_snapshot(IDENTITY, _seed(), epoch=epoch)

    assert failed.failure is FullOrderBookFailure.CROSSED_BOOK
    assert failed.snapshot is None
    assert engine.snapshot(IDENTITY) is None
    stream = engine.diagnostics()["stream_states"][0]
    assert stream["bid_levels"] == stream["ask_levels"] == 0


def test_snapshot_projection_is_sorted_atomic_and_json_safe() -> None:
    engine = FullOrderBookEngine()
    epoch = _started(engine)
    engine.apply_delta(IDENTITY, _delta(100, 101, 99), epoch=epoch)
    installed = engine.install_snapshot(
        IDENTITY,
        _seed(
            bids=((98, 3), (100, 1), (99, 2)),
            asks=((103, 6), (101, 4), (102, 5)),
        ),
        epoch=epoch,
    )
    assert installed.snapshot is not None

    full = engine.snapshot(IDENTITY)
    top_two = engine.snapshot(IDENTITY, depth=2)

    assert full is not None and top_two is not None
    assert [item.price for item in full.bids] == [100, 99, 98]
    assert [item.price for item in full.asks] == [101, 102, 103]
    assert [item.price for item in top_two.bids] == [100, 99]
    assert [item.price for item in top_two.asks] == [101, 102]
    assert top_two.book_bid_levels == top_two.book_ask_levels == 3
    assert top_two.projection_depth == 2
    assert top_two.full_projection is False
    payload = top_two.to_dict()
    assert json.loads(json.dumps(payload)) == payload
    assert payload["local_sequence_continuity"] is True
    assert payload["exchange_full_depth_exhaustive"] is False
    assert all(
        math.isfinite(payload[name])
        for name in ("top_bid", "top_ask", "mid_price", "spread", "spread_bps")
    )


@pytest.mark.parametrize("depth", [0, -1, 5_001])
def test_projection_depth_is_strictly_bounded(depth: int) -> None:
    engine = FullOrderBookEngine()
    _live(engine)

    with pytest.raises((TypeError, ValueError)):
        engine.snapshot(IDENTITY, depth=depth)


def test_stream_and_book_capacity_are_hard_fail_closed_bounds() -> None:
    engine = FullOrderBookEngine(max_streams=1, max_levels_per_side=2)
    epoch = _started(engine)
    result = engine.install_snapshot(
        IDENTITY,
        _seed(snapshot_limit=3),
        epoch=epoch,
    )
    assert result.failure is FullOrderBookFailure.CAPACITY

    eth = ("binance", "futures", "ETHUSDT", 100)
    with pytest.raises(FullOrderBookStateError, match="active stream limit"):
        engine.activate_stream(eth)


def test_live_level_growth_cannot_exceed_side_capacity() -> None:
    engine = FullOrderBookEngine(max_levels_per_side=2)
    epoch = _started(engine)
    engine.apply_delta(IDENTITY, _delta(100, 101, 99), epoch=epoch)
    installed = engine.install_snapshot(
        IDENTITY,
        _seed(snapshot_limit=2, bids=((100, 1),), asks=((101, 1),)),
        epoch=epoch,
    )
    assert installed.state is FullOrderBookState.LIVE

    first_growth = engine.apply_delta(
        IDENTITY,
        _delta(102, 102, 101, bids=((99, 1),)),
        epoch=epoch,
    )
    assert first_growth.state is FullOrderBookState.LIVE
    overflow = engine.apply_delta(
        IDENTITY,
        _delta(103, 103, 102, bids=((98, 1),)),
        epoch=epoch,
    )
    assert overflow.failure is FullOrderBookFailure.CAPACITY
    assert engine.snapshot(IDENTITY) is None


def test_delta_and_buffer_limits_are_hard_bounds() -> None:
    update_limited = FullOrderBookEngine(max_updates_per_delta=1)
    update_epoch = _started(update_limited)
    too_many = update_limited.apply_delta(
        IDENTITY,
        _delta(100, 101, 99, bids=((100, 1),), asks=((101, 1),)),
        epoch=update_epoch,
    )
    assert too_many.failure is FullOrderBookFailure.CAPACITY

    count_limited = FullOrderBookEngine(max_buffered_deltas_per_stream=1)
    count_epoch = _started(count_limited)
    count_limited.apply_delta(IDENTITY, _delta(100, 101, 99), epoch=count_epoch)
    count_overflow = count_limited.apply_delta(
        IDENTITY,
        _delta(102, 102, 101),
        epoch=count_epoch,
    )
    assert count_overflow.failure is FullOrderBookFailure.CAPACITY

    level_limited = FullOrderBookEngine(max_buffered_level_updates=1)
    level_epoch = _started(level_limited)
    level_overflow = level_limited.apply_delta(
        IDENTITY,
        _delta(100, 101, 99, bids=((100, 1),), asks=((101, 1),)),
        epoch=level_epoch,
    )
    assert level_overflow.failure is FullOrderBookFailure.CAPACITY


def test_inactive_stream_is_evicted_but_active_stream_never_is() -> None:
    engine = FullOrderBookEngine(max_streams=1)
    eth = ("binance", "futures", "ETHUSDT", 100)
    assert engine.activate_stream(IDENTITY) is True
    with pytest.raises(FullOrderBookStateError, match="active stream limit"):
        engine.activate_stream(eth)
    assert engine.deactivate_stream(IDENTITY) is True

    assert engine.activate_stream(eth) is True
    assert engine.epoch(IDENTITY) is None
    diagnostics = engine.diagnostics()
    assert diagnostics["streams"] == 1
    assert diagnostics["streams_evicted"] == 1


def test_engine_is_exchange_agnostic_and_identity_is_strict() -> None:
    identity = ("okx", "swap", "BTC-USDT-SWAP", 100)
    engine = FullOrderBookEngine()
    engine.activate_stream(identity)
    epoch = engine.begin_sync(identity)
    engine.apply_delta(
        identity,
        _delta(
            100,
            101,
            99,
            exchange="okx",
            market_type="swap",
            symbol="BTC-USDT-SWAP",
        ),
        epoch=epoch,
    )
    result = engine.install_snapshot(
        identity,
        _seed(
            exchange="okx",
            market_type="swap",
            symbol="BTC-USDT-SWAP",
        ),
        epoch=epoch,
    )
    assert result.state is FullOrderBookState.LIVE
    assert result.snapshot is not None
    assert result.snapshot.stream_identity == identity

    with pytest.raises(ValueError, match="identity conflicts"):
        engine.apply_delta(
            identity,
            _delta(102, 102, 101, exchange="binance"),
            epoch=epoch,
        )


def test_diagnostics_report_state_limits_failures_and_counters() -> None:
    engine = FullOrderBookEngine(
        max_streams=2,
        max_levels_per_side=10,
        max_buffered_deltas_per_stream=3,
        max_updates_per_delta=4,
        max_buffered_level_updates=5,
    )
    epoch = _started(engine)
    buffered = _delta(100, 101, 99, bids=((100, 1),))
    engine.apply_delta(IDENTITY, buffered, epoch=epoch)
    engine.apply_delta(IDENTITY, buffered, epoch=epoch)
    engine.install_snapshot(
        IDENTITY,
        _seed(snapshot_limit=10),
        epoch=epoch,
    )

    diagnostics = engine.diagnostics()

    assert diagnostics["mode"] == "full_depth_reconstructed"
    assert diagnostics["active_streams"] == 1
    assert diagnostics["limits"] == {
        "streams": 2,
        "levels_per_side": 10,
        "buffered_deltas_per_stream": 3,
        "updates_per_delta": 4,
        "buffered_level_updates_per_stream": 5,
    }
    assert diagnostics["deltas_received"] == 2
    assert diagnostics["deltas_buffered"] == 1
    assert diagnostics["deltas_duplicate"] == 1
    assert diagnostics["deltas_replayed"] == 1
    assert diagnostics["stream_states"][0]["state"] == "live"


def test_result_and_snapshot_payloads_are_immutable() -> None:
    engine = FullOrderBookEngine()
    epoch = _live(engine)
    result = engine.apply_delta(
        IDENTITY,
        _delta(102, 102, 101),
        epoch=epoch,
    )
    assert result.snapshot is not None

    with pytest.raises(dataclasses.FrozenInstanceError):
        result.accepted = False  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        result.snapshot.last_update_id = 1  # type: ignore[misc]
    assert result.to_dict()["snapshot"]["last_update_id"] == 102  # type: ignore[index]
