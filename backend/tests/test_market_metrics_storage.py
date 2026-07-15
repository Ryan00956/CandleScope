from __future__ import annotations

import asyncio
from dataclasses import dataclass
from functools import wraps

import pytest

from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey
from app.data_engine.market_data.service import MarketDataService
from app.data_engine.market_data.storage_writer import MarketMetricStorageWriter
from app.data_engine.storage.market_metrics_repo import MarketMetricsRepository


def _async_test(function):
    @wraps(function)
    def _wrapped(*args, **kwargs):
        return asyncio.run(function(*args, **kwargs))

    return _wrapped


def _funding_row(
    *,
    rate: float,
    received_at_ms: int,
    is_final: bool,
) -> dict:
    return {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "funding_time_ms": 1_700_028_800_000,
        "funding_rate": rate,
        "is_final": is_final,
        "source": "http_backfill" if is_final else "websocket",
        "received_at_ms": received_at_ms,
    }


def _oi_row(
    *,
    period: str,
    value: float,
    received_at_ms: int,
    is_final: bool = True,
    event_time_ms: int = 1_700_000_000_000,
) -> dict:
    return {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "period": period,
        "event_time_ms": event_time_ms,
        "open_interest": value,
        "open_interest_value": value * 100,
        "is_final": is_final,
        "source": "http_backfill" if is_final else "http",
        "received_at_ms": received_at_ms,
    }


def test_repository_preserves_final_rows_and_open_interest_period_identity(tmp_path) -> None:
    repository = MarketMetricsRepository(tmp_path / "metrics.sqlite")
    repository.upsert_funding([
        _funding_row(rate=0.001, received_at_ms=100, is_final=False),
    ])
    repository.upsert_funding([
        _funding_row(rate=0.002, received_at_ms=200, is_final=True),
    ])
    repository.upsert_funding([
        _funding_row(rate=0.003, received_at_ms=300, is_final=False),
    ])

    funding = repository.query_funding(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )
    assert len(funding) == 1
    assert funding[0]["funding_rate"] == 0.002
    assert funding[0]["is_final"] == 1

    repository.upsert_open_interest([
        _oi_row(period="5m", value=10, received_at_ms=100),
        _oi_row(period="15m", value=20, received_at_ms=100),
    ])
    repository.upsert_open_interest([
        _oi_row(period="5m", value=30, received_at_ms=200, is_final=False),
    ])
    assert repository.query_open_interest(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        period="5m",
    )[0]["open_interest"] == 10
    assert repository.query_open_interest(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        period="15m",
    )[0]["open_interest"] == 20

    with pytest.raises(ValueError, match="cannot be negative"):
        repository.upsert_open_interest([
            _oi_row(period="5m", value=-1, received_at_ms=200),
        ])
    with pytest.raises(ValueError, match="must be finite"):
        repository.upsert_funding([
            _funding_row(rate=float("nan"), received_at_ms=200, is_final=True),
        ])


@_async_test
async def test_writer_coalesces_provisional_rows_and_flushes_on_close(tmp_path) -> None:
    repository = MarketMetricsRepository(tmp_path / "writer.sqlite")
    writer = MarketMetricStorageWriter(
        repository,
        flush_interval_seconds=60,
        max_pending_provisional=2,
    )
    first = _funding_row(rate=0.001, received_at_ms=100, is_final=False)
    second = _funding_row(rate=0.002, received_at_ms=200, is_final=False)
    assert writer.offer_funding(first) is True
    assert writer.offer_funding(second) is True

    await writer.close()

    stored = repository.query_funding(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )
    assert len(stored) == 1
    assert stored[0]["funding_rate"] == 0.002
    diagnostics = writer.diagnostics()
    assert diagnostics["coalesced"] == 1
    assert diagnostics["provisional_pending"] == 0
    assert diagnostics["state"] == "closed"


@dataclass
class _Handle:
    async def stop(self) -> bool:
        return True


