from __future__ import annotations

from dataclasses import dataclass
import asyncio
from functools import wraps
import time

import pytest

from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType
from app.data_engine.market_data.events import MarketStateEvent
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey
from app.data_engine.market_data.service import MarketDataService


def _async_test(function):
    @wraps(function)
    def _wrapped():
        return asyncio.run(function())

    return _wrapped


@dataclass
class _Handle:
    owner: "_Factory"
    key: str
    stopped: bool = False

    async def stop(self) -> None:
        if self.stopped:
            return
        self.stopped = True
        self.owner.stop_calls.append(self.key)


class _Factory:
    def __init__(self) -> None:
        self.start_calls = []
        self.stop_calls: list[str] = []
        self.callbacks = {}
        self.fetch_calls = []
        self.fail_next_start = False

    async def start_market(self, descriptor, callback):
        if self.fail_next_start:
            self.fail_next_start = False
            raise RuntimeError("start failed")
        self.start_calls.append(descriptor)
        self.callbacks[descriptor.key] = callback
        return _Handle(self, descriptor.key)

    async def fetch_market(self, descriptor, **kwargs):
        self.fetch_calls.append((descriptor, kwargs))
        history = kwargs.get("history", False)
        if descriptor.stream_type == StreamType.OPEN_INTEREST:
            data = {"open_interest": 123.5}
            if history:
                data["open_interest_value"] = 12_350.0
        elif descriptor.stream_type == StreamType.FUNDING_RATE and history:
            data = {"funding_rate": 0.0001, "funding_time_ms": 1_700_000_000_000}
        else:
            data = {
                "mark_price": 101.0,
                "index_price": 100.0,
                "estimated_settle_price": 100.5,
                "funding_rate": 0.0001,
                "next_funding_time_ms": 1_700_028_800_000,
            }
        return [MarketEvent(
            event_type=descriptor.stream_type,
            symbol=descriptor.symbol,
            exchange=descriptor.exchange,
            event_time_ms=1_700_000_000_000,
            received_at_ms=int(time.time() * 1000),
            source=DataSource.HTTP_BACKFILL if history else DataSource.HTTP,
            data=data,
            stream_key=descriptor.key,
            market_type=descriptor.market_type,
        )]


class _BlockingStartFactory(_Factory):
    def __init__(self) -> None:
        super().__init__()
        self.start_entered = asyncio.Event()
        self.start_gate = asyncio.Event()

    async def start_market(self, descriptor, callback):
        self.start_entered.set()
        await self.start_gate.wait()
        return await super().start_market(descriptor, callback)


class _SelectiveBlockingStartFactory(_Factory):
    def __init__(self, blocked_symbol: str) -> None:
        super().__init__()
        self.blocked_symbol = blocked_symbol
        self.start_attempts: list[str] = []
        self.start_entered = asyncio.Event()
        self.start_gate = asyncio.Event()

    async def start_market(self, descriptor, callback):
        self.start_attempts.append(descriptor.symbol)
        if descriptor.symbol == self.blocked_symbol:
            self.start_entered.set()
            await self.start_gate.wait()
        return await super().start_market(descriptor, callback)


class _BlockingStopHandle(_Handle):
    async def stop(self) -> None:
        self.owner.stop_entered.set()
        await self.owner.stop_gate.wait()
        await super().stop()


class _BlockingStopFactory(_Factory):
    def __init__(self) -> None:
        super().__init__()
        self.stop_entered = asyncio.Event()
        self.stop_gate = asyncio.Event()

    async def start_market(self, descriptor, callback):
        self.start_calls.append(descriptor)
        self.callbacks[descriptor.key] = callback
        return _BlockingStopHandle(self, descriptor.key)


class _PartialFetchFactory(_Factory):
    async def fetch_market(self, descriptor, **kwargs):
        if descriptor.stream_type == StreamType.OPEN_INTEREST:
            raise RuntimeError("OI unavailable")
        return await super().fetch_market(descriptor, **kwargs)


