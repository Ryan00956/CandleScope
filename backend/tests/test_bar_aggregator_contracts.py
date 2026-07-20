from __future__ import annotations

import asyncio
import time

from app.data_engine.bar_aggregator import (
    BarAggregator,
    BarAggregatorConfig,
    BarEventType,
    BarFinality,
    BarInput,
    BarInputSource,
    BarStateChange,
    BarStateEngine,
    BarStatus,
    EventRouter,
    MergeMode,
    TimeBucketEngine,
)
from app.data_engine.data_manager.models import (
    DataEvent,
    DataEventType,
    SeriesKey,
    SubscriptionHandle,
)
from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType


def _input(
    open_time_ms: int,
    *,
    source_interval: str,
    close: float,
    open_price: float | None = None,
    high: float | None = None,
    low: float | None = None,
    volume: float = 1,
    trades: int = 1,
    source: BarInputSource = BarInputSource.BACKFILL,
    is_closed: bool = True,
    merge_mode: MergeMode | None = None,
    sequence: int | None = None,
) -> BarInput:
    interval_ms = {
        "1m": 60_000,
        "15m": 900_000,
        "1h": 3_600_000,
    }.get(source_interval, 60_000)
    return BarInput(
        symbol="BTC-USDT",
        source_interval=source_interval,
        exchange="okx",
        market_type="spot",
        open_time_ms=open_time_ms,
        close_time_ms=open_time_ms + interval_ms - 1,
        open=close if open_price is None else open_price,
        high=close + 1 if high is None else high,
        low=close - 1 if low is None else low,
        close=close,
        volume=volume,
        quote_volume=volume * 10,
        trades=trades,
        taker_buy_base=volume / 2,
        taker_buy_quote=volume * 5,
        source=source,
        is_closed=is_closed,
        merge_mode=merge_mode,
        sequence=sequence,
    )


def _market_event(exchange: str, *, event_time_ms: int = 60_000) -> MarketEvent:
    prefix = f"{exchange}:spot:" if exchange != "binance" else ""
    return MarketEvent(
        event_type=StreamType.KLINE,
        symbol="BTC-USDT",
        exchange=exchange,
        event_time_ms=event_time_ms,
        received_at_ms=60_001,
        source=DataSource.WEBSOCKET,
        stream_key=f"{prefix}BTC-USDT@kline_1m",
        # Kline normalizers historically use the component identity here;
        # EventRouter must not mistake it for an update sequence.
        sequence=60_000,
        data={
            "interval": "1m",
            "open_time": 60_000,
            "close_time": 119_999,
            "open": 10,
            "high": 12,
            "low": 9,
            "close": 11,
            "volume": 5,
            "quote_volume": 55,
            "trades": 7,
            "taker_buy_base": 2,
            "taker_buy_quote": 22,
            "is_closed": False,
        },
    )


def test_component_snapshot_rejects_stale_update_for_same_input_key() -> None:
    engine = BarStateEngine(
        BarAggregatorConfig(),
        TimeBucketEngine(2_700_000),
        "45m",
    )
    newer = _input(
        0,
        source_interval="15m",
        close=110,
        open_price=100,
        high=112,
        low=99,
        volume=10,
        is_closed=True,
        merge_mode=MergeMode.COMPONENT,
        sequence=200,
    )
    state, change = engine.apply("okx", "spot", "BTC-USDT", 0, newer)
    assert change is BarStateChange.CREATED
    assert state.close == 110
    assert state.volume == 10
    assert state.last_close_received is True

    stale = _input(
        0,
        source_interval="15m",
        close=105,
        open_price=100,
        high=108,
        low=100,
        volume=5,
        is_closed=False,
        merge_mode=MergeMode.COMPONENT,
        sequence=100,
    )
    state, change = engine.apply("okx", "spot", "BTC-USDT", 0, stale)

    assert change is BarStateChange.NO_CHANGE
    assert state.close == 110
    assert state.volume == 10
    assert state.last_close_received is True
    assert state.source_snapshots[newer.input_key]["sequence"] == 200


def test_newer_closed_backfill_component_can_correct_cumulative_fields_downward() -> None:
    engine = BarStateEngine(
        BarAggregatorConfig(),
        TimeBucketEngine(2_700_000),
        "45m",
    )
    overstated = _input(
        0,
        source_interval="15m",
        close=115,
        open_price=100,
        high=120,
        low=95,
        volume=10,
        source=BarInputSource.REALTIME,
        is_closed=True,
        merge_mode=MergeMode.COMPONENT,
        sequence=100,
    )
    state, change = engine.apply("okx", "spot", "BTC-USDT", 0, overstated)
    assert change is BarStateChange.CREATED

    corrected = _input(
        0,
        source_interval="15m",
        close=103,
        open_price=101,
        high=105,
        low=99,
        volume=5,
        source=BarInputSource.BACKFILL,
        is_closed=True,
        merge_mode=MergeMode.COMPONENT,
        sequence=200,
    )
    state, change = engine.apply("okx", "spot", "BTC-USDT", 0, corrected)

    assert change is BarStateChange.UPDATED
    assert state.open == 101
    assert state.high == 105
    assert state.low == 99
    assert state.close == 103
    assert state.volume == 5
    assert state.source_snapshots[corrected.input_key]["sequence"] == 200

    older_backfill = _input(
        0,
        source_interval="15m",
        close=101,
        open_price=100,
        high=102,
        low=100,
        volume=2,
        source=BarInputSource.BACKFILL,
        is_closed=True,
        merge_mode=MergeMode.COMPONENT,
        sequence=150,
    )
    state, change = engine.apply("okx", "spot", "BTC-USDT", 0, older_backfill)
    assert change is BarStateChange.NO_CHANGE
    assert state.close == 103
    assert state.volume == 5
    assert state.source_snapshots[corrected.input_key]["sequence"] == 200


