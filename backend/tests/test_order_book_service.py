from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from functools import wraps

import pytest

import app.data_engine.market_data.order_book_service as service_module
from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey
from app.data_engine.market_data.order_book import OrderBookEngine
from app.data_engine.market_data.order_book_service import OrderBookService


def _async_test(function):
    @wraps(function)
    def _wrapped(*args, **kwargs):
        return asyncio.run(function(*args, **kwargs))

    return _wrapped


def _key(
    *,
    symbol: str = "BTCUSDT",
    market_type: str = "futures",
    depth_levels: int = 20,
    update_interval_ms: int = 250,
    mode: str = "partial",
) -> MarketStreamKey:
    return MarketStreamKey.build(
        "binance",
        market_type,
        symbol,
        MarketChannel.DEPTH,
        params={
            "mode": mode,
            "depth_levels": depth_levels,
            "update_interval_ms": update_interval_ms,
        },
    )


def _event(
    update_id: int,
    *,
    symbol: str = "BTCUSDT",
    depth_levels: int = 20,
    update_interval_ms: int = 250,
    received_at_ms: int | None = None,
    crossed: bool = False,
) -> MarketEvent:
    now_ms = int(time.time() * 1000)
    received = now_ms if received_at_ms is None else received_at_ms
    return MarketEvent(
        event_type=StreamType.DEPTH,
        symbol=symbol,
        exchange="binance",
        market_type="futures",
        event_time_ms=received - 1,
        received_at_ms=received,
        source=DataSource.WEBSOCKET,
        sequence=update_id,
        data={
            "last_update_id": update_id,
            "depth_levels": depth_levels,
            "update_interval_ms": update_interval_ms,
            "bids": [[100.0, 2.0], [99.0, 3.0]],
            "asks": (
                [[100.0, 1.0], [102.0, 2.0]]
                if crossed
                else [[101.0, 1.0], [102.0, 2.0]]
            ),
        },
    )


@dataclass
class _Handle:
    factory: "_Factory"
    identity: tuple[str, str, str, int, int]
    stopped: bool = False

    async def stop(self) -> bool | None:
        self.factory.stop_invocations += 1
        if self.factory.stop_gate is not None:
            self.factory.stop_started.set()
            while True:
                try:
                    await self.factory.stop_gate.wait()
                except asyncio.CancelledError:
                    if not self.factory.stop_ignores_cancellation:
                        raise
                else:
                    break
        if self.factory.stop_error is not None:
            raise self.factory.stop_error
        if not self.stopped:
            self.stopped = True
            self.factory.stop_calls.append(self.identity)
        return None


class _Factory:
    def __init__(self) -> None:
        self.start_calls = []
        self.start_gates: dict[str, asyncio.Event] = {}
        self.start_entered: dict[str, asyncio.Event] = {}
        self.callbacks = {}
        self.stop_calls: list[tuple[str, str, str, int, int]] = []
        self.stop_gate: asyncio.Event | None = None
        self.stop_started = asyncio.Event()
        self.stop_ignores_cancellation = False
        self.stop_error: Exception | None = None
        self.stop_invocations = 0

    async def start_market(self, descriptor, callback, *, on_gap=None):
        assert on_gap is None
        identity = (
            descriptor.exchange,
            descriptor.market_type,
            descriptor.symbol,
            descriptor.depth_levels,
            descriptor.update_interval_ms,
        )
        self.start_calls.append(descriptor)
        gate = self.start_gates.get(descriptor.symbol)
        if gate is not None:
            self.start_entered.setdefault(descriptor.symbol, asyncio.Event()).set()
            await gate.wait()
        self.callbacks[identity] = callback
        return _Handle(self, identity)

    async def emit(self, key: MarketStreamKey, event: MarketEvent) -> None:
        params = dict(key.params)
        identity = (
            key.exchange,
            key.market_type,
            key.symbol,
            int(params["depth_levels"]),
            int(params["update_interval_ms"]),
        )
        await self.callbacks[identity](event)


