from __future__ import annotations

import pytest

from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType
from app.data_engine.market_data.trade_flow import (
    NormalizedAggTrade,
    TradeFlowEngine,
)


IDENTITY = ("binance", "futures", "BTCUSDT")


def _trade(
    trade_id: int,
    *,
    symbol: str = "BTCUSDT",
    price: float = 100.0,
    quantity: float = 1.0,
    trade_time_ms: int = 1_700_000_000_000,
    buyer_maker: bool = False,
) -> NormalizedAggTrade:
    return NormalizedAggTrade(
        exchange="BINANCE",
        market_type="FUTURES",
        symbol=symbol,
        agg_trade_id=trade_id,
        price=price,
        quantity=quantity,
        trade_time_ms=trade_time_ms,
        event_time_ms=trade_time_ms + 1,
        received_at_ms=trade_time_ms + 2,
        is_buyer_maker=buyer_maker,
        source=DataSource.WEBSOCKET,
        first_trade_id=trade_id * 10,
        last_trade_id=trade_id * 10 + 1,
    )


def test_normalizes_market_event_and_rejects_non_agg_trade() -> None:
    event = MarketEvent(
        event_type=StreamType.AGG_TRADE,
        symbol="btcusdt",
        exchange="BINANCE",
        market_type="FUTURES",
        event_time_ms=1001,
        received_at_ms=1002,
        source=DataSource.HTTP_BACKFILL,
        sequence=7,
        data={
            "agg_trade_id": 7,
            "price": 10,
            "quantity": 2,
            "trade_time_ms": 1000,
            "is_buyer_maker": True,
            "first_trade_id": 70,
            "last_trade_id": 71,
        },
    )

    trade = NormalizedAggTrade.from_market_event(event)

    assert trade.stream_identity == IDENTITY
    assert trade.quote_quantity == 20
    assert trade.aggressor_side == "sell"
    assert trade.source is DataSource.HTTP_BACKFILL
    assert trade.to_dict()["first_trade_id"] == 70

    event.event_type = StreamType.KLINE
    with pytest.raises(ValueError, match="only accepts aggTrade"):
        NormalizedAggTrade.from_market_event(event)


def test_aggregates_taker_buy_sell_delta_counts_and_max_notional() -> None:
    engine = TradeFlowEngine()
    first = engine.ingest(_trade(1, price=100, quantity=2, buyer_maker=False))
    second = engine.ingest(_trade(2, price=110, quantity=1, buyer_maker=True))

    assert first.accepted and second.accepted
    bucket = engine.bucket_snapshot(IDENTITY)[0]
    assert bucket.taker_buy_base == 2
    assert bucket.taker_sell_base == 1
    assert bucket.taker_buy_quote == 200
    assert bucket.taker_sell_quote == 110
    assert bucket.volume_delta_base == 1
    assert bucket.volume_delta_quote == 90
    assert bucket.buy_agg_trade_count == 1
    assert bucket.sell_agg_trade_count == 1
    assert bucket.agg_trade_count == 2
    assert bucket.buy_trade_count == 2
    assert bucket.sell_trade_count == 2
    assert bucket.trade_count == 4
    assert bucket.max_trade_notional == 200
    assert bucket.is_complete is False
    assert bucket.is_final is False
    assert bucket.revision == 2
    assert "cvd" not in bucket.to_dict()


def test_duplicate_and_live_out_of_order_are_rejected_without_mutation() -> None:
    engine = TradeFlowEngine()
    assert engine.ingest(_trade(10)).accepted
    assert engine.ingest(_trade(11)).accepted

    duplicate = engine.ingest(_trade(11, quantity=99))
    older = engine.ingest(_trade(9))

    assert duplicate.reason == "duplicate"
    assert older.reason == "out_of_order"
    bucket = engine.bucket_snapshot(IDENTITY)[0]
    assert bucket.agg_trade_count == 2
    assert bucket.taker_buy_base == 2
    diagnostics = engine.diagnostics()
    assert diagnostics["duplicates_rejected"] == 1
    assert diagnostics["out_of_order_rejected"] == 1