def test_realtime_component_cannot_correct_cumulative_fields_downward() -> None:
    engine = BarStateEngine(
        BarAggregatorConfig(),
        TimeBucketEngine(2_700_000),
        "45m",
    )
    existing = _input(
        0,
        source_interval="15m",
        close=115,
        high=120,
        low=95,
        volume=10,
        source=BarInputSource.REALTIME,
        is_closed=True,
        merge_mode=MergeMode.COMPONENT,
        sequence=100,
    )
    engine.apply("okx", "spot", "BTC-USDT", 0, existing)
    downward = _input(
        0,
        source_interval="15m",
        close=103,
        high=105,
        low=99,
        volume=5,
        source=BarInputSource.REALTIME,
        is_closed=True,
        merge_mode=MergeMode.COMPONENT,
        sequence=200,
    )

    state, change = engine.apply("okx", "spot", "BTC-USDT", 0, downward)

    assert change is BarStateChange.NO_CHANGE
    assert state.high == 120
    assert state.low == 95
    assert state.close == 115
    assert state.volume == 10
    assert state.source_snapshots[existing.input_key]["sequence"] == 100


def test_component_snapshot_without_sequence_requires_monotonic_progress() -> None:
    engine = BarStateEngine(
        BarAggregatorConfig(),
        TimeBucketEngine(2_700_000),
        "45m",
    )
    first = _input(
        0,
        source_interval="15m",
        close=10,
        volume=1,
        is_closed=False,
        merge_mode=MergeMode.COMPONENT,
    )
    engine.apply("okx", "spot", "BTC-USDT", 0, first)

    progressed = _input(
        0,
        source_interval="15m",
        close=11,
        open_price=10,
        high=12,
        low=9,
        volume=2,
        is_closed=False,
        merge_mode=MergeMode.COMPONENT,
    )
    state, change = engine.apply("okx", "spot", "BTC-USDT", 0, progressed)
    assert change is BarStateChange.UPDATED
    assert state.close == 11
    assert state.volume == 2

    ambiguous = _input(
        0,
        source_interval="15m",
        close=9,
        open_price=10,
        high=12,
        low=9,
        volume=2,
        is_closed=False,
        merge_mode=MergeMode.COMPONENT,
    )
    state, change = engine.apply("okx", "spot", "BTC-USDT", 0, ambiguous)
    assert change is BarStateChange.NO_CHANGE
    assert state.close == 11
    assert state.volume == 2


def test_event_router_uses_exchange_event_time_for_kline_freshness() -> None:
    async def _run() -> None:
        router = EventRouter(BarAggregatorConfig())
        routed: list[BarInput] = []

        async def _capture(exchange, market_type, symbol, interval, bar_input):
            routed.append(bar_input)

        router.set_on_bar_input(_capture)
        router.register_target("BTC-USDT", "1m", exchange="binance", market_type="spot")
        await router.on_market_event(_market_event("binance", event_time_ms=60_500))

        assert len(routed) == 1
        assert routed[0].sequence == 60_500

    asyncio.run(_run())


def _record_events(agg: BarAggregator, events: list) -> None:
    async def _capture(event) -> None:
        events.append(event)

    agg.publisher.on_bar_event(_capture)


def test_series_key_topic_and_subscription_matching_include_market_identity() -> None:
    key = SeriesKey(" btc-usdt ", " 1m ", exchange=" OKX ", market_type=" Futures ")
    same = SeriesKey("BTC-USDT", "1m", exchange="okx", market_type="futures")
    spot = SeriesKey("BTC-USDT", "1m", exchange="okx", market_type="spot")
    default = SeriesKey("ethusdt", "price")

    assert key == same
    assert key != spot
    assert key.symbol == "BTC-USDT"
    assert key.interval == "1m"
    assert key.exchange == "okx"
    assert key.market_type == "futures"
    assert key.topic == "okx:futures:BTC-USDT@1m"
    assert str(key) == key.topic
    assert default.topic == "ETHUSDT@price"

    handle = SubscriptionHandle(
        key=key,
        event_types={DataEventType.BAR_UPDATED},
    )
    assert handle.matches(DataEvent(DataEventType.BAR_UPDATED, same))
    assert not handle.matches(DataEvent(DataEventType.BAR_UPDATED, spot))
    assert not handle.matches(DataEvent(DataEventType.BAR_CLOSED, same))