class _BlockingFetchFactory(_Factory):
    def __init__(self) -> None:
        super().__init__()
        self.fetch_entered = asyncio.Event()
        self.fetch_gate = asyncio.Event()

    async def fetch_market(self, descriptor, **kwargs):
        self.fetch_entered.set()
        await self.fetch_gate.wait()
        return await super().fetch_market(descriptor, **kwargs)


class _FlakyStopHandle(_Handle):
    async def stop(self) -> bool:
        self.owner.stop_attempts += 1
        if self.owner.stop_attempts == 1:
            return False
        await super().stop()
        return True


class _FlakyStopFactory(_Factory):
    def __init__(self) -> None:
        super().__init__()
        self.stop_attempts = 0

    async def start_market(self, descriptor, callback):
        self.start_calls.append(descriptor)
        self.callbacks[descriptor.key] = callback
        return _FlakyStopHandle(self, descriptor.key)


class _BlockingFlakyStopFactory(_FlakyStopFactory):
    def __init__(self) -> None:
        super().__init__()
        self.start_entered = asyncio.Event()
        self.start_gate = asyncio.Event()

    async def start_market(self, descriptor, callback):
        self.start_entered.set()
        await self.start_gate.wait()
        return await super().start_market(descriptor, callback)


def _key(
    channel: MarketChannel,
    *,
    symbol: str = "BTCUSDT",
) -> MarketStreamKey:
    return MarketStreamKey.build("binance", "futures", symbol, channel)


@_async_test
async def test_summary_logical_leases_share_one_physical_feed_until_last_release() -> None:
    factory = _Factory()
    service = MarketDataService(factory)
    keys = [
        _key(MarketChannel.MARK_PRICE),
        _key(MarketChannel.INDEX_PRICE),
        _key(MarketChannel.FUNDING_RATE),
        _key(MarketChannel.BASIS),
    ]

    assert await service.ensure_stream(keys[0], consumer_id="one") is True
    assert await service.ensure_stream(keys[0], consumer_id="one") is False
    assert await service.ensure_stream(keys[0], consumer_id="two") is True
    for key in keys[1:]:
        assert await service.ensure_stream(key, consumer_id="one") is True
    assert len(factory.start_calls) == 1
    assert factory.start_calls[0].stream_type is StreamType.MARK_PRICE

    callback = factory.callbacks[factory.start_calls[0].key]
    await callback(MarketEvent(
        event_type=StreamType.MARK_PRICE,
        symbol="BTCUSDT",
        exchange="binance",
        event_time_ms=200,
        received_at_ms=201,
        source=DataSource.WEBSOCKET,
        data={
            "mark_price": 101.0,
            "index_price": 100.0,
            "funding_rate": 0.0001,
            "next_funding_time_ms": 300,
        },
        market_type="futures",
    ))
    records = {record.event.key.channel: record for record in service.hub.snapshot(keys)}
    assert set(records) == {key.channel for key in keys}
    assert records[MarketChannel.BASIS].event.data["basis_bps"] == pytest.approx(100)

    assert await service.release_stream(keys[0], consumer_id="one") is True
    assert await service.release_stream(keys[0], consumer_id="two") is True
    assert factory.stop_calls == []
    for key in keys[1:-1]:
        await service.release_stream(key, consumer_id="one")
    assert factory.stop_calls == []
    await service.release_stream(keys[-1], consumer_id="one")
    assert len(factory.stop_calls) == 1


@_async_test
async def test_open_interest_uses_rest_poll_physical_descriptor() -> None:
    factory = _Factory()
    service = MarketDataService(factory, open_interest_poll_seconds=5)
    key = _key(MarketChannel.OPEN_INTEREST)

    await service.ensure_stream(key, consumer_id="oi")

    descriptor = factory.start_calls[0]
    assert descriptor.stream_type is StreamType.OPEN_INTEREST
    assert descriptor.poll_interval_seconds == 5
    assert service.diagnostics()["physical_streams"] == 1
    await service.release_stream(key, consumer_id="oi")


