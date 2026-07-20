from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import wraps

import pytest

from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey
from app.data_engine.market_data.service import (
    MarketDataService,
    MarketHistoryPage,
    _HistoryRefreshPlan,
    _inferred_funding_interval_ms,
    _next_funding_cycle_ms,
)
from app.data_engine.interval_policy import compute_bucket_start_ms
from app.data_engine.market_data.storage_writer import MarketMetricStorageWriter
from app.data_engine.storage import market_metrics_repo as market_metrics_repo_module
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
    funding_time_ms: int = 1_700_028_800_000,
) -> dict:
    return {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "funding_time_ms": funding_time_ms,
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


def _premium_row(open_time_ms: int, close: float) -> dict:
    return {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "open_time_ms": open_time_ms,
        "close_time_ms": open_time_ms + 59_999,
        "premium_open": close,
        "premium_high": close,
        "premium_low": close,
        "premium_close": close,
        "source": "http_backfill",
        "received_at_ms": open_time_ms + 60_100,
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


def test_repository_normalizes_funding_cycle_without_losing_raw_final_time(tmp_path) -> None:
    repository = MarketMetricsRepository(tmp_path / "funding-cycle.sqlite")
    cycle_ms = 1_700_028_780_000
    repository.upsert_funding([_funding_row(
        rate=0.001,
        received_at_ms=100,
        is_final=False,
        funding_time_ms=cycle_ms,
    )])
    repository.upsert_funding([_funding_row(
        rate=0.002,
        received_at_ms=200,
        is_final=True,
        funding_time_ms=cycle_ms + 2,
    )])

    rows = repository.query_funding(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_ms=cycle_ms,
        end_ms=cycle_ms,
        use_cycle_range=True,
    )

    assert len(rows) == 1
    assert rows[0]["is_final"] == 1
    assert rows[0]["funding_cycle_ms"] == cycle_ms
    assert rows[0]["funding_time_ms"] == cycle_ms + 2
    assert rows[0]["funding_rate"] == 0.002
    assert repository.query_funding(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_ms=cycle_ms,
        end_ms=cycle_ms,
    ) == []
    raw_rows = repository.query_funding(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_ms=cycle_ms + 1,
        end_ms=cycle_ms + 2,
    )
    assert [row["funding_time_ms"] for row in raw_rows] == [cycle_ms + 2]


def test_repository_persists_premium_index_history_separately(tmp_path) -> None:
    repository = MarketMetricsRepository(tmp_path / "premium-index.sqlite")
    repository.upsert_premium_index([{
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "open_time_ms": 60_000,
        "close_time_ms": 119_999,
        "premium_open": 0.001,
        "premium_high": 0.002,
        "premium_low": -0.001,
        "premium_close": 0.0015,
        "source": "http_backfill",
        "received_at_ms": 120_100,
    }])

    rows = repository.query_premium_index(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_ms=60_000,
        end_ms=60_000,
    )

    assert len(rows) == 1
    assert rows[0]["premium_close"] == 0.0015
    assert rows[0]["close_time_ms"] == 119_999


def test_repository_premium_compact_query_is_single_layer_ascending(
    tmp_path,
    monkeypatch,
) -> None:
    repository = MarketMetricsRepository(tmp_path / "premium-index-compact.sqlite")
    repository.upsert_premium_index([
        _premium_row(open_time_ms, close)
        for open_time_ms, close in (
            (60_000, 0.001),
            (120_000, 0.002),
            (180_000, 0.003),
        )
    ])
    statements: list[str] = []
    original_connect = market_metrics_repo_module._connect

    def _traced_connect(path):
        connection = original_connect(path)
        connection.set_trace_callback(statements.append)
        return connection

    monkeypatch.setattr(market_metrics_repo_module, "_connect", _traced_connect)
    rows = repository.query_premium_index_compact(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_ms=60_000,
        end_ms=180_000,
        limit=2,
    )

    assert [row["open_time_ms"] for row in rows] == [60_000, 120_000]
    assert set(rows[0]) == {
        "open_time_ms",
        "close_time_ms",
        "premium_close",
        "received_at_ms",
    }
    select = next(
        statement
        for statement in statements
        if "FROM premium_index_history" in statement
    )
    normalized = " ".join(select.split())
    assert "FROM (" not in normalized
    assert "ORDER BY open_time_ms ASC LIMIT 2" in normalized

    full_rows = repository.query_premium_index(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_ms=60_000,
        end_ms=60_000,
        limit=1,
    )
    assert full_rows[0]["premium_open"] == 0.001
    assert full_rows[0]["source"] == "http_backfill"


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


@_async_test
async def test_writer_durable_write_bypasses_provisional_timer(tmp_path) -> None:
    repository = MarketMetricsRepository(tmp_path / "writer-durable.sqlite")
    writer = MarketMetricStorageWriter(repository, flush_interval_seconds=10)

    written = await asyncio.wait_for(
        writer.write_funding([
            _funding_row(rate=0.001, received_at_ms=100, is_final=True),
        ]),
        timeout=0.5,
    )

    assert written == 1
    assert repository.query_funding(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )[0]["funding_rate"] == 0.001
    await writer.close()


@_async_test
async def test_writer_durable_flush_does_not_pull_provisional_forward(
    tmp_path,
) -> None:
    repository = MarketMetricsRepository(tmp_path / "writer-priority.sqlite")
    writer = MarketMetricStorageWriter(repository, flush_interval_seconds=10)
    writer.offer_funding(
        _funding_row(rate=0.001, received_at_ms=100, is_final=False),
    )

    written = await asyncio.wait_for(
        writer.write_open_interest([
            _oi_row(period="5m", value=10, received_at_ms=100),
        ]),
        timeout=0.5,
    )

    assert written == 1
    assert repository.query_funding(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    ) == []
    assert repository.query_open_interest(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        period="5m",
    )[0]["open_interest"] == 10

    await writer.close()
    assert repository.query_funding(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
    )[0]["funding_rate"] == 0.001


@_async_test
async def test_writer_provisional_rows_still_flush_on_timer(tmp_path) -> None:
    repository = MarketMetricsRepository(tmp_path / "writer-provisional-timer.sqlite")
    writer = MarketMetricStorageWriter(repository, flush_interval_seconds=0.02)
    writer.offer_funding(
        _funding_row(rate=0.001, received_at_ms=100, is_final=False),
    )

    stored: list[dict] = []
    for _ in range(50):
        await asyncio.sleep(0.01)
        stored = repository.query_funding(
            exchange="binance",
            market_type="futures",
            symbol="BTCUSDT",
        )
        if stored:
            break

    assert stored[0]["funding_rate"] == 0.001
    assert stored[0]["is_final"] == 0
    await writer.close()


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


class _SettlementPagingFactory(_Factory):
    def __init__(self, settlement_events: list[MarketEvent]) -> None:
        super().__init__()
        self.settlement_events = settlement_events

    async def fetch_market(self, descriptor, **kwargs):
        self.fetch_calls.append({"descriptor": descriptor, **kwargs})
        if descriptor.stream_type == StreamType.PREMIUM_INDEX:
            return []
        if descriptor.stream_type != StreamType.FUNDING_RATE:
            raise AssertionError("unexpected fetch")
        start_ms = kwargs.get("start_ms")
        end_ms = kwargs.get("end_ms")
        limit = int(kwargs.get("limit", 1000))
        return [
            event
            for event in self.settlement_events
            if (start_ms is None or event.event_time_ms >= start_ms)
            and (end_ms is None or event.event_time_ms <= end_ms)
        ][:limit]


def _key(channel: MarketChannel) -> MarketStreamKey:
    return MarketStreamKey.build("binance", "futures", "BTCUSDT", channel)


def test_funding_cycle_inference_is_discrete_and_never_looks_ahead() -> None:
    hour_ms = 60 * 60 * 1000
    cycles_with_future_cadence_change = [
        0,
        8 * hour_ms,
        10 * hour_ms,
        12 * hour_ms,
    ]

    assert _inferred_funding_interval_ms(
        cycles_with_future_cadence_change,
        as_of_ms=8 * hour_ms,
    ) == 8 * hour_ms
    assert _next_funding_cycle_ms(
        8 * hour_ms,
        final_cycles=cycles_with_future_cadence_change,
    ) == 16 * hour_ms

    # The 16h latest difference represents a missing middle settlement, not a
    # valid cadence. The previous observed 8h cadence must win.
    cycles_with_missing_middle = [0, 8 * hour_ms, 24 * hour_ms]
    assert _inferred_funding_interval_ms(
        cycles_with_missing_middle,
        as_of_ms=24 * hour_ms,
    ) == 8 * hour_ms
    assert _next_funding_cycle_ms(
        24 * hour_ms,
        final_cycles=cycles_with_missing_middle,
    ) == 32 * hour_ms


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
    live_funding = service.hub.snapshot([funding_key])[0].event
    assert live_funding.data["provenance"] == "exchange_realtime"
    assert live_funding.data["quality"] == "live"
    assert live_funding.data["sample_kind"] == "preview"
    assert live_funding.data["observed_at_ms"] == 1_700_000_001_100
    assert live_funding.data["valid_until_ms"] == live_funding.data["funding_cycle_ms"]
    assert live_funding.data["carried"] is False

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


@_async_test
async def test_hybrid_funding_is_dense_no_lookahead_and_excludes_forming_bar(
    tmp_path,
    monkeypatch,
) -> None:
    cycle_ms = 8 * 60 * 60 * 1000
    now_ms = cycle_ms + 5 * 60_000 + 500
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    repository = MarketMetricsRepository(tmp_path / "hybrid.sqlite")
    repository.upsert_funding([
        _funding_row(
            rate=0.0042,
            received_at_ms=cycle_ms + 100,
            is_final=True,
            funding_time_ms=cycle_ms + 2,
        ),
        _funding_row(
            rate=0.005,
            received_at_ms=cycle_ms + 200,
            is_final=False,
            funding_time_ms=2 * cycle_ms,
        ),
    ])
    repository.upsert_premium_index([
        _premium_row(cycle_ms, 0.001),
        _premium_row(cycle_ms + 60_000, 0.003),
        _premium_row(cycle_ms + 120_000, 0.009),
        _premium_row(cycle_ms + 180_000, 0.002),
        _premium_row(cycle_ms + 240_000, 0.001),
    ])
    service = MarketDataService(_Factory(), metrics_repository=repository)

    page = await service._build_hybrid_funding_history(
        _key(MarketChannel.FUNDING_RATE),
        period="1m",
        start_ms=cycle_ms,
        end_ms=now_ms,
        limit=100,
        fetch_missing=False,
    )

    assert [event.event_time_ms for event in page.events] == [
        cycle_ms + offset * 60_000
        for offset in range(5)
    ]
    assert page.events[0].data["provenance"] == "exchange_settlement"
    assert page.events[0].data["funding_rate"] == 0.0042
    second = page.events[1]
    assert second.data["provenance"] == "derived_history"
    assert second.data["quality"] == "estimated"
    assert second.data["formula_version"] == "binance-premium-index-cumavg-v2"
    assert second.data["input_resolution"] == "1m"
    assert second.data["funding_rate"] == pytest.approx(0.0015)
    assert second.data["sample_time_ms"] == cycle_ms + 119_999
    assert page.events[0].data["funding_time_ms"] == cycle_ms + 2
    assert page.events[0].data["funding_cycle_ms"] == cycle_ms
    assert all(event.event_time_ms < cycle_ms + 5 * 60_000 for event in page.events)
    await service.shutdown()


@_async_test
async def test_hybrid_funding_service_canonicalizes_irregular_period_alias(tmp_path) -> None:
    repository = MarketMetricsRepository(tmp_path / "hybrid-canonical-period.sqlite")
    service = MarketDataService(_Factory(), metrics_repository=repository)
    captured: dict[str, object] = {}

    async def _capture(event_key, *, period, **kwargs):
        captured["event_key"] = event_key
        captured["period"] = period
        captured["kwargs"] = kwargs
        return MarketHistoryPage(events=[])

    service._hybrid_funding_history_page = _capture
    await service.history_page(
        _key(MarketChannel.FUNDING_RATE),
        period="2820s",
        view="hybrid",
        limit=5,
    )

    assert captured["period"] == "47m"
    assert captured["event_key"].params == (("period", "47m"), ("view", "hybrid"))
    await service.shutdown()


@_async_test
async def test_hybrid_funding_supports_second_bars_with_closed_1m_input_carry(
    tmp_path,
    monkeypatch,
) -> None:
    cycle_ms = 8 * 60 * 60 * 1000
    now_ms = cycle_ms + 65_500
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    repository = MarketMetricsRepository(tmp_path / "hybrid-1s.sqlite")
    repository.upsert_funding([
        _funding_row(
            rate=0.0001,
            received_at_ms=cycle_ms + 100,
            is_final=True,
            funding_time_ms=cycle_ms,
        ),
        _funding_row(
            rate=0.0002,
            received_at_ms=cycle_ms + 200,
            is_final=False,
            funding_time_ms=2 * cycle_ms,
        ),
    ])
    repository.upsert_premium_index([
        _premium_row(cycle_ms - 60_000, 0.001),
        _premium_row(cycle_ms, 0.002),
    ])
    service = MarketDataService(_Factory(), metrics_repository=repository)

    page = await service._build_hybrid_funding_history(
        _key(MarketChannel.FUNDING_RATE),
        period="1s",
        start_ms=cycle_ms,
        end_ms=now_ms,
        limit=100,
        fetch_missing=False,
    )

    assert [event.event_time_ms for event in page.events] == [
        cycle_ms + offset * 1000
        for offset in range(65)
    ]
    assert page.events[0].data["provenance"] == "exchange_settlement"
    assert all(
        event.data["provenance"] == "derived_history"
        for event in page.events[1:]
    )
    assert all(event.data["input_carried"] is True for event in page.events[1:59])
    assert all(event.data["input_proxy"] is True for event in page.events[1:59])
    assert page.events[59].data["input_carried"] is False
    assert page.events[59].data["input_proxy"] is False
    assert all(event.data["input_carried"] is True for event in page.events[60:])
    assert cycle_ms + 65_000 not in {event.event_time_ms for event in page.events}
    await service.shutdown()


@pytest.mark.parametrize(
    ("period", "funding_time", "now_time"),
    [
        (
            "1w",
            datetime(2024, 1, 10, tzinfo=timezone.utc),
            datetime(2024, 1, 23, tzinfo=timezone.utc),
        ),
        (
            "1M",
            datetime(2024, 1, 15, tzinfo=timezone.utc),
            datetime(2024, 3, 2, tzinfo=timezone.utc),
        ),
    ],
)
def test_hybrid_funding_uses_calendar_bucket_alignment(
    tmp_path,
    monkeypatch,
    period,
    funding_time,
    now_time,
) -> None:
    funding_time_ms = int(funding_time.timestamp() * 1000)
    now_ms = int(now_time.timestamp() * 1000)
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    repository = MarketMetricsRepository(tmp_path / f"hybrid-{period}.sqlite")
    repository.upsert_funding([_funding_row(
        rate=0.001,
        received_at_ms=funding_time_ms + 100,
        is_final=True,
        funding_time_ms=funding_time_ms,
    )])
    service = MarketDataService(_Factory(), metrics_repository=repository)
    period_ms = 7 * 24 * 60 * 60 * 1000 if period == "1w" else 30 * 24 * 60 * 60 * 1000
    expected_bucket_ms = compute_bucket_start_ms(
        funding_time_ms,
        period_ms,
        interval=period,
    )

    page = asyncio.run(service._build_hybrid_funding_history(
        _key(MarketChannel.FUNDING_RATE),
        period=period,
        start_ms=expected_bucket_ms,
        end_ms=funding_time_ms,
        limit=10,
        fetch_missing=False,
    ))

    assert len(page.events) == 1
    assert page.events[0].event_time_ms == expected_bucket_ms
    assert page.events[0].data["provenance"] == "exchange_settlement"
    asyncio.run(service.shutdown())


@_async_test
async def test_hybrid_history_uses_cached_shape_when_settlement_refresh_fails(
    tmp_path,
    monkeypatch,
) -> None:
    cycle_ms = 8 * 60 * 60 * 1000
    now_ms = cycle_ms + 3 * 60_000 + 500
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    repository = MarketMetricsRepository(tmp_path / "hybrid-fallback.sqlite")
    repository.upsert_funding([_funding_row(
        rate=0.001,
        received_at_ms=cycle_ms + 100,
        is_final=True,
        funding_time_ms=cycle_ms,
    )])
    repository.upsert_premium_index([
        _premium_row(cycle_ms, 0.001),
        _premium_row(cycle_ms + 60_000, 0.002),
        _premium_row(cycle_ms + 120_000, 0.003),
    ])
    factory = _Factory()
    factory.fail_history = True
    service = MarketDataService(factory, metrics_repository=repository)

    page = await service.history_page(
        _key(MarketChannel.FUNDING_RATE),
        period="1m",
        view="hybrid",
        start_ms=cycle_ms,
        end_ms=now_ms,
        limit=100,
    )

    assert page.fallback is True
    assert page.retryable is True
    assert page.complete is False
    assert [event.data["provenance"] for event in page.events] == [
        "exchange_settlement",
        "derived_history",
        "derived_history",
    ]
    await service.shutdown()


@_async_test
async def test_hybrid_history_does_not_revert_to_sparse_when_refresh_is_not_needed(
    tmp_path,
    monkeypatch,
) -> None:
    cycle_ms = 8 * 60 * 60 * 1000
    now_ms = cycle_ms + 3 * 60_000 + 500
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    repository = MarketMetricsRepository(tmp_path / "hybrid-no-refresh.sqlite")
    repository.upsert_funding([_funding_row(
        rate=0.001,
        received_at_ms=cycle_ms + 100,
        is_final=True,
        funding_time_ms=cycle_ms,
    )])
    repository.upsert_premium_index([
        _premium_row(cycle_ms, 0.001),
        _premium_row(cycle_ms + 60_000, 0.002),
        _premium_row(cycle_ms + 120_000, 0.003),
    ])
    service = MarketDataService(_Factory(), metrics_repository=repository)
    service._history_refresh_plan = lambda *_args, **_kwargs: _HistoryRefreshPlan(
        start_ms=cycle_ms,
        end_ms=now_ms,
        should_fetch=False,
    )

    page = await service.history_page(
        _key(MarketChannel.FUNDING_RATE),
        period="1m",
        view="hybrid",
        start_ms=cycle_ms,
        end_ms=now_ms,
        limit=100,
    )

    assert [event.data["provenance"] for event in page.events] == [
        "exchange_settlement",
        "derived_history",
        "derived_history",
    ]
    await service.shutdown()


@_async_test
async def test_hybrid_funding_paginates_more_than_1000_actual_settlements(
    tmp_path,
    monkeypatch,
) -> None:
    day_ms = 24 * 60 * 60 * 1000
    base_ms = 10 * day_ms
    settlement_events = [
        MarketEvent(
            event_type=StreamType.FUNDING_RATE,
            symbol="BTCUSDT",
            exchange="binance",
            market_type="futures",
            event_time_ms=base_ms + index * 8 * 60 * 60 * 1000,
            received_at_ms=base_ms + index * 8 * 60 * 60 * 1000 + 100,
            source=DataSource.HTTP_BACKFILL,
            data={
                "funding_rate": index / 1_000_000,
                "funding_time_ms": base_ms + index * 8 * 60 * 60 * 1000,
            },
            stream_key="futures:BTCUSDT@fundingRate",
        )
        for index in range(1200)
    ]
    now_ms = base_ms + 401 * day_ms + 1_000
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    repository = MarketMetricsRepository(tmp_path / "hybrid-paged-final.sqlite")
    factory = _SettlementPagingFactory(settlement_events)
    service = MarketDataService(factory, metrics_repository=repository)

    page = await service._build_hybrid_funding_history(
        _key(MarketChannel.FUNDING_RATE),
        period="1d",
        start_ms=base_ms,
        end_ms=base_ms + 399 * day_ms,
        limit=400,
        fetch_missing=True,
    )

    funding_calls = [
        call
        for call in factory.fetch_calls
        if call["descriptor"].stream_type == StreamType.FUNDING_RATE
    ]
    premium_calls = [
        call
        for call in factory.fetch_calls
        if call["descriptor"].stream_type == StreamType.PREMIUM_INDEX
    ]
    assert len(funding_calls) >= 2
    assert premium_calls == []
    assert len(page.events) == 400
    assert all(
        event.data["provenance"] == "exchange_settlement"
        for event in page.events
    )
    assert page.events[-1].data["settlement_count"] == 3
    assert page.complete is True
    assert page.retryable is False
    await service.shutdown()


@_async_test
async def test_hybrid_funding_scales_interest_to_observed_four_hour_cycle(
    tmp_path,
    monkeypatch,
) -> None:
    hour_ms = 60 * 60 * 1000
    first_cycle_ms = 8 * hour_ms
    second_cycle_ms = 12 * hour_ms
    now_ms = 14 * hour_ms + 500
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    repository = MarketMetricsRepository(tmp_path / "hybrid-4h-interest.sqlite")
    repository.upsert_funding([
        _funding_row(
            rate=0.0001,
            received_at_ms=first_cycle_ms + 100,
            is_final=True,
            funding_time_ms=first_cycle_ms,
        ),
        _funding_row(
            rate=0.0001,
            received_at_ms=second_cycle_ms + 100,
            is_final=True,
            funding_time_ms=second_cycle_ms,
        ),
    ])
    repository.upsert_premium_index([
        _premium_row(second_cycle_ms + index * 60_000, 0.0)
        for index in range(2 * 60)
    ])
    service = MarketDataService(_Factory(), metrics_repository=repository)

    page = await service._build_hybrid_funding_history(
        _key(MarketChannel.FUNDING_RATE),
        period="1h",
        start_ms=13 * hour_ms,
        end_ms=13 * hour_ms,
        limit=10,
        fetch_missing=False,
    )

    assert len(page.events) == 1
    assert page.events[0].data["provenance"] == "derived_history"
    assert page.events[0].data["funding_rate"] == pytest.approx(0.00005)
    await service.shutdown()


@_async_test
async def test_hybrid_funding_non_aligned_start_does_not_repeat_prior_bucket(
    tmp_path,
    monkeypatch,
) -> None:
    cycle_ms = 8 * 60 * 60 * 1000
    now_ms = cycle_ms + 4 * 60_000 + 500
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    repository = MarketMetricsRepository(tmp_path / "hybrid-ceil-start.sqlite")
    repository.upsert_funding([_funding_row(
        rate=0.001,
        received_at_ms=cycle_ms + 100,
        is_final=True,
        funding_time_ms=cycle_ms,
    )])
    repository.upsert_premium_index([
        _premium_row(cycle_ms + offset * 60_000, 0.001)
        for offset in range(4)
    ])
    service = MarketDataService(_Factory(), metrics_repository=repository)

    page = await service._build_hybrid_funding_history(
        _key(MarketChannel.FUNDING_RATE),
        period="1m",
        start_ms=cycle_ms + 1,
        end_ms=cycle_ms + 3 * 60_000,
        limit=10,
        fetch_missing=False,
    )

    assert page.events
    assert page.events[0].event_time_ms == cycle_ms + 60_000
    assert all(event.event_time_ms >= cycle_ms + 1 for event in page.events)
    await service.shutdown()


@_async_test
async def test_hybrid_capacity_page_returns_contiguous_prefix_and_advancing_cursor(
    tmp_path,
    monkeypatch,
) -> None:
    cycle_ms = 8 * 60 * 60 * 1000
    next_cycle_ms = 2 * cycle_ms
    now_ms = next_cycle_ms + 6 * 60_000 + 500
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    monkeypatch.setattr(
        "app.data_engine.market_data.service._FUNDING_CONTEXT_LOOKBACK_MS",
        0,
    )
    monkeypatch.setattr(
        "app.data_engine.market_data.service._MAX_PREMIUM_ESTIMATE_POINTS",
        3,
    )
    repository = MarketMetricsRepository(tmp_path / "hybrid-capacity.sqlite")
    repository.upsert_funding([
        _funding_row(
            rate=0.001,
            received_at_ms=cycle_ms + 100,
            is_final=True,
            funding_time_ms=cycle_ms,
        ),
        _funding_row(
            rate=0.002,
            received_at_ms=next_cycle_ms + 100,
            is_final=True,
            funding_time_ms=next_cycle_ms,
        ),
    ])
    repository.upsert_premium_index([
        _premium_row(open_time_ms, 0.001)
        for open_time_ms in range(cycle_ms, now_ms, 60_000)
    ])
    service = MarketDataService(_Factory(), metrics_repository=repository)

    first = await service._build_hybrid_funding_history(
        _key(MarketChannel.FUNDING_RATE),
        period="1m",
        start_ms=cycle_ms,
        end_ms=now_ms,
        limit=1000,
        fetch_missing=False,
    )
    assert [event.event_time_ms for event in first.events] == [
        cycle_ms,
        cycle_ms + 60_000,
        cycle_ms + 120_000,
    ]
    assert first.complete is False
    assert first.retryable is False
    assert all(
        event.event_time_ms < next_cycle_ms
        for event in first.events
    )

    second_start_ms = first.events[-1].event_time_ms + 1
    second = await service._build_hybrid_funding_history(
        _key(MarketChannel.FUNDING_RATE),
        period="1m",
        start_ms=second_start_ms,
        end_ms=now_ms,
        limit=1000,
        fetch_missing=False,
    )
    assert second.events[0].event_time_ms == cycle_ms + 180_000
    assert second.events[0].event_time_ms > first.events[-1].event_time_ms
    await service.shutdown()


@_async_test
async def test_premium_refresh_page_budget_is_global_across_multiple_gaps(
    tmp_path,
) -> None:
    repository = MarketMetricsRepository(tmp_path / "premium-page-budget.sqlite")
    repository.upsert_premium_index([
        _premium_row(index * 60_000, 0.001)
        for index in range(140)
        if index % 2 == 1
    ])
    factory = _SettlementPagingFactory([])
    service = MarketDataService(factory, metrics_repository=repository)

    _rows, missing, failed, budget_exhausted = (
        await service._ensure_premium_index_history(
            _key(MarketChannel.FUNDING_RATE),
            start_ms=0,
            end_ms=140 * 60_000 - 1,
            fetch_missing=True,
        )
    )

    premium_calls = [
        call
        for call in factory.fetch_calls
        if call["descriptor"].stream_type == StreamType.PREMIUM_INDEX
    ]
    assert len(premium_calls) == 64
    assert missing
    assert failed is False
    assert budget_exhausted is True
    await service.shutdown()


@_async_test
async def test_hybrid_funding_stops_at_premium_gap_even_if_later_data_recovers(
    tmp_path,
    monkeypatch,
) -> None:
    minute_ms = 60_000
    cycle_ms = 8 * 60 * minute_ms
    now_ms = cycle_ms + 6 * minute_ms + 500
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    repository = MarketMetricsRepository(tmp_path / "hybrid-premium-gap.sqlite")
    repository.upsert_funding([
        _funding_row(
            rate=0.001,
            received_at_ms=cycle_ms + 100,
            is_final=True,
            funding_time_ms=cycle_ms,
        ),
        _funding_row(
            rate=0.002,
            received_at_ms=cycle_ms + 4 * minute_ms + 100,
            is_final=True,
            funding_time_ms=cycle_ms + 4 * minute_ms,
        ),
    ])
    # Minute one is absent, while both Premium data and an actual settlement
    # exist later. The response must not jump across that hole.
    repository.upsert_premium_index([
        _premium_row(cycle_ms, 0.001),
        _premium_row(cycle_ms + 2 * minute_ms, 0.002),
        _premium_row(cycle_ms + 3 * minute_ms, 0.003),
        _premium_row(cycle_ms + 4 * minute_ms, 0.004),
    ])
    service = MarketDataService(_Factory(), metrics_repository=repository)

    page = await service._build_hybrid_funding_history(
        _key(MarketChannel.FUNDING_RATE),
        period="1m",
        start_ms=cycle_ms,
        end_ms=now_ms,
        limit=100,
        fetch_missing=False,
    )

    assert [event.event_time_ms for event in page.events] == [cycle_ms]
    assert page.events[0].data["provenance"] == "exchange_settlement"
    assert page.complete is False
    assert page.retryable is False
    await service.shutdown()


@_async_test
async def test_hybrid_funding_5m_stops_before_bucket_with_internal_premium_gap(
    tmp_path,
    monkeypatch,
) -> None:
    minute_ms = 60_000
    cycle_ms = 8 * 60 * minute_ms
    now_ms = cycle_ms + 16 * minute_ms + 500
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    repository = MarketMetricsRepository(
        tmp_path / "hybrid-premium-internal-gap.sqlite",
    )
    repository.upsert_funding([
        _funding_row(
            rate=0.001,
            received_at_ms=cycle_ms + 100,
            is_final=True,
            funding_time_ms=cycle_ms,
        ),
    ])
    # Minute seven is missing inside the second 5m chart bucket. Later Premium
    # rows must not make that bucket (or any following bucket) look complete.
    repository.upsert_premium_index([
        _premium_row(cycle_ms + index * minute_ms, index / 1_000_000)
        for index in range(15)
        if index != 7
    ])
    service = MarketDataService(_Factory(), metrics_repository=repository)

    page = await service._build_hybrid_funding_history(
        _key(MarketChannel.FUNDING_RATE),
        period="5m",
        start_ms=cycle_ms,
        end_ms=cycle_ms + 15 * minute_ms - 1,
        limit=100,
        fetch_missing=False,
    )

    assert [event.event_time_ms for event in page.events] == [cycle_ms]
    assert page.events[0].data["provenance"] == "exchange_settlement"
    assert page.complete is False
    assert page.retryable is False
    assert any(
        excluded["reason"] == "premium_index_unavailable"
        and int(excluded["start_ms"])
        <= cycle_ms + 7 * minute_ms
        <= int(excluded["end_ms"])
        for excluded in page.excluded_ranges
    )
    await service.shutdown()


@_async_test
async def test_settlement_page_budget_fetches_forward_contiguous_prefix(
    tmp_path,
) -> None:
    interval_ms = 8 * 60 * 60 * 1000
    base_ms = 10 * interval_ms
    settlement_events = [
        MarketEvent(
            event_type=StreamType.FUNDING_RATE,
            symbol="BTCUSDT",
            exchange="binance",
            market_type="futures",
            event_time_ms=base_ms + index * interval_ms,
            received_at_ms=base_ms + index * interval_ms + 100,
            source=DataSource.HTTP_BACKFILL,
            data={
                "funding_rate": index / 1_000_000,
                "funding_time_ms": base_ms + index * interval_ms,
            },
            stream_key="futures:BTCUSDT@fundingRate",
        )
        for index in range(1001)
    ]
    repository = MarketMetricsRepository(tmp_path / "settlement-page-prefix.sqlite")
    factory = _SettlementPagingFactory(settlement_events)
    service = MarketDataService(factory, metrics_repository=repository)
    service._fetch_market = factory.fetch_market

    complete, covered_through_ms = await service._fetch_funding_settlement_pages(
        _key(MarketChannel.FUNDING_RATE),
        start_ms=base_ms,
        end_ms=settlement_events[-1].event_time_ms,
        max_pages=1,
    )

    assert complete is False
    assert covered_through_ms == settlement_events[999].event_time_ms
    assert len(factory.fetch_calls) == 1
    assert factory.fetch_calls[0]["start_ms"] == base_ms
    rows = repository.query_funding(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_ms=base_ms,
        end_ms=settlement_events[-1].event_time_ms,
        limit=2000,
    )
    assert len(rows) == 1000
    assert rows[0]["funding_time_ms"] == base_ms
    assert rows[-1]["funding_time_ms"] == settlement_events[999].event_time_ms

    prefix_complete, prefix_covered_through_ms = (
        await service._fetch_funding_settlement_pages(
            _key(MarketChannel.FUNDING_RATE),
            start_ms=base_ms,
            end_ms=settlement_events[999].event_time_ms,
            max_pages=1,
        )
    )
    assert prefix_complete is True
    assert prefix_covered_through_ms == settlement_events[999].event_time_ms
    assert len(factory.fetch_calls) == 1

    full_complete, full_covered_through_ms = (
        await service._fetch_funding_settlement_pages(
            _key(MarketChannel.FUNDING_RATE),
            start_ms=base_ms,
            end_ms=settlement_events[-1].event_time_ms,
            max_pages=1,
        )
    )
    assert full_complete is True
    assert full_covered_through_ms == settlement_events[-1].event_time_ms
    assert len(factory.fetch_calls) == 2
    await service.shutdown()


@_async_test
async def test_settlement_refresh_single_flight_deduplicates_concurrent_range(
    tmp_path,
) -> None:
    repository = MarketMetricsRepository(tmp_path / "settlement-single-flight.sqlite")
    service = MarketDataService(_Factory(), metrics_repository=repository)
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def fetch_market(_descriptor, **_kwargs):
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return []

    service._fetch_market = fetch_market
    key = _key(MarketChannel.FUNDING_RATE)
    first = asyncio.create_task(service._fetch_funding_settlement_pages(
        key,
        start_ms=100,
        end_ms=1000,
    ))
    await started.wait()
    second = asyncio.create_task(service._fetch_funding_settlement_pages(
        key,
        start_ms=100,
        end_ms=1000,
    ))
    await asyncio.sleep(0)
    release.set()

    assert await asyncio.gather(first, second) == [
        (True, 1000),
        (True, 1000),
    ]
    assert calls == 1
    await service.shutdown()


@_async_test
async def test_settlement_refresh_successful_range_serves_hot_subset(
    tmp_path,
) -> None:
    repository = MarketMetricsRepository(tmp_path / "settlement-subset-hit.sqlite")
    service = MarketDataService(_Factory(), metrics_repository=repository)
    calls = 0

    async def fetch_market(_descriptor, **_kwargs):
        nonlocal calls
        calls += 1
        return []

    service._fetch_market = fetch_market
    key = _key(MarketChannel.FUNDING_RATE)

    assert await service._fetch_funding_settlement_pages(
        key,
        start_ms=100,
        end_ms=1000,
    ) == (True, 1000)
    assert await service._fetch_funding_settlement_pages(
        key,
        start_ms=200,
        end_ms=900,
    ) == (True, 900)
    assert calls == 1
    await service.shutdown()


@_async_test
async def test_settlement_refresh_failure_is_not_cached(tmp_path) -> None:
    repository = MarketMetricsRepository(tmp_path / "settlement-failure.sqlite")
    service = MarketDataService(_Factory(), metrics_repository=repository)
    calls = 0

    async def fetch_market(_descriptor, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("upstream unavailable")
        return []

    service._fetch_market = fetch_market
    key = _key(MarketChannel.FUNDING_RATE)

    with pytest.raises(RuntimeError, match="upstream unavailable"):
        await service._fetch_funding_settlement_pages(
            key,
            start_ms=100,
            end_ms=1000,
        )
    assert await service._fetch_funding_settlement_pages(
        key,
        start_ms=100,
        end_ms=1000,
    ) == (True, 1000)
    assert calls == 2
    await service.shutdown()


@_async_test
async def test_settlement_refresh_current_edge_coverage_expires(
    tmp_path,
) -> None:
    repository = MarketMetricsRepository(tmp_path / "settlement-edge-ttl.sqlite")
    service = MarketDataService(_Factory(), metrics_repository=repository)
    calls = 0
    interval_ms = 8 * 60 * 60 * 1000
    wall_ms = 100 * interval_ms
    monotonic_seconds = 100.0

    async def fetch_market(_descriptor, **_kwargs):
        nonlocal calls
        calls += 1
        return []

    service._fetch_market = fetch_market
    service._funding_refresh_wall_ms = lambda: wall_ms
    service._funding_refresh_monotonic = lambda: monotonic_seconds
    key = _key(MarketChannel.FUNDING_RATE)
    historical_start_ms = 0
    historical_end_ms = wall_ms - interval_ms
    edge_start_ms = wall_ms - 1000
    edge_end_ms = wall_ms

    assert await service._fetch_funding_settlement_pages(
        key,
        start_ms=historical_start_ms,
        end_ms=historical_end_ms,
    ) == (True, historical_end_ms)
    assert await service._fetch_funding_settlement_pages(
        key,
        start_ms=historical_start_ms,
        end_ms=historical_end_ms,
    ) == (True, historical_end_ms)

    assert await service._fetch_funding_settlement_pages(
        key,
        start_ms=edge_start_ms,
        end_ms=edge_end_ms,
    ) == (True, edge_end_ms)
    monotonic_seconds += 59.0
    assert await service._fetch_funding_settlement_pages(
        key,
        start_ms=edge_start_ms,
        end_ms=edge_end_ms,
    ) == (True, edge_end_ms)
    assert calls == 2

    monotonic_seconds += 2.0
    assert await service._fetch_funding_settlement_pages(
        key,
        start_ms=edge_start_ms,
        end_ms=edge_end_ms,
    ) == (True, edge_end_ms)
    assert calls == 3

    monotonic_seconds += 10_000.0
    assert await service._fetch_funding_settlement_pages(
        key,
        start_ms=historical_start_ms,
        end_ms=historical_end_ms,
    ) == (True, historical_end_ms)
    assert calls == 3
    await service.shutdown()