def test_bar_aggregator_replay_components_rebuilds_custom_bucket_without_events() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(update_throttle_ms=0))
        agg.add_target("BTC-USDT", "45m", exchange="okx", market_type="spot")
        events = []
        bucket_start_ms = agg.compute_bucket("45m", int(time.time() * 1000))
        assert bucket_start_ms is not None

        async def _capture(event):
            events.append(event)

        agg.publisher.on_bar_event(_capture)
        stale = await agg.replay_components(
            "BTC-USDT",
            "45m",
            [
                _input(
                    bucket_start_ms,
                    source_interval="15m",
                    close=99,
                    volume=99,
                    is_closed=False,
                ),
            ],
            exchange="okx",
            market_type="spot",
            bucket_start_ms=bucket_start_ms,
            emit_events=False,
        )
        assert stale is not None
        assert stale.close == 99

        rebuilt = await agg.replay_components(
            "BTC-USDT",
            "45m",
            [
                _input(
                    bucket_start_ms,
                    source_interval="15m",
                    close=10,
                    volume=1,
                    is_closed=False,
                ),
                _input(
                    bucket_start_ms + 900_000,
                    source_interval="15m",
                    close=20,
                    volume=2,
                    is_closed=False,
                ),
                _input(
                    bucket_start_ms + 1_800_000,
                    source_interval="15m",
                    close=15,
                    volume=3,
                    is_closed=False,
                ),
            ],
            exchange="okx",
            market_type="spot",
            bucket_start_ms=bucket_start_ms,
            expire_existing=True,
            emit_events=False,
        )

        assert rebuilt is not None
        assert rebuilt.exchange == "okx"
        assert rebuilt.market_type == "spot"
        assert rebuilt.open == 10
        assert rebuilt.high == 21
        assert rebuilt.low == 9
        assert rebuilt.close == 15
        assert rebuilt.volume == 6
        assert rebuilt.trades == 3
        assert rebuilt.tick_count == 3
        assert len(rebuilt.source_snapshots) == 3
        assert events == []

    asyncio.run(_run())


def test_event_router_fans_out_okx_realtime_1m_to_larger_standard_intervals() -> None:
    async def _run() -> None:
        router = EventRouter(BarAggregatorConfig())
        routed: list[tuple[str, str, str, str, MergeMode | None]] = []

        async def _capture(exchange, market_type, symbol, interval, bar_input):
            routed.append((exchange, market_type, symbol, interval, bar_input.merge_mode))

        router.set_on_bar_input(_capture)
        router.register_target("BTC-USDT", "1m", exchange="okx", market_type="spot")
        router.register_target("BTC-USDT", "1h", exchange="okx", market_type="spot")
        router.register_target("BTC-USDT", "1m", exchange="binance", market_type="spot")
        router.register_target("BTC-USDT", "1h", exchange="binance", market_type="spot")

        await router.on_market_event(_market_event("okx"))
        assert set(routed) == {
            ("okx", "spot", "BTC-USDT", "1m", MergeMode.SNAPSHOT),
            ("okx", "spot", "BTC-USDT", "1h", MergeMode.PRICE_ONLY),
        }

        routed.clear()
        await router.on_market_event(_market_event("binance"))
        assert routed == [("binance", "spot", "BTC-USDT", "1m", MergeMode.SNAPSHOT)]

    asyncio.run(_run())


def test_okx_standard_fanout_updates_price_without_polluting_native_volume() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(update_throttle_ms=0))
        agg.add_target("BTC-USDT", "1h", exchange="okx", market_type="spot")
        bucket_start_ms = agg.compute_bucket("1h", int(time.time() * 1000))
        assert bucket_start_ms is not None

        await agg.ingest_bar_input(
            "okx",
            "spot",
            "BTC-USDT",
            "1h",
            _input(
                bucket_start_ms,
                source_interval="1m",
                close=10,
                volume=50,
                trades=5,
                source=BarInputSource.REALTIME,
                is_closed=True,
                merge_mode=MergeMode.PRICE_ONLY,
            ),
            emit_events=False,
        )
        state = agg.get_bucket_state(
            "BTC-USDT",
            "1h",
            bucket_start_ms,
            exchange="okx",
            market_type="spot",
        )
        assert state is not None
        assert state.close == 10
        assert state.volume == 0
        assert state.quote_volume == 0
        assert state.trades == 0

        await agg.ingest_bar_input(
            "okx",
            "spot",
            "BTC-USDT",
            "1h",
            _input(
                bucket_start_ms + 60_000,
                source_interval="1m",
                close=12,
                volume=99,
                trades=9,
                source=BarInputSource.REALTIME,
                is_closed=True,
                merge_mode=MergeMode.PRICE_ONLY,
            ),
            emit_events=False,
        )
        state = agg.get_bucket_state(
            "BTC-USDT",
            "1h",
            bucket_start_ms,
            exchange="okx",
            market_type="spot",
        )
        assert state is not None
        assert state.high == 13
        assert state.close == 12
        assert state.volume == 0
        assert state.trades == 0

        await agg.ingest_bar_input(
            "okx",
            "spot",
            "BTC-USDT",
            "1h",
            _input(
                bucket_start_ms + 120_000,
                source_interval="1h",
                close=11,
                volume=123,
                trades=45,
                source=BarInputSource.REALTIME,
                is_closed=False,
                merge_mode=MergeMode.SNAPSHOT,
            ),
            emit_events=False,
        )
        state = agg.get_bucket_state(
            "BTC-USDT",
            "1h",
            bucket_start_ms,
            exchange="okx",
            market_type="spot",
        )
        assert state is not None
        assert state.close == 11
        assert state.volume == 123
        assert state.quote_volume == 1230
        assert state.trades == 45

    asyncio.run(_run())