class _Factory:
    def __init__(self) -> None:
        self.callbacks = {}
        self.fail_history = False
        self.funding_rate = 0.001
        self.fetch_calls: list[dict] = []

    async def start_market(self, descriptor, callback):
        self.callbacks[descriptor.key] = callback
        return _Handle()

    async def fetch_market(self, descriptor, **kwargs):
        self.fetch_calls.append({"descriptor": descriptor, **kwargs})
        if self.fail_history:
            raise RuntimeError("upstream unavailable")
        history = kwargs.get("history", False)
        event_time_ms = kwargs.get("start_ms") or 1_700_000_000_000
        if descriptor.stream_type == StreamType.FUNDING_RATE and history:
            data = {
                "funding_rate": self.funding_rate,
                "funding_time_ms": event_time_ms,
            }
        elif descriptor.stream_type == StreamType.OPEN_INTEREST and history:
            data = {
                "open_interest": 123.0,
                "open_interest_value": 12_300.0,
            }
        else:
            raise AssertionError("unexpected fetch")
        return [
            MarketEvent(
                event_type=descriptor.stream_type,
                symbol=descriptor.symbol,
                exchange=descriptor.exchange,
                market_type=descriptor.market_type,
                event_time_ms=event_time_ms,
                received_at_ms=event_time_ms + 100,
                source=DataSource.HTTP_BACKFILL,
                data=data,
                stream_key=descriptor.key,
            ),
        ]


def _key(channel: MarketChannel) -> MarketStreamKey:
    return MarketStreamKey.build("binance", "futures", "BTCUSDT", channel)


@_async_test
async def test_history_writes_then_rereads_and_falls_back_to_local(tmp_path) -> None:
    repository = MarketMetricsRepository(tmp_path / "history.sqlite")
    # A newer cached settlement must not pull a forward Funding page's cursor
    # to the right edge after the upstream returns its oldest page.
    repository.upsert_funding([
        _funding_row(rate=0.009, received_at_ms=100, is_final=True),
    ])
    writer = MarketMetricStorageWriter(repository, flush_interval_seconds=0.01)
    factory = _Factory()
    service = MarketDataService(
        factory,
        metrics_repository=repository,
        metrics_writer=writer,
    )

    funding_page = await service.history_page(
        _key(MarketChannel.FUNDING_RATE),
        limit=1,
    )
    assert funding_page.fallback is False
    funding = funding_page.events
    assert len(funding) == 1
    assert funding[0].event_time_ms == 1_700_000_000_000
    assert funding[0].data["funding_rate"] == 0.001
    assert funding[0].data["is_final"] is True
    assert funding[0].data["sample_kind"] == "settlement"
    assert repository.query_funding(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )[0]["is_final"] == 1

    oi = await service.history(
        _key(MarketChannel.OPEN_INTEREST),
        period="5m",
        limit=50,
    )
    assert oi[0].key.params == (("period", "5m"),)
    assert oi[0].data["open_interest_value"] == 12_300.0
    assert oi[0].data["is_final"] is True
    assert oi[0].data["sample_kind"] == "final"

    factory.fail_history = True
    fallback_page = await service.history_page(
        _key(MarketChannel.FUNDING_RATE),
        limit=50,
    )
    assert fallback_page.fallback is True
    fallback = fallback_page.events
    assert fallback[0].data["funding_rate"] == 0.001
    await service.shutdown()


@_async_test
async def test_expired_open_interest_range_reads_local_without_upstream_retry(
    tmp_path,
    monkeypatch,
) -> None:
    period_ms = 5 * 60 * 1000
    retention_start_ms = 1_700_000_100_000
    # The raw cutoff is one millisecond before a period boundary.  The safety
    # margin must still move the request to the following complete bucket.
    now_ms = retention_start_ms + 30 * 24 * 60 * 60 * 1000 - 1
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    repository = MarketMetricsRepository(tmp_path / "expired-oi.sqlite")
    cached_time_ms = retention_start_ms - period_ms
    repository.upsert_open_interest([
        _oi_row(
            period="5m",
            value=321,
            received_at_ms=cached_time_ms + 100,
            event_time_ms=cached_time_ms,
        ),
    ])
    factory = _Factory()
    service = MarketDataService(factory, metrics_repository=repository)

    page = await service.history_page(
        _key(MarketChannel.OPEN_INTEREST),
        period="5m",
        start_ms=retention_start_ms - 2 * period_ms,
        end_ms=retention_start_ms - 1,
        limit=500,
    )

    assert factory.fetch_calls == []
    assert page.fallback is False
    assert [event.event_time_ms for event in page.events] == [cached_time_ms]
    assert page.events[0].data["open_interest"] == 321
    await service.shutdown()