@_async_test
async def test_generic_funding_uses_its_declared_ccxt_funding_route() -> None:
    factory = _Factory()
    service = MarketDataService(factory)
    key = MarketStreamKey.build(
        "bybit",
        "swap.linear",
        "BTC/USDT:USDT",
        MarketChannel.FUNDING_RATE,
    )

    await service.ensure_stream(key, consumer_id="funding")

    descriptor = factory.start_calls[0]
    assert descriptor.stream_type is StreamType.FUNDING_RATE
    assert descriptor.poll_interval_seconds == 5
    await service.release_stream(key, consumer_id="funding")


@_async_test
async def test_generic_open_interest_history_passes_through_undeclared_period() -> None:
    factory = _Factory()
    service = MarketDataService(factory)
    key = MarketStreamKey.build(
        "bybit",
        "swap.linear",
        "BTC/USDT:USDT",
        MarketChannel.OPEN_INTEREST,
    )

    history = await service.history(
        key,
        period="5m",
        limit=10,
        start_ms=1_699_999_700_000,
        end_ms=1_700_000_000_000,
    )

    assert history[0].data["open_interest"] == 123.5
    descriptor, kwargs = factory.fetch_calls[0]
    assert descriptor.interval == "5m"
    assert kwargs["history"] is True


@_async_test
async def test_start_failure_rolls_back_leases_and_can_retry() -> None:
    factory = _Factory()
    factory.fail_next_start = True
    service = MarketDataService(factory)
    key = _key(MarketChannel.MARK_PRICE)

    with pytest.raises(RuntimeError, match="start failed"):
        await service.ensure_stream(key, consumer_id="one")
    assert service.diagnostics()["logical_streams"] == 0
    assert service.diagnostics()["physical_streams"] == 0

    assert await service.ensure_stream(key, consumer_id="one") is True
    assert len(factory.start_calls) == 1
    await service.shutdown()
    assert len(factory.stop_calls) == 1


@_async_test
async def test_snapshot_groups_summary_fetch_and_history_is_channel_gated() -> None:
    factory = _Factory()
    service = MarketDataService(factory)
    mark = _key(MarketChannel.MARK_PRICE)
    funding = _key(MarketChannel.FUNDING_RATE)
    basis = _key(MarketChannel.BASIS)
    oi = _key(MarketChannel.OPEN_INTEREST)

    records = await service.snapshot([mark, funding, basis, oi])
    assert len(records) == 4
    assert len(factory.fetch_calls) == 2

    history = await service.history(funding, limit=10)
    assert history[0].data["funding_rate"] == 0.0001
    oi_history = await service.history(oi, period="5m", limit=10)
    assert oi_history[0].data["open_interest_value"] == 12_350.0
    with pytest.raises(ValueError, match="does not support history"):
        await service.history(mark, period="5m")


@_async_test
async def test_cancelled_start_rolls_back_logical_and_physical_state() -> None:
    factory = _BlockingStartFactory()
    service = MarketDataService(factory)
    key = _key(MarketChannel.MARK_PRICE)

    task = asyncio.create_task(service.ensure_stream(key, consumer_id="cancelled"))
    await factory.start_entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    diagnostics = service.diagnostics()
    assert diagnostics["logical_streams"] == 0
    assert diagnostics["physical_streams"] == 0


@_async_test
async def test_cancel_after_start_returns_stops_unpublished_handle() -> None:
    factory = _BlockingStartFactory()
    service = MarketDataService(factory)
    key = _key(MarketChannel.MARK_PRICE)
    task = asyncio.create_task(
        service.ensure_stream(key, consumer_id="cancelled-after-start"),
    )
    await factory.start_entered.wait()

    async with service._lock:
        factory.start_gate.set()
        await asyncio.sleep(0)
        assert len(factory.start_calls) == 1
        assert task.done() is False
        task.cancel()
        await asyncio.sleep(0)

    with pytest.raises(asyncio.CancelledError):
        await task

    diagnostics = service.diagnostics()
    assert diagnostics["logical_streams"] == 0
    assert diagnostics["physical_streams"] == 0
    assert len(factory.stop_calls) == 1
    assert await service.ensure_stream(key, consumer_id="replacement") is True
    assert len(factory.start_calls) == 2
    await service.shutdown()