def test_standard_merge_respects_explicit_price_only_mode() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(update_throttle_ms=0))
        agg.add_target("BTC-USDT", "1h", exchange="okx", market_type="spot")
        bucket_start_ms = agg.compute_bucket("1h", int(time.time() * 1000))
        assert bucket_start_ms is not None

        await agg.ingest_bar_input(
            "okx",
            "spot",
            "BTC-USDT",
            "1h",
            _input(
                bucket_start_ms,
                source_interval="1h",
                close=10,
                volume=50,
                trades=5,
                source=BarInputSource.REALTIME,
                is_closed=False,
                merge_mode=MergeMode.PRICE_ONLY,
            ),
            emit_events=False,
        )

        state = agg.get_bucket_state(
            "BTC-USDT",
            "1h",
            bucket_start_ms,
            exchange="okx",
            market_type="spot",
        )
        assert state is not None
        assert state.close == 10
        assert state.volume == 0
        assert state.quote_volume == 0
        assert state.trades == 0

        await agg.ingest_bar_input(
            "okx",
            "spot",
            "BTC-USDT",
            "1h",
            _input(
                bucket_start_ms + 60_000,
                source_interval="1m",
                close=11,
                volume=70,
                trades=7,
                source=BarInputSource.REALTIME,
                is_closed=False,
                merge_mode=MergeMode.SNAPSHOT,
            ),
            emit_events=False,
        )

        state = agg.get_bucket_state(
            "BTC-USDT",
            "1h",
            bucket_start_ms,
            exchange="okx",
            market_type="spot",
        )
        assert state is not None
        assert state.close == 11
        assert state.volume == 70
        assert state.quote_volume == 700
        assert state.trades == 7

    asyncio.run(_run())


def test_unconfirmed_native_bar_expires_on_timeout_without_closed_event() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(
            finalize_timeout_ms=0,
            update_throttle_ms=0,
            emit_expired_events=True,
        ))
        agg.add_target("BTC-USDT", "1h", exchange="okx", market_type="spot")
        events = []
        _record_events(agg, events)

        await agg.ingest_bar_input(
            "okx",
            "spot",
            "BTC-USDT",
            "1h",
            _input(
                0,
                source_interval="1h",
                close=10,
                source=BarInputSource.REALTIME,
                is_closed=False,
                merge_mode=MergeMode.SNAPSHOT,
            ),
        )
        state = agg.get_bucket_state(
            "BTC-USDT", "1h", 0, exchange="okx", market_type="spot",
        )
        assert state is not None
        assert state.requires_authoritative_close is True

        await agg._check_timeouts()

        assert agg.get_bucket_state(
            "BTC-USDT", "1h", 0, exchange="okx", market_type="spot",
        ) is None
        assert state.status == BarStatus.EXPIRED
        assert state.finality == BarFinality.PROVISIONAL
        assert state.close_reason == "timeout_unconfirmed"
        assert BarEventType.CLOSED not in [event.event_type for event in events]
        assert BarEventType.EXPIRED in [event.event_type for event in events]

    asyncio.run(_run())


def test_next_bucket_expires_unconfirmed_native_bar_without_closed_event() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(
            finalize_timeout_ms=10**12,
            update_throttle_ms=0,
            emit_expired_events=True,
        ))
        agg.add_target("BTC-USDT", "1h", exchange="okx", market_type="spot")
        events = []
        _record_events(agg, events)
        bucket_start_ms = agg.compute_bucket("1h", int(time.time() * 1000))
        assert bucket_start_ms is not None

        for open_time_ms, close in (
            (bucket_start_ms, 10),
            (bucket_start_ms + 3_600_000, 11),
        ):
            await agg.ingest_bar_input(
                "okx",
                "spot",
                "BTC-USDT",
                "1h",
                _input(
                    open_time_ms,
                    source_interval="1h",
                    close=close,
                    source=BarInputSource.REALTIME,
                    is_closed=False,
                    merge_mode=MergeMode.SNAPSHOT,
                ),
            )

        assert agg.get_bucket_state(
            "BTC-USDT", "1h", bucket_start_ms, exchange="okx", market_type="spot",
        ) is None
        assert agg.get_bucket_state(
            "BTC-USDT",
            "1h",
            bucket_start_ms + 3_600_000,
            exchange="okx",
            market_type="spot",
        ) is not None
        assert BarEventType.CLOSED not in [event.event_type for event in events]
        assert BarEventType.EXPIRED in [event.event_type for event in events]

    asyncio.run(_run())


