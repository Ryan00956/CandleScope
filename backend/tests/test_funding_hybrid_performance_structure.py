from __future__ import annotations

import asyncio
from functools import wraps
from unittest.mock import AsyncMock

from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey
from app.data_engine.market_data.service import MarketDataService, _HistoryRefreshPlan
from app.data_engine.storage.market_metrics_repo import MarketMetricsRepository


_MINUTE_MS = 60_000


def _async_test(function):
    @wraps(function)
    def _wrapped(*args, **kwargs):
        return asyncio.run(function(*args, **kwargs))

    return _wrapped


def _funding_key() -> MarketStreamKey:
    return MarketStreamKey.build(
        "binance",
        "futures",
        "BTCUSDT",
        MarketChannel.FUNDING_RATE,
    )


def _funding_row(funding_time_ms: int) -> dict:
    return {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "funding_time_ms": funding_time_ms,
        "funding_rate": 0.001,
        "is_final": True,
        "source": "http_backfill",
        "received_at_ms": funding_time_ms + 100,
    }


def _premium_row(open_time_ms: int) -> dict:
    return {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "open_time_ms": open_time_ms,
        "close_time_ms": open_time_ms + _MINUTE_MS - 1,
        "premium_open": 0.001,
        "premium_high": 0.001,
        "premium_low": 0.001,
        "premium_close": 0.001,
        "source": "http_backfill",
        "received_at_ms": open_time_ms + _MINUTE_MS + 100,
    }


def _premium_event(descriptor, open_time_ms: int) -> MarketEvent:
    return MarketEvent(
        event_type=StreamType.PREMIUM_INDEX,
        symbol=descriptor.symbol,
        exchange=descriptor.exchange,
        market_type=descriptor.market_type,
        event_time_ms=open_time_ms,
        received_at_ms=open_time_ms + _MINUTE_MS + 100,
        source=DataSource.HTTP_BACKFILL,
        data={
            "interval": "1m",
            "open_time_ms": open_time_ms,
            "close_time_ms": open_time_ms + _MINUTE_MS - 1,
            "premium_index_open": 0.001,
            "premium_index_high": 0.001,
            "premium_index_low": 0.001,
            "premium_index_close": 0.001,
        },
        stream_key=descriptor.key,
    )


class _ColdPremiumFactory:
    def __init__(self, *, missing_minutes: set[int] | None = None) -> None:
        self.missing_minutes = missing_minutes or set()
        self.calls: list[dict] = []
        self.in_flight = 0
        self.max_in_flight = 0

    async def fetch_market(self, descriptor, **kwargs):
        if descriptor.stream_type == StreamType.FUNDING_RATE:
            return []
        if descriptor.stream_type != StreamType.PREMIUM_INDEX:
            raise AssertionError(f"unexpected stream: {descriptor.stream_type}")

        self.calls.append({"descriptor": descriptor, **kwargs})
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            # A real yield is required so a concurrent shard implementation can
            # overlap calls; a serial implementation remains observable as one.
            await asyncio.sleep(0.01)
            start_ms = int(kwargs["start_ms"])
            end_ms = int(kwargs["end_ms"])
            limit = int(kwargs["limit"])
            open_times = range(start_ms, end_ms + 1, _MINUTE_MS)
            return [
                _premium_event(descriptor, open_time_ms)
                for open_time_ms in open_times
                if open_time_ms // _MINUTE_MS not in self.missing_minutes
            ][:limit]
        finally:
            self.in_flight -= 1


@_async_test
async def test_hybrid_history_page_has_one_builder_owned_funding_refresh(
    tmp_path,
    monkeypatch,
) -> None:
    bucket_ms = 8 * 60 * _MINUTE_MS
    now_ms = bucket_ms + 2 * _MINUTE_MS + 500
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    repository = MarketMetricsRepository(tmp_path / "hybrid-entry.sqlite")
    repository.upsert_funding([_funding_row(bucket_ms)])
    service = MarketDataService(_ColdPremiumFactory(), metrics_repository=repository)

    sparse_read = AsyncMock(return_value=[])
    outer_fetch = AsyncMock(return_value=[])
    builder_settlement_refresh = AsyncMock(
        return_value=(True, bucket_ms + _MINUTE_MS - 1),
    )
    monkeypatch.setattr(service, "_read_persisted_history", sparse_read)
    monkeypatch.setattr(service, "_fetch_market", outer_fetch)
    monkeypatch.setattr(
        service,
        "_fetch_funding_settlement_pages",
        builder_settlement_refresh,
    )
    monkeypatch.setattr(
        service,
        "_history_refresh_plan",
        lambda *args, **kwargs: _HistoryRefreshPlan(
            start_ms=bucket_ms,
            end_ms=bucket_ms + _MINUTE_MS - 1,
            should_fetch=True,
            max_page_size=1000,
        ),
    )

    page = await service.history_page(
        _funding_key(),
        period="1m",
        start_ms=bucket_ms,
        end_ms=bucket_ms + _MINUTE_MS - 1,
        limit=10,
        view="hybrid",
    )

    observed = {
        "generic_sparse_reads": sparse_read.await_count,
        "outer_funding_fetches": outer_fetch.await_count,
        "builder_settlement_refreshes": builder_settlement_refresh.await_count,
    }
    assert observed == {
        "generic_sparse_reads": 0,
        "outer_funding_fetches": 0,
        "builder_settlement_refreshes": 1,
    }
    assert [event.event_time_ms for event in page.events] == [bucket_ms]
    await service.shutdown()