@_async_test
async def test_cancelled_start_cleanup_reuses_physical_stop_retry() -> None:
    factory = _BlockingFlakyStopFactory()
    service = MarketDataService(factory)
    key = _key(MarketChannel.MARK_PRICE)
    task = asyncio.create_task(
        service.ensure_stream(key, consumer_id="cancelled-after-start"),
    )
    await factory.start_entered.wait()

    async with service._lock:
        factory.start_gate.set()
        await asyncio.sleep(0)
        assert len(factory.start_calls) == 1
        assert task.done() is False
        task.cancel()
        await asyncio.sleep(0)

    with pytest.raises(asyncio.CancelledError):
        await task

    diagnostics = service.diagnostics()
    assert diagnostics["logical_streams"] == 0
    assert diagnostics["physical_streams"] == 1
    assert factory.stop_attempts == 1

    assert await asyncio.wait_for(
        service.ensure_stream(key, consumer_id="replacement"),
        timeout=1.0,
    ) is True
    assert factory.stop_attempts == 2
    assert len(factory.start_calls) == 2
    await service.shutdown()


@_async_test
async def test_keyed_lifecycle_allows_parallel_symbols_and_shutdown_during_start() -> None:
    factory = _SelectiveBlockingStartFactory("BTCUSDT")
    service = MarketDataService(factory)
    btc_mark = _key(MarketChannel.MARK_PRICE)
    btc_index = _key(MarketChannel.INDEX_PRICE)
    eth_mark = _key(MarketChannel.MARK_PRICE, symbol="ETHUSDT")

    first = asyncio.create_task(
        service.ensure_stream(btc_mark, consumer_id="btc-mark"),
    )
    await factory.start_entered.wait()
    same_physical = asyncio.create_task(
        service.ensure_stream(btc_index, consumer_id="btc-index"),
    )

    assert await asyncio.wait_for(
        service.ensure_stream(eth_mark, consumer_id="eth-mark"),
        timeout=0.25,
    ) is True
    assert factory.start_attempts.count("BTCUSDT") == 1
    assert factory.start_attempts.count("ETHUSDT") == 1
    assert not same_physical.done()

    shutdown = asyncio.create_task(service.shutdown())
    for _ in range(100):
        if service.diagnostics()["closed"]:
            break
        await asyncio.sleep(0.005)
    assert service.diagnostics()["closed"] is True
    factory.start_gate.set()

    results = await asyncio.gather(first, same_physical, return_exceptions=True)
    assert all(isinstance(item, RuntimeError) for item in results)
    await asyncio.wait_for(shutdown, timeout=0.5)

    diagnostics = service.diagnostics()
    assert diagnostics["logical_streams"] == 0
    assert diagnostics["physical_streams"] == 0
    assert len(factory.start_calls) == 2
    assert len(factory.stop_calls) == 2
    assert service._identity_locks.active_keys == 0  # noqa: SLF001


@_async_test
async def test_cancelled_release_finishes_stop_before_same_physical_stream_restarts() -> None:
    factory = _BlockingStopFactory()
    service = MarketDataService(factory)
    key = _key(MarketChannel.MARK_PRICE)
    await service.ensure_stream(key, consumer_id="first")

    release = asyncio.create_task(service.release_stream(key, consumer_id="first"))
    await factory.stop_entered.wait()
    release.cancel()
    with pytest.raises(asyncio.CancelledError):
        await release
    assert service.diagnostics()["physical"][0]["state"] == "stopping"

    restart = asyncio.create_task(service.ensure_stream(key, consumer_id="second"))
    await asyncio.sleep(0)
    assert not restart.done()
    factory.stop_gate.set()
    assert await restart is True
    assert len(factory.start_calls) == 2
    await service.release_stream(key, consumer_id="second")