def test_gap_marks_bucket_incomplete_and_explicit_fill_restores_it() -> None:
    engine = TradeFlowEngine()
    base = 1_700_000_000_000
    engine.ingest(_trade(100, trade_time_ms=base))
    confirmed = engine.confirm_bootstrap_complete(IDENTITY)
    assert confirmed[0].is_complete is True
    complete_revision = confirmed[0].revision
    gap_result = engine.ingest(_trade(103, trade_time_ms=base + 2000))

    assert gap_result.detected_gap is not None
    assert gap_result.detected_gap.start_id == 101
    assert gap_result.detected_gap.end_id == 102
    assert gap_result.buckets[-1].is_complete is False
    assert gap_result.buckets[-1].revision > complete_revision
    assert engine.ingest(_trade(101, trade_time_ms=base + 500)).reason == "out_of_order"

    first_fill = engine.ingest_gap_fill(_trade(101, trade_time_ms=base + 500))
    assert first_fill.accepted
    assert first_fill.buckets[-1].is_complete is False
    assert first_fill.unresolved_gaps[0].start_id == 102

    final_fill = engine.ingest_gap_fill(_trade(102, trade_time_ms=base + 1000))
    assert final_fill.accepted
    assert final_fill.unresolved_gaps == ()
    assert final_fill.buckets[-1].is_complete is True
    assert final_fill.buckets[-1].agg_trade_count == 4
    assert final_fill.buckets[-1].trade_count == 8
    assert engine.diagnostics()["gaps_resolved"] == 1


def test_gap_across_minutes_marks_each_existing_bucket_and_refinalizes() -> None:
    engine = TradeFlowEngine()
    minute = 1_700_000_040_000
    first = engine.ingest(_trade(1, trade_time_ms=minute + 59_000))
    engine.confirm_bootstrap_complete(IDENTITY)
    second = engine.ingest(_trade(3, trade_time_ms=minute + 61_000))

    assert first.buckets[0].is_final is False
    assert len(second.buckets) == 2
    assert second.buckets[0].is_final is True
    assert all(not bucket.is_complete for bucket in second.buckets)

    filled = engine.ingest_gap_fill(_trade(2, trade_time_ms=minute + 60_000))
    assert filled.unresolved_gaps == ()
    snapshots = engine.bucket_snapshot(IDENTITY)
    assert len(snapshots) == 2
    assert snapshots[0].is_final is True
    assert snapshots[1].is_final is False
    assert all(bucket.is_complete for bucket in snapshots)

    # A gap-fill update cannot move a finalized bucket back to provisional.
    assert filled.buckets[0].is_final is True


def test_raw_ring_and_bucket_retention_are_bounded() -> None:
    engine = TradeFlowEngine(raw_ring_size=2, max_buckets_per_stream=2)
    base = 1_700_000_040_000
    for index in range(3):
        engine.ingest(_trade(index + 1, trade_time_ms=base + index * 60_000))

    assert [trade.agg_trade_id for trade in engine.raw_snapshot(IDENTITY)] == [2, 3]
    assert [bucket.first_agg_trade_id for bucket in engine.bucket_snapshot(IDENTITY)] == [2, 3]
    diagnostics = engine.diagnostics()
    assert diagnostics["raw_ring_evicted"] == 1
    assert diagnostics["buckets_evicted"] == 1
    assert diagnostics["tracked_recent_ids"] == 2


def test_raw_tail_selects_newest_ids_without_relying_on_ingest_order() -> None:
    engine = TradeFlowEngine(raw_ring_size=10)
    base = 1_700_000_000_000
    assert engine.ingest(_trade(1, trade_time_ms=base)).accepted
    assert engine.ingest(_trade(5, trade_time_ms=base + 4_000)).accepted
    for trade_id in (4, 2, 3):
        assert engine.ingest_gap_fill(
            _trade(trade_id, trade_time_ms=base + trade_id * 1_000),
        ).accepted

    assert [trade.agg_trade_id for trade in engine.raw_tail(IDENTITY, 2)] == [4, 5]
    assert engine.raw_tail(IDENTITY, 0) == ()

    single = TradeFlowEngine(raw_ring_size=1)
    assert single.ingest(_trade(1, trade_time_ms=base)).accepted
    assert single.ingest(_trade(3, trade_time_ms=base + 3_000)).accepted
    assert single.ingest_gap_fill(_trade(2, trade_time_ms=base + 2_000)).accepted
    assert [trade.agg_trade_id for trade in single.raw_snapshot(IDENTITY)] == [2]


