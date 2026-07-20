from __future__ import annotations

import asyncio
import time

from app.data_engine.bar_aggregator import (
    BarAggregator,
    BarAggregatorConfig,
    BarInput,
    BarInputSource,
    BarStateChange,
    BarStateEngine,
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
