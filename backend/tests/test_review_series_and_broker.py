from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.api.v1.indicators import IndicatorRangeRequest, _build_range_meta
from app.data_engine.bar_aggregator import (
    BarAggregator,
    BarInput,
    BarInputSource,
    MergeMode,
)
from app.data_engine.data_manager.aggregator_bridge import AggregatorBridge
from app.data_engine.data_manager.cache import BarCache
from app.data_engine.data_manager.models import BarData, SeriesKey
from app.data_engine.series_identity import KlineSeriesIdentity
from app.indicator import create_engine
from app.indicator.range_result_service import IndicatorRangeResultService
from app.indicator.series_reference import parse_series_reference, series_reference
from app.indicator.types import IndicatorKey


def identity(venue):
    return KlineSeriesIdentity(
        provider_id="twelvedata",
        venue=venue,
        asset_class="equity",
        series_variant="native",
        price_adjustment="raw",
        session_variant="regular",
        volume_semantics="shares",
    )


def test_indicator_instances_revisions_and_range_metadata_are_separated_by_full_identity():
    a, b = identity("xnas"), identity("xnys")
    context = dict(exchange="twelvedata", market_type="stock")
    engine = create_engine()

    def bars(price):
        return [
            BarData(time=60, open=price, high=price, low=price, close=price, volume=1)
        ]

    key_a, _ = engine.subscribe(
        "AAPL:US",
        "1m",
        "stock",
        "MA",
        {"period": 1},
        bars(10),
        exchange="twelvedata",
        series_identity=a,
    )
    key_b, _ = engine.subscribe(
        "AAPL:US",
        "1m",
        "stock",
        "MA",
        {"period": 1},
        bars(20),
        exchange="twelvedata",
        series_identity=b,
    )
    assert key_a != key_b
    assert (
        key_a.series_topic == SeriesKey("AAPL:US", "1m", **context, **a.to_dict()).topic
    )
    engine.on_bar_closed(
        "AAPL:US", "1m", replace(bars(11)[0], time=120), **context, series_identity=a
    )
    assert engine._last_committed[key_a] == 120
    assert engine._last_committed[key_b] == 60
    assert IndicatorKey("BTCUSDT", "1m", "MA").series_topic == "BTCUSDT@1m"
    meta = {
        **context,
        "symbol": "AAPL:US",
        "interval": "1m",
        "series_identity": a.to_dict(),
    }
    assert parse_series_reference(series_reference(meta)) == meta
    service = IndicatorRangeResultService()
    other = {**meta, "series_identity": b.to_dict()}
    before = service.data_revision_for_meta(other)
    service.note_correction(series_key=series_reference(meta), start=60, end=120)
    assert service.data_revision_for_meta(other) == before
    assert service.identity_from_meta(meta) != service.identity_from_meta(other)
    req = IndicatorRangeRequest(
        clientId="ma",
        exchange="twelvedata",
        marketType="stock",
        symbol="AAPL:US",
        interval="1m",
        name="MA",
        start=60,
        end=120,
        seriesIdentity={
            "venue": "xnas",
            "assetClass": "equity",
            "sessionVariant": "regular",
            "volumeSemantics": "shares",
        },
    )
    assert _build_range_meta(req)["series_identity"] == a.to_dict()


def test_indicator_history_queries_receive_the_same_identity():
    from app.api.v1.stream_indicator_payloads import _query_indicator_compute_result

    calls = []
    dm = SimpleNamespace(
        query=lambda *args, **kwargs: calls.append(kwargs) or SimpleNamespace()
    )
    meta = dict(
        exchange="twelvedata",
        market_type="stock",
        symbol="AAPL",
        interval="1m",
        series_identity=identity("xnas").to_dict(),
    )
    _query_indicator_compute_result(
        dm, meta, 60, 120, warmup_bars=0, auto_backfill=False
    )
    assert calls[0]["series_identity"] == identity("xnas")