def test_id_dedupe_memory_is_bounded_independently_of_bucket_retention() -> None:
    engine = TradeFlowEngine(
        raw_ring_size=2,
        max_buckets_per_stream=100,
        initial_bucket_complete=True,
    )
    base = 1_700_000_040_000

    for index in range(20):
        engine.ingest(
            _trade(index + 1, trade_time_ms=base + index * 60_000),
        )

    diagnostics = engine.diagnostics()
    assert diagnostics["buckets"] == 20
    assert diagnostics["tracked_recent_ids"] == 2
    assert diagnostics["raw_trades"] == 2


def test_high_water_duplicate_stays_rejected_after_gap_fills_rotate_ring() -> None:
    engine = TradeFlowEngine(raw_ring_size=2, initial_bucket_complete=True)
    base = 1_700_000_000_000
    engine.ingest(_trade(10, trade_time_ms=base))
    engine.ingest(_trade(15, trade_time_ms=base + 5_000))
    for trade_id in (11, 12, 13):
        assert engine.ingest_gap_fill(
            _trade(trade_id, trade_time_ms=base + trade_id * 100),
        ).accepted

    duplicate = engine.ingest(
        _trade(15, quantity=99, trade_time_ms=base + 5_000),
    )

    assert duplicate.reason == "duplicate"
    assert engine.bucket_snapshot(IDENTITY)[0].agg_trade_count == 5


def test_bootstrap_dedupes_even_when_prefix_exceeds_raw_ring() -> None:
    engine = TradeFlowEngine(raw_ring_size=2)
    base = 1_700_000_000_000
    engine.ingest(_trade(10, trade_time_ms=base + 10_000))
    for trade_id in (9, 8, 7):
        assert engine.ingest_bootstrap(
            _trade(trade_id, trade_time_ms=base + trade_id * 100),
        ).accepted

    duplicate = engine.ingest_bootstrap(
        _trade(9, quantity=99, trade_time_ms=base + 900),
    )

    assert duplicate.reason == "duplicate"
    assert engine.bucket_snapshot(IDENTITY)[0].agg_trade_count == 4
    assert engine.diagnostics()["bootstrap_seen_ids"] == 4


def test_gap_fill_outside_open_gap_is_rejected() -> None:
    engine = TradeFlowEngine()
    engine.ingest(_trade(10))
    engine.ingest(_trade(12, trade_time_ms=1_700_000_001_000))

    assert engine.ingest_gap_fill(_trade(8)).reason == "not_gap_fill"
    assert engine.ingest_gap_fill(_trade(13)).reason == "not_gap_fill"

    invalid_time = engine.ingest_gap_fill(
        _trade(11, trade_time_ms=1_700_000_002_000),
    )
    assert invalid_time.reason == "out_of_order"
    assert engine.gap_snapshot(IDENTITY)[0].start_id == 11


def test_explicit_bootstrap_can_prepend_initial_minute_before_confirmation() -> None:
    engine = TradeFlowEngine()
    base = 1_700_000_000_000
    live = engine.ingest(_trade(10, trade_time_ms=base + 20_000))
    assert live.buckets[0].is_complete is False

    prefix = engine.ingest_bootstrap(_trade(9, trade_time_ms=base + 10_000))
    assert prefix.accepted
    assert prefix.buckets[0].first_agg_trade_id == 9
    assert prefix.buckets[0].is_complete is False

    confirmed = engine.confirm_bootstrap_complete(IDENTITY)
    assert confirmed[0].is_complete is True
    assert confirmed[0].revision > prefix.buckets[0].revision
    assert engine.diagnostics()["bootstrap_trades_filled"] == 1