@_async_test
async def test_open_interest_refresh_clamps_crossing_range_to_retention_boundary(
    tmp_path,
    monkeypatch,
) -> None:
    period_ms = 5 * 60 * 1000
    retention_start_ms = 1_700_000_100_000
    now_ms = retention_start_ms + 30 * 24 * 60 * 60 * 1000
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    repository = MarketMetricsRepository(tmp_path / "crossing-oi.sqlite")
    factory = _Factory()
    service = MarketDataService(factory, metrics_repository=repository)
    requested_end_ms = retention_start_ms + 2 * period_ms

    page = await service.history_page(
        _key(MarketChannel.OPEN_INTEREST),
        period="5m",
        start_ms=retention_start_ms - 2 * period_ms,
        end_ms=requested_end_ms,
        limit=500,
    )

    assert len(factory.fetch_calls) == 1
    assert factory.fetch_calls[0]["start_ms"] == retention_start_ms + period_ms
    assert factory.fetch_calls[0]["end_ms"] == requested_end_ms
    assert page.fallback is False
    assert [event.event_time_ms for event in page.events] == [
        retention_start_ms + period_ms,
    ]
    await service.shutdown()


@_async_test
async def test_expired_open_interest_range_still_validates_period(tmp_path) -> None:
    factory = _Factory()
    service = MarketDataService(
        factory,
        metrics_repository=MarketMetricsRepository(tmp_path / "invalid-period.sqlite"),
    )

    with pytest.raises(ValueError, match="unsupported open-interest period: 1m"):
        await service.history_page(
            _key(MarketChannel.OPEN_INTEREST),
            period="1m",
            start_ms=0,
            end_ms=1,
            limit=500,
        )

    assert factory.fetch_calls == []
    await service.shutdown()


@_async_test
async def test_open_interest_end_only_query_preserves_upstream_page_semantics(
    monkeypatch,
) -> None:
    now_ms = 1_702_592_100_000
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    factory = _Factory()
    service = MarketDataService(factory)

    await service.history_page(
        _key(MarketChannel.OPEN_INTEREST),
        period="5m",
        end_ms=now_ms,
        limit=500,
    )

    assert len(factory.fetch_calls) == 1
    assert factory.fetch_calls[0]["start_ms"] is None
    assert factory.fetch_calls[0]["end_ms"] == now_ms
    await service.shutdown()


@_async_test
async def test_fully_future_history_is_not_fetched_and_is_explicitly_excluded(
    monkeypatch,
) -> None:
    now_ms = 1_702_592_100_000
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    factory = _Factory()
    service = MarketDataService(factory)

    page = await service.history_page(
        _key(MarketChannel.FUNDING_RATE),
        start_ms=now_ms + 1,
        end_ms=now_ms + 10_000,
        limit=500,
    )

    assert factory.fetch_calls == []
    assert page.events == []
    assert page.complete is True
    assert page.retryable is False
    assert page.terminal_reason is None
    assert page.excluded_ranges == ({
        "start_ms": now_ms + 1,
        "end_ms": now_ms + 10_000,
        "disposition": "not_expected",
        "reason": "future",
    },)
    await service.shutdown()