def test_shutdown_expires_unconfirmed_native_bar_without_closed_event() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(
            update_throttle_ms=0,
            emit_expired_events=True,
        ))
        agg.add_target("BTC-USDT", "1h", exchange="okx", market_type="spot")
        events = []
        _record_events(agg, events)

        await agg.ingest_bar_input(
            "okx",
            "spot",
            "BTC-USDT",
            "1h",
            _input(
                0,
                source_interval="1h",
                close=10,
                source=BarInputSource.REALTIME,
                is_closed=False,
                merge_mode=MergeMode.SNAPSHOT,
            ),
        )
        state = agg.get_bucket_state(
            "BTC-USDT", "1h", 0, exchange="okx", market_type="spot",
        )
        assert state is not None

        await agg.stop()

        assert state.status == BarStatus.EXPIRED
        assert BarEventType.CLOSED not in [event.event_type for event in events]
        assert BarEventType.EXPIRED in [event.event_type for event in events]

    asyncio.run(_run())


def test_authoritative_native_close_still_emits_closed() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(update_throttle_ms=0))
        agg.add_target("BTC-USDT", "1h", exchange="okx", market_type="spot")
        events = []
        _record_events(agg, events)

        await agg.ingest_bar_input(
            "okx",
            "spot",
            "BTC-USDT",
            "1h",
            _input(
                0,
                source_interval="1h",
                close=10,
                source=BarInputSource.REALTIME,
                is_closed=True,
                merge_mode=MergeMode.SNAPSHOT,
            ),
        )

        assert agg.get_bucket_state(
            "BTC-USDT", "1h", 0, exchange="okx", market_type="spot",
        ) is None
        recent = agg.get_recent_bars(
            "BTC-USDT", "1h", exchange="okx", market_type="spot",
        )
        assert len(recent) == 1
        assert recent[0].last_close_received is True
        assert recent[0].finality == BarFinality.AUTHORITATIVE
        assert recent[0].close_reason == "source_close"
        assert [event.event_type for event in events].count(BarEventType.CLOSED) == 1

    asyncio.run(_run())


def test_legacy_source_close_flag_cannot_disable_native_finality_boundary() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(
            use_source_close_signal=False,
            finalize_timeout_ms=0,
            update_throttle_ms=0,
            emit_expired_events=True,
        ))
        agg.add_target("BTC-USDT", "1h", exchange="okx", market_type="spot")
        events = []
        _record_events(agg, events)

        await agg.ingest_bar_input(
            "okx",
            "spot",
            "BTC-USDT",
            "1h",
            _input(
                0,
                source_interval="1h",
                close=10,
                source=BarInputSource.REALTIME,
                is_closed=False,
                merge_mode=MergeMode.SNAPSHOT,
            ),
        )
        state = agg.get_bucket_state(
            "BTC-USDT", "1h", 0, exchange="okx", market_type="spot",
        )
        assert state is not None
        assert state.requires_authoritative_close is True

        await agg._check_timeouts()

        assert state.status == BarStatus.EXPIRED
        assert BarEventType.CLOSED not in [event.event_type for event in events]

        await agg.ingest_bar_input(
            "okx",
            "spot",
            "BTC-USDT",
            "1h",
            _input(
                3_600_000,
                source_interval="1h",
                close=11,
                source=BarInputSource.REALTIME,
                is_closed=True,
                merge_mode=MergeMode.SNAPSHOT,
            ),
        )
        recent = agg.get_recent_bars(
            "BTC-USDT", "1h", exchange="okx", market_type="spot",
        )
        assert len(recent) == 1
        assert recent[0].finality == BarFinality.AUTHORITATIVE
        assert recent[0].close_reason == "source_close"

    asyncio.run(_run())


def test_incremental_standard_bar_keeps_event_driven_close_compatibility() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(
            finalize_timeout_ms=10**12,
            update_throttle_ms=0,
        ))
        agg.add_target("BTC-USDT", "1h", exchange="okx", market_type="spot")
        events = []
        _record_events(agg, events)
        bucket_start_ms = agg.compute_bucket("1h", int(time.time() * 1000))
        assert bucket_start_ms is not None

        for open_time_ms, close in (
            (bucket_start_ms, 10),
            (bucket_start_ms + 3_600_000, 11),
        ):
            await agg.ingest_bar_input(
                "okx",
                "spot",
                "BTC-USDT",
                "1h",
                _input(
                    open_time_ms,
                    source_interval="tick",
                    close=close,
                    source=BarInputSource.REALTIME,
                    is_closed=False,
                    merge_mode=MergeMode.INCREMENTAL,
                ),
            )

        recent = agg.get_recent_bars(
            "BTC-USDT", "1h", exchange="okx", market_type="spot",
        )
        assert len(recent) == 1
        assert recent[0].bucket_start_ms == bucket_start_ms
        assert recent[0].requires_authoritative_close is False
        assert recent[0].finality == BarFinality.PROVISIONAL
        assert recent[0].close_reason == "event_driven"
        assert [event.event_type for event in events].count(BarEventType.CLOSED) == 1

    asyncio.run(_run())