def test_many_same_minute_gaps_collapse_to_bounded_permanent_incomplete() -> None:
    engine = TradeFlowEngine(
        initial_bucket_complete=True,
        max_gaps_per_stream=3,
    )
    base = 1_700_000_040_000

    for trade_id in (1, 3, 5, 7, 9):
        engine.ingest(_trade(trade_id, trade_time_ms=base + trade_id))

    assert engine.gap_snapshot(IDENTITY) == ()
    assert engine.bucket_snapshot(IDENTITY)[0].is_complete is False
    diagnostics = engine.diagnostics()
    assert diagnostics["unresolved_gaps"] <= diagnostics["max_gaps_per_stream"]
    assert diagnostics["gap_overflow_events"] == 1
    assert diagnostics["precise_gaps_collapsed"] == 4
    assert diagnostics["permanently_incomplete_buckets"] == 1

    # Further gaps in the collapsed minute stay bounded and cannot be
    # presented as repaired by an opportunistic late fill.
    engine.ingest(_trade(11, trade_time_ms=base + 11))
    rejected = engine.ingest_gap_fill(_trade(2, trade_time_ms=base + 2))
    assert rejected.reason == "not_gap_fill"
    assert engine.gap_snapshot(IDENTITY) == ()
    assert engine.bucket_snapshot(IDENTITY)[0].is_complete is False
    assert engine.diagnostics()["gaps_suppressed_permanent"] == 1


def test_gap_is_pruned_only_after_all_affected_buckets_leave_retention() -> None:
    engine = TradeFlowEngine(
        initial_bucket_complete=True,
        max_buckets_per_stream=2,
    )
    base = 1_700_000_040_000
    engine.ingest(_trade(1, trade_time_ms=base + 59_000))
    engine.ingest(_trade(3, trade_time_ms=base + 61_000))
    engine.ingest(_trade(4, trade_time_ms=base + 121_000))

    assert len(engine.gap_snapshot(IDENTITY)) == 1
    retained = engine.bucket_snapshot(IDENTITY)
    assert [bucket.bucket_start_ms for bucket in retained] == [
        base + 60_000,
        base + 120_000,
    ]
    assert retained[0].is_complete is False

    engine.ingest(_trade(5, trade_time_ms=base + 181_000))

    assert engine.gap_snapshot(IDENTITY) == ()
    assert all(bucket.is_complete for bucket in engine.bucket_snapshot(IDENTITY))
    assert engine.diagnostics()["gaps_evicted_before_retention"] == 1


def test_gap_split_cannot_exceed_hard_gap_limit() -> None:
    engine = TradeFlowEngine(
        initial_bucket_complete=True,
        max_gaps_per_stream=1,
    )
    base = 1_700_000_040_000
    engine.ingest(_trade(1, trade_time_ms=base + 1))
    engine.ingest(_trade(5, trade_time_ms=base + 5))

    filled = engine.ingest_gap_fill(_trade(3, trade_time_ms=base + 3))

    assert filled.accepted is True
    assert filled.is_gap_fill is True
    assert len(engine.gap_snapshot(IDENTITY)) <= 1
    assert engine.gap_snapshot(IDENTITY) == ()
    assert engine.bucket_snapshot(IDENTITY)[0].is_complete is False
    assert engine.diagnostics()["gap_overflow_events"] == 1


def test_active_stream_state_is_never_silently_lru_evicted() -> None:
    engine = TradeFlowEngine(max_streams=2, initial_bucket_complete=True)
    eth = ("binance", "futures", "ETHUSDT")
    sol = ("binance", "futures", "SOLUSDT")
    engine.activate_stream(IDENTITY)
    engine.ingest(_trade(1))
    engine.ingest(_trade(1, symbol="ETHUSDT"))

    engine.activate_stream(sol)

    assert engine.bucket_snapshot(IDENTITY)
    assert engine.bucket_snapshot(eth) == ()
    assert engine.diagnostics()["active_streams"] == 2
    with pytest.raises(RuntimeError, match="all retained states are active"):
        engine.ingest(_trade(1, symbol="ETHUSDT"))