@_async_test
async def test_mixed_history_range_clamps_to_wall_clock_and_regular_cadence(
    monkeypatch,
) -> None:
    period_ms = 5 * 60 * 1000
    now_ms = 1_702_592_123_456
    latest_oi_event_ms = (now_ms // period_ms) * period_ms
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    factory = _Factory()
    service = MarketDataService(factory)

    funding_start_ms = now_ms - 60_000
    funding_page = await service.history_page(
        _key(MarketChannel.FUNDING_RATE),
        start_ms=funding_start_ms,
        end_ms=now_ms + 60_000,
        limit=500,
    )
    assert factory.fetch_calls[-1]["start_ms"] == funding_start_ms
    assert factory.fetch_calls[-1]["end_ms"] == now_ms
    assert funding_page.excluded_ranges == ({
        "start_ms": now_ms + 1,
        "end_ms": now_ms + 60_000,
        "disposition": "not_expected",
        "reason": "future",
    },)

    oi_start_ms = latest_oi_event_ms - period_ms
    oi_page = await service.history_page(
        _key(MarketChannel.OPEN_INTEREST),
        period="5m",
        start_ms=oi_start_ms,
        end_ms=now_ms + period_ms,
        limit=500,
    )
    assert factory.fetch_calls[-1]["start_ms"] == oi_start_ms
    assert factory.fetch_calls[-1]["end_ms"] == latest_oi_event_ms
    assert oi_page.excluded_ranges == ({
        "start_ms": latest_oi_event_ms + 1,
        "end_ms": now_ms + period_ms,
        "disposition": "not_expected",
        "reason": "future",
    },)
    await service.shutdown()


@_async_test
async def test_realtime_storage_is_channel_gated_and_uses_stable_buckets(tmp_path) -> None:
    repository = MarketMetricsRepository(tmp_path / "realtime.sqlite")
    writer = MarketMetricStorageWriter(repository, flush_interval_seconds=60)
    factory = _Factory()
    service = MarketDataService(
        factory,
        metrics_repository=repository,
        metrics_writer=writer,
    )

    for channel in (
        MarketChannel.MARK_PRICE,
        MarketChannel.INDEX_PRICE,
        MarketChannel.BASIS,
    ):
        await service.ensure_stream(_key(channel), consumer_id=f"{channel.value}-only")
    summary_callback = factory.callbacks["futures:BTCUSDT@markPrice"]
    await summary_callback(
        MarketEvent(
            event_type=StreamType.MARK_PRICE,
            symbol="BTCUSDT",
            exchange="binance",
            market_type="futures",
            event_time_ms=1_700_000_000_000,
            received_at_ms=1_700_000_000_100,
            source=DataSource.WEBSOCKET,
            data={
                "mark_price": 100.0,
                "index_price": 99.0,
                "funding_rate": 0.001,
                "next_funding_time_ms": 1_700_028_800_000,
            },
            stream_key="futures:BTCUSDT@markPrice",
        ),
    )
    assert writer.diagnostics()["provisional_pending"] == 0

    funding_key = _key(MarketChannel.FUNDING_RATE)
    await service.ensure_stream(funding_key, consumer_id="funding")
    await summary_callback(
        MarketEvent(
            event_type=StreamType.MARK_PRICE,
            symbol="BTCUSDT",
            exchange="binance",
            market_type="futures",
            event_time_ms=1_700_000_001_000,
            received_at_ms=1_700_000_001_100,
            source=DataSource.WEBSOCKET,
            data={
                "mark_price": 101.0,
                "index_price": 100.0,
                "funding_rate": 0.002,
                "next_funding_time_ms": 1_700_028_800_000,
            },
            stream_key="futures:BTCUSDT@markPrice",
        ),
    )

    oi_key = _key(MarketChannel.OPEN_INTEREST)
    await service.ensure_stream(oi_key, consumer_id="oi")
    oi_callback = factory.callbacks["futures:BTCUSDT@openInterest"]
    for event_time_ms, value in (
        (1_700_000_001_000, 10.0),
        (1_700_000_002_000, 11.0),
    ):
        await oi_callback(
            MarketEvent(
                event_type=StreamType.OPEN_INTEREST,
                symbol="BTCUSDT",
                exchange="binance",
                market_type="futures",
                event_time_ms=event_time_ms,
                received_at_ms=event_time_ms + 10,
                source=DataSource.HTTP,
                data={"open_interest": value},
                stream_key="futures:BTCUSDT@openInterest",
            ),
        )

    await service.shutdown()
    funding = repository.query_funding(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )
    assert len(funding) == 1
    assert funding[0]["funding_time_ms"] == 1_700_028_800_000
    assert funding[0]["funding_rate"] == 0.002
    assert funding[0]["is_final"] == 0
    assert "mark_price" not in funding[0]
    oi = repository.query_open_interest(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        period="5m",
    )
    assert len(oi) == 1
    assert oi[0]["open_interest"] == 11.0
    assert oi[0]["is_final"] == 0

    fallback_factory = _Factory()
    fallback_factory.fail_history = True
    fallback_service = MarketDataService(
        fallback_factory,
        metrics_repository=repository,
    )
    funding_preview = await fallback_service.history(
        _key(MarketChannel.FUNDING_RATE),
        limit=50,
    )
    assert funding_preview[0].data["is_final"] is False
    assert funding_preview[0].data["sample_kind"] == "preview"
    assert funding_preview[0].received_at_ms == 1_700_000_001_100
    oi_preview = await fallback_service.history(
        _key(MarketChannel.OPEN_INTEREST),
        period="5m",
        limit=50,
    )
    assert oi_preview[0].data["is_final"] is False
    assert oi_preview[0].data["sample_kind"] == "provisional"
    await fallback_service.shutdown()