@_async_test
async def test_p1_rejects_params_and_bounds_open_interest_physical_streams() -> None:
    factory = _Factory()
    service = MarketDataService(factory, max_open_interest_streams=1)
    alias = MarketStreamKey.build(
        "binance",
        "futures",
        "BTCUSDT",
        MarketChannel.MARK_PRICE,
        params={"alias": "one"},
    )
    with pytest.raises(ValueError, match="do not accept params"):
        await service.ensure_stream(alias, consumer_id="alias")

    first = _key(MarketChannel.OPEN_INTEREST)
    second = MarketStreamKey.build(
        "binance",
        "futures",
        "ETHUSDT",
        MarketChannel.OPEN_INTEREST,
    )
    await service.ensure_stream(first, consumer_id="one")
    with pytest.raises(RuntimeError, match="physical stream limit"):
        await service.ensure_stream(second, consumer_id="two")
    await service.release_stream(first, consumer_id="one")


@_async_test
async def test_snapshot_returns_successful_group_and_excludes_stale_failed_group() -> None:
    factory = _PartialFetchFactory()
    service = MarketDataService(factory)
    mark = _key(MarketChannel.MARK_PRICE)
    oi = _key(MarketChannel.OPEN_INTEREST)
    service.hub.publish(MarketStateEvent(
        key=oi,
        event_time_ms=100,
        received_at_ms=100,
        source=DataSource.HTTP,
        data={"open_interest": 1.0},
    ))

    records = await service.snapshot([mark, oi], refresh_missing=True)

    assert [record.event.key for record in records] == [mark]
    assert service.diagnostics()["snapshot_fetch_errors"] == 1


@_async_test
async def test_cancelled_snapshot_waiter_does_not_leak_singleflight_task() -> None:
    factory = _BlockingFetchFactory()
    service = MarketDataService(factory)
    key = _key(MarketChannel.MARK_PRICE)

    waiter = asyncio.create_task(service.snapshot([key]))
    await factory.fetch_entered.wait()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter

    assert len(service._snapshot_tasks) == 1
    factory.fetch_gate.set()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert service._snapshot_tasks == {}
    assert len(service.hub.snapshot([key])) == 0


@_async_test
async def test_stop_failure_retries_before_restarting_same_physical_stream() -> None:
    factory = _FlakyStopFactory()
    service = MarketDataService(factory)
    key = _key(MarketChannel.MARK_PRICE)
    await service.ensure_stream(key, consumer_id="first")

    with pytest.raises(RuntimeError, match="reported stop failure"):
        await service.release_stream(key, consumer_id="first")
    assert service.diagnostics()["physical"][0]["state"] == "stopping"
    assert service.diagnostics()["physical_stop_errors"] == 1

    assert await service.ensure_stream(key, consumer_id="second") is True
    assert factory.stop_attempts == 2
    assert len(factory.start_calls) == 2
    await service.release_stream(key, consumer_id="second")


@_async_test
async def test_failed_stop_is_reclaimed_before_other_symbol_uses_capacity() -> None:
    factory = _FlakyStopFactory()
    service = MarketDataService(factory, max_summary_streams=1)
    btc = _key(MarketChannel.MARK_PRICE)
    eth = MarketStreamKey.build(
        "binance",
        "futures",
        "ETHUSDT",
        MarketChannel.MARK_PRICE,
    )
    await service.ensure_stream(btc, consumer_id="btc")

    with pytest.raises(RuntimeError, match="reported stop failure"):
        await service.release_stream(btc, consumer_id="btc")

    assert await service.ensure_stream(eth, consumer_id="eth") is True
    assert factory.stop_attempts == 2
    assert [item.symbol for item in factory.start_calls] == ["BTCUSDT", "ETHUSDT"]
    await service.release_stream(eth, consumer_id="eth")


@_async_test
async def test_closed_service_rejects_new_reads_without_fetching() -> None:
    factory = _Factory()
    service = MarketDataService(factory)
    mark = _key(MarketChannel.MARK_PRICE)
    funding = _key(MarketChannel.FUNDING_RATE)
    await service.shutdown()

    with pytest.raises(RuntimeError, match="service is closed"):
        await service.snapshot([mark])
    with pytest.raises(RuntimeError, match="service is closed"):
        await service.history(funding)
    with pytest.raises(RuntimeError, match="service is closed"):
        service.subscribe([mark])
    assert factory.fetch_calls == []