def _service(factory: _Factory, **kwargs) -> OrderBookService:
    return OrderBookService(
        factory,
        engine=kwargs.pop("engine", OrderBookEngine(max_streams=16)),
        max_streams=kwargs.pop("max_streams", 16),
        max_snapshot_age_ms=kwargs.pop("max_snapshot_age_ms", 10_000),
        **kwargs,
    )


async def _wait_until(predicate, *, timeout: float = 2.0) -> None:
    async def _wait() -> None:
        while not predicate():
            await asyncio.sleep(0.005)

    await asyncio.wait_for(_wait(), timeout=timeout)


@_async_test
async def test_default_stop_budget_exceeds_transport_close_bound() -> None:
    service = OrderBookService(_Factory())

    assert service.diagnostics()["shutdown"]["physical_stop_timeout_seconds"] == 5.0
    await service.shutdown()


@_async_test
async def test_consumers_share_one_physical_feed_until_last_release() -> None:
    factory = _Factory()
    service = _service(factory)
    key = _key()

    assert await service.ensure_stream(key, consumer_id="first") is True
    assert await service.ensure_stream(key, consumer_id="first") is False
    assert await service.ensure_stream(key, consumer_id="second") is True
    assert len(factory.start_calls) == 1
    descriptor = factory.start_calls[0]
    assert descriptor.stream_type is StreamType.DEPTH
    assert descriptor.depth_levels == 20
    assert descriptor.update_interval_ms == 250
    await factory.emit(key, _event(1))
    await _wait_until(lambda: service.current(key) is not None)
    assert service._last_event_time_ms
    assert service._last_published_at_ms

    assert await service.release_stream(key, consumer_id="first") is True
    assert factory.stop_calls == []
    assert await service.release_stream(key, consumer_id="second") is True
    assert factory.stop_calls == [("binance", "futures", "BTCUSDT", 20, 250)]
    assert service.current(key) is None
    assert service._last_event_time_ms == {}
    assert service._last_published_at_ms == {}
    await service.shutdown()


@_async_test
async def test_keyed_lifecycle_parallelizes_symbols_and_singleflights_identity() -> None:
    factory = _Factory()
    factory.start_gates["BTCUSDT"] = asyncio.Event()
    factory.start_entered["BTCUSDT"] = asyncio.Event()
    service = _service(factory)
    btc = _key()
    eth = _key(symbol="ETHUSDT")

    first = asyncio.create_task(service.ensure_stream(btc, consumer_id="btc-one"))
    await factory.start_entered["BTCUSDT"].wait()
    same_identity = asyncio.create_task(
        service.ensure_stream(btc, consumer_id="btc-two"),
    )

    assert await asyncio.wait_for(
        service.ensure_stream(eth, consumer_id="eth"),
        timeout=0.25,
    ) is True
    assert len(factory.start_calls) == 2
    assert not same_identity.done()

    factory.start_gates["BTCUSDT"].set()
    assert await first is True
    assert await same_identity is True
    assert len(factory.start_calls) == 2

    await service.shutdown()
    assert len(factory.stop_calls) == 2
    assert service.diagnostics()["physical_streams"] == 0
    assert service._identity_locks.active_keys == 0  # noqa: SLF001


@_async_test
async def test_levels_and_update_interval_are_part_of_immutable_identity() -> None:
    factory = _Factory()
    service = _service(factory)
    fast = _key(depth_levels=5, update_interval_ms=100)
    deep = _key(depth_levels=20, update_interval_ms=500)
    spot = _key(market_type="spot", depth_levels=20, update_interval_ms=1000)

    await service.ensure_stream(fast, consumer_id="same-consumer")
    await service.ensure_stream(deep, consumer_id="same-consumer")
    await service.ensure_stream(spot, consumer_id="same-consumer")

    assert len(factory.start_calls) == 3
    assert {
        (item.market_type, item.depth_levels, item.update_interval_ms)
        for item in factory.start_calls
    } == {
        ("futures", 5, 100),
        ("futures", 20, 500),
        ("spot", 20, 1000),
    }
    assert service.diagnostics()["physical_streams"] == 3
    await service.shutdown()