def test_aggregated_series_keep_separate_buckets_cache_events_and_durable_keys():
    async def run():
        aggregator = BarAggregator()
        cache = BarCache()
        persisted, events = [], []

        class Storage:
            def upsert_bars(
                self, symbol, interval, rows, source, exchange, market_type, **kwargs
            ):
                persisted.append((kwargs.get("series_identity"), rows[0]["close"]))
                return 1

        async def emit(event):
            events.append(event)

        bridge = AggregatorBridge(
            cache=cache,
            event_bus=SimpleNamespace(emit=emit),
            storage_provider=lambda: Storage(),
            mark_bar_received=lambda key: None,
            is_started=lambda: True,
        )
        aggregator.publisher.on_bar_closed(bridge.on_bar_event)
        for semantic, price in ((identity("xnas"), 10), (identity("xnys"), 20)):
            aggregator.add_target(
                "AAPL",
                "1m",
                exchange="twelvedata",
                market_type="stock",
                series_identity=semantic,
            )
            source = BarInput(
                symbol="AAPL",
                source_interval="1m",
                open_time_ms=60_000,
                close_time_ms=119_999,
                open=price,
                high=price,
                low=price,
                close=price,
                volume=1,
                source=BarInputSource.REALTIME,
                is_closed=True,
                exchange="twelvedata",
                market_type="stock",
                merge_mode=MergeMode.SNAPSHOT,
                series_identity=semantic,
            )
            await aggregator.ingest_bar_input(
                "twelvedata", "stock", "AAPL", "1m", source
            )
        assert persisted == [(identity("xnas"), 10), (identity("xnys"), 20)]
        assert len({event.key for event in events}) == 2
        for event in events:
            assert cache.get_latest(event.key, 1)[0].close == event.bar.close
        assert (
            cache.get_latest(
                SeriesKey("AAPL", "1m", exchange="twelvedata", market_type="stock"), 1
            )
            == []
        )

    asyncio.run(run())


@pytest.mark.parametrize(
    "interval,timestamp", [("1m", "2026-09-03 12:00:00"), ("1d", "2026-09-03")]
)
def test_twelve_data_current_bar_is_not_final(interval, timestamp):
    from app.data_engine.ingestion.config import IngestionConfig
    from app.data_engine.ingestion.models import (
        DataSource,
        RawMessage,
        StreamDescriptor,
        StreamType,
    )
    from app.exchanges.plugins.twelvedata.normalizer import TwelveDataNormalizer

    descriptor = StreamDescriptor(
        symbol="EUR/USD",
        interval=interval,
        stream_type=StreamType.KLINE,
        exchange="twelvedata",
        market_type="forex",
    )
    normalizer = TwelveDataNormalizer(IngestionConfig(), descriptor)
    received = int(
        datetime(2026, 9, 3, 12, 0, 30, tzinfo=timezone.utc).timestamp() * 1000
    )
    message = RawMessage(
        payload={
            "datetime": timestamp,
            "open": "1",
            "high": "2",
            "low": "1",
            "close": "1.5",
        },
        source=DataSource.HTTP_BACKFILL,
        stream_type=StreamType.KLINE,
        received_at_ms=received,
    )
    assert normalizer.parse(message).data["is_closed"] is False
    assert (
        normalizer.parse(replace(message, received_at_ms=received + 86_400_000)).data[
            "is_closed"
        ]
        is True
    )


def test_failed_hedge_book_close_restores_all_state_and_cannot_fill_next_bar():
    from tests.fixtures.replay.broker_fakes import CONFIG, make_broker, request, bar
    from app.replay.broker.models import (
        PositionMode,
        PositionSide,
        TOUCH_OR_TAPE_EXECUTION_MODE,
    )
    from app.replay.errors import ReplayDomainError

    broker = make_broker(
        config=replace(CONFIG, position_mode=PositionMode.HEDGE),
        execution_mode=TOUCH_OR_TAPE_EXECUTION_MODE,
    )
    broker.apply_bar(bar(0, 100))
    broker.place_order(
        replace(request(client_order_id="open"), position_side=PositionSide.LONG),
        command_id="open",
    )
    before = broker.snapshot()
    with pytest.raises(ReplayDomainError):
        broker.execute_historical_book_close(
            position_side="LONG",
            side="SELL",
            quantity="1",
            levels=[{"price": "99", "quantity": "0.5"}],
            command_id="failed",
            accepted_source_sequence=1,
            created_time_ms=0,
        )
    assert broker.snapshot() == before
    assert not broker.apply_bar(bar(1, 98)).fills
    assert broker.position.long.quantity == "1"