def test_complete_custom_components_still_emit_closed() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(
            finalize_timeout_ms=10**12,
            update_throttle_ms=0,
        ))
        agg.add_target("BTC-USDT", "45m", exchange="okx", market_type="spot")
        events = []
        _record_events(agg, events)
        bucket_start_ms = agg.compute_bucket("45m", int(time.time() * 1000))
        assert bucket_start_ms is not None

        for offset, close in ((0, 10), (900_000, 11), (1_800_000, 12)):
            await agg.ingest_bar_input(
                "okx",
                "spot",
                "BTC-USDT",
                "45m",
                _input(
                    bucket_start_ms + offset,
                    source_interval="15m",
                    close=close,
                    source=BarInputSource.REALTIME,
                    is_closed=True,
                    merge_mode=MergeMode.COMPONENT,
                ),
            )

        recent = agg.get_recent_bars(
            "BTC-USDT", "45m", exchange="okx", market_type="spot",
        )
        assert len(recent) == 1
        assert recent[0].close == 12
        assert recent[0].tick_count == 3
        assert recent[0].finality == BarFinality.AUTHORITATIVE
        assert recent[0].close_reason == "composite_close"
        assert [event.event_type for event in events].count(BarEventType.CLOSED) == 1

    asyncio.run(_run())


def test_component_mode_on_standard_spelling_closes_after_out_of_order_full_coverage() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(
            finalize_timeout_ms=10**12,
            update_throttle_ms=0,
        ))
        # Some exchanges resolve a globally standard interval through a
        # smaller native base. The input mode, not the target spelling, must
        # select component aggregation and finalization semantics.
        agg.add_target("BTC-USDT", "1h", exchange="okx", market_type="spot")
        events = []
        _record_events(agg, events)
        bucket_start_ms = agg.compute_bucket("1h", int(time.time() * 1000))
        assert bucket_start_ms is not None

        for offset, close, volume in (
            (2_700_000, 13, 4),  # last component arrives first
            (0, 10, 1),
            (900_000, 11, 2),
            (1_800_000, 12, 3),
        ):
            await agg.ingest_bar_input(
                "okx",
                "spot",
                "BTC-USDT",
                "1h",
                _input(
                    bucket_start_ms + offset,
                    source_interval="15m",
                    close=close,
                    volume=volume,
                    source=BarInputSource.REALTIME,
                    is_closed=True,
                    merge_mode=MergeMode.COMPONENT,
                ),
            )

        recent = agg.get_recent_bars(
            "BTC-USDT", "1h", exchange="okx", market_type="spot",
        )
        assert len(recent) == 1
        assert recent[0].close == 13
        assert recent[0].volume == 10
        assert recent[0].tick_count == 4
        assert recent[0].requires_authoritative_close is False
        assert recent[0].finality == BarFinality.AUTHORITATIVE
        assert recent[0].close_reason == "composite_close"
        assert [event.event_type for event in events].count(BarEventType.CLOSED) == 1

    asyncio.run(_run())


def test_native_backfill_snapshot_closes_through_batch_only() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(update_throttle_ms=0))
        agg.add_target("BTC-USDT", "1h", exchange="okx", market_type="spot")

        await agg.ingest_bar_input(
            "okx",
            "spot",
            "BTC-USDT",
            "1h",
            _input(
                0,
                source_interval="1h",
                close=10,
                source=BarInputSource.BACKFILL,
                is_closed=True,
                merge_mode=MergeMode.SNAPSHOT,
            ),
        )

        recent = agg.get_recent_bars(
            "BTC-USDT", "1h", exchange="okx", market_type="spot",
        )
        assert len(recent) == 1
        assert recent[0].finality == BarFinality.AUTHORITATIVE
        assert recent[0].close_reason == "batch"

    asyncio.run(_run())


def test_last_custom_component_alone_cannot_claim_authoritative_close() -> None:
    async def _exercise(source: BarInputSource) -> None:
        agg = BarAggregator(BarAggregatorConfig(
            finalize_timeout_ms=10**12,
            update_throttle_ms=0,
        ))
        agg.add_target("BTC-USDT", "45m", exchange="okx", market_type="spot")
        events = []
        _record_events(agg, events)
        bucket_start_ms = agg.compute_bucket("45m", int(time.time() * 1000))
        assert bucket_start_ms is not None

        await agg.ingest_bar_input(
            "okx",
            "spot",
            "BTC-USDT",
            "45m",
            _input(
                bucket_start_ms + 1_800_000,
                source_interval="15m",
                close=12,
                source=source,
                is_closed=True,
                merge_mode=MergeMode.COMPONENT,
            ),
        )

        state = agg.get_bucket_state(
            "BTC-USDT",
            "45m",
            bucket_start_ms,
            exchange="okx",
            market_type="spot",
        )
        assert state is not None
        assert state.status == BarStatus.FORMING
        assert state.finality == BarFinality.PROVISIONAL
        assert [event.event_type for event in events].count(BarEventType.CLOSED) == 0

    async def _run() -> None:
        await _exercise(BarInputSource.REALTIME)
        await _exercise(BarInputSource.BACKFILL)

    asyncio.run(_run())