@_async_test
async def test_invalid_or_unsupported_keys_fail_before_start() -> None:
    factory = _Factory()
    service = _service(factory)
    missing_mode = MarketStreamKey.build(
        "binance",
        "futures",
        "BTCUSDT",
        MarketChannel.DEPTH,
        params={"depth_levels": 20, "update_interval_ms": 250},
    )

    with pytest.raises(ValueError, match="requires exactly"):
        await service.ensure_stream(missing_mode, consumer_id="missing")
    with pytest.raises(ValueError, match="mode='partial'"):
        await service.ensure_stream(_key(mode="full"), consumer_id="full")
    with pytest.raises(ValueError, match="mode='partial'"):
        await service.ensure_stream(_key(mode="Partial"), consumer_id="mixed-case")
    with pytest.raises(ValueError, match="'spot' or 'futures'"):
        await service.ensure_stream(
            _key(market_type="margin"),
            consumer_id="margin",
        )
    with pytest.raises(ValueError, match="100, 1000"):
        await service.ensure_stream(
            _key(market_type="spot", update_interval_ms=250),
            consumer_id="spot-wrong-speed",
        )
    with pytest.raises(ValueError, match="100, 250, 500"):
        await service.ensure_stream(
            _key(update_interval_ms=1_000),
            consumer_id="slow",
        )
    assert factory.start_calls == []
    await service.shutdown()


@_async_test
async def test_engine_active_identity_without_physical_lease_fails_closed() -> None:
    factory = _Factory()
    engine = OrderBookEngine(max_streams=16)
    engine.activate_stream(("binance", "futures", "BTCUSDT", 20, 250))
    service = _service(factory, engine=engine)

    with pytest.raises(RuntimeError, match="active without a physical lease"):
        await service.ensure_stream(_key(), consumer_id="inconsistent")

    assert factory.start_calls == []
    assert service.diagnostics()["physical_streams"] == 0
    await service.shutdown()


@_async_test
async def test_attach_handoff_exposes_complete_current_then_live_snapshot() -> None:
    factory = _Factory()
    service = _service(factory)
    key = _key()
    await service.ensure_stream(key, consumer_id="socket")
    await factory.emit(key, _event(1))
    await _wait_until(lambda: service.current(key) is not None)

    attachment = service.attach(key)
    current = attachment.current[key]
    assert current.revision == 1
    assert current.event.data["delivery"] == "snapshot"
    assert current.event.data["partial"] is True
    assert current.event.data["full_book"] is False
    assert current.event.data["sequence_continuity"] is False
    assert current.event.data["mid_price"] == 100.5

    await factory.emit(key, _event(2))
    live = await asyncio.wait_for(attachment.subscription.receive(), timeout=1)
    assert live is not None
    assert live.revision == 2
    assert live.event.sequence == 2
    await attachment.subscription.close()
    await service.shutdown()


@_async_test
async def test_slow_consumer_only_loses_replaceable_old_snapshots() -> None:
    factory = _Factory()
    service = _service(factory)
    key = _key()
    await service.ensure_stream(key, consumer_id="slow-browser")
    attachment = service.attach(key, max_pending=1)

    for update_id in (1, 2, 3):
        await factory.emit(key, _event(update_id))
        await _wait_until(
            lambda update_id=update_id: (
                service.diagnostics()["events_processed"] == update_id
            ),
        )

    assert attachment.subscription.pending_count == 1
    latest = await asyncio.wait_for(attachment.subscription.receive(), timeout=1)
    assert latest is not None
    assert latest.event.sequence == 3
    diagnostics = service.diagnostics()
    assert diagnostics["hub"]["subscriber_coalesced"] == 2
    assert diagnostics["hub"]["subscriber_dropped"] == 0
    await attachment.subscription.close()
    await service.shutdown()