@_async_test
async def test_fully_warm_premium_range_is_queried_once(
    tmp_path,
    monkeypatch,
) -> None:
    minute_count = 1000
    repository = MarketMetricsRepository(tmp_path / "premium-warm.sqlite")
    repository.upsert_premium_index([
        _premium_row(index * _MINUTE_MS)
        for index in range(minute_count)
    ])

    query_calls: list[str] = []
    for method_name in (
        "query_premium_index",
        "query_premium_index_compact",
    ):
        if not hasattr(repository, method_name):
            continue
        original = getattr(repository, method_name)

        def counted_query(
            *args,
            _method_name=method_name,
            _original=original,
            **kwargs,
        ):
            query_calls.append(_method_name)
            return _original(*args, **kwargs)

        monkeypatch.setattr(repository, method_name, counted_query)

    service = MarketDataService(_ColdPremiumFactory(), metrics_repository=repository)
    unexpected_fetch = AsyncMock(side_effect=AssertionError("warm cache fetched upstream"))
    monkeypatch.setattr(service, "_fetch_market", unexpected_fetch)

    rows, missing, fetch_failed, budget_exhausted = (
        await service._ensure_premium_index_history(
            _funding_key(),
            start_ms=0,
            end_ms=minute_count * _MINUTE_MS - 1,
            fetch_missing=True,
        )
    )

    assert len(rows) == minute_count
    assert missing == []
    assert fetch_failed is False
    assert budget_exhausted is False
    assert query_calls in (
        ["query_premium_index"],
        ["query_premium_index_compact"],
    )
    assert unexpected_fetch.await_count == 0
    await service.shutdown()


@_async_test
async def test_cold_premium_refresh_uses_concurrent_deterministic_shards_and_one_wave_upsert(
    tmp_path,
    monkeypatch,
) -> None:
    minute_count = 2500
    repository = MarketMetricsRepository(tmp_path / "premium-cold.sqlite")
    factory = _ColdPremiumFactory()
    service = MarketDataService(factory, metrics_repository=repository)
    monkeypatch.setattr(service, "_fetch_market", factory.fetch_market)

    upsert_batches: list[list[int]] = []
    original_upsert = repository.upsert_premium_index

    def counted_upsert(rows):
        batch = list(rows)
        upsert_batches.append([int(row["open_time_ms"]) for row in batch])
        return original_upsert(batch)

    monkeypatch.setattr(repository, "upsert_premium_index", counted_upsert)

    rows, missing, fetch_failed, budget_exhausted = (
        await service._ensure_premium_index_history(
            _funding_key(),
            start_ms=0,
            end_ms=minute_count * _MINUTE_MS - 1,
            fetch_missing=True,
        )
    )

    observed_ranges = sorted(
        (int(call["start_ms"]), int(call["end_ms"]))
        for call in factory.calls
    )
    expected_ranges = [
        (0, 999 * _MINUTE_MS),
        (1000 * _MINUTE_MS, 1999 * _MINUTE_MS),
        (2000 * _MINUTE_MS, 2499 * _MINUTE_MS),
    ]
    violations: list[str] = []
    if observed_ranges != expected_ranges:
        violations.append(
            f"shards={observed_ranges!r}, expected={expected_ranges!r}",
        )
    if factory.max_in_flight <= 1:
        violations.append(f"max_in_flight={factory.max_in_flight}, expected > 1")
    if len(upsert_batches) != 1:
        violations.append(
            f"upsert_batch_sizes={[len(batch) for batch in upsert_batches]!r}, "
            "expected one successful wave batch",
        )
    elif len(upsert_batches[0]) != minute_count:
        violations.append(
            f"upserted={len(upsert_batches[0])}, expected={minute_count}",
        )

    assert not violations, "; ".join(violations)
    assert len(rows) == minute_count
    assert [int(row["open_time_ms"]) for row in rows] == [
        index * _MINUTE_MS
        for index in range(minute_count)
    ]
    assert missing == []
    assert fetch_failed is False
    assert budget_exhausted is False
    await service.shutdown()


@_async_test
async def test_cold_premium_gap_returns_only_a_contiguous_fail_closed_prefix(
    tmp_path,
    monkeypatch,
) -> None:
    now_ms = 11 * _MINUTE_MS + 500
    monkeypatch.setattr(
        "app.data_engine.market_data.service.time.time",
        lambda: now_ms / 1000,
    )
    monkeypatch.setattr(
        "app.data_engine.market_data.service._FUNDING_CONTEXT_LOOKBACK_MS",
        0,
    )
    repository = MarketMetricsRepository(tmp_path / "premium-gap.sqlite")
    repository.upsert_funding([_funding_row(0)])
    factory = _ColdPremiumFactory(missing_minutes={4})
    service = MarketDataService(factory, metrics_repository=repository)
    monkeypatch.setattr(service, "_fetch_market", factory.fetch_market)

    page = await service._build_hybrid_funding_history(
        _funding_key(),
        period="1m",
        start_ms=0,
        end_ms=10 * _MINUTE_MS + _MINUTE_MS - 1,
        limit=20,
        fetch_missing=True,
    )

    assert [event.event_time_ms for event in page.events] == [
        index * _MINUTE_MS
        for index in range(4)
    ]
    assert page.complete is False
    assert page.retryable is False
    assert any(
        excluded["reason"] == "premium_index_unavailable"
        and int(excluded["start_ms"]) <= 4 * _MINUTE_MS <= int(excluded["end_ms"])
        for excluded in page.excluded_ranges
    )
    assert repository.query_premium_index(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_ms=5 * _MINUTE_MS,
        end_ms=10 * _MINUTE_MS,
    )
    await service.shutdown()