def test_incomplete_custom_next_bucket_fallback_stays_provisional() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(
            finalize_timeout_ms=10**12,
            update_throttle_ms=0,
        ))
        agg.add_target("BTC-USDT", "45m", exchange="okx", market_type="spot")
        bucket_start_ms = agg.compute_bucket("45m", int(time.time() * 1000))
        assert bucket_start_ms is not None

        for open_time_ms, close in (
            (bucket_start_ms, 10),
            (bucket_start_ms + 2_700_000, 11),
        ):
            await agg.ingest_bar_input(
                "okx",
                "spot",
                "BTC-USDT",
                "45m",
                _input(
                    open_time_ms,
                    source_interval="15m",
                    close=close,
                    source=BarInputSource.REALTIME,
                    is_closed=True,
                    merge_mode=MergeMode.COMPONENT,
                ),
            )

        recent = agg.get_recent_bars(
            "BTC-USDT", "45m", exchange="okx", market_type="spot",
        )
        assert len(recent) == 1
        assert recent[0].bucket_start_ms == bucket_start_ms
        assert recent[0].finality == BarFinality.PROVISIONAL
        assert recent[0].close_reason == "event_driven"

    asyncio.run(_run())


def test_late_backfill_complete_component_coverage_promotes_provisional_close() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(
            finalize_timeout_ms=10**12,
            update_throttle_ms=0,
        ))
        agg.add_target("BTC-USDT", "45m", exchange="okx", market_type="spot")
        events = []
        _record_events(agg, events)
        bucket_start_ms = agg.compute_bucket("45m", int(time.time() * 1000))
        assert bucket_start_ms is not None

        # Close the incomplete bucket provisionally by advancing the timeline.
        for open_time_ms, close in (
            (bucket_start_ms, 10),
            (bucket_start_ms + 2_700_000, 13),
        ):
            await agg.ingest_bar_input(
                "okx",
                "spot",
                "BTC-USDT",
                "45m",
                _input(
                    open_time_ms,
                    source_interval="15m",
                    close=close,
                    source=BarInputSource.REALTIME,
                    is_closed=True,
                    merge_mode=MergeMode.COMPONENT,
                ),
            )

        old = agg.get_recent_bars(
            "BTC-USDT", "45m", exchange="okx", market_type="spot",
        )[0]
        assert old.bucket_start_ms == bucket_start_ms
        assert old.finality == BarFinality.PROVISIONAL

        # Late repair fills the two missing components. Only the amendment
        # that completes full closed coverage may become authoritative.
        for offset, close in ((900_000, 11), (1_800_000, 12)):
            await agg.ingest_bar_input(
                "okx",
                "spot",
                "BTC-USDT",
                "45m",
                _input(
                    bucket_start_ms + offset,
                    source_interval="15m",
                    close=close,
                    source=BarInputSource.BACKFILL,
                    is_closed=True,
                    merge_mode=MergeMode.COMPONENT,
                ),
            )
            if offset == 900_000:
                still_incomplete = agg.get_recent_bars(
                    "BTC-USDT", "45m", exchange="okx", market_type="spot",
                )[0]
                assert still_incomplete.finality == BarFinality.PROVISIONAL

        repaired = agg.get_recent_bars(
            "BTC-USDT", "45m", exchange="okx", market_type="spot",
        )[0]
        assert repaired.bucket_start_ms == bucket_start_ms
        assert repaired.close == 12
        assert repaired.tick_count == 3
        assert repaired.finality == BarFinality.AUTHORITATIVE
        assert repaired.close_reason == "backfill_amendment"
        amended = [event for event in events if event.event_type == BarEventType.AMENDED]
        assert len(amended) == 2
        assert amended[-1].bar.finality == BarFinality.AUTHORITATIVE

    asyncio.run(_run())