@_async_test
async def test_ingestion_mailbox_coalesces_without_waiting_for_worker() -> None:
    factory = _Factory()
    service = _service(factory)
    key = _key()
    await service.ensure_stream(key, consumer_id="capture")

    await factory.emit(key, _event(1))
    await factory.emit(key, _event(2))
    await factory.emit(key, _event(3))
    await _wait_until(lambda: service.diagnostics()["events_processed"] == 1)

    current = service.current(key)
    assert current is not None
    assert current.event.sequence == 3
    diagnostics = service.diagnostics()
    assert diagnostics["events_offered"] == 3
    assert diagnostics["events_coalesced"] == 2
    assert diagnostics["engine"]["snapshots_accepted"] == 1
    await service.shutdown()


@_async_test
async def test_late_callback_from_released_generation_is_rejected() -> None:
    factory = _Factory()
    service = _service(factory)
    key = _key()
    await service.ensure_stream(key, consumer_id="old")
    identity = ("binance", "futures", "BTCUSDT", 20, 250)
    old_callback = factory.callbacks[identity]
    await service.release_stream(key, consumer_id="old")
    await service.ensure_stream(key, consumer_id="new")

    await old_callback(_event(99))
    await asyncio.sleep(0)
    assert service.current(key) is None
    assert service.diagnostics()["events_inactive_generation"] == 1

    await factory.emit(key, _event(1))
    await _wait_until(lambda: service.current(key) is not None)
    assert service.current(key).event.sequence == 1  # type: ignore[union-attr]
    await service.shutdown()


@_async_test
async def test_queued_event_is_rechecked_against_generation_at_dequeue() -> None:
    factory = _Factory()
    service = _service(factory)
    key = _key()
    await service.ensure_stream(key, consumer_id="generation")
    generation = service._stream_generations[key]

    service._offer_event(key, _event(99), generation=generation)
    service._stream_generations[key] = object()
    await _wait_until(
        lambda: service.diagnostics()["events_inactive_generation"] == 1,
    )

    assert service.current(key) is None
    assert service.diagnostics()["events_processed"] == 0
    await service.shutdown()


@_async_test
async def test_mismatched_invalid_duplicate_and_stale_snapshots_fail_closed() -> None:
    factory = _Factory()
    service = _service(factory)
    key = _key()
    await service.ensure_stream(key, consumer_id="validation")

    await factory.emit(key, _event(1, depth_levels=5))
    await factory.emit(key, _event(2, crossed=True))
    await _wait_until(lambda: service.diagnostics()["events_processed"] == 1)
    assert service.current(key) is None
    assert service.diagnostics()["identity_mismatches"] == 1
    assert service.diagnostics()["events_invalid"] == 1

    await factory.emit(key, _event(5))
    await _wait_until(lambda: service.current(key) is not None)
    await factory.emit(key, _event(5))
    await _wait_until(lambda: service.diagnostics()["events_duplicate"] == 1)
    await factory.emit(key, _event(4))
    await _wait_until(lambda: service.diagnostics()["events_stale"] == 1)
    assert service.current(key).event.sequence == 5  # type: ignore[union-attr]
    await service.shutdown()


@_async_test
async def test_wait_is_bounded_and_transient_snapshot_releases_lease() -> None:
    factory = _Factory()
    service = _service(factory)
    key = _key()
    await service.ensure_stream(key, consumer_id="timeout")

    with pytest.raises(asyncio.TimeoutError):
        await service.wait_for_snapshot(key, timeout_seconds=0.01)
    assert service.diagnostics()["snapshot_wait_timeouts"] == 1
    await service.release_stream(key, consumer_id="timeout")

    task = asyncio.create_task(
        service.transient_snapshot(
            key,
            consumer_id="http-request",
            timeout_seconds=1,
        ),
    )
    await _wait_until(lambda: len(factory.start_calls) == 2)
    await factory.emit(key, _event(10))
    record = await task
    assert record.event.sequence == 10
    assert service.diagnostics()["physical_streams"] == 0
    assert len(factory.stop_calls) == 2
    await service.shutdown()