def test_late_newer_backfill_corrects_authoritative_closed_component_bar() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(update_throttle_ms=0))
        agg.add_target("BTC-USDT", "45m", exchange="okx", market_type="spot")
        events = []
        _record_events(agg, events)
        bucket_start_ms = agg.compute_bucket("45m", int(time.time() * 1000))
        assert bucket_start_ms is not None

        components = (
            _input(
                bucket_start_ms,
                source_interval="15m",
                close=110,
                open_price=100,
                high=120,
                low=99,
                volume=10,
                source=BarInputSource.REALTIME,
                is_closed=True,
                merge_mode=MergeMode.COMPONENT,
                sequence=100,
            ),
            _input(
                bucket_start_ms + 900_000,
                source_interval="15m",
                close=104,
                high=106,
                low=103,
                volume=2,
                source=BarInputSource.REALTIME,
                is_closed=True,
                merge_mode=MergeMode.COMPONENT,
                sequence=101,
            ),
            _input(
                bucket_start_ms + 1_800_000,
                source_interval="15m",
                close=105,
                high=107,
                low=104,
                volume=3,
                source=BarInputSource.REALTIME,
                is_closed=True,
                merge_mode=MergeMode.COMPONENT,
                sequence=102,
            ),
        )
        for component in components:
            await agg.ingest_bar_input(
                "okx", "spot", "BTC-USDT", "45m", component,
            )

        before = agg.get_recent_bars(
            "BTC-USDT", "45m", exchange="okx", market_type="spot",
        )[0]
        assert before.finality == BarFinality.AUTHORITATIVE
        assert before.high == 120
        assert before.volume == 15

        await agg.ingest_bar_input(
            "okx",
            "spot",
            "BTC-USDT",
            "45m",
            _input(
                bucket_start_ms,
                source_interval="15m",
                close=103,
                open_price=100,
                high=105,
                low=99,
                volume=5,
                source=BarInputSource.BACKFILL,
                is_closed=True,
                merge_mode=MergeMode.COMPONENT,
                sequence=200,
            ),
        )

        corrected = agg.get_recent_bars(
            "BTC-USDT", "45m", exchange="okx", market_type="spot",
        )[0]
        assert corrected.finality == BarFinality.AUTHORITATIVE
        assert corrected.close_reason == "backfill_amendment"
        assert corrected.high == 107
        assert corrected.close == 105
        assert corrected.volume == 10
        assert [event.event_type for event in events].count(BarEventType.AMENDED) == 1

    asyncio.run(_run())


def test_active_capacity_expires_unconfirmed_native_bar_without_closed_event() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(
            max_active_bars=1,
            finalize_timeout_ms=10**12,
            use_event_driven_close=False,
            update_throttle_ms=0,
            emit_expired_events=True,
        ))
        agg.add_target("BTC-USDT", "1h", exchange="okx", market_type="spot")
        events = []
        _record_events(agg, events)

        first = None
        for open_time_ms, close in ((0, 10), (3_600_000, 11)):
            await agg.ingest_bar_input(
                "okx",
                "spot",
                "BTC-USDT",
                "1h",
                _input(
                    open_time_ms,
                    source_interval="1h",
                    close=close,
                    source=BarInputSource.REALTIME,
                    is_closed=False,
                    merge_mode=MergeMode.SNAPSHOT,
                ),
            )
            if open_time_ms == 0:
                first = agg.get_bucket_state(
                    "BTC-USDT", "1h", 0, exchange="okx", market_type="spot",
                )

        assert first is not None
        assert first.status == BarStatus.EXPIRED
        assert agg.get_recent_bars(
            "BTC-USDT", "1h", exchange="okx", market_type="spot",
        ) == []
        assert BarEventType.CLOSED not in [event.event_type for event in events]
        assert BarEventType.EXPIRED in [event.event_type for event in events]

    asyncio.run(_run())


def test_remove_target_discards_only_the_exact_forming_state() -> None:
    async def _run() -> None:
        agg = BarAggregator(BarAggregatorConfig(
            finalize_timeout_ms=10**12,
            update_throttle_ms=0,
        ))
        agg.add_target("BTC-USDT", "1h", exchange="okx", market_type="spot")
        agg.add_target("BTC-USDT", "15m", exchange="okx", market_type="spot")
        events = []
        _record_events(agg, events)

        await agg.ingest_bar_input(
            "okx", "spot", "BTC-USDT", "1h",
            _input(
                0,
                source_interval="1h",
                close=10,
                source=BarInputSource.REALTIME,
                is_closed=False,
                merge_mode=MergeMode.SNAPSHOT,
            ),
        )
        await agg.ingest_bar_input(
            "okx", "spot", "BTC-USDT", "15m",
            _input(
                0,
                source_interval="15m",
                close=11,
                source=BarInputSource.REALTIME,
                is_closed=False,
                merge_mode=MergeMode.SNAPSHOT,
            ),
        )

        agg.remove_target(
            "BTC-USDT", "1h", exchange="okx", market_type="spot",
        )

        assert agg.get_bucket_state(
            "BTC-USDT", "1h", 0, exchange="okx", market_type="spot",
        ) is None
        assert agg.get_bucket_state(
            "BTC-USDT", "15m", 0, exchange="okx", market_type="spot",
        ) is not None
        assert ("okx", "spot", "BTC-USDT", "15m") in agg.get_targets()
        assert ("okx", "spot", "BTC-USDT", "1h") not in agg.get_targets()
        assert BarEventType.CLOSED not in [event.event_type for event in events]

    asyncio.run(_run())