@_async_test
async def test_wall_clock_stale_snapshot_is_not_served(monkeypatch) -> None:
    factory = _Factory()
    service = _service(factory, max_snapshot_age_ms=100)
    key = _key()
    await service.ensure_stream(key, consumer_id="freshness")
    now_ms = int(time.time() * 1000)
    await factory.emit(key, _event(1, received_at_ms=now_ms))
    await _wait_until(lambda: service.current(key) is not None)

    monkeypatch.setattr(service_module.time, "time", lambda: (now_ms + 101) / 1000)
    assert service.current(key) is None
    assert service.diagnostics()["snapshot_stale_reads"] == 1
    await service.shutdown()


@_async_test
async def test_timed_out_stop_never_spawns_a_duplicate_physical_feed() -> None:
    factory = _Factory()
    factory.stop_gate = asyncio.Event()
    factory.stop_ignores_cancellation = True
    service = _service(factory, physical_stop_timeout_seconds=0.02)
    key = _key()
    await service.ensure_stream(key, consumer_id="first")

    assert await service.release_stream(key, consumer_id="first") is False
    assert service.diagnostics()["physical_streams"] == 1
    assert service.diagnostics()["physical"][0]["stop_state"] == "stopping"
    with pytest.raises(RuntimeError, match="stop is still in progress"):
        await service.ensure_stream(key, consumer_id="replacement")
    assert len(factory.start_calls) == 1

    factory.stop_gate.set()
    await _wait_until(lambda: service.diagnostics()["physical_streams"] == 0)
    assert await service.ensure_stream(key, consumer_id="replacement") is True
    assert len(factory.start_calls) == 2
    await service.shutdown()


@_async_test
async def test_failed_stop_is_fail_closed_and_can_be_retried() -> None:
    factory = _Factory()
    factory.stop_error = RuntimeError("stop failed")
    service = _service(factory)
    key = _key()
    await service.ensure_stream(key, consumer_id="owner")
    await factory.emit(key, _event(1))
    await _wait_until(lambda: service.current(key) is not None)

    assert await service.release_stream(key, consumer_id="owner") is False
    assert service.current(key) is None
    assert service.diagnostics()["degraded"] is True
    with pytest.raises(RuntimeError, match="unavailable after a failed stop"):
        await service.ensure_stream(key, consumer_id="still-broken")
    assert len(factory.start_calls) == 1

    factory.stop_error = None
    assert await service.ensure_stream(key, consumer_id="owner") is True
    assert service.diagnostics()["physical_streams"] == 1
    assert service.diagnostics()["degraded"] is False
    assert len(factory.start_calls) == 2
    assert factory.stop_invocations == 3
    assert await service.release_stream(key, consumer_id="owner") is True
    await service.shutdown()


@_async_test
async def test_shutdown_drains_latest_event_and_bounds_cancellation_resistant_stop() -> None:
    factory = _Factory()
    factory.stop_gate = asyncio.Event()
    factory.stop_ignores_cancellation = True
    service = _service(factory, physical_stop_timeout_seconds=0.02)
    key = _key()
    await service.ensure_stream(key, consumer_id="shutdown")
    attachment = service.attach(key, max_pending=1)
    await factory.emit(key, _event(1))
    await factory.emit(key, _event(2))

    await asyncio.wait_for(asyncio.shield(service.shutdown()), timeout=0.5)

    diagnostics = service.diagnostics()
    assert diagnostics["state"] == "closed"
    assert diagnostics["shutdown"]["degraded"] is True
    assert diagnostics["physical_streams"] == 0
    assert diagnostics["engine"]["snapshots_accepted"] == 1
    latest = await attachment.subscription.receive()
    assert latest is not None
    assert latest.event.sequence == 2
    assert await attachment.subscription.receive() is None

    factory.stop_gate.set()
    await _wait_until(
        lambda: service.diagnostics()["physical_stops_late_succeeded"] == 1,
    )
